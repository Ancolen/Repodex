import { readFileSync } from "node:fs";
import { stat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { CONFIG } from "../config";
import { readProjectConfig, extToLanguage, languageAllowSet, type ProjectConfig } from "../core/project-config";
import { resolveFraming, frameDoc } from "../core/framing";
import { chunkCode } from "../chunking/chunker";
import { extractIdTerms } from "../core/idterms";
import { getEmbeddings } from "./embed";
import {
  insertChunks,
  deleteFileRecords,
  ensureVectorIndex,
  ensureFtsIndex,
  countTableRows,
  dropTable,
  scanTableBatches,
  tableColumns,
  type CodeRecord,
} from "./db";
import { hashContent } from "../utils/hash";
import { mapWithConcurrency } from "../utils/concurrency";
import { gitTrackedFiles } from "./git";
import { tableNameFor } from "../core/registry";
import type { Registry } from "../core/registry";

/**
 * An indexing target: which project (indexName + cache scope),
 * which LanceDB table and which root directory.
 * One target per registered index; generated from the registry.
 */
export interface IndexTarget {
  indexName: string;
  tableName: string;
  baseDir: string;
}

export interface IndexOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ((processed: number, total: number, currentFile?: string) => void) | undefined;
  registry?: Registry | undefined;
}

/**
 * Skip-reason counters gathered by `collectFiles` — the why-empty telemetry:
 * a zero-file collection is a legitimate outcome (e.g. everything under a
 * `languages` allowlist or an ignore rule), so the job surfaces *why* instead
 * of reporting a bare "ready" with nothing in the table.
 */
export interface CollectStats {
  /** File/dir entries skipped by the ignore matcher (.gitignore/.cidxignore/ignoredDirs). */
  ignored: number;
  /** Files rejected because their extension is not in `indexing.allowedExtensions`. */
  disallowedExt: number;
  /** Files rejected by the git-tracked-only mode (not in the tracked set). */
  untracked: number;
  /** Files rejected by the per-project `.cidx.json` `languages` allowlist. */
  langFiltered: number;
  /** Files rejected by the `maxFileSizeBytes` guard. */
  oversized: number;
}

export interface IndexResult {
  files: number;
  chunks: number;
  dim: number | null;
  /** Number of files cleaned up because they were deleted from disk during indexing. */
  deleted: number;
  /**
   * Number of files skipped because they exceed the effective
   * `maxFileSizeBytes` limit (never silent — surfaced on the job result and
   * the ready log line).
   */
  skippedOversized: number;
  /**
   * Files that threw during indexing (embedding provider unreachable, parse
   * failure, …). They keep their previous rows (if any) but a non-zero count
   * means the run did not fully apply — surfaced on the ready log line and the
   * registry note so provider outages are not silent.
   */
  failed: number;
  /**
   * Why-candidates-were-skipped counters for the last `collectFiles` — carried
   * so a zero-processed run can explain itself (registry note + status).
   */
  filterStats: CollectStats;
}

/** Single-file indexing result (chunk count + observed embedding dimension). */
export interface FileIndexResult {
  chunks: number;
  dim: number | null;
  /** True only when the file was skipped by the `maxFileSizeBytes` guard. */
  skippedOversized?: boolean | undefined;
}

/** Would `indexFile` accept this path (same extension rule as `collectFiles`)? */
export function isAllowedFile(filePath: string): boolean {
  return CONFIG.ALLOWED_EXTENSIONS.includes(path.extname(filePath));
}

/** Is a path ignored according to the given ignore matcher? (relative to baseDir). */
export function isPathIgnored(ig: Ignore, baseDir: string, fullPath: string): boolean {
  const rel = path.relative(baseDir, fullPath);
  if (!rel || rel.startsWith("..")) return false;
  return ig.ignores(rel);
}

/**
 * The effective `maxFileSizeBytes` limit for a project (the oversized-file
 * guard): the `.cidx.json` value overrides the global `indexing.maxFileSizeBytes`
 * default. Anything <= 0 means the guard is OFF. (The `.cidx.json` value is
 * validated to a positive integer at parse time; the global default is 0.)
 */
export function effectiveMaxFileSizeBytes(pcfg?: ProjectConfig | undefined): number {
  return pcfg?.maxFileSizeBytes ?? CONFIG.MAX_FILE_SIZE_BYTES;
}

/** Builds an ignore matcher from .gitignore + .cidxignore + global ignores (+ optional extra patterns from `.cidx.json`). */
export async function buildIgnore(baseDir: string, extra?: string[] | undefined): Promise<Ignore> {
  const ig = ignore().add(CONFIG.GLOBAL_IGNORED_DIRS);
  // .gitignore (optional, controlled by CONFIG.RESPECT_GITIGNORE)
  if (CONFIG.RESPECT_GITIGNORE) {
    try {
      const gitIgnore = await readFile(path.join(baseDir, ".gitignore"), "utf-8");
      ig.add(gitIgnore);
    } catch {
      // it's fine if there is no .gitignore
    }
  }
  // .cidxignore (project-level extra rules, can override/extend .gitignore)
  try {
    const content = await readFile(path.join(baseDir, ".cidxignore"), "utf-8");
    ig.add(content);
  } catch {
    // continue with defaults if there is no .cidxignore
  }
  // .cidx.json `ignore` patterns (per-project extra rules)
  if (extra && extra.length > 0) ig.add(extra);
  return ig;
}

/**
 * Synchronous twin of `buildIgnore`, for callers that need the matcher before
 * an event loop can run — notably the watcher, whose chokidar `ignored`
 * predicate must filter paths synchronously at startup (otherwise chokidar
 * opens a watch per file in trees the indexer never reads, e.g. `.venv`).
 * Same sources and precedence as `buildIgnore`; reads two small files once.
 */
export function buildIgnoreSync(baseDir: string, extra?: string[] | undefined): Ignore {
  const ig = ignore().add(CONFIG.GLOBAL_IGNORED_DIRS);
  const addFile = (name: string): void => {
    try {
      ig.add(readFileSync(path.join(baseDir, name), "utf-8"));
    } catch {
      // optional ignore file
    }
  };
  if (CONFIG.RESPECT_GITIGNORE) addFile(".gitignore");
  addFile(".cidxignore");
  if (extra && extra.length > 0) ig.add(extra);
  return ig;
}

/**
 * Recursively scans a directory and returns the list of files to index.
 * `langSet` (from a `.cidx.json` `languages` allowlist) keeps only files whose
 * extension produces a language label inside the set — unlabeled extensions are
 * dropped while a filter is active. `maxFileSizeBytes` (the oversized-file
 * guard, `effectiveMaxFileSizeBytes`) skips files strictly larger than that
 * many bytes when > 0. Filtered-out files are absent from the returned list,
 * so the deleted-file cleanup prunes them on the next sync — including a file
 * that GREW past the limit after being indexed once. A file whose stat fails
 * is kept (never treated as oversized): the per-file index step reports the
 * real failure instead of silently deleting its records.
 */
export async function collectFiles(
  baseDir: string,
  ig: Ignore,
  allowSet?: Set<string> | null,
  langSet?: Set<string> | null,
  maxFileSizeBytes?: number | undefined,
): Promise<{ files: string[]; stats: CollectStats }> {
  const out: string[] = [];
  const stats: CollectStats = { ignored: 0, disallowedExt: 0, untracked: 0, langFiltered: 0, oversized: 0 };
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isPathIgnored(ig, baseDir, full)) {
        stats.ignored++;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (!isAllowedFile(full)) {
          stats.disallowedExt++;
          continue;
        }
        // In git-tracked mode, only files in the allowed set.
        if (allowSet && !allowSet.has(full)) {
          stats.untracked++;
          continue;
        }
        // Per-project language allowlist (.cidx.json `languages`).
        if (langSet) {
          const lang = extToLanguage(path.extname(full));
          if (!lang || !langSet.has(lang)) {
            stats.langFiltered++;
            continue;
          }
        }
        // Oversized-file guard (active only when a positive limit is set).
        if (maxFileSizeBytes !== undefined && maxFileSizeBytes > 0) {
          try {
            const fst = await stat(full);
            if (fst.size > maxFileSizeBytes) {
              stats.oversized++;
              continue;
            }
          } catch {
            // Unreadable/unstat-able file: keep it — indexFile reports the
            // failure, and no record is silently pruned on a bad stat.
          }
        }
        out.push(full);
      }
    }
  }
  await walk(baseDir);
  return { files: out, stats };
}

/**
 * One-line human summary of why `collectFiles` kept what it kept — attached to
 * the ready log line and the registry note when a run processes zero files,
 * so an agent or the user can see which filter ate the candidates.
 */
export function describeFilterStats(stats: CollectStats): string {
  const parts: string[] = [];
  if (stats.ignored > 0) parts.push(`${stats.ignored} ignored by .gitignore/.cidxignore/ignoredDirs`);
  if (stats.disallowedExt > 0) parts.push(`${stats.disallowedExt} with a disallowed extension`);
  if (stats.untracked > 0) parts.push(`${stats.untracked} not git-tracked`);
  if (stats.langFiltered > 0) parts.push(`${stats.langFiltered} filtered by the languages allowlist`);
  if (stats.oversized > 0) parts.push(`${stats.oversized} oversized`);
  return parts.length > 0 ? parts.join(", ") : "no candidate files seen";
}

/**
 * Embeds a list of texts through the content-hash cache: cache hits fill the
 * slot, misses go to Ollama in batches with bounded parallelism, and results
 * are written back to the cache. Returns null per text when aborted mid-way
 * (the caller then skips the write).
 */
async function embedTexts(
  texts: string[],
  model: string,
  registry?: Registry,
  signal?: AbortSignal,
): Promise<(number[] | null)[]> {
  const hashes = texts.map(hashContent);
  const vectors: (number[] | null)[] = new Array(texts.length).fill(null);

  // 1) Read from cache
  if (registry) {
    for (let i = 0; i < hashes.length; i++) {
      const cached = registry.getCachedEmbedding(model, hashes[i]!);
      if (cached) vectors[i] = cached;
    }
  }

  // 2) Embed the missing ones in batches, with bounded parallelism.
  const missIdx: number[] = [];
  for (let i = 0; i < vectors.length; i++) if (vectors[i] === null) missIdx.push(i);

  // Split missing indices into groups of EMBED_BATCH_SIZE; cross-group parallelism
  // is bounded by EMBED_CONCURRENCY (reduces round-trips without overwhelming Ollama).
  const batches: number[][] = [];
  for (let b = 0; b < missIdx.length; b += CONFIG.EMBED_BATCH_SIZE) {
    batches.push(missIdx.slice(b, b + CONFIG.EMBED_BATCH_SIZE));
  }

  const toCache: { hash: string; vector: number[] }[] = [];
  await mapWithConcurrency(batches, CONFIG.EMBED_CONCURRENCY, async (batch) => {
    // If aborted, don't embed the remaining batches. This ensures that cancelling
    // a remove/reindex in the middle of a large file actually stops (with at most
    // one in-flight batch of delay). Half-finished vectors remain null → the
    // corresponding chunks are not written; this is fine since cancellation will
    // drop the table anyway.
    if (signal?.aborted) return;
    const embs = await getEmbeddings(batch.map((i) => texts[i]!), model);
    for (let k = 0; k < batch.length; k++) {
      const i = batch[k]!;
      const vec = embs[k];
      if (!vec) continue;
      vectors[i] = vec;
      toCache.push({ hash: hashes[i]!, vector: vec });
    }
  });
  if (registry && toCache.length > 0) registry.putCachedEmbeddings(model, toCache);
  return vectors;
}

/**
 * Indexes a single file. Skips it if unchanged (mtime cache).
 * Embeddings are read from the content-hash cache; missing ones are fetched from
 * Ollama in batches and written to the cache.
 *
 * `maxFileSizeBytes` (the effective project limit, see
 * `effectiveMaxFileSizeBytes`): when > 0 and the file exceeds it, the file is
 * skipped BEFORE chunking/embedding — the old records (if any) stay until the
 * next sync, whose deleted-file cleanup prunes the now-oversized file (it is
 * absent from `collectFiles` output). This is the watcher-side half of the
 * guard: the full index path already filters in `collectFiles`.
 *
 * Each chunk's docstring (`chunk.doc`, see `chunking/docstring.ts`) is embedded
 * into a separate `doc_vector` (same model, same dimension), so symbol docs form
 * their own retrieval leg. Compound identifiers are split into subparts into
 * `id_terms` (`src/core/idterms.ts`) — a pure CPU step, no embedding.
 *
 * Task framing (per-model framing layer): the record's framing id frames BOTH
 * embed sites — the chunk contents and the docstring texts get the preset's
 * document prefix before `embedTexts`, so the cached key is the hash of the
 * FRAMED text ("hash what you embed"). The stored `content`/`doc` columns keep
 * the raw text; a null framing embeds the raw bytes exactly as before framing
 * existed.
 */
export async function indexFile(
  target: IndexTarget,
  filePath: string,
  registry?: Registry,
  signal?: AbortSignal,
  embedModel?: string | undefined,
  framing?: string | null | undefined,
  maxFileSizeBytes?: number | undefined,
): Promise<FileIndexResult> {
  if (!isAllowedFile(filePath)) return { chunks: 0, dim: null };
  if (signal?.aborted) return { chunks: 0, dim: null };

  const st = await stat(filePath);
  if (!st.isFile()) return { chunks: 0, dim: null };

  // Oversized-file guard (the same rule collectFiles applies on full indexes).
  if (maxFileSizeBytes !== undefined && maxFileSizeBytes > 0 && st.size > maxFileSizeBytes) {
    console.error(
      `[indexer] '${target.indexName}' skipping '${filePath}': ${st.size} bytes exceeds maxFileSizeBytes (${maxFileSizeBytes}).`,
    );
    return { chunks: 0, dim: null, skippedOversized: true };
  }

  const mtime = st.mtimeMs;
  if (registry && registry.getFileMtime(target.indexName, filePath) === mtime) {
    return { chunks: 0, dim: null }; // unchanged → skip
  }

  const content = await readFile(filePath, "utf-8");
  const chunks = await chunkCode(filePath, content);

  if (chunks.length === 0) {
    await deleteFileRecords(target.tableName, filePath);
    registry?.setFileMtime(target.indexName, filePath, mtime);
    return { chunks: 0, dim: null };
  }

  const model = embedModel ?? CONFIG.OLLAMA_MODEL;
  const vectors = await embedTexts(chunks.map((c) => frameDoc(c.content, framing)), model, registry, signal);

  // Docstring leg: one extra embedding per doc-carrying chunk (framed too —
  // the docstring is a document for the same framing).
  const docIdx: number[] = [];
  const docTexts: string[] = [];
  if (CONFIG.DOCSTRINGS) {
    for (let i = 0; i < chunks.length; i++) {
      const doc = chunks[i]!.doc;
      if (doc && doc.trim().length > 0) {
        docIdx.push(i);
        docTexts.push(frameDoc(doc, framing));
      }
    }
  }
  const docVecs =
    docIdx.length > 0 ? await embedTexts(docTexts, model, registry, signal) : null;

  // If aborted, don't write half data for this file; exit silently.
  if (signal?.aborted) return { chunks: 0, dim: null };

  // 3) Build the records (fixed schema)
  const records: CodeRecord[] = [];
  let dim: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const vector = vectors[i];
    if (!vector) continue;
    if (dim === null) dim = vector.length;
    records.push({
      id: `${filePath}#${i}`,
      filePath,
      content: chunk.content,
      vector,
      language: chunk.language ?? "",
      symbolName: chunk.symbolName ?? "",
      symbolType: chunk.symbolType ?? "",
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      // Docstring leg: null on doc-less chunks (fixed-schema nullable columns).
      doc: chunk.doc ?? null,
      doc_vector: null,
      // Identifier-part BM25 leg (no embedding): compound identifiers of the
      // chunk split into subparts (`getUserName` → "getusername get user name"),
      // null when the chunk has none. See `src/core/idterms.ts`.
      id_terms: extractIdTerms(chunk.content) || null,
    });
  }
  if (docVecs) {
    for (let k = 0; k < docIdx.length; k++) {
      const rec = records[docIdx[k]!];
      const vec = docVecs[k];
      if (rec && vec) rec.doc_vector = vec;
    }
  }

  if (records.length > 0) {
    await insertChunks(target.tableName, records);
  } else {
    await deleteFileRecords(target.tableName, filePath);
  }

  registry?.setFileMtime(target.indexName, filePath, mtime);
  return { chunks: records.length, dim };
}

export async function removeFileIndex(
  target: IndexTarget,
  filePath: string,
  registry?: Registry,
): Promise<void> {
  await deleteFileRecords(target.tableName, filePath);
  registry?.deleteFileCache(target.indexName, filePath);
}

/**
 * Indexes a directory from scratch.
 * - Progress is reported via onProgress (0..total).
 * - Can be cancelled via AbortSignal.
 * - If a registry is provided, files that are in file_cache but not in the list
 *   (deleted/ignored) on disk are cleaned up from the table + cache.
 *   This prevents files deleted while the daemon was down from remaining.
 * - At the end of indexing, an ANN vector index is built if the table is large.
 */
export async function indexDirectory(
  target: IndexTarget,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  // SAFETY: If the directory is inaccessible, do NO cleanup at all. Otherwise
  // collectFiles returns an empty list and the deleted-file cleanup removes ALL
  // records in the table (unmounted disk / moved-deleted folder / permission error
  // → data loss). In that case, finish the job with an error; the existing index
  // is preserved as-is.
  try {
    const st = await stat(target.baseDir);
    if (!st.isDirectory()) {
      throw new Error(`indexing target is not a directory: ${target.baseDir}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not a directory")) throw err;
    throw new Error(
      `cannot access indexing directory, index preserved: ${target.baseDir} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // Per-project configuration (.cidx.json): extra ignore patterns, language
  // allowlist, embedding model + task framing, oversized-file limit. Read fresh
  // on every job, so a reindex picks up edits; filtered-out files are pruned by
  // the deleted-file cleanup.
  const pcfg = readProjectConfig(target.baseDir);
  if (pcfg?.embedModel && pcfg.embedModel !== CONFIG.OLLAMA_MODEL) {
    console.error(`[indexer] '${target.indexName}' using per-project embedding model: ${pcfg.embedModel}`);
  }
  const langSet = languageAllowSet(pcfg);
  if (langSet) {
    console.error(`[indexer] '${target.indexName}' language filter: ${[...langSet].join(", ")}`);
  }
  // The framing every embed of this job uses — resolved under the same model
  // the job embeds with (the `.cidx.json` model override, else the global).
  // Must match what `runIndexJob` re-pins: the pin describes the table's
  // framing as of this job.
  const framing = resolveFraming(pcfg?.framing ?? CONFIG.EMBEDDING_FRAMING, pcfg?.embedModel ?? CONFIG.OLLAMA_MODEL);
  if (framing) {
    console.error(`[indexer] '${target.indexName}' embedding framing: ${framing}`);
  }

  const maxFileBytes = effectiveMaxFileSizeBytes(pcfg);
  if (maxFileBytes > 0) {
    console.error(`[indexer] '${target.indexName}' max file size filter: ${maxFileBytes} bytes.`);
  }

  const ig = await buildIgnore(target.baseDir, pcfg?.ignore);
  const allowSet = CONFIG.GIT_TRACKED_ONLY ? await gitTrackedFiles(target.baseDir) : null;
  if (CONFIG.GIT_TRACKED_ONLY && allowSet) {
    console.error(`[indexer] '${target.indexName}' git-tracked mode: ${allowSet.size} tracked files.`);
  }
  const { files, stats } = await collectFiles(target.baseDir, ig, allowSet, langSet, maxFileBytes);
  const total = files.length;
  if (total === 0) {
    // A zero-file collection is a legitimate outcome, but never a silent one:
    // an earlier full index would have everything pruned as "deleted", and a
    // first index would register an empty table. Log loudly and carry the
    // reason into the job result (registry note + status surface).
    console.error(
      `[indexer] '${target.indexName}' collected 0 files — ${describeFilterStats(stats)}. ` +
        "Check .gitignore/.cidxignore/ignoredDirs, indexing.allowedExtensions, " +
        "the .cidx.json `languages` allowlist and maxFileSizeBytes settings.",
    );
  }

  // --- Clean up deleted/ignored files (incremental sync) ---
  let deleted = 0;
  if (opts.registry) {
    const onDisk = new Set(files);
    const cached = opts.registry.listCachedFiles(target.indexName);
    for (const cachedPath of cached) {
      if (opts.signal?.aborted) break;
      if (!onDisk.has(cachedPath)) {
        try {
          await removeFileIndex(target, cachedPath, opts.registry);
          deleted++;
        } catch (err) {
          console.error(`[indexer] failed to clean up '${cachedPath}':`, err);
        }
      }
    }
  }

  opts.onProgress?.(0, total);

  let processed = 0;
  let chunks = 0;
  let dim: number | null = null;
  let skippedOversized = 0;
  let failed = 0;
  for (const file of files) {
    if (opts.signal?.aborted) break;
    try {
      const r = await indexFile(target, file, opts.registry, opts.signal, pcfg?.embedModel, framing, maxFileBytes);
      chunks += r.chunks;
      if (dim === null && r.dim !== null) dim = r.dim;
      if (r.skippedOversized) skippedOversized++;
    } catch (err) {
      failed++;
      console.error(`[indexer] failed to index '${file}':`, err);
    }
    processed++;
    opts.onProgress?.(processed, total, file);
  }

  // --- Indexes: ANN vector (instead of brute-force) + BM25/FTS (hybrid search) ---
  if (!opts.signal?.aborted) {
    try {
      const created = await ensureVectorIndex(target.tableName, CONFIG.VECTOR_INDEX_THRESHOLD);
      if (created) console.error(`[indexer] built ANN vector index for '${target.tableName}'.`);
    } catch (err) {
      console.error(`[indexer] failed to build vector index for '${target.tableName}':`, err);
    }
    try {
      // Same threshold logic for the docstring leg; a no-op on legacy tables
      // (no doc_vector column) and small tables.
      const created = await ensureVectorIndex(target.tableName, CONFIG.VECTOR_INDEX_THRESHOLD, "doc_vector");
      if (created) console.error(`[indexer] built ANN doc_vector index for '${target.tableName}'.`);
    } catch (err) {
      console.error(`[indexer] failed to build doc_vector index for '${target.tableName}':`, err);
    }
    try {
      // BM25 over `content`, `doc` and `id_terms` (the optional legs are
      // schema-guarded inside and never fail the index).
      const built = await ensureFtsIndex(target.tableName);
      if (built > 0) console.error(`[indexer] built ${built} BM25/FTS index(es) for '${target.tableName}'.`);
    } catch (err) {
      console.error(`[indexer] failed to build FTS index for '${target.tableName}':`, err);
    }
  }

  return { files: processed, chunks, dim, deleted, skippedOversized, failed, filterStats: stats };
}

// ------------------------------------------------- O2: zero-downtime migration

/**
 * Rows read (and embedded) per shadow-build batch. Larger than one embed batch
 * on purpose: a batch spans several files while an `EMBED_BATCH_SIZE` embed
 * round still bounds each wire call (embedTexts batches and bounds its own
 * concurrency inside).
 */
const MIGRATE_BATCH_ROWS = Math.max(CONFIG.EMBED_BATCH_SIZE * 8, 128);

/** Progress + the registry (the commit point) for a migration. */
export interface MigrateContext {
  registry: Registry;
  signal?: AbortSignal | undefined;
  onProgress?: ((processed: number, total: number, message?: string) => void) | undefined;
  /**
   * The framing identity to embed the shadow with (per-model framing layer):
   * a preset id or null for none. Passed by `runMigrateJob` from the migrate
   * payload so a framing change rides the same zero-downtime machinery as a
   * model change; omitted (test/direct callers) means null — pre-framing
   * behavior, byte-identical re-embeds.
   */
  framing?: string | null | undefined;
}

export interface MigrateResult {
  project: string;
  /** Table the migration started from. */
  fromTable: string;
  /** Table the registry serves now (=== fromTable for an in-place pin). */
  toTable: string;
  /** Rows the committed table holds (0 when nothing was committed). */
  rows: number;
  /** Dimension of the newly embedded vectors (null when nothing was embedded). */
  dim: number | null;
  /** The framing the committed record now pins (what the shadow embedded with). */
  framing: string | null;
  /**
   * "swapped"  — shadow built, the registry transaction flipped to it, the old
   *              table dropped best-effort. An empty source table commits an
   *              in-place model pin instead (toTable === fromTable).
   * "noop"     — the project already serves the target model.
   * "cancelled" — aborted before the commit point: registry + original table
   *              untouched, the partial shadow removed.
   */
  kind: "swapped" | "noop" | "cancelled";
  /** The superseded table was dropped (false → an orphan the doctor flags). */
  originalDropped: boolean;
}

/**
 * Zero-downtime model migration (proposal O2): rebuilds every vector of the
 * project's current table in a SHADOW table (`<current>_mig`) with the target
 * model — the registry transaction is the commit point. Until the commit,
 * search keeps serving the untouched original table with self-consistent
 * vectors; only after the shadow is COMPLETE (rows re-embedded, ANN + BM25
 * indexes built) does one registry transaction flip `{ tableName, embedModel,
 * embedDim, framing, chunkCount, lastIndexedAt }` and mark the index ready.
 *
 * The re-embeds are framed with the target framing (`ctx.framing`, null =
 * unframed): a framing change escalates through this same machinery, so a
 * table is always rebuilt as a whole under the one framing its record pins.
 *
 * Crash safety: before the transaction a crash leaves the original untouched
 * (the partial shadow is stale garbage the doctor flags as `*_mig` and the next
 * attempt pre-cleans); after it the registry points at the complete shadow — a
 * failed drop of the OLD table only leaves an unregistered orphan, never a
 * data loss. The chunk CONTENT is model-independent and is copied (re-embedded,
 * not re-chunked), so a migration neither re-reads the working tree nor loses
 * watcher edits — those land in the new table on the next sync.
 *
 * Repeated migrations nest the suffix (`idx_x` → `idx_x_mig` → `idx_x_mig_mig`):
 * the shadow is always derived from the CURRENT stored name, so it can never
 * collide with the table being served. (A LanceDB rename keeping the original
 * name would need a SECOND registry commit with a broken window in between, so
 * the rename API is deliberately not used.)
 */
export async function migrateTable(
  target: IndexTarget,
  targetModel: string,
  ctx: MigrateContext,
): Promise<MigrateResult> {
  const { registry, signal, onProgress } = ctx;
  // No framing given (omitted context) or resolved to none → the pre-framing
  // byte-identical behavior.
  const targetFraming = ctx.framing ?? null;
  const project = target.indexName;
  // The stored name — after the first migration this is NOT the derived
  // default, so the shadow name keeps nesting instead of colliding with the
  // table being served.
  const fromTable = tableNameFor({ name: project, tableName: target.tableName });
  const shadowName = `${fromTable}_mig`;

  const noop = (): MigrateResult => ({
    project,
    fromTable,
    toTable: fromTable,
    rows: 0,
    dim: null,
    framing: targetFraming,
    kind: "noop",
    originalDropped: false,
  });

  if ((await tableColumns(fromTable)).size === 0) {
    // Nothing to migrate from: a missing table cannot be re-embedded, and
    // pretending a migration happened would hide the hole behind an empty
    // table. Point the user at a full reindex (the honest remedy).
    throw new Error(
      `table '${fromTable}' of '${project}' does not exist — nothing to migrate; run a full reindex instead`,
    );
  }

  if ((await countTableRows(fromTable)) === 0) {
    // An existing but empty table has no vectors to re-embed — and LanceDB
    // cannot create an empty one (the first insert pins the vector dimension).
    // Pin the target model AND framing in place: the registry transaction IS
    // the whole migration; future writes (watcher/next sync) build the table
    // with the new model and framing.
    registry.commitTableSwap(project, {
      tableName: fromTable,
      embedModel: targetModel,
      embedDim: null,
      framing: targetFraming,
      chunkCount: 0,
      lastIndexedAt: Date.now(),
    });
    return { ...noop(), kind: "swapped" };
  }

  let committed = false;
  const dropShadow = async (): Promise<void> => {
    try {
      await dropTable(shadowName);
    } catch (err) {
      console.error(`[indexer] failed to clean up migration shadow '${shadowName}':`, err);
    }
  };

  try {
    // A stale shadow (a previously interrupted attempt — the doctor flags it)
    // is dropped and rebuilt from scratch.
    await dropTable(shadowName);

    const totalRows = await countTableRows(fromTable);
    onProgress?.(0, totalRows, "starting migration");

    let processed = 0;
    let dim: number | null = null;

    await scanTableBatches(
      fromTable,
      MIGRATE_BATCH_ROWS,
      async (batch) => {
        let lastFile = "";
        let i = 0;
        while (i < batch.length) {
          const filePath = batch[i]!.filePath;
          let j = i;
          while (j < batch.length && batch[j]!.filePath === filePath) j++;
          const rows = batch.slice(i, j);
          lastFile = filePath;

          // Re-embed the content (cache-first) and the doc legs — the same
          // embedTexts/caching recipe as indexing, keyed on the TARGET model,
          // framed with the TARGET framing (hash what you embed: the cache
          // keys on the framed text, so a framing change re-keys cleanly and
          // an unchanged framing keeps hitting the existing cache).
          const vectors = await embedTexts(
            rows.map((r) => frameDoc(r.content, targetFraming)),
            targetModel,
            registry,
            signal,
          );
          const docIdx: number[] = [];
          const docTexts: string[] = [];
          if (CONFIG.DOCSTRINGS) {
            for (let k = 0; k < rows.length; k++) {
              const doc = rows[k]!.doc;
              if (doc && doc.trim().length > 0) {
                docIdx.push(k);
                docTexts.push(frameDoc(doc, targetFraming));
              }
            }
          }
          const docVecs =
            docIdx.length > 0 ? await embedTexts(docTexts, targetModel, registry, signal) : null;
          // Abort mid-batch: vectors half-filled with nulls are never written.
          if (signal?.aborted) return;

          const records: (CodeRecord | null)[] = new Array(rows.length).fill(null);
          for (let k = 0; k < rows.length; k++) {
            const row = rows[k]!;
            const vector = vectors[k];
            // A missing vector without an abort means the backend under-delivered
            // (fewer embeddings than inputs). Committing a shadow with silently
            // dropped chunks would corrupt search after the swap — fail the job
            // instead (the shadow is cleaned up, the original keeps serving; the
            // sync re-escalates and retries).
            if (!vector) {
              if (signal?.aborted) continue;
              throw new Error(
                `migration of '${project}': the embedding backend returned no vector for '${filePath}' chunk ${k}`,
              );
            }
            if (dim === null) dim = vector.length;
            const rec: CodeRecord = {
              // ids are re-numbered per file — the chunks' own content/position
              // is what matters, and the shadow is built file-aligned.
              id: `${filePath}#${k}`,
              filePath,
              content: row.content,
              vector,
              language: row.language ?? "",
              symbolName: row.symbolName ?? "",
              symbolType: row.symbolType ?? "",
              doc: row.doc ?? null,
              doc_vector: null,
              // Identifier-leg terms are pure CPU (no embedding) — recomputed
              // so the shadow carries them even when the source table predates.
              id_terms: extractIdTerms(row.content) || null,
            };
            // Line numbers pass through as-is (absent stays absent, not 0).
            if (row.startLine != null) rec.startLine = row.startLine;
            if (row.endLine != null) rec.endLine = row.endLine;
            records[k] = rec;
          }
          if (docVecs) {
            for (let d = 0; d < docIdx.length; d++) {
              const rec = records[docIdx[d]!];
              const vec = docVecs[d];
              if (!vec) {
                if (signal?.aborted) continue;
                throw new Error(
                  `migration of '${project}': the embedding backend returned no doc vector (row '${docIdx[d]}' of '${filePath}')`,
                );
              }
              if (rec) rec.doc_vector = vec;
            }
          }
          const clean: CodeRecord[] = [];
          for (const r of records) if (r) clean.push(r);
          if (clean.length > 0) await insertChunks(shadowName, clean);

          i = j;
        }
        processed += batch.length;
        onProgress?.(processed, totalRows, `re-embedding ${lastFile}`);
      },
      { signal },
    );

    if (signal?.aborted) {
      await dropShadow();
      return {
        project,
        fromTable,
        toTable: fromTable,
        rows: 0,
        dim: null,
        framing: targetFraming,
        kind: "cancelled",
        originalDropped: false,
      };
    }

    // --- Build ALL search indexes on the shadow, mirroring indexDirectory ---
    try {
      const created = await ensureVectorIndex(shadowName, CONFIG.VECTOR_INDEX_THRESHOLD);
      if (created) console.error(`[indexer] built ANN vector index for '${shadowName}'.`);
    } catch (err) {
      console.error(`[indexer] failed to build vector index for '${shadowName}':`, err);
    }
    try {
      const created = await ensureVectorIndex(shadowName, CONFIG.VECTOR_INDEX_THRESHOLD, "doc_vector");
      if (created) console.error(`[indexer] built ANN doc_vector index for '${shadowName}'.`);
    } catch (err) {
      console.error(`[indexer] failed to build doc_vector index for '${shadowName}':`, err);
    }
    try {
      const built = await ensureFtsIndex(shadowName);
      if (built > 0) console.error(`[indexer] built ${built} BM25/FTS index(es) for '${shadowName}'.`);
    } catch (err) {
      console.error(`[indexer] failed to build FTS index for '${shadowName}':`, err);
    }

    // --- THE COMMIT POINT: one registry transaction flips the project. ---
    const rows = await countTableRows(shadowName);
    try {
      registry.commitTableSwap(project, {
        tableName: shadowName,
        embedModel: targetModel,
        embedDim: dim,
        framing: targetFraming,
        chunkCount: rows,
        lastIndexedAt: Date.now(),
      });
      committed = true;
    } catch (err) {
      // The registry refused — the shadow is an orphan, the original untouched.
      onProgress?.(processed, totalRows, "registry commit failed");
      throw err;
    }

    // --- Best-effort drop of the superseded table (post-commit). A failure
    // leaves it unregistered → the doctor flags it; search already serves the
    // shadow, so nothing is lost. ---
    let originalDropped = false;
    try {
      await dropTable(fromTable);
      originalDropped = true;
    } catch (err) {
      console.error(
        `[indexer] failed to drop the superseded table '${fromTable}' for '${project}' ` +
          "(it is no longer registered — the doctor flags it as an orphan):",
        err,
      );
    }

    onProgress?.(rows, totalRows, "migration committed");
    return {
      project,
      fromTable,
      toTable: shadowName,
      rows,
      dim,
      framing: targetFraming,
      kind: "swapped",
      originalDropped,
    };
  } catch (err) {
    // Build/commit failure: the original table + registry are untouched — the
    // shadow was never pointed to and can be discarded.
    if (!committed) await dropShadow();
    throw err;
  }
}
