import chokidar, { type FSWatcher } from "chokidar";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CONFIG } from "../config";
import { buildIgnoreSync, isAllowedFile, isPathIgnored, indexFile, removeFileIndex, effectiveMaxFileSizeBytes, type IndexTarget } from "./indexer";
import { readProjectConfig, extToLanguage, languageAllowSet } from "../core/project-config";
import { resolveFraming } from "../core/framing";
import { tableNameFor } from "../core/registry";
import type { Registry } from "../core/registry";

export interface WatchOptions {
  registry?: Registry | undefined;
  debounceMs?: number | undefined;
  /**
   * If it returns true, the watcher does not write/delete files at that moment;
   * the event is rescheduled. Prevents conflicting writes to the same table
   * while a full index/sync is running (race avoidance).
   */
  isBusy?: (() => boolean) | undefined;
  /**
   * Called after a per-file write/removal settles (success OR failure). The
   * manager uses it to reconcile the registry's file/chunk counters, which the
   * watcher's table writes would otherwise leave stale.
   */
  onFileSettled?: (() => void) | undefined;
}

type PendingAction = "index" | "remove";

/**
 * Watches a directory and reindexes changes (debounced).
 * - Consecutive save events for the same file are batched into one.
 * - While a full index/sync is running (isBusy), events are deferred; this way
 *   the background job and the watcher do not write to the same LanceDB table
 *   concurrently.
 * - RESPECTS .gitignore/.cidxignore/global ignore rules: to stay consistent with
 *   full indexing, ignored files are not indexed (and are cleaned up if they were
 *   indexed before). The chokidar-level `ignored` predicate applies the same
 *   rules plus the extension allowlist, so ignored trees (`.venv`, `target`, …)
 *   and unindexable files get no watch handle at all. Rules are read once at
 *   watcher startup; if they change, the next full reindex/sync reflects them.
 */
export function startWatcher(target: IndexTarget, opts: WatchOptions = {}): FSWatcher {
  const debounceMs = opts.debounceMs ?? CONFIG.WATCH_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // The ignore matcher must exist BEFORE chokidar's first traversal: chokidar
  // opens a watch handle per accepted file, so filtering only at event time
  // (the old behavior) still watched every file in ignored trees — e.g. a
  // Python `.venv` with ~75k files held ~75k fds. Same sources/precedence as
  // the full index (`buildIgnore`); rules are read once at startup, matching
  // the `.cidxignore` semantics documented below.
  const startupConfig = readProjectConfig(target.baseDir);
  const ig = buildIgnoreSync(target.baseDir, startupConfig?.ignore);

  // Cached per watcher: chokidar asks about each directory repeatedly. A full
  // readdir pass per directory is acceptable — the initial crawl reads them all
  // anyway, and this is the only place that can keep Bun's `fs.watch` away from
  // an un-openable child (see `dirHasUnwatchableChild`).
  const unwatchableDirCache = new Map<string, boolean>();

  /**
   * True when the directory directly contains an entry Bun's `fs.watch` cannot
   * safely open: a FIFO, socket or device node (or a symlink to one).
   *
   * Bun 1.3's `fs.watch(dir)` walks the directory and `open()`s every direct
   * child to attach its inotify handle. `open()` on a FIFO blocks until a
   * writer appears, so one such child parks an fs worker forever; once enough
   * are parked, the NEXT fs call blocks the event loop itself (the main thread
   * sits in `futex_do_wait` and no timer fires — the daemon hangs, keeps its
   * sockets shut, and a supervisor's event-loop watchdog kills it in a loop).
   *
   * Chokidar hands no watch handle to an ignored path, so rejecting the PARENT
   * directory keeps `fs.watch` away from it entirely; the child-level rule in
   * the `ignored` predicate only prevents a direct watch on the FIFO, which is
   * not where Bun blocks. Only the watcher is affected — the indexer walks the
   * tree on its own and already skips non-regular entries (`entry.isFile()`),
   * so nothing indexable is lost.
   */
  const dirHasUnwatchableChild = (dirPath: string): boolean => {
    const cached = unwatchableDirCache.get(dirPath);
    if (cached !== undefined) return cached;
    let unwatchable = false;
    try {
      for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.isFile() || entry.isDirectory()) continue;
        if (entry.isSymbolicLink()) {
          // A symlink is opened through to its target — only a link to a
          // non-regular file can block. A dangling link fails fast (ENOENT).
          try {
            const target = statSync(path.join(dirPath, entry.name));
            if (target.isFile() || target.isDirectory()) continue;
          } catch {
            continue;
          }
          unwatchable = true;
          break;
        }
        unwatchable = true; // FIFO / socket / block or char device
        break;
      }
    } catch {
      // Unreadable directory: nothing to protect, let chokidar decide.
      unwatchable = false;
    }
    unwatchableDirCache.set(dirPath, unwatchable);
    return unwatchable;
  };

  const watcher = chokidar.watch(target.baseDir, {
    // Files the indexer would never read get no watch handle (the extension
    // rule); directories stay traversable. `stats` is provided by chokidar's
    // matcher (see chokidar's docs); when absent, only ignore rules apply.
    //
    // NON-REGULAR entries (FIFO, socket, device) must be rejected here, not
    // just filtered at event time: chokidar opens a watch handle per accepted
    // path. A probe run directory full of `host-stdin.fifo`
    // (logs/second-screen-probe/runs/*) did exactly that: the daemon hung at
    // startup right after restoring watchers, never opened its servers, and
    // the event-loop watchdog kept SIGKILLing it every 5 minutes. The indexer
    // already skips these (`entry.isFile()` in collectFiles), so nothing
    // indexable is lost.
    ignored: (p: string, stats?: { isFile(): boolean; isDirectory(): boolean }) =>
      isPathIgnored(ig, target.baseDir, p) ||
      (stats !== undefined && !stats.isFile() && !stats.isDirectory()) ||
      (stats?.isDirectory() === true && dirHasUnwatchableChild(p)) ||
      (stats?.isFile() === true && !isAllowedFile(p)),
    persistent: true,
    ignoreInitial: true,
    // Properly handle editors' atomic saves (write to temp file then rename).
    atomic: true,
    // Wait until the file write finishes: prevents indexing half-written content
    // and collapses large file copies into a single event (including rename/move).
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  /** The event's target with the record's CURRENT table name (an O2 migration swaps it). */
  const targetNow = (rec: { name: string; tableName: string } | null): IndexTarget =>
    rec ? { ...target, tableName: tableNameFor(rec) } : target;

  const fire = async (filePath: string, action: PendingAction): Promise<void> => {
    try {
      // Per-project config is read fresh per event so watcher writes follow the
      // same rules as the next full index (`.cidx.json` `languages` allowlist +
      // `embedModel` override + `maxFileSizeBytes`; extra `ignore` patterns still
      // come from the startup matcher, matching the .cidxignore semantics above).
      const pcfg = readProjectConfig(target.baseDir);
      const langSet = languageAllowSet(pcfg);
      const lang = extToLanguage(path.extname(filePath));
      // The record is read once per event: it drives both the model-mismatch
      // rule and the current table name (which the O2 migration legitimately
      // swaps mid-flight — the watcher's captured target must not keep writing
      // into a table the registry abandoned).
      const rec = opts.registry ? opts.registry.getIndex(target.indexName) : null;
      if (isPathIgnored(ig, target.baseDir, filePath) || (langSet !== null && (!lang || !langSet.has(lang)))) {
        // Ignored/filtered file: do not index. If it was indexed before (a rule
        // started covering it later), remove it from the table → stays
        // consistent with full indexing.
        await removeFileIndex(targetNow(rec), filePath, opts.registry);
        return;
      }
      // A changed per-project embedding model must not mix vectors from two
      // models into one table: skip writes until the project is reindexed.
      if (pcfg?.embedModel && rec?.embedModel && rec.embedModel !== pcfg.embedModel) {
        console.error(
          `[watcher] '${target.indexName}' .cidx.json embedModel changed (${rec.embedModel} → ${pcfg.embedModel}); ` +
            `skipping '${filePath}'. Reindex to apply.`,
        );
        return;
      }
      // A framing divergence — a per-project `.cidx.json` `framing` edit OR a
      // changed global `embedding.framing` default resolving differently from
      // the record's pin — must not mix framed and unframed vectors either:
      // skip writes until the next sync migrates/reindexes the project
      // (exactly the model-mismatch rule above). Unlike that rule this is not
      // gated on the override being present: a global-default change must not
      // silently write framed vectors into an unframed table.
      const intendedFraming = resolveFraming(
        pcfg?.framing ?? CONFIG.EMBEDDING_FRAMING,
        pcfg?.embedModel ?? rec?.embedModel ?? CONFIG.OLLAMA_MODEL,
      );
      if (rec && intendedFraming !== (rec.framing ?? null)) {
        console.error(
          `[watcher] '${target.indexName}' embedding framing changed (${rec.framing ?? "none"} → ` +
            `${intendedFraming ?? "none"}); skipping '${filePath}'. Sync to re-apply.`,
        );
        return;
      }
      if (action === "index") {
        // Framing: the RECORD's pin — here it always equals the intended value
        // (the check above just skipped any divergence), and the pin is what
        // the table's vectors were framed with. The maxFileSizeBytes guard
        // lives inside indexFile (skip before chunking, logged there at the
        // same level as the other skips); a file that grew past the limit stays
        // out of the table this way, and the next sync prunes any records it
        // had (it is then absent from collectFiles, mirroring the `languages`
        // semantics).
        await indexFile(
          targetNow(rec),
          filePath,
          opts.registry,
          undefined,
          pcfg?.embedModel,
          rec?.framing ?? null,
          effectiveMaxFileSizeBytes(pcfg),
        );
      } else {
        await removeFileIndex(targetNow(rec), filePath, opts.registry);
      }
    } catch (e) {
      console.error(`[watcher] failed to process '${filePath}' (${action}):`, e);
    } finally {
      // Every settled event (write/removal, skipped or failed) can change the
      // table's file/chunk counts; the manager debounces the actual reconcile.
      try {
        opts.onFileSettled?.();
      } catch (e) {
        console.error("[watcher] onFileSettled callback failed:", e);
      }
    }
  };

  const schedule = (filePath: string, action: PendingAction): void => {
    const prev = timers.get(filePath);
    if (prev) clearTimeout(prev);
    timers.set(
      filePath,
      setTimeout(function run() {
        // If a full index is running, defer: retry after the debounce interval.
        if (opts.isBusy?.()) {
          timers.set(filePath, setTimeout(run, debounceMs));
          return;
        }
        timers.delete(filePath);
        fire(filePath, action);
      }, debounceMs),
    );
  };

  watcher
    .on("add", (filePath: string) => schedule(filePath, "index"))
    .on("change", (filePath: string) => schedule(filePath, "index"))
    .on("unlink", (filePath: string) => schedule(filePath, "remove"))
    // Swallow per-file/per-directory watch errors (e.g. unreadable .key files →
    // EACCES): an 'error' event with no listener crashes the whole daemon. These
    // errors don't prevent continued watching; only that path can't be watched.
    .on("error", (err: unknown) => {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "ENOENT") {
        console.error(`[watcher] skipped unwatchable path (${e.code}): ${e.path ?? ""}`);
      } else {
        console.error(`[watcher] watch error:`, err);
      }
    });

  console.error(`[watcher] Watching: ${target.baseDir}`);
  return watcher;
}
