/**
 * Bridge-session protocol and registry (proposal O4) — pure logic from
 * src/core/bridgesessions.ts: the 10-minute silence TTL, the registry's
 * register/touch/remove bookkeeping, and the wire requests the stdio bridge
 * builds (method + path, no live daemon involved).
 */
import { describe, test, expect } from "bun:test";
import {
  BridgeSessionRegistry,
  BRIDGE_SESSION_TTL_MS,
  BRIDGE_HEARTBEAT_MS,
  isSessionExpired,
  registerSessionRequest,
  heartbeatSessionRequest,
  deleteSessionRequest,
} from "../src/core/bridgesessions";

describe("isSessionExpired — the 10-minute silence rule", () => {
  test("a live session is not expired one ms before the TTL", () => {
    expect(isSessionExpired(1_000, 1_000 + BRIDGE_SESSION_TTL_MS - 1)).toBe(false);
  });

  test("expired at exactly the TTL (inclusive boundary)", () => {
    expect(isSessionExpired(1_000, 1_000 + BRIDGE_SESSION_TTL_MS)).toBe(true);
  });

  test("well beyond the TTL is expired", () => {
    expect(isSessionExpired(1_000, 1_000 + BRIDGE_SESSION_TTL_MS * 5)).toBe(true);
  });

  test("a future lastSeen (clock skew) is never expired", () => {
    expect(isSessionExpired(2_000, 1_000)).toBe(false);
  });

  test("a custom TTL is honored", () => {
    expect(isSessionExpired(1_000, 1_000 + 5_000, 10_000)).toBe(false);
    expect(isSessionExpired(1_000, 1_000 + 10_000, 10_000)).toBe(true);
  });

  test("the heartbeat interval is safely inside the TTL", () => {
    expect(BRIDGE_HEARTBEAT_MS).toBeLessThan(BRIDGE_SESSION_TTL_MS / 5);
  });
});

describe("bridge-session request construction (no live daemon)", () => {
  test("register is POST /bridge-session", () => {
    expect(registerSessionRequest()).toEqual({ method: "POST", path: "/bridge-session" });
  });

  test("heartbeat is POST /bridge-session/:id with the id encoded", () => {
    expect(heartbeatSessionRequest("abc-123")).toEqual({
      method: "POST",
      path: "/bridge-session/abc-123",
    });
    const req = heartbeatSessionRequest("a/b?c#d e");
    expect(req.path).toBe("/bridge-session/a%2Fb%3Fc%23d%20e");
  });

  test("unregister is DELETE /bridge-session/:id with the id encoded", () => {
    expect(deleteSessionRequest("xyz")).toEqual({ method: "DELETE", path: "/bridge-session/xyz" });
    expect(deleteSessionRequest("w/1").path).toBe("/bridge-session/w%2F1");
  });
});

describe("BridgeSessionRegistry", () => {
  /** Deterministic id generator: s1, s2, s3... */
  const counterGen = (): (() => string) => {
    let n = 0;
    return () => `s${++n}`;
  };

  test("register adds a live session and returns its id", () => {
    const r = new BridgeSessionRegistry(counterGen());
    const id = r.register(1_000);
    expect(id).toBe("s1");
    expect(r.activeCount(1_000)).toBe(1);
    expect(r.list(1_000)).toEqual([{ id: "s1", lastSeen: 1_000 }]);
  });

  test("touch refreshes lastSeen, extending the session's life", () => {
    const r = new BridgeSessionRegistry(counterGen());
    const id = r.register(0);
    // 9 minutes pass, then a heartbeat:
    r.touch(id, 9 * 60_000);
    // 14 minutes in — 9 past the ORIGINAL TTL, but only 5 past the touch.
    expect(r.activeCount(14 * 60_000)).toBe(1);
  });

  test("touch of an unknown id is refused", () => {
    const r = new BridgeSessionRegistry(counterGen());
    expect(r.touch("nope", 0)).toBe(false);
  });

  test("touch of an already-expired session is refused and prunes it", () => {
    const r = new BridgeSessionRegistry(counterGen());
    const id = r.register(0);
    // Registered at 0, TTL 10 min: at 11 min the touch is refused.
    expect(r.touch(id, 11 * 60_000)).toBe(false);
    expect(r.activeCount(11 * 60_000)).toBe(0);
  });

  test("activeCount prunes expired sessions and only counts live ones", () => {
    const r = new BridgeSessionRegistry(counterGen());
    r.register(0);
    r.register(6 * 60_000);
    // Both silent at 20 min → both expired.
    expect(r.activeCount(20 * 60_000)).toBe(0);
    expect(r.list(20 * 60_000)).toEqual([]);
  });

  test("partial expiry: only the silent session is pruned", () => {
    const r = new BridgeSessionRegistry(counterGen());
    const stale = r.register(0);
    const fresh = r.register(9 * 60_000);
    // Heartbeat keeps `fresh` alive through the stale one's death.
    r.touch(fresh, 15 * 60_000);
    expect(r.activeCount(16 * 60_000)).toBe(1);
    expect(r.list(16 * 60_000)).toEqual([{ id: fresh, lastSeen: 15 * 60_000 }]);
    expect(r.list(16 * 60_000).some((s) => s.id === stale)).toBe(false);
  });

  test("register prunes expired sessions first (no unbounded growth)", () => {
    const r = new BridgeSessionRegistry(counterGen());
    r.register(0);
    r.register(0);
    const id = r.register(12 * 60_000);
    expect(r.activeCount(12 * 60_000)).toBe(1);
    expect(r.list(12 * 60_000)).toEqual([{ id, lastSeen: 12 * 60_000 }]);
  });

  test("remove unregisters; removing twice is a no-op returning false", () => {
    const r = new BridgeSessionRegistry(counterGen());
    const id = r.register(0);
    expect(r.remove(id)).toBe(true);
    expect(r.remove(id)).toBe(false);
    expect(r.activeCount(0)).toBe(0);
  });

  test("the default id generator yields distinct non-empty ids", () => {
    const r = new BridgeSessionRegistry();
    const a = r.register(0);
    const b = r.register(0);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  test("an open session reads as nonzero openBridgeSessions for the idle gate", () => {
    // The contract index.ts relies on: activeCount(now) > 0 while a bridge is
    // registered and heartbeating.
    const r = new BridgeSessionRegistry();
    const id = r.register(50_000);
    expect(r.activeCount(50_000 + 60_000 * 5)).toBe(1); // + 5 min: still live
    r.remove(id);
    expect(r.activeCount(50_000 + 60_000 * 5)).toBe(0);
  });
});