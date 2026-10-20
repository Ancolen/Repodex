/**
 * Liveness probing for the daemon's Control API, shared by the CLI and the
 * stdio bridge.
 *
 * A `/ping` timeout is NOT proof the daemon is down. The daemon is
 * single-threaded, and the report tools (`check_docs`, `find_dead_code`,
 * `get_hotspots`, …) run multi-second synchronous CPU passes. While such a
 * pass runs the event loop is blocked: every request — `/ping` included —
 * simply queues and is answered when the pass finishes. Calling that "not
 * running" (or spawning a second daemon against the first one's port) is
 * wrong. So the probe classifies three states:
 *
 *   up    — `/ping` answered: fully responsive.
 *   busy  — the control port ACCEPTS TCP connections, but `/ping` did not
 *           answer within the probe timeout: the process is alive and its
 *           event loop is occupied. Callers should let their real request
 *           queue (it will be answered when the pass finishes) and must not
 *           spawn another daemon.
 *   down  — nothing is listening: there is no daemon process.
 */
import { connect } from "node:net";

export type DaemonState = "up" | "busy" | "down";

export interface DaemonTarget {
  /** Base URL of the Control API, e.g. `http://127.0.0.1:9372`. */
  base: string;
  host: string;
  port: number;
}

/** Default `/ping` patience. Anything longer than this reads as "busy". */
export const DAEMON_PING_TIMEOUT_MS = 1000;

/** A single `/ping`; false on timeout or connection failure. */
export async function pingControl(
  base: string,
  timeoutMs: number = DAEMON_PING_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const r = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/** TCP-level probe: is something accepting connections on host:port? */
export function portAccepts(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (inUse: boolean): void => {
      sock.destroy();
      resolve(inUse);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Classifies the daemon in one shot (one `/ping` attempt plus, on failure, one
 * TCP probe of the control port).
 */
export async function probeDaemon(
  target: DaemonTarget,
  opts: { pingTimeoutMs?: number } = {},
): Promise<DaemonState> {
  if (await pingControl(target.base, opts.pingTimeoutMs ?? DAEMON_PING_TIMEOUT_MS)) return "up";
  if (await portAccepts(target.host, target.port)) return "busy";
  return "down";
}
