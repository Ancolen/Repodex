/**
 * Daemon idle shutdown (proposal O4) — pure decision logic.
 *
 * The daemon (src/index.ts) arms a 30 s interval ONLY when
 * `daemon.idleTimeoutMinutes > 0` and evaluates `shouldIdleShutdown` each tick.
 * Everything time-dependent is injected, so the decision is testable without a
 * live daemon.
 *
 * Guardrails — the daemon must NEVER idle out while it is demonstrably in use:
 *   - jobs queued or running (JobQueue.activeJobCount()),
 *   - the boot-time restore() phase,
 *   - an open MCP session (stdio-bridge heartbeats + open legacy SSE
 *     transports; the call site sums them into `openBridgeSessions`).
 * Any control-API or MCP HTTP request bumps the activity timestamp at the
 * servers' central entry point, so ordinary traffic keeps the daemon alive.
 */

/** How often the daemon re-evaluates the idle decision (only when armed). */
export const IDLE_TICK_MS = 30_000;

const MS_PER_MINUTE = 60_000;

export interface IdleInput {
  /** Current time (ms). */
  now: number;
  /** Timestamp of the last observed activity (request, job enqueue/finish). */
  lastActivityAt: number;
  /** `daemon.idleTimeoutMinutes`; <= 0 disables idle shutdown entirely. */
  timeoutMinutes: number;
  /** Jobs currently queued or running. */
  activeJobs: number;
  /** Open MCP sessions (bridge heartbeats + open legacy SSE transports). */
  openBridgeSessions: number;
  /** True while the boot-time restore() phase runs. */
  restoring?: boolean;
}

export interface IdleDecision {
  shutdown: boolean;
  reason?: string;
}

/** Idle duration in (fractional) minutes; negative clock values clamp to 0. */
export function idleMinutes(now: number, lastActivityAt: number): number {
  return Math.max(0, (now - lastActivityAt) / MS_PER_MINUTE);
}

/** "61.5"/"62" — no float noise in the reason line. */
function formatMinutes(minutes: number): string {
  const rounded = Math.round(minutes * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * The pure idle-shutdown decision. Disabled (`timeoutMinutes <= 0`) or any
 * guardrail active → keep running; otherwise the idle window is compared to
 * the timeout (inclusive boundary: idle >= timeout → shut down).
 */
export function shouldIdleShutdown(input: IdleInput): IdleDecision {
  if (input.timeoutMinutes <= 0) return { shutdown: false };
  if (input.restoring === true) return { shutdown: false };
  if (input.activeJobs > 0) return { shutdown: false };
  if (input.openBridgeSessions > 0) return { shutdown: false };
  const idle = idleMinutes(input.now, input.lastActivityAt);
  if (idle >= input.timeoutMinutes) {
    return {
      shutdown: true,
      reason: `idle shutdown after ${formatMinutes(idle)} minutes (daemon.idleTimeoutMinutes=${input.timeoutMinutes})`,
    };
  }
  return { shutdown: false };
}