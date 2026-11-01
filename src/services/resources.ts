/**
 * Process resource usage for `cidx doctor` (the watcher fd budget).
 *
 * This exists because of a measured Bun behaviour: `fs.watch` holds one open
 * descriptor per watched path — and watching a directory opens every direct
 * child, so a project tree costs roughly one fd per file under it (see
 * `watcher.ts`). 13k watched files = 13k fds, which is harmless under a high
 * `LimitNOFILE` but fatal under a low one; the same trees also consume one
 * inotify watch each (`fs.inotify.max_user_watches`). Doctor reports both so
 * the limit is visible before the watcher starts failing.
 *
 * Linux-only (procfs); every read failure degrades to `null` and is never an
 * error — a diagnostic must not fail because a counter is unavailable.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface ProcessResources {
  /** Soft RLIMIT_NOFILE (`Max open files` first column), null when unreadable. */
  fdLimit: number | null;
  /** This process's open descriptors. */
  openFds: number | null;
  /** `fs.inotify.max_user_watches` (systemd-wide), null when unreadable. */
  inotifyLimit: number | null;
  /** inotify watches held by this process. */
  inotifyWatches: number | null;
}

/** Reads the live counters; no throwing, no side effects beyond procfs reads. */
export function measureProcessResources(): ProcessResources {
  const out: ProcessResources = {
    fdLimit: null,
    openFds: null,
    inotifyLimit: null,
    inotifyWatches: null,
  };

  try {
    const limits = readFileSync("/proc/self/limits", "utf-8");
    const line = limits.split("\n").find((l) => l.startsWith("Max open files"));
    if (line) {
      const soft = Number(line.slice("Max open files".length).trim().split(/\s+/)[0]);
      if (Number.isFinite(soft) && soft > 0) out.fdLimit = soft;
    }
  } catch {
    // non-Linux / restricted procfs
  }

  try {
    const fds = readdirSync("/proc/self/fd");
    out.openFds = fds.length;
    // Count watches only on inotify descriptors; reading fdinfo for every fd
    // would be needless syscalls on a process that may hold tens of thousands.
    let watches = 0;
    for (const fd of fds) {
      try {
        if (!readlinkSync(`/proc/self/fd/${fd}`).startsWith("anon_inode:inotify")) continue;
        const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf-8");
        for (const line2 of info.split("\n")) {
          if (line2.startsWith("inotify wd:")) watches++;
        }
      } catch {
        // fd closed between readdir and readlink
      }
    }
    out.inotifyWatches = watches;
  } catch {
    // non-Linux / restricted procfs
  }

  try {
    const n = Number(readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf-8").trim());
    if (Number.isFinite(n) && n > 0) out.inotifyLimit = n;
  } catch {
    // non-Linux / restricted procfs
  }

  return out;
}
