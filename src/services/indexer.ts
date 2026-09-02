import { stat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { CONFIG } from "../config";
import { chunkCode } from "../chunking/chunker";
import { getEmbeddings } from "./ollama";
import { insertChunks, deleteFileRecords, ensureVectorIndex, ensureFtsIndex, type CodeRecord } from "./db";
import { hashContent } from "../utils/hash";
import { mapWithConcurrency } from "../utils/concurrency";
import { gitTrackedFiles } from "./git";
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

export interface IndexResult {
  files: number;
  chunks: number;
  dim: number | null;
  /** Number of files cleaned up because they were deleted from disk during indexing. */
  deleted: number;
}

/** Single-file indexing result (chunk count + observed embedding dimension). */
export interface FileIndexResult {
  chunks: number;
  dim: number | null;
}

function isAllowed(filePath: string): boolean {
  return CONFIG.ALLOWED_EXTENSIONS.includes(path.extname(filePath));
}

/** Is a path ignored according to the given ignore matcher? (relative to baseDir). */
export function isPathIgnored(ig: Ignore, baseDir: string, fullPath: string): boolean {
  const rel = path.relative(baseDir, fullPath);
  if (!rel || rel.startsWith("..")) return false;
  return ig.ignores(rel);
}

/** Builds an ignore matcher from .gitignore + .cidxignore + global ignores. */
export async function buildIgnore(baseDir: string): Promise<Ignore> {
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
  return ig;
}

/** Recursively scans a directory and returns the list of files to index. */
export async function collectFiles(
  baseDir: string,
  ig: Ignore,
  allowSet?: Set<string> | null,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isPathIgnored(ig, baseDir, full)) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && isAllowed(full)) {
        // In git-tracked mode, only files in the allowed set.
        if (allowSet && !allowSet.has(full)) continue;
        out.push(full);
      }
    }
  }
  await walk(baseDir);
  return out;
}

/**
 * Indexes a single file. Skips it if unchanged (mtime cache).
 * Embeddings are read from the content-hash cache; missing ones are fetched from
 * Ollama in batches and written to the cache.
 */
export async function indexFile(
  target: IndexTarget,
  filePath: string,
  registry?: Registry,
  signal?: AbortSignal,
): Promise<FileIndexResult> {
  if (!isAllowed(filePath)) return { chunks: 0, dim: null };
  if (signal?.aborted) return { chunks: 0, dim: null };

  const st = await stat(filePath);
  if (!st.isFile()) return { chunks: 0, dim: null };

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

  const model = CONFIG.OLLAMA_MODEL;
  const texts = chunks.map((c) => c.content);
  const hashes = texts.map(hashContent);
  const vectors: (number[] | null)[] = new Array(chunks.length).fill(null);

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
    const embs = await getEmbeddings(batch.map((i) => texts[i]!));
    for (let k = 0; k < batch.length; k++) {
      const i = batch[k]!;
      const vec = embs[k];
      if (!vec) continue;
      vectors[i] = vec;
      toCache.push({ hash: hashes[i]!, vector: vec });
    }
  });
  if (registry && toCache.length > 0) registry.putCachedEmbeddings(model, toCache);

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
    });
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

  const ig = await buildIgnore(target.baseDir);
  const allowSet = CONFIG.GIT_TRACKED_ONLY ? await gitTrackedFiles(target.baseDir) : null;
  if (CONFIG.GIT_TRACKED_ONLY && allowSet) {
    console.error(`[indexer] '${target.indexName}' git-tracked mode: ${allowSet.size} tracked files.`);
  }
  const files = await collectFiles(target.baseDir, ig, allowSet);
  const total = files.length;

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
  for (const file of files) {
    if (opts.signal?.aborted) break;
    try {
      const r = await indexFile(target, file, opts.registry, opts.signal);
      chunks += r.chunks;
      if (dim === null && r.dim !== null) dim = r.dim;
    } catch (err) {
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
      const created = await ensureFtsIndex(target.tableName);
      if (created) console.error(`[indexer] built BM25/FTS index for '${target.tableName}'.`);
    } catch (err) {
      console.error(`[indexer] failed to build FTS index for '${target.tableName}':`, err);
    }
  }

  return { files: processed, chunks, dim, deleted };
}
