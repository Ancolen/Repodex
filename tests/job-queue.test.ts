import { test, expect, describe } from "bun:test";
import { JobQueue } from "../src/core/job-queue";

/** Helper that waits for a job to be 'finished'. */
function waitFinished(q: JobQueue, id: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    q.on("finished", (job: { id: string }) => {
      if (job.id === id) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

describe("JobQueue", () => {
  test("unknown type cannot be enqueued", () => {
    const q = new JobQueue();
    expect(() => q.enqueue("missing", {})).toThrow();
  });

  test("handler runs and returns result + completed status", async () => {
    const q = new JobQueue();
    q.registerHandler<{ a: number; b: number }, number>("sum", async (ctx) => {
      return ctx.payload.a + ctx.payload.b;
    });
    const id = q.enqueue("sum", { a: 2, b: 3 });
    await waitFinished(q, id);
    const job = q.getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.result).toBe(5);
  });

  test("updateProgress updates progress", async () => {
    const q = new JobQueue();
    const seen: number[] = [];
    q.on("progress", (job: { progress: { processed: number } }) => seen.push(job.progress.processed));
    q.registerHandler("work", async (ctx) => {
      ctx.updateProgress(1, 3);
      ctx.updateProgress(2, 3);
      ctx.updateProgress(3, 3);
      return null;
    });
    const id = q.enqueue("work", {});
    await waitFinished(q, id);
    expect(q.getJob(id)?.progress.total).toBe(3);
    expect(seen).toContain(3);
  });

  test("running job becomes 'cancelled' when cancelled", async () => {
    const q = new JobQueue();
    let releaseStarted: () => void;
    const started = new Promise<void>((r) => (releaseStarted = r));
    q.registerHandler("long", async (ctx) => {
      releaseStarted();
      // Wait until cancellation signal is received
      await new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          if (ctx.isCancelled()) {
            clearInterval(iv);
            resolve();
          }
        }, 5);
      });
      return null;
    });
    const id = q.enqueue("long", {});
    await started;
    const ok = q.cancel(id);
    expect(ok).toBe(true);
    await waitFinished(q, id);
    expect(q.getJob(id)?.status).toBe("cancelled");
  });

  test("queued job becomes 'cancelled' when cancelled", async () => {
    const q = new JobQueue();
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.registerHandler("blocker", async () => {
      await gate;
      return null;
    });
    q.registerHandler("noop", async () => null);

    const blockerId = q.enqueue("blocker", {}); // keeps the worker busy
    const queuedId = q.enqueue("noop", {}); // waits in queue

    const cancelled = q.cancel(queuedId);
    expect(cancelled).toBe(true);
    expect(q.getJob(queuedId)?.status).toBe("cancelled");

    release!(); // release the blocker
    await waitFinished(q, blockerId);
    expect(q.getJob(blockerId)?.status).toBe("completed");
  });
});

describe("JobQueue worker pool (concurrency)", () => {
  test("concurrency=2: two jobs can run concurrently", async () => {
    const q = new JobQueue({ concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    let release: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.registerHandler("work", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return null;
    });
    const a = q.enqueue("work", {});
    const b = q.enqueue("work", {});
    // Wait a short time for both jobs to start.
    await Bun.sleep(20);
    expect(maxActive).toBe(2);
    release!();
    await Promise.all([waitFinished(q, a), waitFinished(q, b)]);
  });

  test("concurrency=2: a long/stuck job does NOT block a quick job", async () => {
    const q = new JobQueue({ concurrency: 2 });
    let releaseBlocker: () => void;
    const blocker = new Promise<void>((r) => (releaseBlocker = r));
    q.registerHandler("blocker", async () => {
      await blocker;
      return "blk";
    });
    q.registerHandler("quick", async () => "ok");

    const blockerId = q.enqueue("blocker", {}); // keeps the 1st slot busy
    const quickId = q.enqueue("quick", {}); // should run immediately in the 2nd slot

    await waitFinished(q, quickId); // completes while blocker is still running
    expect(q.getJob(quickId)?.status).toBe("completed");
    expect(q.getJob(blockerId)?.status).toBe("running");

    releaseBlocker!();
    await waitFinished(q, blockerId);
    expect(q.getJob(blockerId)?.status).toBe("completed");
  });

  test("concurrency=1 (default): jobs run serially", async () => {
    const q = new JobQueue(); // default concurrency 1
    let active = 0;
    let maxActive = 0;
    q.registerHandler("work", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(10);
      active--;
      return null;
    });
    const ids = [q.enqueue("work", {}), q.enqueue("work", {}), q.enqueue("work", {})];
    await Promise.all(ids.map((id) => waitFinished(q, id)));
    expect(maxActive).toBe(1);
  });
});
