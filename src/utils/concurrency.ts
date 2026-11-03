/** A counting semaphore (see `createSemaphore`). */
export interface Semaphore {
  /** Runs `fn` while holding one permit; the permit is released in a finally. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Counting semaphore with FIFO waiters.
 *
 * Full indexing runs several files concurrently (`indexing.fileConcurrency`),
 * and each file already fans its embed batches out with `EMBED_CONCURRENCY`.
 * Without a shared gate the two levels multiply and a 13k-file job would open
 * `fileConcurrency × EMBED_CONCURRENCY` requests against the embedding server —
 * defeating the one knob meant to bound it. The index job creates ONE
 * semaphore (`EMBED_CONCURRENCY` permits) and passes it to every file's embed
 * calls, so total in-flight requests stay at the configured bound while the
 * file pool keeps the queue full during chunking/DB writes.
 */
export function createSemaphore(limit: number): Semaphore {
  let available = Math.max(1, limit);
  const waiters: (() => void)[] = [];

  const acquire = (): Promise<void> => {
    if (available > 0) {
      available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else available++;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/**
 * Processes a list of tasks with bounded parallelism (concurrency pool).
 *
 * - At most `limit` `worker` calls over `items` run at the same time
 *   (to avoid overwhelming Ollama / the embedding server).
 * - Results are returned in **input order** (even if workers finish in a
 *   different order).
 * - If any worker throws, the first error propagates up (fail-fast).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  if (n === 0) return results;

  const concurrency = Math.max(1, Math.min(limit, n));
  let next = 0;
  let failed: unknown = null;

  async function runner(): Promise<void> {
    while (true) {
      if (failed !== null) return;
      const i = next++;
      if (i >= n) return;
      try {
        results[i] = await worker(items[i]!, i);
      } catch (err) {
        if (failed === null) failed = err;
        return;
      }
    }
  }

  const runners = Array.from({ length: concurrency }, () => runner());
  await Promise.all(runners);

  if (failed !== null) throw failed;
  return results;
}
