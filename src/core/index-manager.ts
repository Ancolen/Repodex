import path from "node:path";
import { statSync } from "node:fs";
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
  countTableRows,
  dropTable,
  searchTable,
  searchTableText,
  searchSymbol,
  searchContent,
  tableMetadata,
  tableSymbolsWithContent,
  tableColumns,
  ensureFtsIndex,
  buildWhere,
  type SearchResult,
  type SearchFilters,
} from "../services/db";
import { cachedEmbed, getEmbedding } from "../services/ollama";
import { readProjectConfig } from "./project-config";
import { rerankScores } from "../services/rerank";
import { selectMMR } from "../utils/mmr";
import { applyCharBudget } from "../utils/budget";
import { gitHeadPath, isGitRepo, searchGitLog } from "../services/git";
import { rrfMerge } from "../utils/rrf";
import { deriveSignature, matchIdentifierLines } from "../utils/text";
import { extractImports } from "../chunking/imports";
import { resolveImports, buildFileIndex, type ResolvedDep } from "./resolve";
import {
  countReferences,
  scoreDeadCode,
  matchNamesFor,
  type CountSymbol,
  type CountChunk,
  type DeadSignal,
} from "./deadcode";
import { buildCallEdges, traverseCallGraph, matchRootSymbols } from "./callgraph";
import type { CallSymbol, CallChunk, CallGraphNode } from "./callgraph";
export type { CallGraphNode } from "./callgraph";
import type { CommitHit, CommitQueryOpts } from "./commits";
export type { CommitHit, CommitQueryOpts } from "./commits";
import { mapWithConcurrency } from "../utils/concurrency";

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

/** One query's worth of batch-search results (`searchBatch`). */
export interface BatchSearchGroup {
  query: string;
  results: ScopedSearchResult[];
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
  /**
   * Override the default second-stage reranker behavior for this call.
   * - true  → rerank even if disabled in config (no-op if no reranker model is configured).
   * - false → skip reranking even if enabled in config.
   * - undefined → use CONFIG.RERANK_ENABLED.
   */
  rerank?: boolean | undefined;
  /**
   * Override the default MMR diversification for this call.
   * - true  → diversify even if disabled in config.
   * - false → skip diversification even if enabled in config.
   * - undefined → use CONFIG.MMR_ENABLED.
   */
  mmr?: boolean | undefined;
  /**
   * If > 0, cap the returned results to an approximate character budget: results
   * are kept in ranked order (whole, never truncated mid-chunk) while they fit,
   * so a high `limit` can be used for recall without bloating the caller's
   * context. Always keeps at least the top result. Default undefined (no cap).
   */
  maxChars?: number | undefined;
  /**
   * Override the docstring retrieval legs for this call (tables indexed with
   * `indexing.docstrings` carry a `doc_vector` + `doc` column per chunk).
   * - false → skip the doc legs even if the table has them.
   * - true/undefined → include them when the columns exist (default on).
   */
  doc?: boolean | undefined;
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

/** One import edge of a file: a specifier resolved (or not) to an indexed file. */
export interface DependencyEdge {
  raw: string;
  language: string;
  line: number;
  /** Absolute path when resolved to an indexed file. */
  path?: string;
  /** Repo-relative path when resolved. */
  relativePath?: string;
  status: "resolved" | "external" | "unresolved";
  reason?: string;
}

/** Result of `get_dependencies`: what a file imports + who imports it. */
export interface DependencyResult {
  project: string;
  file: string;
  relativeFile: string;
  imports: DependencyEdge[];
  /** Repo-relative paths of files that import the queried file. */
  importedBy: string[];
  /** The reverse list was capped at the call's `limit`. */
  truncated: boolean;
  /** Files scanned to build the reverse graph (the first call is the costly one). */
  scannedFiles: number;
}

/** A single candidate dead symbol (a zero-reference symbol that survived scoring). */
export interface DeadCodeResult {
  project: string;
  symbolName: string;
  symbolType: string;
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  language?: string;
  signature?: string;
  referenceCount: number;
  signals: DeadSignal[];
  confidence: number;
  category: "likely dead" | "uncertain" | "review";
}

/** Result of `find_dead_code`: scored zero-reference symbols for one project. */
export interface DeadCodeReport {
  project: string;
  results: DeadCodeResult[];
  scannedSymbols: number;
  scannedChunks: number;
  /** The table hit the row cap — coverage is partial (reindex/raise to be exhaustive). */
  truncated: boolean;
}

/** Result of `get_call_graph`: caller/callee trees rooted at the anchor symbol(s). */
export interface CallGraphResult {
  project: string;
  /** Anchor symbol(s): one if a unique symbol was named, several for a file/ambiguous name. */
  roots: CallGraphNode[];
  direction: "callers" | "callees" | "both";
  depth: number;
  /** Trees of who calls each root (empty when direction excludes callers). */
  callers: CallGraphNode[];
  /** Trees of what each root calls (empty when direction excludes callees). */
  callees: CallGraphNode[];
  scannedSymbols: number;
  /** The node budget or table cap was hit — the graph is partial (raise --limit for more). */
  truncated: boolean;
}

/** Result of `searchCommits`: git-history / commit-message matches for a project. */
export interface CommitSearchResult {
  project: string;
  /** The message query that was run (absent for a pure path/author/date filter). */
  query?: string;
  count: number;
  commits: CommitHit[];
  /** The commit limit was hit — older matching commits exist beyond it (raise --limit). */
  truncated: boolean;
  /** The project directory is not a git repo — no history to search. */
  notARepo: boolean;
}

/** Converts a project name to a safe LanceDB table name. */
function sanitize(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : "idx";
}

/** Symbol types worth checking for dead code (skip `code`/`impl`/anonymous). */
const DEAD_CANDIDATE_TYPES = new Set([
  "function", "method", "class", "interface", "enum", "struct", "trait", "record",
]);

/** Symbol types that can make/receive a call (the call-graph inventory). */
const CALLABLE_TYPES = new Set(["function", "method", "constructor"]);

/** Empty adjacency, reused to render depth-0 root nodes via `traverseCallGraph`. */
const EMPTY_ADJ: Map<string, Set<string>> = new Map();

/** Test-file patterns: symbols here are exercised indirectly, so never dead. */
function isTestFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  const norm = filePath.replace(/\\/g, "/");
  if (/^test_/.test(base)) return true; // test_*.py / test_*.go
  if (/_test\.[a-z0-9]+$/.test(base)) return true; // foo_test.go
  if (/\.(test|spec)\.[a-z0-9]+$/.test(base)) return true; // foo.test.ts / bar.spec.js
  if (/(^|\/)(tests?|__tests?__|spec)\//.test(norm)) return true; // tests/, __tests__/, spec/
  return false;
}

/** Entry-point files (main/index/app/…): their symbols are called by the runtime. */
function isEntryPointFile(filePath: string): boolean {
  const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
  return ENTRY_POINT_NAMES.has(base);
}

/** A cached, mtime-keyed import graph for one project (reverse deps are on-demand). */
interface DepGraph {
  forward: Map<string, string[]>; // importer abs path → resolved imported abs paths
  reverse: Map<string, string[]>; // imported abs path → importer abs paths
  fileMtimes: Map<string, number>;
  scannedFiles: number;
}
interface DepGraphCacheEntry {
  /** Join of the indexed-file set; a change invalidates the cache. */
  setKey: string;
  graph: DepGraph;
}

/** A cached call-graph adjacency for one project (rebuilt when the index changes). */
interface CallGraphCacheEntry {
  /** `IndexRecord.lastIndexedAt`; a change invalidates the cache (data lives in LanceDB, not on disk). */
  lastIndexedAt: number | null;
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  /** key → symbol metadata (node rendering). */
  symbolsByKey: Map<string, CallSymbol>;
  /** stored symbolName → symbols (anchor resolution by name). */
  nameToSymbols: Map<string, CallSymbol[]>;
  scannedSymbols: number;
  truncated: boolean;
}

/** Converts a ResolvedDep into the edge shape we return. */
function toEdge(dep: ResolvedDep, projectRoot: string): DependencyEdge {
  const edge: DependencyEdge = {
    raw: dep.raw,
    language: dep.language,
    line: dep.line,
    status: dep.status,
  };
  if (dep.resolvedPath) edge.path = dep.resolvedPath;
  if (dep.relativePath) edge.relativePath = dep.relativePath;
  else if (dep.resolvedPath) {
    const rel = path.relative(projectRoot, dep.resolvedPath);
    if (rel && !rel.startsWith("..")) edge.relativePath = rel;
  }
  if (dep.reason) edge.reason = dep.reason;
  return edge;
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
  /** On-demand, mtime-keyed reverse-dependency graph, one entry per project. */
  private depGraphCache = new Map<string, DepGraphCacheEntry>();
  /** On-demand call-graph adjacency, one entry per project (keyed on lastIndexedAt). */
  private callGraphCache = new Map<string, CallGraphCacheEntry>();

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
      // A per-project model override (.cidx.json `embedModel`) wins over the
      // global config; the record pins the model the table is built with.
      embedModel: readProjectConfig(baseDir)?.embedModel ?? CONFIG.OLLAMA_MODEL,
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

    // A changed per-project embedding model (.cidx.json) can't be applied
    // incrementally — vectors from two models can never share a table. Escalate
    // to a full reindex, which rewrites every file with the new model.
    const pcfgModel = readProjectConfig(rec.path)?.embedModel;
    if (pcfgModel && rec.embedModel && pcfgModel !== rec.embedModel) {
      console.error(
        `[manager] '${name}' .cidx.json embedModel changed (${rec.embedModel} → ${pcfgModel}); reindexing from scratch.`,
      );
      return this.reindex(name);
    }

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
    this.depGraphCache.delete(name);
    this.callGraphCache.delete(name);
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
    // The query is embedded with the model the table was built with (the record
    // pins it — global config or a .cidx.json per-project override), so vectors
    // are always comparable. A legacy record without a model falls back to the
    // global config.
    const projectModel = rec.embedModel ?? CONFIG.OLLAMA_MODEL;
    const vector =
      mode === "text" ? null : await cachedEmbed(query, projectModel, this.registry, (t) => getEmbedding(t, projectModel));
    const rerankOn = this.wantRerank(opts);
    const mmrOn = this.wantMMR(opts);
    const fetchLimit = rerankOn || mmrOn ? Math.max(limit, CONFIG.RERANK_TOP_K, CONFIG.MMR_TOP_K) : limit;
    const rows = await this.searchOnTable(rec.tableName, query, vector, fetchLimit, opts);
    const refined = await this.refineAndSlice(rows, query, limit, mode, rerankOn, mmrOn);
    const scoped = refined.map((r) => this.scope(r, name, rec.lastIndexedAt));
    const enriched = await this.enrich(scoped, opts?.contextLines ?? 0);
    return applyCharBudget(enriched, opts?.maxChars);
  }

  /** Search across all projects; results are merged and ranked. */
  async searchAll(query: string, limit = 5, opts?: SearchOptions): Promise<ScopedSearchResult[]> {
    const mode = opts?.mode ?? "hybrid";
    const indexes = this.registry.listIndexes();
    if (indexes.length === 0) return [];
    const rerankOn = this.wantRerank(opts);
    const mmrOn = this.wantMMR(opts);
    const fetchLimit = rerankOn || mmrOn ? Math.max(limit, CONFIG.RERANK_TOP_K, CONFIG.MMR_TOP_K) : limit;

    const perTable = await Promise.all(
      indexes.map(async (rec) => {
        try {
          // Each table is queried with a vector embedded by the model the table
          // was built with (per-project overrides make models differ between
          // projects). Caveat: cross-project ranking mixes distances from
          // different embedding spaces when models differ.
          const model = rec.embedModel ?? CONFIG.OLLAMA_MODEL;
          const vector = mode === "text" ? null : await cachedEmbed(query, model, this.registry, (t) => getEmbedding(t, model));
          const rows = await this.searchOnTable(rec.tableName, query, vector, fetchLimit, opts);
          return rows.map((r) => this.scope(r, rec.name, rec.lastIndexedAt));
        } catch {
          return [] as ScopedSearchResult[];
        }
      }),
    );

    const ranked = this.rankCombined(perTable.flat(), mode);
    const refined = await this.refineAndSlice(ranked, query, limit, mode, rerankOn, mmrOn);
    const enriched = await this.enrich(refined, opts?.contextLines ?? 0);
    return applyCharBudget(enriched, opts?.maxChars);
  }

  /**
   * Runs several queries concurrently in a single round-trip. Duplicate /
   * blank query strings are de-duped; each query reuses searchIndex/searchAll
   * (so rerank/MMR/maxChars + the shared query cache apply per query). Returns
   * one group per distinct query, in first-seen order.
   */
  async searchBatch(
    queries: string[],
    project: string | undefined,
    limit = 5,
    opts?: SearchOptions,
  ): Promise<BatchSearchGroup[]> {
    const uniq = [...new Set(queries.map((q) => q.trim()).filter((q) => q.length > 0))];
    if (uniq.length === 0) return [];
    return Promise.all(
      uniq.map(async (query) => {
        const results = project
          ? await this.searchIndex(project, query, limit, opts)
          : await this.searchAll(query, limit, opts);
        return { query, results };
      }),
    );
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

  // ------------------------------------------------------------- dependencies

  /**
   * What does a file import, and who imports it?
   * - Forward (imports): read the file, parse its imports (tree-sitter), resolve
   *   each specifier against the indexed-file set (resolved / external / unresolved).
   * - Reverse (imported-by): from the on-demand, mtime-cached import graph. The
   *   first call per project pays the cost of parsing every indexed file's imports;
   *   later calls are free until a file's mtime changes (watcher-reflecting).
   */
  async getDependencies(
    filePath: string,
    project?: string,
    opts?: { limit?: number },
  ): Promise<DependencyResult> {
    const abs = path.resolve(filePath);
    const rec = this.resolveProjectForFile(abs, project);
    const limit = opts?.limit ?? 200;

    let content: string;
    try {
      content = await readFile(abs, "utf-8");
    } catch (err) {
      throw new Error(`Cannot read '${abs}': ${err instanceof Error ? err.message : err}`);
    }

    const specs = await extractImports(abs, content);
    const indexedFiles = this.registry.listCachedFiles(rec.name);
    const imports =
      specs.length === 0
        ? []
        : resolveImports(specs, rec.path, buildFileIndex(new Set(indexedFiles)), abs).map((d) =>
            toEdge(d, rec.path),
          );

    const graph = await this.buildImportGraph(rec);
    const reverse = graph.reverse.get(abs) ?? [];
    const importedBy = reverse.slice(0, limit).map((f) => path.relative(rec.path, f));

    return {
      project: rec.name,
      file: abs,
      relativeFile: path.relative(rec.path, abs),
      imports,
      importedBy,
      truncated: reverse.length > limit,
      scannedFiles: graph.scannedFiles,
    };
  }

  /**
   * Call graph for a symbol and/or file: who calls it (callers) and what it calls
   * (callees), as bounded, cycle-safe trees. Adjacency comes from whole-identifier
   * matching over chunk content (same discipline as `find_references` /
   * `find_dead_code`), so this is additive — no schema change, no reindex.
   *
   * The per-project adjacency is cached and keyed on `lastIndexedAt` (not file
   * mtimes): it is built from LanceDB rows, which can change on a re-chunk even
   * when source mtimes do not. The first call per project pays the scan; later
   * calls are instant until the project is reindexed.
   */
  async getCallGraph(opts: {
    symbol?: string;
    path?: string;
    project?: string;
    direction?: "callers" | "callees" | "both";
    depth?: number;
    limit?: number;
  }): Promise<CallGraphResult> {
    const symbol = opts.symbol?.trim();
    const filePath = opts.path?.trim();
    if (!symbol && !filePath) {
      throw new Error("getCallGraph needs a symbol name and/or a file path.");
    }
    const direction = opts.direction ?? "both";
    const depth = opts.depth ?? 3;
    const limit = opts.limit ?? 100;

    // Resolve the project: from the file path, the explicit name, or the single
    // indexed project. (The anchor may be a symbol with no file, so we can't
    // always infer from a path like `getDependencies` does.)
    let rec: IndexRecord;
    let absFile: string | undefined;
    if (filePath) {
      absFile = path.resolve(filePath);
      rec = this.resolveProjectForFile(absFile, opts.project);
    } else if (opts.project) {
      const r = this.registry.getIndex(opts.project);
      if (!r) throw new Error(`Index not found: ${opts.project}`);
      rec = r;
    } else {
      const all = this.registry.listIndexes();
      if (all.length === 0) throw new Error("No indexed project; index a directory first.");
      if (all.length > 1) {
        throw new Error(
          `'${symbol}' could belong to multiple projects (${all.map((p) => p.name).join(", ")}); pass --project.`,
        );
      }
      rec = all[0]!;
    }

    const graph = await this.buildCallGraph(rec);
    const { forward, reverse, symbolsByKey, nameToSymbols, scannedSymbols, truncated: scanTruncated } = graph;

    // Resolve anchor keys. `matchRootSymbols` mirrors `find_symbol` so a bare
    // method name (e.g. `getDependencies`) resolves to its `Class.method` form.
    let matched: CallSymbol[];
    if (symbol) {
      matched = matchRootSymbols(nameToSymbols, symbol);
      if (absFile) matched = matched.filter((s) => s.filePath === absFile);
      if (matched.length === 0) {
        const where = absFile ? ` in ${path.relative(rec.path, absFile)}` : "";
        throw new Error(`No callable symbol '${symbol}' found${where} (project: ${rec.name}).`);
      }
    } else {
      matched = absFile
        ? [...symbolsByKey.values()].filter((s) => s.filePath === absFile)
        : [];
      if (matched.length === 0) {
        throw new Error(
          `No callable symbols found in '${path.relative(rec.path, absFile!)}' (project: ${rec.name}).`,
        );
      }
    }
    const rootKeys = [...new Set(matched.map((s) => s.key))];

    const wantCallers = direction === "callers" || direction === "both";
    const wantCallees = direction === "callees" || direction === "both";

    const rootNodes = traverseCallGraph(rootKeys, EMPTY_ADJ, symbolsByKey, rec.path, 0, limit).nodes;
    const callersRes = wantCallers
      ? traverseCallGraph(rootKeys, reverse, symbolsByKey, rec.path, depth, limit)
      : null;
    const calleesRes = wantCallees
      ? traverseCallGraph(rootKeys, forward, symbolsByKey, rec.path, depth, limit)
      : null;

    return {
      project: rec.name,
      roots: rootNodes,
      direction,
      depth,
      callers: callersRes?.nodes ?? [],
      callees: calleesRes?.nodes ?? [],
      scannedSymbols,
      truncated: scanTruncated || (callersRes?.truncated ?? false) || (calleesRes?.truncated ?? false),
    };
  }

  /**
   * Git-history / commit-message search for a project: runs `git log` in the
   * project root and returns matching commits ("when / why was feature X added",
   * "who changed this file"). Live — no indexing, no embedding, no reindex
   * (additive, like `getDependencies` / `findDeadCode`). Filters by message
   * (`query`), path, author, and date range; `withFiles` appends changed files.
   * Returns `notARepo: true` when the directory isn't a git working tree.
   */
  async searchCommits(
    project: string,
    opts?: CommitQueryOpts,
  ): Promise<CommitSearchResult> {
    const rec = this.registry.getIndex(project);
    if (!rec) throw new Error(`Index not found: ${project}`);
    const limit = opts?.limit ?? 50;
    if (!(await isGitRepo(rec.path))) {
      return { project, count: 0, commits: [], truncated: false, notARepo: true };
    }
    const commits = await searchGitLog(rec.path, opts ?? {});
    const result: CommitSearchResult = {
      project,
      count: commits.length,
      commits,
      truncated: commits.length >= limit,
      notARepo: false,
    };
    if (opts?.query) result.query = opts.query;
    return result;
  }

  /**
   * Builds (and caches) the project's caller→callee adjacency from one
   * `tableSymbolsWithContent` pass. The cache is keyed on `lastIndexedAt`: the
   * data lives in LanceDB, so file mtimes are not a correct freshness signal (a
   * chunker bump or embedding-only reindex rewrites rows without moving mtimes).
   */
  private async buildCallGraph(rec: IndexRecord): Promise<CallGraphCacheEntry> {
    const cached = this.callGraphCache.get(rec.name);
    if (cached && cached.lastIndexedAt === rec.lastIndexedAt) return cached;

    const allRows = await tableSymbolsWithContent(rec.tableName);
    const truncated = allRows.length >= 200000;

    // Inventory: callable symbols, deduped by (name, file), keeping the min start
    // line as the declaration and the longest content for signature recovery.
    const byKey = new Map<string, CallSymbol>();
    for (const r of allRows) {
      const name = r.symbolName;
      const st = r.symbolType;
      if (!name || !st || !CALLABLE_TYPES.has(st)) continue;
      if (typeof r.startLine !== "number" || typeof r.endLine !== "number") continue;
      const content = typeof r.content === "string" ? r.content : "";
      const key = `${name}\0${r.filePath}`;
      const ex = byKey.get(key);
      if (!ex) {
        const sym: CallSymbol = {
          key,
          symbolName: name,
          symbolType: st,
          matchNames: matchNamesFor(name),
          filePath: r.filePath,
          declarationLine: r.startLine,
          endLine: r.endLine,
          content,
        };
        if (r.language) sym.language = r.language;
        byKey.set(key, sym);
      } else {
        ex.declarationLine = Math.min(ex.declarationLine, r.startLine);
        ex.endLine = Math.max(ex.endLine, r.endLine);
        if (content.length > (ex.content?.length ?? 0)) ex.content = content;
      }
    }
    const symbols = [...byKey.values()];

    // Bodies to scan: every callable chunk, tagged with its caller key (so a
    // function split across chunks is scanned in full).
    const chunks: CallChunk[] = [];
    for (const r of allRows) {
      const name = r.symbolName;
      const st = r.symbolType;
      if (!name || !st || !CALLABLE_TYPES.has(st)) continue;
      if (typeof r.startLine !== "number") continue;
      const content = typeof r.content === "string" ? r.content : "";
      if (!content) continue;
      chunks.push({
        callerKey: `${name}\0${r.filePath}`,
        filePath: r.filePath,
        startLine: r.startLine,
        content,
      });
    }

    const { forward, reverse } = buildCallEdges(symbols, chunks);

    const nameToSymbols = new Map<string, CallSymbol[]>();
    for (const s of symbols) {
      let arr = nameToSymbols.get(s.symbolName);
      if (!arr) {
        arr = [];
        nameToSymbols.set(s.symbolName, arr);
      }
      arr.push(s);
    }
    const symbolsByKey = new Map<string, CallSymbol>();
    for (const s of symbols) symbolsByKey.set(s.key, s);

    const entry: CallGraphCacheEntry = {
      lastIndexedAt: rec.lastIndexedAt,
      forward,
      reverse,
      symbolsByKey,
      nameToSymbols,
      scannedSymbols: symbols.length,
      truncated,
    };
    this.callGraphCache.set(rec.name, entry);
    return entry;
  }

  /**
   * Conservative dead-code detection for one project: symbols with zero
   * whole-identifier references anywhere, scored by a multi-signal model that is
   * reluctant to flag anything reachable via export/polymorphism/dynamic-call.
   * Single pass over all chunk content; no reindex required.
   */
  async findDeadCode(
    project: string,
    opts?: { language?: string; symbolType?: string; minConfidence?: number; limit?: number },
  ): Promise<DeadCodeReport> {
    const rec = this.registry.getIndex(project);
    if (!rec) throw new Error(`Index not found: ${project}`);
    const minConfidence = opts?.minConfidence ?? 0;
    const limit = opts?.limit ?? 200;

    const allRows = await tableSymbolsWithContent(rec.tableName);
    const truncated = allRows.length >= 200000;

    // Optional language/symbolType filters shrink the scanned set (and the regex).
    const rows = allRows.filter((r) => {
      if (opts?.language && r.language !== opts.language) return false;
      if (opts?.symbolType && r.symbolType !== opts.symbolType) return false;
      return true;
    });

    // Candidate inventory: real symbols, deduped by (symbolName, filePath), keeping
    // the min start line as the declaration line and the longest content chunk for
    // signature/export recovery.
    const byKey = new Map<
      string,
      {
        symbolName: string;
        symbolType: string;
        filePath: string;
        language: string;
        declLine: number;
        endLine: number;
        content: string;
      }
    >();
    for (const r of rows) {
      const name = r.symbolName;
      const st = r.symbolType;
      if (!name || !st || !DEAD_CANDIDATE_TYPES.has(st)) continue;
      if (typeof r.startLine !== "number" || typeof r.endLine !== "number") continue;
      const content = typeof r.content === "string" ? r.content : "";
      const key = `${name} ${r.filePath}`;
      const ex = byKey.get(key);
      if (!ex) {
        byKey.set(key, {
          symbolName: name,
          symbolType: st,
          filePath: r.filePath,
          language: r.language ?? "",
          declLine: r.startLine,
          endLine: r.endLine,
          content,
        });
      } else {
        ex.declLine = Math.min(ex.declLine, r.startLine);
        ex.endLine = Math.max(ex.endLine, r.endLine);
        if (content.length > ex.content.length) ex.content = content;
      }
    }

    // Pre-filter: drop test files and entry points entirely.
    const candidates = [...byKey.values()].filter(
      (c) => !isTestFile(c.filePath) && !isEntryPointFile(c.filePath),
    );
    const scannedSymbols = candidates.length;

    // Common-name detection: the bare name is shared by > 3 distinct symbols.
    const nameCount = new Map<string, number>();
    for (const c of candidates) {
      const bare = c.symbolName.split(".").pop() ?? c.symbolName;
      nameCount.set(bare, (nameCount.get(bare) ?? 0) + 1);
    }

    const countSymbols: CountSymbol[] = candidates.map((c) => ({
      key: `${c.symbolName} ${c.filePath} ${c.declLine}`,
      matchNames: matchNamesFor(c.symbolName),
      filePath: c.filePath,
      declarationLine: c.declLine,
    }));
    const countChunks: CountChunk[] = rows
      .filter((r) => typeof r.content === "string" && r.content.length > 0)
      .map((r) => ({
        filePath: r.filePath,
        startLine: typeof r.startLine === "number" ? r.startLine : 1,
        content: r.content ?? "",
      }));

    const refCounts = countReferences(countSymbols, countChunks);

    // Per (file, symbol-name) reference totals — used for owner-class lookups.
    const refsByNameFile = new Map<string, number>();
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const cnt = refCounts.get(countSymbols[i]!.key) ?? 0;
      const k = `${c.filePath} ${c.symbolName}`;
      refsByNameFile.set(k, (refsByNameFile.get(k) ?? 0) + cnt);
    }

    const results: DeadCodeResult[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      const cnt = refCounts.get(countSymbols[i]!.key) ?? 0;
      if (cnt > 0) continue; // referenced → not dead

      const bare = c.symbolName.split(".").pop() ?? c.symbolName;
      const isCommon = (nameCount.get(bare) ?? 0) > 3;
      const ownerRef = c.symbolName.includes(".")
        ? (refsByNameFile.get(`${c.filePath} ${c.symbolName.split(".")[0]}`) ?? 0) > 0
        : false;

      const scored = scoreDeadCode({
        symbolName: c.symbolName,
        symbolType: c.symbolType,
        language: c.language,
        content: c.content,
        referenceCount: 0,
        ownerClassReferenced: ownerRef,
        isCommonName: isCommon,
      });
      if (scored.confidence < minConfidence) continue;

      const res: DeadCodeResult = {
        project: rec.name,
        symbolName: c.symbolName,
        symbolType: c.symbolType,
        filePath: c.filePath,
        relativePath: path.relative(rec.path, c.filePath),
        startLine: c.declLine,
        endLine: c.endLine,
        referenceCount: 0,
        signals: scored.signals,
        confidence: scored.confidence,
        category: scored.category,
      };
      if (c.language) res.language = c.language;
      const sig = deriveSignature(c.content);
      if (sig) res.signature = sig;
      results.push(res);
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return {
      project: rec.name,
      results: results.slice(0, limit),
      scannedSymbols,
      scannedChunks: allRows.length,
      truncated,
    };
  }

  /** Resolves which project an absolute file belongs to (prefix match; most-specific wins). */
  private resolveProjectForFile(abs: string, project?: string): IndexRecord {
    if (project) {
      const rec = this.registry.getIndex(project);
      if (!rec) throw new Error(`Index not found: ${project}`);
      return rec;
    }
    const matches = this.registry.listIndexes().filter((r) => {
      const rel = path.relative(r.path, abs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (matches.length === 0) {
      throw new Error(
        `No indexed project contains '${abs}'. Pass --project <name> to disambiguate.`,
      );
    }
    if (matches.length === 1) return matches[0]!;
    // Most specific (longest path) wins; an exact tie is genuinely ambiguous.
    matches.sort((a, b) => b.path.length - a.path.length);
    if (matches[0]!.path.length === matches[1]!.path.length) {
      throw new Error(
        `'${abs}' belongs to multiple projects (${matches.map((m) => m.name).join(", ")}); pass --project.`,
      );
    }
    return matches[0]!;
  }

  /**
   * Builds (and caches) the project's import graph. The cache is keyed on the
   * indexed-file set and per-file mtimes, so it rebuilds only when something
   * changed — watcher edits surface on the next call without the engine touching
   * the watcher. Imports are parsed in bounded parallelism; the shared tree-sitter
   * parser stays safe because each setLanguage→parse is a synchronous, await-free
   * critical section (the same invariant `chunkCode` relies on).
   */
  private async buildImportGraph(rec: IndexRecord): Promise<DepGraph> {
    const indexedFiles = this.registry.listCachedFiles(rec.name);
    const setKey = indexedFiles.join("\n");
    const cached = this.depGraphCache.get(rec.name);
    if (cached && cached.setKey === setKey) {
      let stale = false;
      for (const f of indexedFiles) {
        try {
          if (statSync(f).mtimeMs !== cached.graph.fileMtimes.get(f)) {
            stale = true;
            break;
          }
        } catch {
          stale = true;
          break;
        }
      }
      if (!stale) return cached.graph;
    }

    const index = buildFileIndex(new Set(indexedFiles));
    const fileMtimes = new Map<string, number>();
    for (const f of indexedFiles) {
      try {
        fileMtimes.set(f, statSync(f).mtimeMs);
      } catch {
        // unreadable file → mtime unknown, but keep it so the graph still includes it
      }
    }

    const forward = new Map<string, string[]>();
    await mapWithConcurrency(indexedFiles, 8, async (f) => {
      let content: string;
      try {
        content = await readFile(f, "utf-8");
      } catch {
        return;
      }
      const specs = await extractImports(f, content);
      if (specs.length === 0) return;
      const resolved = resolveImports(specs, rec.path, index, f);
      const edges: string[] = [];
      for (const r of resolved) {
        if (r.status === "resolved" && r.resolvedPath) edges.push(r.resolvedPath);
      }
      if (edges.length > 0) forward.set(f, edges);
    });

    const reverse = new Map<string, string[]>();
    for (const [importer, targets] of forward) {
      for (const t of targets) {
        let arr = reverse.get(t);
        if (!arr) {
          arr = [];
          reverse.set(t, arr);
        }
        if (!arr.includes(importer)) arr.push(importer);
      }
    }

    const graph: DepGraph = { forward, reverse, fileMtimes, scannedFiles: indexedFiles.length };
    this.depGraphCache.set(rec.name, { setKey, graph });
    return graph;
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
    const wantDoc = opts?.doc !== false;

    if (mode === "vector") {
      const vec = await searchTable(table, vector!, limit, where);
      if (!wantDoc) return vec;
      return this.mergeWithDocLegs(table, query, vector, where, limit, [vec]);
    }
    if (mode === "text") {
      const fts = await searchTableText(table, query, limit, where);
      if (!wantDoc) return fts;
      return this.mergeWithDocLegs(table, query, vector, where, limit, [fts]);
    }

    // hybrid: vector + BM25 → RRF (plus the docstring legs, when present)
    const pool = Math.max(limit * 3, 10);
    const [vec, fts] = await Promise.all([
      searchTable(table, vector!, pool, where),
      searchTableText(table, query, pool, where),
    ]);
    if (!wantDoc) return this.combine([vec, fts], limit);
    return this.mergeWithDocLegs(table, query, vector, where, pool, [vec, fts]);
  }

  /** Merges non-empty result lists: a single list keeps its native metric, multiple lists go through RRF. */
  private combine(lists: SearchResult[][], fetchCount: number): SearchResult[] {
    const nonEmpty = lists.filter((l) => l.length > 0);
    if (nonEmpty.length === 0) return [];
    if (nonEmpty.length === 1) return nonEmpty[0]!.slice(0, fetchCount);
    return rrfMerge(nonEmpty, (r) => String(r.id), 60)
      .slice(0, fetchCount)
      .map(({ item, score }) => ({ ...item, _score: score }));
  }

  /**
   * Merges the docstring retrieval legs with the base result lists via RRF.
   * The legs are gated on the table actually having the columns (tables indexed
   * before 2.4.0 predate `doc`/`doc_vector`): `doc_vector` ANN (needs a query
   * vector) and BM25 over `doc`. Results that matched via a doc leg carry
   * `_docHit: true` — useful for explaining why a code chunk answered an
   * intent-style query ("how do we …?"). When no doc leg yields anything, the
   * base lists keep their legacy semantics untouched.
   */
  private async mergeWithDocLegs(
    table: string,
    query: string,
    vector: number[] | null,
    where: string | undefined,
    fetchCount: number,
    base: SearchResult[][],
  ): Promise<SearchResult[]> {
    const cols = await tableColumns(table);
    const docIds = new Set<string>();
    const lists = [...base];
    if (vector !== null && cols.has("doc_vector")) {
      const hits = await searchTable(table, vector, fetchCount, where, "doc_vector");
      for (const h of hits) docIds.add(String(h.id));
      if (hits.length > 0) lists.push(hits);
    }
    if (cols.has("doc")) {
      const hits = await searchTableText(table, query, fetchCount, where, ["doc"]);
      for (const h of hits) docIds.add(String(h.id));
      if (hits.length > 0) lists.push(hits);
    }
    if (lists.length === base.length) return this.combine(base, fetchCount);
    return rrfMerge(lists, (r) => String(r.id), 60)
      .slice(0, fetchCount)
      .map(({ item, score }) => {
        const row: SearchResult = { ...item, _score: score };
        if (docIds.has(String(row.id))) row._docHit = true;
        return row;
      });
  }

  /** Sorts cross-project results by the metric appropriate for the mode. */
  private rankCombined(rows: ScopedSearchResult[], mode: string): ScopedSearchResult[] {
    if (mode === "vector") {
      return rows
        .filter((r) => r._distance !== undefined)
        // Merged results (docstring legs joined) carry an RRF `_score`; a plain
        // single-column vector search does not and keeps the distance order.
        .sort((a, b) =>
          a._score !== undefined || b._score !== undefined
            ? (b._score ?? 0) - (a._score ?? 0)
            : a._distance! - b._distance!,
        );
    }
    // hybrid/text → higher score first
    return rows.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  }

  /** Cached result of the one-time reranker-model availability probe. */
  private rerankAvailable: boolean | null = null;

  /** Is second-stage reranking active for this call? (needs a configured model) */
  private wantRerank(opts?: SearchOptions): boolean {
    const flag = opts?.rerank;
    const enabled = flag === true || (CONFIG.RERANK_ENABLED && flag !== false);
    return enabled && CONFIG.RERANK_MODEL.length > 0;
  }

  /** Is MMR diversification active for this call? */
  private wantMMR(opts?: SearchOptions): boolean {
    const flag = opts?.mmr;
    return flag === true || (CONFIG.MMR_ENABLED && flag !== false);
  }

  /**
   * Probes once (cached) whether the configured reranker model exists in Ollama.
   * Default-on reranking must not pay a per-search storm of failed calls when the
   * model isn't installed, so reranking is disabled for the session if it's absent.
   */
  private async ensureRerankAvailable(): Promise<boolean> {
    if (this.rerankAvailable !== null) return this.rerankAvailable;
    if (!CONFIG.RERANK_MODEL) {
      this.rerankAvailable = false;
      return false;
    }
    try {
      const resp = await fetch(`${CONFIG.OLLAMA_URL}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: CONFIG.RERANK_MODEL }),
      });
      this.rerankAvailable = resp.ok;
      if (!resp.ok) {
        console.error(
          `[manager] reranker model '${CONFIG.RERANK_MODEL}' not found in Ollama; ` +
            `reranking disabled for this session (install it, or set search.rerank.enabled=false).`,
        );
      }
    } catch (err) {
      this.rerankAvailable = false;
      console.error("[manager] reranker availability probe failed; reranking disabled:", err);
    }
    return this.rerankAvailable;
  }

  /**
   * Refines the candidate pool and slices to `limit`:
   *   1. (optional) rerank — re-score by the cross-encoder and sort by precision;
   *   2. (optional) MMR — select a relevant-and-diverse subset.
   * A step is skipped (transparently, with a plain slice) when it is off, when the
   * pool is already ≤ `limit`, when the reranker model is absent, when vectors are
   * missing, or on any error — rerank/MMR are refinements, never hard dependencies.
   */
  private async refineAndSlice<T extends SearchResult>(
    rows: T[],
    query: string,
    limit: number,
    mode: string,
    rerankOn: boolean,
    mmrOn: boolean,
  ): Promise<T[]> {
    if (!(rerankOn || mmrOn) || rows.length <= limit) return rows.slice(0, limit);
    // Shallow-copy the candidates: rows come straight from LanceDB and arrive as
    // non-extensible Proxy objects, so assigning `_rerankScore` in place throws
    // ("Proxy object's 'set' trap returned falsy") and silently disables rerank.
    const candidates = rows
      .slice(0, Math.max(limit, CONFIG.RERANK_TOP_K, CONFIG.MMR_TOP_K))
      .map((r) => ({ ...r }) as T);

    // 1) Rerank for precision (re-score + sort by relevance).
    if (rerankOn && (await this.ensureRerankAvailable())) {
      try {
        const scores = await rerankScores(query, candidates.map((r) => r.content ?? ""));
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          if (c) c._rerankScore = scores[i] ?? 0.5;
        }
        candidates.sort((a, b) => (b._rerankScore ?? 0) - (a._rerankScore ?? 0));
      } catch (err) {
        // Whole-batch failure (e.g. Ollama unreachable) → keep pre-rerank order.
        console.error("[manager] rerank failed; using pre-rerank order:", err);
      }
    }

    // 2) MMR for diversity (selects `limit` from the pool; null ⇒ vectors missing).
    if (mmrOn) {
      const picked = this.selectDiverse(candidates.slice(0, CONFIG.MMR_TOP_K), mode, limit);
      if (picked) return picked;
    }

    return candidates.slice(0, limit);
  }

  /**
   * Maximal Marginal Relevance selection over `pool`. Returns a relevant-and-
   * diverse subset of size `limit`, or null if any candidate lacks a vector (MMR
   * is vector-based; the caller falls back to a plain slice in that case).
   */
  private selectDiverse<T extends SearchResult>(
    pool: T[],
    mode: string,
    limit: number,
  ): T[] | null {
    if (pool.length === 0) return null;
    const vectors = pool.map((r) => (Array.isArray(r.vector) ? r.vector : null));
    if (vectors.some((v) => !v || v.length === 0)) return null;
    const relevances = pool.map((r) =>
      typeof r._rerankScore === "number"
        ? r._rerankScore
        : mode === "vector"
          ? -(r._distance ?? 0)
          : (r._score ?? 0),
    );
    const indices = selectMMR(
      vectors as number[][],
      relevances,
      Math.min(limit, pool.length),
      CONFIG.MMR_LAMBDA,
    );
    return indices.map((i) => pool[i]!);
  }

  /** Is the index compatible with the active embedding model? (compatible if no model recorded.) */
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
        // Report the table's true state, not the job's write counts: after an
        // incremental sync (mtime-skips + deletions), result.files/chunks only
        // describe what THIS job touched.
        const fileCount = this.registry.listCachedFiles(t.indexName).length;
        const chunkCount = await countTableRows(t.tableName);
        this.registry.setIndexStats(t.indexName, fileCount, chunkCount, Date.now());
        if (result.dim !== null) {
          // Pin the model actually used for this run (per-project override or global).
          const usedModel = readProjectConfig(t.baseDir)?.embedModel ?? CONFIG.OLLAMA_MODEL;
          this.registry.setIndexEmbedding(t.indexName, usedModel, result.dim);
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
