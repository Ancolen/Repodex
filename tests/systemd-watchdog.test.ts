/**
 * systemd watchdog (src/core/systemd-watchdog.ts) — the EXTERNAL half of the
 * O5 health net. libsystemd is not available on every platform, so the
 * sd_notify call itself is injected here; these tests cover the arming
 * decision (pure) and the READY/WATCHDOG/STOPPING sequence.
 */
import { describe, test, expect } from "bun:test";
import { systemdWatchdogPlan, startSystemdWatchdog } from "../src/core/systemd-watchdog";

const base = { NOTIFY_SOCKET: "/run/systemd/notify" };

describe("systemdWatchdogPlan", () => {
  test("not under systemd → null", () => {
    expect(systemdWatchdogPlan({})).toBeNull();
    expect(systemdWatchdogPlan({ WATCHDOG_USEC: "300000000" })).toBeNull();
  });

  test("WatchdogSec not set (no WATCHDOG_USEC) → null", () => {
    expect(systemdWatchdogPlan(base)).toBeNull();
  });

  test("malformed or non-positive WATCHDOG_USEC → null", () => {
    expect(systemdWatchdogPlan({ ...base, WATCHDOG_USEC: "soon" })).toBeNull();
    expect(systemdWatchdogPlan({ ...base, WATCHDOG_USEC: "0" })).toBeNull();
    expect(systemdWatchdogPlan({ ...base, WATCHDOG_USEC: "-5" })).toBeNull();
  });

  test("pings at half the watchdog window", () => {
    expect(systemdWatchdogPlan({ ...base, WATCHDOG_USEC: "60000000" })).toEqual({
      pingMs: 30_000,
      watchdogSec: 60,
    });
    expect(systemdWatchdogPlan({ ...base, WATCHDOG_USEC: "10000000" })).toEqual({
      pingMs: 5_000,
      watchdogSec: 10,
    });
  });

  test("clamps the cadence to [1 s, 30 s]", () => {
    expect(systemdWatchdogPlan({ ...base, WATCHDOG_USEC: "1000000" })).toEqual({
      pingMs: 1_000,
      watchdogSec: 1,
    });
    expect(systemdWatchdogPlan({ ...base, WATCHDOG_USEC: "3600000000" })).toEqual({
      pingMs: 30_000,
      watchdogSec: 3_600,
    });
  });
});

describe("startSystemdWatchdog", () => {
  test("does not arm without systemd supervision", () => {
    const sent: string[] = [];
    const wd = startSystemdWatchdog({}, (s) => {
      sent.push(s);
    });
    expect(wd).toBeNull();
    expect(sent).toEqual([]);
  });

  test("sends READY at arm time and STOPPING on stop", () => {
    const sent: string[] = [];
    const wd = startSystemdWatchdog({ ...base, WATCHDOG_USEC: "300000000" }, (s) => {
      sent.push(s);
    });
    expect(wd).not.toBeNull();
    expect(sent).toEqual(["READY=1"]);
    wd!.stop();
    expect(sent).toEqual(["READY=1", "STOPPING=1"]);
  });
});
