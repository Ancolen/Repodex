import { describe, test, expect } from "bun:test";
import { watchdogDecision, startLoopWatchdog, WATCHDOG_TICK_MS } from "../src/core/watchdog";
import { CONFIG } from "../src/config";

describe("watchdogDecision", () => {
  const base = { prev: 7, current: 7, stalledMs: 0, limitMs: 300_000, intervalMs: WATCHDOG_TICK_MS };

  test("a moving heartbeat clears the stall", () => {
    expect(watchdogDecision({ ...base, current: 8, stalledMs: 120_000 })).toEqual({ stalledMs: 0, kill: false });
  });

  test("a still heartbeat accumulates the sampling interval", () => {
    expect(watchdogDecision({ ...base, stalledMs: 5_000 })).toEqual({
      stalledMs: 5_000 + WATCHDOG_TICK_MS,
      kill: false,
    });
  });

  test("kills exactly when the accumulated stall reaches the limit", () => {
    const half = watchdogDecision({ ...base, stalledMs: base.limitMs - WATCHDOG_TICK_MS });
    expect(half.kill).toBe(true);
    const almost = watchdogDecision({ ...base, stalledMs: base.limitMs - WATCHDOG_TICK_MS * 2 });
    expect(almost.kill).toBe(false);
  });

  test("a zero (or negative) limit never kills — the watchdog is off", () => {
    expect(watchdogDecision({ ...base, limitMs: 0, stalledMs: 10_000_000 }).kill).toBe(false);
  });
});

describe("startLoopWatchdog", () => {
  test("a non-positive limit disables the watchdog", () => {
    expect(startLoopWatchdog(0)).toBeNull();
    expect(startLoopWatchdog(-1)).toBeNull();
  });

  test("a positive limit arms and stops cleanly", () => {
    const wd = startLoopWatchdog(5);
    expect(wd).not.toBeNull();
    wd!.stop();
  });
});

describe("config", () => {
  test("daemon.watchdogMinutes ships enabled with a minutes-scale default", () => {
    // Seconds would restart the daemon during a legitimately long native pass.
    expect(CONFIG.WATCHDOG_MINUTES).toBeGreaterThanOrEqual(1);
  });
});
