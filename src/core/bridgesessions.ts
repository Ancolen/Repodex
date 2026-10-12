/**
 * Bridge-session protocol and registry (proposal O4).
 *
 * The stdio bridge (`cidx mcp`) talks to the daemon over the Control API. When
 * the daemon runs with `daemon.idleTimeoutMinutes > 0`, an OPEN stdio MCP
 * session must count as activity — otherwise the daemon exits under a live
 * bridge and the bridge's auto-start fights it (a restart storm) on every
 * heartbeat.
 *
 * The daemon side is this in-memory registry (sessions are lost on restart,
 * which is fine: the bridge re-registers); the bridge side sends the three
 * requests built by the `*SessionRequest` helpers. All traffic is HTTP-side —
 * the bridge never mixes anything into its stdout JSON-RPC channel.
 */

import { randomUUID } from "node:crypto";

/** A session expires after this much silence (no heartbeat, no unregister). */
export const BRIDGE_SESSION_TTL_MS = 10 * 60_000;

/**
 * How often the bridge heartbeats. 30 s aligns with the daemon's decision tick
 * (IDLE_TICK_MS): after a daemon restart the first re-register lands within
 * 30 s of boot, strictly before the first shutdown-eligible idle tick even at
 * a 1-minute timeout — so an open session is never "invisible" to a fresh
 * daemon. It is also far inside BRIDGE_SESSION_TTL_MS, so a single missed
 * beat never expires a live session.
 */
export const BRIDGE_HEARTBEAT_MS = 30_000;

export interface BridgeSession {
  id: string;
  lastSeen: number;
}

/**
 * Pure expiry rule: expired when the session has been silent at least `ttl`
 * ms (inclusive boundary). A `lastSeen` in the future is never expired.
 */
export function isSessionExpired(
  lastSeen: number,
  now: number,
  ttl: number = BRIDGE_SESSION_TTL_MS,
): boolean {
  return now - lastSeen >= ttl;
}

/** Wire shape of the bridge-session requests the bridge sends to the Control API. */
export interface SessionRequest {
  method: "POST" | "DELETE";
  path: string;
}

/** POST /bridge-session — register; the daemon answers `{ sessionId }`. */
export function registerSessionRequest(): SessionRequest {
  return { method: "POST", path: "/bridge-session" };
}

/** POST /bridge-session/:id — heartbeat/touch `lastSeen`. */
export function heartbeatSessionRequest(id: string): SessionRequest {
  return { method: "POST", path: `/bridge-session/${encodeURIComponent(id)}` };
}

/** DELETE /bridge-session/:id — clean unregister (stdin close, signals). */
export function deleteSessionRequest(id: string): SessionRequest {
  return { method: "DELETE", path: `/bridge-session/${encodeURIComponent(id)}` };
}

export type SessionIdGen = () => string;

/**
 * Daemon-side session tracker. `now` is always an argument (injectable clock),
 * so expiry is testable without waiting; ids come from an injectable
 * generator (defaults to randomUUID) for deterministic tests.
 */
export class BridgeSessionRegistry {
  private sessions = new Map<string, BridgeSession>();

  constructor(private readonly newId: SessionIdGen = randomUUID) {}

  /** Registers a live session (pruning expired ones first); returns its id. */
  register(now: number): string {
    this.pruneExpired(now);
    const id = this.newId();
    this.sessions.set(id, { id, lastSeen: now });
    return id;
  }

  /**
   * Touches a session's `lastSeen`. Unknown or already-expired sessions are
   * removed and the touch is refused — the caller (the bridge) then
   * re-registers, which is how the daemon recovers from its own restart.
   */
  touch(id: string, now: number): boolean {
    const session = this.sessions.get(id);
    if (!session || isSessionExpired(session.lastSeen, now)) {
      if (session) this.sessions.delete(id);
      return false;
    }
    session.lastSeen = now;
    return true;
  }

  /** Removes a session (clean unregister); false when it was already gone. */
  remove(id: string): boolean {
    return this.sessions.delete(id);
  }

  /** Prunes expired sessions, then returns how many live ones remain. */
  activeCount(now: number): number {
    this.pruneExpired(now);
    return this.sessions.size;
  }

  /** Snapshot of the live sessions (post-prune), for tests and debugging. */
  list(now: number): BridgeSession[] {
    this.pruneExpired(now);
    return [...this.sessions.values()].map((s) => ({ id: s.id, lastSeen: s.lastSeen }));
  }

  private pruneExpired(now: number): void {
    for (const [id, session] of this.sessions) {
      if (isSessionExpired(session.lastSeen, now)) this.sessions.delete(id);
    }
  }
}