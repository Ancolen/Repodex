/**
 * Extensible job system types.
 * To add a new job type: define a payload type and register a handler with
 * JobQueue.registerHandler(type, handler).
 */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobProgress {
  processed: number;
  total: number;
  message?: string;
}

export interface Job<TPayload = unknown, TResult = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  payload: TPayload;
  /**
   * Queue priority: HIGHER values are claimed first by the worker pool; jobs of
   * equal priority keep enqueue (FIFO) order. Default 0 — every user-initiated
   * job (index/reindex/sync via CLI, Control API or MCP) runs at 0.
   */
  priority: number;
  progress: JobProgress;
  result?: TResult;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** The execution context given to a handler: progress reporting + cancellation check. */
export interface JobContext<TPayload = unknown> {
  readonly job: Job<TPayload>;
  readonly payload: TPayload;
  readonly signal: AbortSignal;
  updateProgress(processed: number, total?: number, message?: string): void;
  isCancelled(): boolean;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  ctx: JobContext<TPayload>,
) => Promise<TResult>;

// ------------------------------------------------------- registered job types
// Payload types + type constants for the registered job handlers; the handlers
// live with their managers (IndexManager registers `index` and `migrate` at
// daemon boot via JobQueue.registerHandler).

/** The async indexing job: (re)index the project's table from the working tree. */
export const INDEX_JOB_TYPE = "index";

/**
 * Queue priority of jobs the daemon enqueues BY ITSELF at boot (restore()):
 * offline-change catch-up and half-finished-project resumes. They must not
 * starve a job the user just clicked — an interactive index job at the default
 * priority 0 is claimed before any background catch-up still waiting in
 * (or re-added to) the queue.
 */
export const JOB_PRIORITY_BACKGROUND = -5;

/**
 * How long the optional `wait` on an index start (`/index`/`/reindex`/`/sync`
 * body, MCP `index_project`) blocks for the final status — one round-trip for
 * agents that cannot receive job-completion notifications, but never a
 * deadlock on a slow backend: past the budget the call returns with
 * `timedOut: true` and the caller falls back to polling like before.
 */
export const INDEX_WAIT_MS = 120_000;

/** The zero-downtime model migration job (proposal O2): rebuild every vector of the
 * project's current table in a shadow table with `targetModel` and swap the
 * registry to it in one transaction once the shadow is complete. Search keeps
 * serving the old table until the swap. */
export const MIGRATE_JOB_TYPE = "migrate";

export interface MigrateJobPayload {
  project: string;
  targetModel: string;
  /**
   * The framing identity to embed the shadow table with (per-model framing
   * layer, `src/core/framing.ts`): the resolved preset id
   * ("embeddinggemma-2" | "qwen3-embedding") or null for none. `startMigration`
   * resolves it from the effective framing setting under `targetModel`, so the
   * commit pins exactly what the shadow embedded — a framing change rides the
   * same zero-downtime machinery as a model change. Payloads enqueued before
   * framing existed carry no field and read as null (the only framing those
   * records could have pinned).
   */
  framing?: string | null;
}

/**
 * The doc–code conformance job (proposal D1c, watch/loop mode): re-runs the
 * deterministic `checkDocs` over the project and stores the latest report in
 * the registry (`doccheck_reports`, one snapshot per project). Enqueued after a
 * successful index/sync/migrate job when `doccheck.watch` is on — the handler
 * is cheap and embedding-free (the reranker-free deterministic path).
 */
export const DOC_CHECK_JOB_TYPE = "doccheck";

export interface DocCheckJobPayload {
  project: string;
}
