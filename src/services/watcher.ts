import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { CONFIG } from "../config";
import { buildIgnore, isPathIgnored, indexFile, removeFileIndex, type IndexTarget } from "./indexer";
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
}

const IGNORE_RE = /(^|[/\\])(node_modules|\.git|\.lancedb|dist|build|out|target|\.godot)([/\\]|$)/;

type PendingAction = "index" | "remove";

/**
 * Watches a directory and reindexes changes (debounced).
 * - Consecutive save events for the same file are batched into one.
 * - While a full index/sync is running (isBusy), events are deferred; this way
 *   the background job and the watcher do not write to the same LanceDB table
 *   concurrently.
 * - RESPECTS .gitignore/.cidxignore/global ignore rules: to stay consistent with
 *   full indexing, ignored files are not indexed (and are cleaned up if they were
 *   indexed before). Rules are read once at watcher startup; if they change, the
 *   next full reindex/sync reflects them.
 */
export function startWatcher(target: IndexTarget, opts: WatchOptions = {}): FSWatcher {
  const debounceMs = opts.debounceMs ?? CONFIG.WATCH_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Set up the ignore matcher once (async). Since events are debounced, it is
  // ready before the first trigger.
  const igPromise = buildIgnore(target.baseDir);

  const watcher = chokidar.watch(target.baseDir, {
    ignored: (p: string) => IGNORE_RE.test(p),
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
      const ig = await igPromise;
      // Per-project config is read fresh per event so watcher writes follow the
      // same rules as the next full index (`.cidx.json` `languages` allowlist +
      // `embedModel` override; extra `ignore` patterns still come from the
      // startup matcher, matching the .cidxignore semantics above).
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
        // the table's vectors were framed with.
        await indexFile(targetNow(rec), filePath, opts.registry, undefined, pcfg?.embedModel, rec?.framing ?? null);
      } else {
        await removeFileIndex(targetNow(rec), filePath, opts.registry);
      }
    } catch (e) {
      console.error(`[watcher] failed to process '${filePath}' (${action}):`, e);
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
