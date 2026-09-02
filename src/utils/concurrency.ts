/**
 * Processes a list of tasks with bounded parallelism (concurrency pool).
 *
 * - At most `limit` `worker` calls over `items` run at the same time
 *   (to avoid overwhelming Ollama / the embedding server).
 * - Results are returned in **input order** (even if workers finish in a
 *   different order).
 * - If any worker throws, the first error propagates up (fail-fast).
 *
 * Implements the "4-8 parallel embedding pipeline" that was designed but never
 * implemented in Phase 5.
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
