/**
 * Idle shutdown decision (proposal O4) — pure logic from src/core/idle.ts.
 *
 * Every guardrail is exercised: disabled, busy queue, restoring phase, open
 * MCP sessions, and the inclusive idle>=timeout boundary of the armed path.
 */
import { describe, test, expect } from "bun:test";
import { shouldIdleShutdown, idleMinutes, IDLE_TICK_MS } from "../src/core/idle";

/** A fully-idle, armed baseline: nothing active, idle exactly 10 minutes. */
function baseInput(overrides: Partial<Parameters<typeof shouldIdleShutdown>[0]> = {}) {
  const now = 10_000_000;
  return {
    now,
    lastActivityAt: now - 10 * 60_000,
    timeoutMinutes: 30,
    activeJobs: 0,
    openBridgeSessions: 0,
    restoring: false,
    ...overrides,
  };
}

describe("shouldIdleShutdown — disabled", () => {
  test("timeoutMinutes = 0 (the default) never shuts down, however long the idle", () => {
    const input = baseInput({ timeoutMinutes: 0, lastActivityAt: baseInput().now - 500 * 60_000 });
    expect(shouldIdleShutdown(input).shutdown).toBe(false);
  });

  test("a negative timeout is the same opt-out as 0", () => {
    expect(shouldIdleShutdown(baseInput({ timeoutMinutes: -99 })).shutdown).toBe(false);
  });
});

describe("shouldIdleShutdown — guardrails (never idle out while in use)", () => {
  test("a queued or running job blocks shutdown", () => {
    const input = baseInput({ lastActivityAt: baseInput().now - 999 * 60_000, activeJobs: 1 });
    expect(shouldIdleShutdown(input).shutdown).toBe(false);
    expect(shouldIdleShutdown(baseInput({ activeJobs: 3 })).shutdown).toBe(false);
  });

  test("the boot-time restore() phase blocks shutdown", () => {
    expect(shouldIdleShutdown(baseInput({ restoring: true })).shutdown).toBe(false);
  });

  test("an open bridge session blocks shutdown", () => {
    const input = baseInput({ lastActivityAt: baseInput().now - 999 * 60_000, openBridgeSessions: 1 });
    expect(shouldIdleShutdown(input).shutdown).toBe(false);
    expect(shouldIdleShutdown(baseInput({ openBridgeSessions: 5 })).shutdown).toBe(false);
  });

  test("restoring wins over every other field combination (no shutdown while booting)", () => {
    const input = baseInput({
      restoring: true,
      activeJobs: 2,
      openBridgeSessions: 2,
      lastActivityAt: baseInput().now - 999 * 60_000,
    });
    const decision = shouldIdleShutdown(input);
    expect(decision.shutdown).toBe(false);
    expect(decision.reason).toBeUndefined();
  });

  test("an open session blocks shutdown even when the idle window long passed", () => {
    const decision = shouldIdleShutdown(
      baseInput({ timeoutMinutes: 1, lastActivityAt: baseInput().now - 120 * 60_000, openBridgeSessions: 1 }),
    );
    expect(decision.shutdown).toBe(false);
  });
});

describe("shouldIdleShutdown — armed and idle", () => {
  test("idle clearly below the timeout → keep running", () => {
    const input = baseInput({ lastActivityAt: baseInput().now - 5 * 60_000 });
    expect(shouldIdleShutdown(input)).toEqual({ shutdown: false });
  });

  test("one second below the boundary → keep running", () => {
    const input = baseInput({ lastActivityAt: baseInput().now - (30 * 60_000 - 1000) });
    expect(shouldIdleShutdown(input).shutdown).toBe(false);
  });

  test("idle exactly at the timeout (inclusive boundary) → shutdown with a reason", () => {
    const input = baseInput({ lastActivityAt: baseInput().now - 30 * 60_000 });
    const decision = shouldIdleShutdown(input);
    expect(decision.shutdown).toBe(true);
    expect(decision.reason).toContain("idle shutdown after 30 minutes");
    expect(decision.reason).toContain("daemon.idleTimeoutMinutes=30");
  });

  test("idle beyond the timeout → shutdown; the reason names the real idle minutes", () => {
    const decision = shouldIdleShutdown(baseInput({ lastActivityAt: baseInput().now - 90 * 60_000 }));
    expect(decision.shutdown).toBe(true);
    expect(decision.reason).toBe(
      "idle shutdown after 90 minutes (daemon.idleTimeoutMinutes=30)",
    );
  });

  test("the reason formats fractional minutes without float noise", () => {
    const decision = shouldIdleShutdown(baseInput({ lastActivityAt: baseInput().now - 30.5 * 60_000 }));
    expect(decision.reason).toContain("idle shutdown after 30.5 minutes");
  });

  test("an activity in the future (clock skew) clamps to 0 idle minutes", () => {
    const decision = shouldIdleShutdown({ ...baseInput(), lastActivityAt: baseInput().now + 5 * 60_000 });
    expect(decision.shutdown).toBe(false);
  });
});

describe("idleMinutes / tick", () => {
  test("conversion is minutes of ms; negatives clamp to 0", () => {
    expect(idleMinutes(1_000_000, 1_000_000 - 2 * 60_000)).toBe(2);
    expect(idleMinutes(1_000_000, 1_000_000 + 60_000)).toBe(0);
    expect(idleMinutes(0, 0)).toBe(0);
  });

  test("the armed tick is 30 s (proposal O4)", () => {
    expect(IDLE_TICK_MS).toBe(30_000);
  });
});