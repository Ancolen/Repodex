import path from "node:path";
import { readFile } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { CONFIG } from "../config";
import { type IndexRecord, type Registry } from "./registry";
import type { JobQueue } from "./job-queue";
import type { Job } from "./types";
import {
  indexDirectory,
  type IndexResult,
  type IndexTarget,
} from "../services/indexer";
import { startWatcher } from "../services/watcher";
import {
  dropTable,
  searchTable,
  searchTableText,
  searchSymbol,
  searchContent,
  tableMetadata,
  ensureFtsIndex,
  buildWhere,
  type SearchResult,
  type SearchFilters,
} from "../services/db";
import { getEmbedding } from "../services/ollama";
import { gitHeadPath } from "../services/git";
import { rrfMerge } from "../utils/rrf";
import { deriveSignature, matchIdentifierLines } from "../utils/text";

const INDEX_JOB = "index";

/** File basenames (without extension) commonly used as project entry points. */
const ENTRY_POINT_NAMES = new Set([
  "main", "index", "app", "cli", "server", "program", "__main__",
  "mod", "lib", "entry", "bootstrap", "start",
]);

export interface IndexJobPayload {
  target: IndexTarget;
  /** If true, the existing table+cache are cleared and indexed from scratch. */
  fresh?: boolean;
}

/** A result that also carries which project it came from in cross-project search. */
export interface ScopedSearchResult extends SearchResult {
  project: string;
  /** When the owning project was last indexed (ms epoch) — a freshness hint. */
  indexedAt?: number | null;
  /** Best-effort declaration signature derived from the chunk content. */
  signature?: string;
  /** N lines immediately before the chunk in the current file (if requested). */
  contextBefore?: string[];
  /** N lines immediately after the chunk in the current file (if requested). */
  contextAfter?: string[];
}

/** Search behavior: merge mode + metadata filters. */
export interface SearchOptions extends SearchFilters {
  /**
   * "hybrid" (default): vector + BM25, merged with RRF.
   * "vector": semantic vector search only.
   * "text": BM25/full-text search only.
   */
  mode?: "hybrid" | "vector" | "text" | undefined;
  /**
   * If > 0, include up to this many lines of surrounding context (read live from
   * the file on disk) before/after each result chunk. Default 0 (off).
   */
  contextLines?: number | undefined;
}

/** One occurrence of a symbol name found in the indexed code. */
export interface SymbolReference {
  project: string;
  filePath: string;
  /** 1-based line number of the occurrence. */
  line: number;
  /** The trimmed source line containing the occurrence. */
  text: string;
  /** The symbol that the containing chunk belongs to (if any). */
  inSymbol?: string;
  inSymbolType?: string;
}

/** Aggregated structural snapshot of a project (for agent onboarding). */
export interface RepoOverview {
  name: string;
  path: string;
  status: string;
  files: number;
  chunks: number;
  symbols: number;
  lastIndexedAt: number | null;
  embedModel: string | null;
  languages: { language: string; files: number; symbols: number }[];
  symbolTypes: { type: string; count: number }[];
  topDirectories: { dir: string; files: number }[];
  entryPoints: string[];
  largestFiles: { file: string; symbols: number }[];
}

/** Converts a project name to a safe LanceDB table name. */
function sanitize(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : "idx";
}

/**
 * The hub that manages multiple projects.
 * - Each project has an IndexRecord in the registry + its own `idx_<name>` LanceDB table.
 * - Indexing runs asynchronously via the job queue.
 * - One watcher is kept per project.
 * - restore(): when the daemon restarts, restores the watchers and resumes
 *   half-finished indexings.
 */
export class IndexManager {
  private watchers = new Map<string, FSWatcher>();
  private branchWatchers = new Map<string, FSWatcher>();
  private jobByIndex = new Map<string, string>();

  constructor(
    private registry: Registry,
    private jobQueue: JobQueue,
  ) {
    if (!this.jobQueue.hasHandler(INDEX_JOB)) {
      this.jobQueue.registerHandler<IndexJobPayload, IndexResult>(INDEX_JOB, (ctx) =>
        this.runIndexJob(ctx.payload, ctx),
      );
    }
    // Clean up the index↔job mapping when finished.
    this.jobQueue.on("finished", (job: { id: string }) => {
      for (const [name, id] of this.jobByIndex) {
        if (id === job.id) this.jobByIndex.delete(name);
      }
    });
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * Indexes a new project or refreshes an existing one for the same path.
   * THE WORK IS ASYNC: returns immediately, indexing continues in the background.
   */
  createIndex(dir: string, explicitName?: string): IndexRecord {
    const baseDir = path.resolve(dir);
    let name = explicitName ?? path.basename(baseDir);

    const existing = this.registry.getIndex(name);
    if (existing) {
      if (path.resolve(existing.path) === baseDir) {
        // The same project was added again → refresh.
        return this.reindex(name);
      }
      // Name conflict, different path → generate a unique name.
      name = this.uniqueName(name);
    }

    const tableName = this.uniqueTableName(name);
    const now = Date.now();
    this.registry.upsertIndex({
      name,
      path: baseDir,
      tableName,
      status: "indexing",
      fileCount: 0,
      chunkCount: 0,
      embedModel: CONFIG.OLLAMA_MODEL,
      embedDim: null,
      lastIndexedAt: null,
      createdAt: now,
      error: null,
    });

    const target: IndexTarget = { indexName: name, tableName, baseDir };
    this.enqueueIndex(target, false);
    this.ensureWatcher(target);
    return this.registry.getIndex(name)!;
  }

  /** Reindexes an existing project from scratch. */
  reindex(name: string): IndexRecord {
    const rec = this.registry.getIndex(name);
    if (!rec) throw new Error(`Index not found: ${name}`);
    if (rec.status === "indexing") return rec; // already in progress

    this.registry.setIndexStatus(name, "indexing");
    const target: IndexTarget = {
      indexName: rec.name,
      tableName: rec.tableName,
      baseDir: rec.path,
    };
    this.enqueueIndex(target, true);
    this.ensureWatcher(target);
    return this.registry.getIndex(name)!;
  }

  /**
   * INCREMENTALLY synchronizes an existing project (fresh=false):
   * - Unchanged files (mtime cache) are skipped.
   * - Changed/new files are reindexed.
   * - Files no longer on disk are cleaned up from the table + cache.
   * Much faster than a full reindex; ideal for catching up on changes that
   * happened while the daemon was down.
   */
  syncIndex(name: string): IndexRecord {
    const rec = this.registry.getIndex(name);
    if (!rec) throw new Error(`Index not found: ${name}`);
    if (rec.status === "indexing") return rec; // already in progress

    this.registry.setIndexStatus(name, "indexing");
    const target: IndexTarget = {
      indexName: rec.name,
      tableName: rec.tableName,
      baseDir: rec.path,
    };
    this.enqueueIndex(target, false);
    this.ensureWatcher(target);
    return this.registry.getIndex(name)!;
  }

  /**
   * Removes a project entirely: cancel job, close watcher, drop table+record.
   * DEEP CLEANUP: Also removes embedding cache and job records (zero traces).
   */
  async removeIndex(name: string): Promise<boolean> {
    const rec = this.registry.getIndex(name);
    if (!rec) return false;

    const jobId = this.jobByIndex.get(name);
    if (jobId) {
      // Send the cancel signal AND wait until the job has actually stopped:
      // otherwise an in-progress insertChunks could recreate the table AFTER
      // dropTable, leaving an orphan table not present in the registry.
      this.jobQueue.cancel(jobId);
      await this.jobQueue.waitForJob(jobId);
    }

    await this.watchers.get(name)?.close();
    this.watchers.delete(name);
    await this.branchWatchers.get(name)?.close();
    this.branchWatchers.delete(name);

    await dropTable(rec.tableName);
    // Deep cleanup: removes indexes, file_cache, AND stale job records
    this.registry.removeIndexDeep(name);
    this.jobByIndex.delete(name);
    return true;
  }

  listIndexes(): IndexRecord[] {
    return this.registry.listIndexes();
  }

  getIndex(name: string): IndexRecord | null {
    return this.registry.getIndex(name);
  }

  /** The job for a project still queued/running (if any) — for progress. */
  activeJob(name: string): Job | null {
    const id = this.jobByIndex.get(name);
    if (!id) return null;
    return this.jobQueue.getJob(id);
  }

  // ------------------------------------------------------------------ search

  /** Search within a single project (default: hybrid). */
  async searchIndex(
    name: string,
    query: string,
    limit = 5,
    opts?: SearchOptions,
  ): Promise<ScopedSearchResult[]> {
    const rec = this.registry.getIndex(name);
    if (!rec) throw new Error(`Index not found: ${name}`);
    const mode = opts?.mode ?? "hybrid";
    if (mode !== "text" && !this.modelMatches(rec)) {
      throw new Error(
        `'${name}' was indexed with model '${rec.embedModel}'; active model is '${CONFIG.OLLAMA_MODEL}'. ` +
          `Incompatible vectors. Fix: 'reindex ${name}' (or mode:"text").`,
      );
    }
    const vector = mode === "text" ? null : await getEmbedding(query);
    const rows = await this.searchOnTable(rec.tableName, query, vector, limit, opts);
    const scoped = rows.map((r) => this.scope(r, name, rec.lastIndexedAt));
    return this.enrich(scoped, opts?.contextLines ?? 0);
  }

  /** Search across all compatible projects; results are merged and ranked. */
  async searchAll(query: string, limit = 5, opts?: SearchOptions): Promise<ScopedSearchResult[]> {
    const mode = opts?.mode ?? "hybrid";
    const all = this.registry.listIndexes();
    // In "text" mode, model compatibility is not required (no vectors used).
    const indexes = mode === "text" ? all : all.filter((rec) => this.modelMatches(rec));
    if (mode !== "text") {
      const skipped = all.filter((rec) => !this.modelMatches(rec));
      if (skipped.length > 0) {
        console.error(
          `[manager] Projects excluded from the search due to model mismatch (reindex needed): ` +
            skipped.map((r) => r.name).join(", "),
        );
      }
    }
    if (indexes.length === 0) return [];
    const vector = mode === "text" ? null : await getEmbedding(query);

    const perTable = await Promise.all(
      indexes.map(async (rec) => {
        try {
          const rows = await this.searchOnTable(rec.tableName, query, vector, limit, opts);
          return rows.map((r) => this.scope(r, rec.name, rec.lastIndexedAt));
        } catch {
          return [] as ScopedSearchResult[];
        }
      }),
    );

    const ranked = this.rankCombined(perTable.flat(), mode).slice(0, limit);
    return this.enrich(ranked, opts?.contextLines ?? 0);
  }

  /**
   * Direct search by symbol name (exact/prefix). Does not use vectors, so it
   * requires no model compatibility and is fully precise. The engine of the
   * `find_symbol` tool.
   */
  async findSymbol(
    name: string,
    project?: string,
    limit = 20,
    filters?: SearchFilters,
  ): Promise<ScopedSearchResult[]> {
    const where = buildWhere(filters);
    if (project) {
      const rec = this.registry.getIndex(project);
      if (!rec) throw new Error(`Index not found: ${project}`);
      const rows = await searchSymbol(rec.tableName, name, limit, where);
      return this.enrich(rows.map((r) => this.scope(r, project, rec.lastIndexedAt)), 0);
    }
    const indexes = this.registry.listIndexes();
    const perTable = await Promise.all(
      indexes.map(async (rec) => {
        try {
          const rows = await searchSymbol(rec.tableName, name, limit, where);
          return rows.map((r) => this.scope(r, rec.name, rec.lastIndexedAt));
        } catch {
          return [] as ScopedSearchResult[];
        }
      }),
    );
    return this.enrich(perTable.flat().slice(0, limit), 0);
  }

  /** Wraps a raw row with project + freshness metadata. */
  private scope(r: SearchResult, project: string, indexedAt: number | null): ScopedSearchResult {
    return { ...r, project, indexedAt };
  }

  /**
   * Adds the derived signature to every result and, when contextLines > 0, reads
   * the surrounding lines from the file on disk. Context is read AFTER ranking/
   * slicing so only the final results trigger a file read.
   */
  private async enrich(rows: ScopedSearchResult[], contextLines: number): Promise<ScopedSearchResult[]> {
    for (const r of rows) {
      if (typeof r.content === "string" && r.content.length > 0) {
        r.signature = deriveSignature(r.content);
      }
    }
    if (contextLines > 0) {
      await Promise.all(rows.map((r) => this.attachContext(r, contextLines)));
    }
    return rows;
  }

  /** Reads up to `n` lines before/after the chunk from the current file. */
  private async attachContext(r: ScopedSearchResult, n: number): Promise<void> {
    if (r.startLine === undefined || r.endLine === undefined || !r.filePath) return;
    try {
      const lines = (await readFile(r.filePath, "utf-8")).split("\n");
      const before = lines.slice(Math.max(0, r.startLine - 1 - n), r.startLine - 1);
      const after = lines.slice(r.endLine, Math.min(lines.length, r.endLine + n));
      if (before.length > 0) r.contextBefore = before;
      if (after.length > 0) r.contextAfter = after;
    } catch {
      // File missing/changed — skip context silently (still a valid result).
    }
  }

  /**
   * Finds occurrences (usages) of a symbol NAME across the indexed code.
   *
   * Practical (non-LSP) approach: fetch candidate chunks whose content contains
   * the token (LIKE scan), then keep only WHOLE-identifier matches per line. This
   * leans on the existing schema (content + symbolName + line ranges) and finds
   * both the definition and call sites. `find_symbol` finds the definition only;
   * this answers "where is it used".
   */
  async findReferences(
    name: string,
    project?: string,
    limit = 50,
    filters?: SearchFilters,
  ): Promise<SymbolReference[]> {
    if (!name) return [];
    const where = buildWhere(filters);
    let targets: IndexRecord[];
    if (project) {
      const rec = this.registry.getIndex(project);
      if (!rec) throw new Error(`Index not found: ${project}`);
      targets = [rec];
    } else {
      targets = this.registry.listIndexes();
    }

    // Fetch a generous candidate pool per table; line-level expansion narrows it.
    const pool = Math.max(limit * 4, 50);
    const perTable = await Promise.all(
      targets.map(async (rec) => {
        try {
          const chunks = await searchContent(rec.tableName, name, pool, where);
          return this.expandReferences(chunks, rec.name, name);
        } catch {
          return [] as SymbolReference[];
        }
      }),
    );

    // Dedup by file:line (overlapping chunks can repeat a line) and cap.
    const seen = new Set<string>();
    const refs: SymbolReference[] = [];
    for (const ref of perTable.flat()) {
      const key = `${ref.project}\u0000${ref.filePath}\u0000${ref.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
    refs.sort((a, b) =>
      a.filePath === b.filePath ? a.line - b.line : a.filePath < b.filePath ? -1 : 1,
    );
    return refs.slice(0, limit);
  }

  /** Expands matching chunks into per-line references (whole-identifier matches). */
  private expandReferences(chunks: SearchResult[], project: string, name: string): SymbolReference[] {
    const out: SymbolReference[] = [];
    for (const c of chunks) {
      if (typeof c.content !== "string") continue;
      const base = typeof c.startLine === "number" ? c.startLine : 1;
      for (const m of matchIdentifierLines(c.content, base, name)) {
        const ref: SymbolReference = {
          project,
          filePath: c.filePath,
          line: m.line,
          text: m.text,
        };
        if (c.symbolName) ref.inSymbol = c.symbolName;
        if (c.symbolType) ref.inSymbolType = c.symbolType;
        out.push(ref);
      }
    }
    return out;
  }

  /**
   * Builds a structural snapshot of a project for agent onboarding: language and
   * symbol-type distribution, top-level directories, detected entry points and the
   * files with the most symbols. Aggregated cheaply from the registry + file cache
   * + chunk metadata — no LLM and no re-indexing involved.
   */
  async repoOverview(name: string): Promise<RepoOverview> {
    const rec = this.registry.getIndex(name);
    if (!rec) throw new Error(`Index not found: ${name}`);

    const files = this.registry.listCachedFiles(name);
    const meta = await tableMetadata(rec.tableName);

    const langFiles = new Map<string, Set<string>>();
    const langSymbols = new Map<string, number>();
    const symbolTypes = new Map<string, number>();
    const fileSymbols = new Map<string, number>();
    let symbolCount = 0;

    for (const m of meta) {
      const lang = m.language && m.language.length > 0 ? m.language : "(other)";
      if (!langFiles.has(lang)) langFiles.set(lang, new Set());
      langFiles.get(lang)!.add(m.filePath);
      if (m.symbolName && m.symbolName.length > 0) {
        symbolCount++;
        langSymbols.set(lang, (langSymbols.get(lang) ?? 0) + 1);
        const st = m.symbolType && m.symbolType.length > 0 ? m.symbolType : "code";
        symbolTypes.set(st, (symbolTypes.get(st) ?? 0) + 1);
        fileSymbols.set(m.filePath, (fileSymbols.get(m.filePath) ?? 0) + 1);
      }
    }

    const languages = [...langFiles.entries()]
      .map(([language, set]) => ({ language, files: set.size, symbols: langSymbols.get(language) ?? 0 }))
      .sort((a, b) => b.files - a.files);

    const symbolTypeList = [...symbolTypes.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);

    // Top-level directories relative to the project root.
    const dirCounts = new Map<string, number>();
    for (const f of files) {
      const rel = path.relative(rec.path, f);
      const seg = rel.split(path.sep)[0] ?? rel;
      const dir = !seg || seg.startsWith("..") ? "(root)" : rel.includes(path.sep) ? seg : "(root)";
      dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
    }
    const topDirectories = [...dirCounts.entries()]
      .map(([dir, count]) => ({ dir, files: count }))
      .sort((a, b) => b.files - a.files)
      .slice(0, 12);

    const entryPoints = files
      .filter((f) => ENTRY_POINT_NAMES.has(path.basename(f, path.extname(f)).toLowerCase()))
      .map((f) => path.relative(rec.path, f))
      .slice(0, 20);

    const largestFiles = [...fileSymbols.entries()]
      .map(([file, symbols]) => ({ file: path.relative(rec.path, file), symbols }))
      .sort((a, b) => b.symbols - a.symbols)
      .slice(0, 10);

    return {
      name: rec.name,
      path: rec.path,
      status: rec.status,
      files: rec.fileCount,
      chunks: rec.chunkCount,
      symbols: symbolCount,
      lastIndexedAt: rec.lastIndexedAt,
      embedModel: rec.embedModel,
      languages,
      symbolTypes: symbolTypeList,
      topDirectories,
      entryPoints,
      largestFiles,
    };
  }

  /** Searches a table according to the chosen mode (hybrid/vector/text). */
  private async searchOnTable(
    table: string,
    query: string,
    vector: number[] | null,
    limit: number,
    opts?: SearchOptions,
  ): Promise<SearchResult[]> {
    const where = buildWhere(opts);
    const mode = opts?.mode ?? "hybrid";

    if (mode === "vector") return searchTable(table, vector!, limit, where);
    if (mode === "text") return searchTableText(table, query, limit, where);

    // hybrid: vector + BM25 → RRF
    const pool = Math.max(limit * 3, 10);
    const [vec, fts] = await Promise.all([
      searchTable(table, vector!, pool, where),
      searchTableText(table, query, pool, where),
    ]);
    // If the FTS index isn't built yet (old table), fall back to vector only.
    if (fts.length === 0) return vec.slice(0, limit);
    const merged = rrfMerge([vec, fts], (r) => String(r.id), 60);
    return merged.slice(0, limit).map(({ item, score }) => ({ ...item, _score: score }));
  }

  /** Sorts cross-project results by the metric appropriate for the mode. */
  private rankCombined(rows: ScopedSearchResult[], mode: string): ScopedSearchResult[] {
    if (mode === "vector") {
      return rows
        .filter((r) => r._distance !== undefined)
        .sort((a, b) => a._distance! - b._distance!);
    }
    // hybrid/text → higher score first
    return rows.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  }

  /** Is the index compatible with the active embedding model? (compatible if no model recorded.) */
  private modelMatches(rec: IndexRecord): boolean {
    return !rec.embedModel || rec.embedModel === CONFIG.OLLAMA_MODEL;
  }

  // ----------------------------------------------------------------- restore

  /**
   * Called at daemon startup:
   * - Marks job rows left over from the previous run as 'failed'.
   * - Restores watchers for 'ready' projects.
   * - Re-enqueues half-finished ('indexing') projects.
   */
  restore(): void {
    const interrupted = this.registry.markInterruptedJobs();
    if (interrupted > 0) {
      console.error(`[manager] ${interrupted} interrupted jobs marked 'failed'.`);
    }

    for (const rec of this.registry.listIndexes()) {
      const target: IndexTarget = {
        indexName: rec.name,
        tableName: rec.tableName,
        baseDir: rec.path,
      };
      this.ensureWatcher(target);
      // Both half-finished ('indexing') and 'ready' projects are incrementally
      // synced: files added/changed/deleted while the daemon was down are caught
      // (thanks to the mtime cache + deleted-file cleanup).
      // Search continues uninterrupted on the existing data meanwhile.
      if (rec.status === "indexing") {
        console.error(`[manager] '${rec.name}' was half-finished, resuming indexing.`);
        this.registry.setIndexStatus(rec.name, "indexing");
        this.enqueueIndex(target, false);
      } else if (rec.status === "ready") {
        console.error(`[manager] '${rec.name}' is syncing at startup (offline changes).`);
        this.registry.setIndexStatus(rec.name, "indexing");
        this.enqueueIndex(target, false);
      }
      // 'error' projects are left untouched; the user can reindex/sync them.
    }
  }

  /** Closes open watchers (graceful shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    await Promise.all([...this.branchWatchers.values()].map((w) => w.close()));
    this.watchers.clear();
    this.branchWatchers.clear();
  }

  // ------------------------------------------------------------------ private

  private async runIndexJob(
    payload: IndexJobPayload,
    ctx: { signal: AbortSignal; isCancelled: () => boolean; updateProgress: (p: number, t?: number, m?: string) => void },
  ): Promise<IndexResult> {
    const t = payload.target;
    if (payload.fresh) {
      await dropTable(t.tableName);
      this.registry.clearFileCache(t.indexName);
    }
    try {
      const result = await indexDirectory(t, {
        signal: ctx.signal,
        registry: this.registry,
        onProgress: (processed, total, file) => ctx.updateProgress(processed, total, file),
      });
      if (ctx.isCancelled()) {
        // Cancellation usually happens during remove; the record may already be deleted.
        if (this.registry.getIndex(t.indexName)) {
          this.registry.setIndexStatus(t.indexName, "error", "indexing cancelled");
        }
      } else {
        this.registry.setIndexStats(t.indexName, result.files, result.chunks, Date.now());
        if (result.dim !== null) {
          this.registry.setIndexEmbedding(t.indexName, CONFIG.OLLAMA_MODEL, result.dim);
        }
        this.registry.setIndexStatus(t.indexName, "ready");
        const pruned = this.registry.pruneEmbeddingCache(CONFIG.EMBED_CACHE_MAX);
        console.error(
          `[index] '${t.indexName}' ready: ${result.files} files, ${result.chunks} chunks` +
            (result.deleted > 0 ? `, ${result.deleted} deleted cleaned up` : "") +
            ` → ${t.tableName}` +
            (pruned > 0 ? ` (cache prune: ${pruned})` : ""),
        );
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.registry.getIndex(t.indexName)) {
        this.registry.setIndexStatus(t.indexName, "error", msg);
      }
      throw err;
    }
  }

  private enqueueIndex(target: IndexTarget, fresh: boolean): void {
    const id = this.jobQueue.enqueue<IndexJobPayload>(INDEX_JOB, { target, fresh });
    this.jobByIndex.set(target.indexName, id);
  }

  private ensureWatcher(target: IndexTarget): void {
    if (this.watchers.has(target.indexName)) return;
    const w = startWatcher(target, {
      registry: this.registry,
      // While a full index/sync is running, the watcher should not write individual files (race avoidance).
      isBusy: () => this.isIndexing(target.indexName),
    });
    this.watchers.set(target.indexName, w);
    this.ensureBranchWatcher(target);
  }

  /**
   * Watches the `.git/HEAD` file; on a branch change (checkout/switch),
   * incrementally syncs the project. Since the working tree changes, the new
   * branch's files are picked up. No-op if it's not a git repo.
   */
  private ensureBranchWatcher(target: IndexTarget): void {
    if (this.branchWatchers.has(target.indexName)) return;
    const headPath = gitHeadPath(target.baseDir);
    if (!headPath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const w = chokidar.watch(headPath, { persistent: true, ignoreInitial: true });
    const onChange = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        console.error(`[manager] '${target.indexName}' branch change detected → incremental sync.`);
        try {
          this.syncIndex(target.indexName);
        } catch (e) {
          console.error(`[manager] failed to start branch sync:`, e);
        }
      }, 500);
    };
    w.on("change", onChange).on("add", onChange).on("error", (err: unknown) => {
      console.error(`[manager] '${target.indexName}' branch watcher error:`, err);
    });
    this.branchWatchers.set(target.indexName, w);
  }

  /** Is there a queued/running indexing job for this project? */
  private isIndexing(name: string): boolean {
    const job = this.activeJob(name);
    return !!job && (job.status === "running" || job.status === "queued");
  }

  private uniqueName(base: string): string {
    let candidate = base;
    let n = 2;
    while (this.registry.getIndex(candidate)) {
      candidate = `${base}-${n++}`;
    }
    return candidate;
  }

  private uniqueTableName(name: string): string {
    const used = new Set(this.registry.listIndexes().map((r) => r.tableName));
    const base = `idx_${sanitize(name)}`;
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base}_${n}`)) n++;
    return `${base}_${n}`;
  }
}
