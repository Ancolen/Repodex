/**
 * systemd watchdog — the EXTERNAL half of the daemon health net.
 *
 * `watchdog.ts` arms an in-process Bun Worker that SIGKILLs the daemon when
 * the main loop stops beating. That covers a blocked main thread (a long native
 * call, a parked fs worker, microtask starvation): the worker lives on its own
 * OS thread and keeps ticking. It does NOT cover a runtime-wide deadlock that
 * also freezes the worker's thread. That happened in production on 2026-11-01:
 * the process stayed alive with both listeners bound, never accepted another
 * connection, every thread sat in `futex_do_wait` at 0 % CPU — and the
 * in-process watchdog produced no log line, so nothing ever restarted it.
 *
 * systemd's `WatchdogSec=` is immune to that class of failure because the
 * supervisor is a different process. The unit arms a timer at start; the
 * service must send `WATCHDOG=1` (sd_notify) before it expires, otherwise
 * systemd kills the unit and `Restart=on-failure` brings it back. The ping is
 * sent from a MAIN-LOOP timer, so a wedged loop stops pinging by construction.
 *
 * The notification is sent through `libsystemd.so.0` via `bun:ffi` — no extra
 * dependency, no child process. Everything is a no-op unless the process runs
 * under systemd AND the unit sets `WatchdogSec=` (systemd then exports
 * `NOTIFY_SOCKET` + `WATCHDOG_USEC`). The ping interval follows the documented
 * half-window rule, clamped to [1 s, 30 s]; the kill threshold stays whatever
 * the unit's `WatchdogSec=` says (the installers ship 300 s, matching
 * `daemon.watchdogMinutes`).
 */

import { dlopen } from "bun:ffi";

export interface SystemdWatchdogPlan {
  /** Milliseconds between WATCHDOG=1 pings. */
  pingMs: number;
  /** The unit's WatchdogSec, in seconds (for the log line). */
  watchdogSec: number;
}

/**
 * Decides whether the external watchdog is armed, and at what cadence. Pure.
 *
 * `NOTIFY_SOCKET` exists for every service the systemd user manager starts
 * (it is how sd_notify reaches systemd), so the presence of `WATCHDOG_USEC` is
 * the real signal: systemd only exports it when the unit sets `WatchdogSec=`.
 */
export function systemdWatchdogPlan(env: NodeJS.ProcessEnv): SystemdWatchdogPlan | null {
  if (!env.NOTIFY_SOCKET) return null;
  const raw = env.WATCHDOG_USEC;
  if (!raw) return null;
  const usec = Number(raw);
  if (!Number.isFinite(usec) || usec <= 0) return null;
  // Ping at half the window (systemd's documented convention), clamped so a
  // 5-minute WatchdogSec pings every 30 s and a tiny one still gets >= 1 s.
  const pingMs = Math.max(1_000, Math.min(Math.floor(usec / 2_000), 30_000));
  return { pingMs, watchdogSec: Math.round(usec / 1_000_000) };
}

/** The sd_notify entry point we need (`int sd_notify(int, const char *)`). */
type SdNotify = (state: string) => void;

interface SystemdWatchdog {
  stop(): void;
}

let cachedSdNotify: SdNotify | null | undefined;

/**
 * Resolves the real sd_notify (cached). The state string is passed as a
 * NUL-terminated buffer: Bun's FFI `ptr` argument takes a TypedArray, and
 * `cstring` does not accept a JS string in Bun 1.3.
 */
function realSdNotify(): SdNotify | null {
  if (cachedSdNotify !== undefined) return cachedSdNotify;
  try {
    const lib = dlopen("libsystemd.so.0", {
      sd_notify: { args: ["i32", "ptr"], returns: "i32" },
    });
    cachedSdNotify = (state: string): void => {
      try {
        lib.symbols.sd_notify(0, Buffer.from(`${state}\0`, "utf8"));
      } catch {
        // A failed notification must never take the daemon down; systemd's
        // watchdog will restart it if the silence is real.
      }
    };
  } catch (err) {
    console.error("[watchdog] libsystemd unavailable — external systemd watchdog disabled:", err);
    cachedSdNotify = null;
  }
  return cachedSdNotify;
}

/**
 * Arms the external watchdog. `notify` is injectable for tests; production
 * passes nothing and resolves libsystemd lazily. Returns null when the daemon
 * is not supervised with `WatchdogSec=`, so non-systemd installs are unchanged.
 */
export function startSystemdWatchdog(
  env: NodeJS.ProcessEnv = process.env,
  notify: SdNotify | null = null,
): SystemdWatchdog | null {
  const plan = systemdWatchdogPlan(env);
  if (!plan) return null;
  const send = notify ?? realSdNotify();
  if (!send) return null;
  send("READY=1");
  const timer = setInterval(() => send("WATCHDOG=1"), plan.pingMs);
  timer.unref?.();
  console.error(
    `[watchdog] systemd watchdog armed (ping every ${Math.round(plan.pingMs / 1000)}s; ` +
      `WatchdogSec=${plan.watchdogSec}s → the supervisor restarts a wedged loop)`,
  );
  return {
    stop(): void {
      clearInterval(timer);
      send("STOPPING=1");
    },
  };
}
