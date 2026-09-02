import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Job, JobContext, JobHandler } from "./types";
import type { JobRow, Registry } from "./registry";

export interface JobQueueOptions {
  /** If provided, jobs are persisted to bun:sqlite. */
  registry?: Registry | undefined;
  /**
   * Maximum number of jobs that can run at the same time (worker pool size).
   * Default 1 (serial). When >1, a stuck/long job (e.g. a very large file) does
   * NOT BLOCK the indexing of other projects — since each project writes to an
   * independent table, it is parallel-safe. The default of 1 preserves the
   * current test/behavior semantics; the daemon passes a higher value from config.
   */
  concurrency?: number | undefined;
}

/** Upper bound on how often progress updates are written to SQLite (ms). */
const PROGRESS_PERSIST_MS = 1000;

/**
 * Asynchronous, extensible job queue.
 *
 * - New job types are added with registerHandler(type, fn).
 * - enqueue() puts the job in the queue and returns IMMEDIATELY (doesn't block
 *   the server).
 * - Jobs are processed in order (single worker); since the event loop is free
 *   while waiting for I/O, searches/requests continue uninterrupted.
 * - EventEmitter: "enqueued" | "started" | "progress" | "finished" events
 *   (for live progress broadcasting via SSE in Phase 3/6).
 *
 * If parallel workers are needed later, the `process()` loop can be turned into a pool.
 */
export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>();
  private handlers = new Map<string, JobHandler<any, any>>();
  private queue: string[] = [];
  private controllers = new Map<string, AbortController>();
  private activeWorkers = 0;
  private maxWorkers: number;
  private registry: Registry | undefined;

  constructor(opts: JobQueueOptions = {}) {
    super();
    this.registry = opts.registry;
    this.maxWorkers = Math.max(1, opts.concurrency ?? 1);
  }

  /** Registers a handler for a job type. */
  registerHandler<TPayload, TResult>(type: string, handler: JobHandler<TPayload, TResult>): void {
    this.handlers.set(type, handler as JobHandler<any, any>);
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  /** Enqueues the job, returns the job id. The caller does not wait. */
  enqueue<TPayload>(type: string, payload: TPayload): string {
    if (!this.handlers.has(type)) {
      throw new Error(`Unknown job type: ${type}`);
    }
    const job: Job<TPayload> = {
      id: randomUUID(),
      type,
      status: "queued",
      payload,
      progress: { processed: 0, total: 0 },
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job as Job);
    this.queue.push(job.id);
    this.persist(job as Job);
    this.emit("enqueued", job);
    this.pump();
    return job.id;
  }

  getJob(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  listJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Cancels a queued job or sends an abort signal to a running job. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "queued") {
      job.status = "cancelled";
      this.queue = this.queue.filter((q) => q !== id);
      this.finish(job);
      return true;
    }
    if (job.status === "running") {
      this.controllers.get(id)?.abort();
      return true;
    }
    return false;
  }

  /**
   * Waits for a job to reach a terminal state (completed/failed/cancelled).
   * Returns immediately if the job does not exist or has already finished. Used
   * together with `cancel()`: to wait until a running job has ACTUALLY stopped
   * after being cancelled (e.g. to guarantee that an in-progress write finishes
   * before dropping the table).
   */
  waitForJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return Promise.resolve();
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const onFinished = (j: Job): void => {
        if (j.id === id) {
          this.off("finished", onFinished);
          resolve();
        }
      };
      this.on("finished", onFinished);
    });
  }

  /** Sends an abort signal to all running jobs (graceful shutdown). */
  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  // ----------------------------------------------------------------- worker
  /**
   * Pulls jobs from the queue and fills the worker pool: at most `maxWorkers`
   * jobs run at the same time. The pool is refilled each time a job finishes.
   * A single long/stuck job does not block other jobs as long as there is a free slot.
   */
  private pump(): void {
    while (this.activeWorkers < this.maxWorkers && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) continue;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      this.activeWorkers++;
      void this.run(job).finally(() => {
        this.activeWorkers--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      job.status = "failed";
      job.error = `Handler not found: ${job.type}`;
      this.finish(job);
      return;
    }

    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = "running";
    job.startedAt = Date.now();
    this.persist(job);
    this.emit("started", job);

    // Throttle progress persistence: instead of writing to SQLite on every file,
    // write at most once per PROGRESS_PERSIST_MS. The in-memory job stays up to
    // date (for live /health and activeJob); the persisted row is a milestone
    // (a half-finished job is marked 'failed' on restart anyway). The final
    // progress is written in finish() regardless.
    let lastPersist = 0;
    const ctx: JobContext = {
      job,
      payload: job.payload,
      signal: controller.signal,
      isCancelled: () => controller.signal.aborted,
      updateProgress: (processed, total, message) => {
        job.progress = {
          processed,
          total: total ?? job.progress.total,
          ...(message !== undefined ? { message } : {}),
        };
        this.emit("progress", job);
        const now = Date.now();
        if (now - lastPersist >= PROGRESS_PERSIST_MS) {
          lastPersist = now;
          this.persist(job);
        }
      },
    };

    try {
      const result = await handler(ctx);
      if (controller.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.status = "completed";
        job.result = result;
      }
    } catch (err) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.controllers.delete(job.id);
      this.finish(job);
    }
  }

  private finish(job: Job): void {
    job.finishedAt = Date.now();
    this.persist(job);
    this.emit("finished", job);
  }

  // ------------------------------------------------------------ persistence
  private persist(job: Job): void {
    if (!this.registry) return;
    this.registry.saveJob(this.toRow(job));
  }

  private toRow(job: Job): JobRow {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      payload: job.payload === undefined ? null : JSON.stringify(job.payload),
      progressProcessed: job.progress.processed,
      progressTotal: job.progress.total,
      progressMessage: job.progress.message ?? null,
      result: job.result === undefined ? null : JSON.stringify(job.result),
      error: job.error ?? null,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
    };
  }
}
