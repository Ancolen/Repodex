/**
 * Cooperative scheduling for CPU-bound pure passes.
 *
 * The daemon is single-threaded: an async function that runs a tight scan loop
 * without yielding owns the event loop, so HTTP/MCP requests queue behind it —
 * `/ping` included. These helpers let such a pass split its work into ~15 ms
 * slices and hand the loop back between slices, so other requests are served
 * while the pass continues. The result is unchanged; only latency is
 * interleaved.
 *
 * `setImmediate` is deliberate: its callbacks run in the check phase after I/O
 * callbacks, which is exactly what a queued HTTP request needs (a timer would
 * add up to a millisecond of granularity per slice for no benefit).
 */
export const COOPERATIVE_SLICE_MS = 15;

export interface SliceClock {
  last: number;
}

/** A fresh clock, started now. */
export function sliceClock(): SliceClock {
  return { last: performance.now() };
}

/** Hands the event loop back; resumes on the next check-phase turn. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Yields when the current slice has run for `sliceMs` (default 15). Call it
 * once per unit of work (a chunk, a file) — cheap enough to call every
 * iteration: the `performance.now()` check is the only cost until a yield is
 * actually due.
 */
export async function yieldIfExpired(
  clock: SliceClock,
  sliceMs: number = COOPERATIVE_SLICE_MS,
): Promise<void> {
  if (performance.now() - clock.last < sliceMs) return;
  await yieldToEventLoop();
  clock.last = performance.now();
}
