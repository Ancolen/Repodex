/**
 * Event-loop watchdog (proposal O5).
 *
 * The daemon is single-threaded: every request — `/ping` included — is served
 * by the same loop that runs indexing and the report passes. When that loop
 * wedges (a blocked native call, a microtask-starvation chain, a stuck lock),
 * the process stays alive and keeps its listening sockets, so the supervisor
 * sees a healthy service while every client times out. That is exactly how the
 * daemon once sat unresponsive for 27 hours with no log line: `Restart=on-failure`
 * never fired because the process never died.
 *
 * Nothing inside the loop can detect that state — a timer cannot fire while the
 * loop is stuck. The heartbeat therefore has two halves:
 *
 * - the MAIN thread bumps a counter in shared memory on a timer (`startLoopWatchdog`),
 * - a WORKER thread (its own OS thread) checks that counter and, when it has not
 *   moved for `daemon.watchdogMinutes`, logs and SIGKILLs the process.
 *
 * SIGKILL, not SIGTERM: a wedged loop cannot run a signal handler either, so a
 * graceful signal would change nothing. `Restart=on-failure` (or any supervisor)
 * then brings the daemon back with a clean state, and the journal carries the
 * reason. A legitimately long synchronous pass (a multi-minute ANN build on a
 * huge table) is why the threshold is minutes, not seconds — see the config
 * default.
 */

/** How often the watchdog thread samples the heartbeat. */
export const WATCHDOG_TICK_MS = 1_000;

export interface WatchdogSample {
  /** Beat value seen on the previous tick. */
  prev: number;
  /** Beat value seen now. */
  current: number;
  /** Consecutive stalled milliseconds accumulated so far (before this tick). */
  stalledMs: number;
  /** Threshold from `daemon.watchdogMinutes`. */
  limitMs: number;
  /** This tick's sampling interval. */
  intervalMs: number;
}

export interface WatchdogVerdict {
  /** Stalled time to carry into the next tick. */
  stalledMs: number;
  /** True when the stall crossed the limit — the caller kills the process. */
  kill: boolean;
}

/**
 * Pure decision: did the heartbeat move, and how long has it been still?
 * (Kept separate from the thread so the rule is unit-testable — the same split
 * `idle.ts` uses for idle shutdown.)
 */
export function watchdogDecision(sample: WatchdogSample): WatchdogVerdict {
  if (sample.current !== sample.prev) return { stalledMs: 0, kill: false };
  const stalledMs = sample.stalledMs + sample.intervalMs;
  return { stalledMs, kill: sample.limitMs > 0 && stalledMs >= sample.limitMs };
}

/** How often the MAIN thread bumps the heartbeat (a timer that can't fire while wedged). */
export const HEARTBEAT_INTERVAL_MS = 1_000;

export interface LoopWatchdog {
  /** Stops the heartbeat and the watchdog thread (daemon shutdown). */
  stop(): void;
}

/**
 * Arms the heartbeat + watchdog thread. `limitMinutes <= 0` disables it and
 * returns `null` (the default in the shipped config template keeps it on —
 * see `daemon.watchdogMinutes`).
 *
 * Failure to start the thread is not fatal: the daemon logs and keeps running
 * without protection rather than refusing to boot on an environment where a
 * `Worker` cannot be spawned.
 */
export function startLoopWatchdog(limitMinutes: number): LoopWatchdog | null {
  const limitMs = limitMinutes * 60_000;
  if (!(limitMs > 0)) return null;

  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counter = new Int32Array(buffer);
  const heartbeat = setInterval(() => {
    Atomics.add(counter, 0, 1);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  let thread: Worker;
  const sourceUrl = URL.createObjectURL(new Blob([watchdogThreadSource()], { type: "text/javascript" }));
  try {
    thread = new Worker(sourceUrl);
  } catch (err) {
    clearInterval(heartbeat);
    console.error("[watchdog] could not start the watchdog thread — running without it:", err);
    return null;
  }
  thread.onerror = (err: unknown): void => {
    console.error("[watchdog] watchdog thread failed — running without it:", err);
  };
  thread.unref?.();
  thread.postMessage({ buffer, intervalMs: WATCHDOG_TICK_MS, limitMs });
  return {
    stop(): void {
      clearInterval(heartbeat);
      thread.terminate();
      URL.revokeObjectURL(sourceUrl);
    },
  };
}

/**
 * The watchdog thread's source, as a Blob.
 *
 * It is a string rather than a `new Worker("./watchdog-thread.ts")` reference
 * because `bun build --compile` does not embed a file-referenced worker: in the
 * single binary that worker fails with
 * `ModuleNotFound resolving "/$bunfs/root/watchdog-thread.ts"`, which would
 * leave release installs silently unprotected. A Blob URL is created from this
 * string at runtime and needs no module resolution, so dev and compiled builds
 * run the identical thread.
 *
 * The stall rule is NOT duplicated here: `watchdogDecision`'s own source is
 * interpolated, so the unit-tested function is the one the thread runs.
 */
function watchdogThreadSource(): string {
  return `
let counter = null;
let intervalMs = ${WATCHDOG_TICK_MS};
let limitMs = 0;
let prev = 0;
let stalledMs = 0;
const watchdogDecision = ${watchdogDecision.toString()};

self.onmessage = function (event) {
  const init = event.data;
  if (!init || !(init.buffer instanceof SharedArrayBuffer)) return;
  counter = new Int32Array(init.buffer);
  if (init.intervalMs > 0) intervalMs = init.intervalMs;
  limitMs = init.limitMs;
  prev = Atomics.load(counter, 0);
  setInterval(tick, intervalMs);
};

function tick() {
  if (counter === null) return;
  const current = Atomics.load(counter, 0);
  const verdict = watchdogDecision({ prev, current, stalledMs, limitMs, intervalMs });
  stalledMs = verdict.stalledMs;
  if (current !== prev) {
    prev = current;
    return;
  }
  if (!verdict.kill) return;
  console.error(
    "[watchdog] event loop has not beaten for " + Math.round(stalledMs / 1000) + "s (limit " +
      Math.round(limitMs / 1000) + "s) — exiting so the supervisor can restart the daemon",
  );
  // A wedged loop cannot run a signal handler; SIGKILL leaves the supervisor to
  // restart us with a clean state.
  process.kill(process.pid, "SIGKILL");
}
`;
}
