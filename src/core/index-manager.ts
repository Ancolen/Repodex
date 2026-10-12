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
import { cachedEmbed, getEmbedding, resolveEmbedBackend } from "../services/embed";
import { probeLlamaServer } from "../services/llamacpp";
import { modelTagPresent } from "../utils/model-tag";
import { readProjectConfig } from "./project-config";
import { rerankScores } from "../services/rerank";
import { selectMMR } from "../utils/mmr";
import { applyPathBoost, type PathBoostConfig } from "../utils/boost";
import { applyCharBudget, applyPackBudget } from "../utils/budget";
import { fileOutline, type OutlineEntry } from "../chunking/chunker";
import { gitHeadPath, isGitRepo, searchGitLog, blameRange } from "../services/git";
// C4 — blame/ownership: the pure porcelain parser (git lives in services/git).
import { parseGitBlamePorcelain, summarizeBlameRange, type BlameLineRecord } from "./blame";
import { rrfMerge } from "../utils/rrf";
import { wantIdTermsLeg } from "./idterms";
import { deriveSignature, matchIdentifierLines } from "../utils/text";
import { extractImports } from "../chunking/imports";
import { resolveImports, buildFileIndex, type ResolvedDep, type FileIndex } from "./resolve";
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
// C1 — change impact: the pure join over the three cached adjacency sources.
import {
  buildImpactReport,
  selectAnchor,
  IMPACT_DEFAULT_DEPTH,
  IMPACT_DEFAULT_LIMIT,
} from "./impact";
import type { ChangeImpactReport, ImpactAnchor, ImpactChunk } from "./impact";
export type { ChangeImpactReport, ImpactAnchor } from "./impact";
import type { CommitHit, CommitQueryOpts } from "./commits";
export type { CommitHit, CommitQueryOpts } from "./commits";
// ---- public API diff (proposal C2) ----
export type {
  ApiSymbol,
  ApiChangeKind,
  ApiDiffSide,
  ApiDiffEntry,
  ApiDiffCounts,
} from "./apidiff";
import { mapWithConcurrency } from "../utils/concurrency";
// ---- public API diff (proposal C2) ----
import {
  compareSurfaces,
  countDiff,
  extractRefSurface,
  surfaceFromIndexRows,
  type ApiSymbol,
  type ApiDiffCounts,
  type ApiDiffEntry,
} from "./apidiff";
import { gitRefExists, safeGitRef, gitCommitTimeAt } from "../services/git";
// D1 — doc–code conformance: the pure engine + the fs half.
import {
  extractDocSpans,
  runDocCheck,
  isDocPath,
  HISTORICAL_FILE_RE,
  type DocCheckChunk,
  type DocCheckReport,
  type DocCheckState,
  type DocFile,
  type DocSymbol,
} from "./doccheck";
export type { DocCheckReport, DocFinding, UndocumentedEntry } from "./doccheck";
import { collectDocFiles, listRootFiles, readProjectManifest } from "../services/docfiles";
// Shared file-kind heuristics (dead code + reverse doc coverage use the same recipe).
import {
  DEAD_CANDIDATE_TYPES,
  ENTRY_POINT_NAMES,
  isTestFile,
  isEntryPointFile,
} from "./filekinds";

const INDEX_JOB = "index";

/**
 * Per-search blame budget (proposal C4): at most this many hit files get ONE
 * `git blame --porcelain` each; the rest are reported as `blameSkipped` so the
 * worst-case search latency stays bounded (files kept whole in rank order).
 */
const BLAME_FILE_CAP = 8;

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
  /**
   * Blame (opt-in, proposal C4): author of the most recent commit touching
   * this chunk's line range — fresh from git, never from the (possibly stale)
   * index. Absent when blame was not requested, the file is untracked and
   * `git blame` failed for it.
   */
  lastAuthor?: string;
  /** Blame: UTC calendar date (YYYY-MM-DD) of that commit's author time. */
  lastCommitDate?: string;
  /** Blame: distinct commits touching this chunk's lines (cap — see churnTruncated). */
  churnCommits?: number;
  /** Blame: more distinct commits than the cap touch this chunk's range. */
  churnTruncated?: boolean;
}

/** One query's worth of batch-search results (`searchBatch`). */
export interface BatchSearchGroup {
  query: string;
  results: ScopedSearchResult[];
  /** Blame requested, but no hit file lives in a git working tree → nothing was stamped. */
  blameNotARepo?: boolean;
  /** Hit files whose blame was skipped by the per-search file cap (no silent caps). */
  blameSkipped?: number;
}

/**
 * The result list of one search plus its opt-in blame notes (proposal C4).
 * The blame fields ride on the hits; these envelope notes carry what can't be
 * said per-hit — the whole-list not-a-repo case and the honest file-cap count.
 * They flow to the control-API JSON, the MCP `structuredContent` and the CLI.
 */
export interface SearchEnvelope {
  results: ScopedSearchResult[];
  /** `blame` was requested, but no hit file is in a git working tree → nothing was stamped. */
  blameNotARepo?: boolean;
  /** Hit files whose blame was skipped by the per-search file cap (no silent caps). */
  blameSkipped?: number;
}

/** One assembled hit of a context pack: the search hit plus its file's shape and imports. */
export interface ContextPackHit {
  /** The search hit, enriched as always (`signature` / `indexedAt` / context lines). */
  hit: ScopedSearchResult;
  /**
   * The hit file's symbol map (`get_file_outline` data), capped to the hit's
   * neighborhood: the symbols overlapping the hit's chunk range plus the next few
   * below it. Absent when the file is unreadable / has no symbols.
   */
  outline?: OutlineEntry[];
  /**
   * Forward imports of the hit file, resolved to indexed files ONLY (no phantom
   * edges), capped at `PACK_IMPORT_CAP`. Absent when the file imports nothing indexed.
   */
  imports?: DependencyEdge[];
  /** More indexed imports exist beyond the cap (no silent caps). */
  importsTruncated?: boolean;
}

/** Result of `get_context_pack`: search + per-hit file shape + imports, under ONE budget. */
export interface ContextPack {
  query: string;
  /** The project searched (null = all projects were searched). */
  project: string | null;
  /** Assembled hits in ranked order, each whole — a hit is never truncated mid-content. */
  hits: ContextPackHit[];
  /** Approximate rendered size of the kept pack (hits + legs + framing). */
  totalChars: number;
  /** Hits dropped whole by the pack budget (they exceeded what was left). */
  omitted: number;
  /** The budget that was applied (null = uncapped). */
  maxChars: number | null;
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
   * Override the default path/surface boost for this call (proposal S3 — small
   * multiplicative signals over RRF-merged results: short project-relative
   * path, conventional source root, test/generated demotion).
   * - true  → boost even if disabled in config.
   * - false → skip boosting even if enabled in config; the ordering is then
   *   byte-identical to a boost-free run.
   * - undefined → use CONFIG.BOOST_ENABLED.
   * Single-leg results (no RRF `_score`) are never touched either way.
   */
  boost?: boolean | undefined;
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
  /**
   * Ownership/blame enrichment (opt-in, default false): stamp each final hit
   * with `lastAuthor` / `lastCommitDate` / `churnCommits` — one
   * `git blame --porcelain` per hit file (≤ BLAME_FILE_CAP, extras reported as
   * `blameSkipped`). Off by default: it costs one git call per hit file.
   */
  blame?: boolean | undefined;
}

/**
 * One table's search result: the rows plus whether they came out of an RRF
 * merge. Distinguishing the two matters for the path/surface boost (S3): rows
 * can carry a `_score` from EITHER source — an RRF merge writes its own rank-
 * fused score, but a single-leg list passes the raw metric straight through
 * (the LanceDB text leg surfaces native BM25 as `_score`, vector legs as
 * `_distance`) — and the boost must never rescale a native metric.
 */
interface TableSearch {
  rows: SearchResult[];
  /** True when `rows` are RRF-merged (all of them carry a fused `_score`). */
  rrfMerged: boolean;
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

/** Optional behavior of the reference scan (`find_references`). */
export interface ReferencesOpts extends SearchFilters {
  /**
   * Include doc artifacts (.md/.mdx/.xml/.rst) as reference evidence. Docs are
   * indexed as chunks, so a mention in the changelog IS a real occurrence — but
   * a "who calls X" question usually wants code only. Default true.
   */
  includeDocs?: boolean | undefined;
}

/** Result of `findReferences`: the kept references plus the honesty counters. */
export interface ReferenceResult {
  /** Distinct occurrences (deduped by file:line), capped at the call's `limit`. */
  refs: SymbolReference[];
  /** Distinct occurrences found BEFORE the limit cut — the honest total. */
  total: number;
  /** `total` exceeded the kept list (raise `limit` for more). */
  truncated: boolean;
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

// ------------------------------------------------------ API diff (proposal C2)

/** Label for the default head side of an API diff: the index, i.e. the working tree. */
export const WORKING_TREE = "(working tree)";

/** Result of `get_api_diff`: the classified public-API difference between two refs. */
export interface ApiDiffResult {
  project: string;
  /** The ref the diff starts from (the "before" side). */
  base: string;
  /** The ref compared to; `WORKING_TREE` when the index supplied the head side. */
  head: string;
  /** True when the head side came from the index (no `head` ref was given). */
  headIsIndex: boolean;
  /** Classified symbols, breaking kinds first, capped by `limit`. */
  entries: ApiDiffEntry[];
  /** Per-kind totals over the WHOLE diff (never capped). */
  counts: ApiDiffCounts & { breaking: number };
  /** Files at a ref that could not be read or parsed — reported, never skipped. */
  unparsedFiles: { path: string; reason: string; side: "base" | "head" }[];
  /** AST-language files scanned on the historical side(s). */
  scannedFiles: number;
  /** A cap was hit (files or entries) — the diff is partial. */
  truncated: boolean;
  /** The project directory is not a git repo — no refs to compare. */
  notARepo?: boolean;
  /** The named ref doesn't resolve in the project's repo. */
  unknownRef?: "base" | "head";
  /** The named ref can't safely be passed to git (reported instead of thrown). */
  invalidRef?: "base" | "head";
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
 * The min..max line coverage of one file's hits — the single `-L` range ONE
 * `git blame` for that file must cover so every hit's subrange sits inside it.
 * Null when no hit carries usable line numbers.
 */
function hitLineBounds(group: readonly ScopedSearchResult[]): { start: number; end: number } | null {
  let start = 0;
  let end = 0;
  for (const r of group) {
    if (typeof r.startLine !== "number" || typeof r.endLine !== "number") continue;
    if (r.startLine < 1 || r.endLine < 1) continue;
    const lo = Math.min(r.startLine, r.endLine);
    const hi = Math.max(r.startLine, r.endLine);
    if (start === 0) {
      start = lo;
      end = hi;
    } else {
      start = Math.min(start, lo);
      end = Math.max(end, hi);
    }
  }
  return start > 0 ? { start, end } : null;
}

/**
 * Closest indexed project name for a mistyped guess: case-insensitive substring
 * either way, else a shared-prefix ratio. Loose on purpose — this is an
 * error-message hint, never a resolution.
 */
function nearestProjectName(name: string, available: readonly string[]): string | undefined {
  const q = name.toLowerCase();
  let best: string | undefined;
  let bestScore = 0;
  for (const c of available) {
    const cl = c.toLowerCase();
    let score = 0;
    if (cl.includes(q) || q.includes(cl)) score = 0.9;
    else {
      const n = Math.min(q.length, cl.length);
      let shared = 0;
      while (shared < n && q[shared] === cl[shared]) shared++;
      score = (shared * 2) / (q.length + cl.length);
    }
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : undefined;
}

/**
 * The self-healing "unknown project" message: names what IS indexed and, when
 * the guess is close, the likeliest intended project — an agent reading this
 * can correct itself in the same turn instead of paying a second `list_indexes`
 * round-trip. Exported: the control API reuses it for its own 404s.
 */
export function indexNotFoundMessage(name: string, available: readonly string[]): string {
  let msg = `Index not found: ${name}`;
  if (available.length > 0) msg += ` (available: ${available.join(", ")})`;
  const hint = nearestProjectName(name, available);
  if (hint) msg += ` — did you mean '${hint}'?`;
  return msg;
}

/** Symbol types that can make/receive a call (the call-graph inventory). */
const CALLABLE_TYPES = new Set(["function", "method", "constructor"]);

/** Empty adjacency, reused to render depth-0 root nodes via `traverseCallGraph`. */
const EMPTY_ADJ: Map<string, Set<string>> = new Map();

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

/** A cached doc-check snapshot for one project (rebuilt when the index changes). */
interface DocChunkCacheEntry {
  /** `IndexRecord.lastIndexedAt`; a change invalidates the cache. */
  lastIndexedAt: number | null;
  /** Code chunks with project-relative posix paths (doc artifacts excluded). */
  chunks: DocCheckChunk[];
  /** Reverse-coverage candidate symbols, deduped by (name, file). */
  symbols: DocSymbol[];
  /** True when `tableSymbolsWithContent` hit its row cap. */
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

// ------------------------------------------------------ context pack (pure helpers)

/** Default pack-level character budget (`get_context_pack`). */
const PACK_DEFAULT_MAX_CHARS = 6000;

/** Default number of hits considered for a pack. */
const PACK_DEFAULT_LIMIT = 5;

/** Forward-import cap per hit (resolved edges only). */
const PACK_IMPORT_CAP = 10;

/** Outline entries kept per hit, at most. */
const PACK_OUTLINE_MAX = 12;

/** Outline entries kept BELOW the hit's chunk range (the "what comes next" window). */
const PACK_OUTLINE_BELOW = 4;

/**
 * Caps a file outline to a hit's neighborhood: the symbols whose line range
 * overlaps the hit's chunk, followed by up to `below` symbols that start after it
 * ("what comes next in the file"), capped at `max` overall. File order is preserved
 * (every overlapping symbol starts at or before the chunk's end and every kept
 * below-symbol starts after it, so the concatenation stays sorted); symbols wholly
 * above the chunk are dropped — they are not its neighborhood. Without line info the
 * outline passes through, still capped.
 */
export function sliceOutlineForHit(
  outline: OutlineEntry[],
  startLine: number | undefined,
  endLine: number | undefined,
  max: number = PACK_OUTLINE_MAX,
  below: number = PACK_OUTLINE_BELOW,
): OutlineEntry[] {
  if (outline.length === 0) return [];
  if (typeof startLine !== "number" || typeof endLine !== "number") return outline.slice(0, max);
  const overlapping: OutlineEntry[] = [];
  const after: OutlineEntry[] = [];
  for (const o of outline) {
    if (o.startLine <= endLine && o.endLine >= startLine) overlapping.push(o);
    else if (o.startLine > endLine) after.push(o);
  }
  return [...overlapping, ...after.slice(0, below)].slice(0, max);
}

/**
 * Keeps only the imports that resolved to an indexed file (`resolveImports` +
 * `toEdge` already validate every candidate against the index and set `path` — no
 * phantom edges), capped at `cap`, with the overflow reported rather than silently
 * dropped.
 */
export function resolvedImports(
  edges: DependencyEdge[],
  cap: number = PACK_IMPORT_CAP,
): { imports: DependencyEdge[]; truncated: boolean } {
  const resolved = edges.filter((e) => e.status === "resolved");
  return { imports: resolved.slice(0, cap), truncated: resolved.length > cap };
}

/** Reads + parses a file's outline once per pack call (hits can share a file). */
function cachedFileOutline(
  abs: string,
  cache: Map<string, Promise<OutlineEntry[]>>,
): Promise<OutlineEntry[]> {
  const cached = cache.get(abs);
  if (cached) return cached;
  const promise = readFile(abs, "utf-8")
    .then((content) => fileOutline(abs, content))
    .catch(() => [] as OutlineEntry[]);
  cache.set(abs, promise);
  return promise;
}

/**
 * Forward imports of one file (the `getDependencies` forward leg only — the
 * reverse graph, whose first build parses every indexed file, is deliberately
 * NOT triggered here). Specifiers are resolved against the project's indexed set,
 * so a resolved edge always points at a real indexed file.
 */
function cachedForwardImports(
  rec: IndexRecord,
  abs: string,
  index: FileIndex,
  cache: Map<string, Promise<DependencyEdge[]>>,
): Promise<DependencyEdge[]> {
  const key = `${rec.name}\u0000${abs}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<DependencyEdge[]> => {
    let content: string;
    try {
      content = await readFile(abs, "utf-8");
    } catch {
      return [];
    }
    const specs = await extractImports(abs, content);
    if (specs.length === 0) return [];
    return resolveImports(specs, rec.path, index, abs).map((d) => toEdge(d, rec.path));
  })().catch(() => [] as DependencyEdge[]);
  cache.set(key, promise);
  return promise;
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
  /** On-demand doc-check snapshot (chunks + symbols), keyed on lastIndexedAt. */
  private docChunkCache = new Map<string, DocChunkCacheEntry>();

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
    if (!rec) throw this.indexNotFound(name);
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
    if (!rec) throw this.indexNotFound(name);
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
    this.docChunkCache.delete(name);
    return true;
  }

  listIndexes(): IndexRecord[] {
    return this.registry.listIndexes();
  }

  getIndex(name: string): IndexRecord | null {
    return this.registry.getIndex(name);
  }

  /** The self-healing "Index not found" error (names the available projects). */
  private indexNotFound(name: string): Error {
    return new Error(indexNotFoundMessage(name, this.registry.listIndexes().map((r) => r.name)));
  }

  /**
   * Resolves an optional project anchor — an explicit `project` name, or a
   * `path` inside an indexed project (prefix match, most-specific wins) — to a
   * project NAME. The shared engine for every tool that accepts `project?`/
   * `path?`: the search family passes `allWhenUnset` (nothing given → search
   * all projects), the per-project report tools pass `false` (nothing given →
   * the single indexed project, or an error that names them). Every failure
   * mode is self-healing: the error lists the available projects so the caller
   * can correct itself without another round-trip.
   */
  resolveProjectScope(
    project?: string,
    filePath?: string,
    allWhenUnset: boolean = true,
  ): string | undefined {
    if (project) {
      const rec = this.registry.getIndex(project);
      if (!rec) throw this.indexNotFound(project);
      return rec.name;
    }
    if (filePath) return this.resolveProjectForFile(path.resolve(filePath)).name;
    if (allWhenUnset) return undefined;
    const all = this.registry.listIndexes();
    if (all.length === 0) throw new Error("No indexed project; index a directory first.");
    if (all.length > 1) {
      throw new Error(
        `Multiple projects are indexed (${all.map((p) => p.name).join(", ")}) — ` +
          "pass the 'project' (or 'path') argument to pick one.",
      );
    }
    return all[0]!.name;
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
  ): Promise<SearchEnvelope> {
    const rec = this.registry.getIndex(name);
    if (!rec) throw this.indexNotFound(name);
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
    const boostOn = this.wantBoost(opts);
    const fetchLimit = rerankOn || mmrOn ? Math.max(limit, CONFIG.RERANK_TOP_K, CONFIG.MMR_TOP_K) : limit;
    const { rows, rrfMerged } = await this.searchOnTable(rec.tableName, query, vector, fetchLimit, opts);
    // Path/surface boost: after the RRF merge, BEFORE rerank/MMR — the boost
    // adjusts relevance input only (rerank/MMR see the adjusted order). RRF-
    // merged lists only: single-leg lists keep their native metric untouched
    // (a text leg surfaces raw BM25 as `_score`, a vector leg `_distance`).
    const boosted = boostOn && rrfMerged ? applyPathBoost(rows, this.pathBoostCfg(true), rec.path) : rows;
    const refined = await this.refineAndSlice(boosted, query, limit, mode, rerankOn, mmrOn);
    const scoped = refined.map((r) => this.scope(r, name, rec.lastIndexedAt));
    const enriched = await this.enrich(scoped, opts?.contextLines ?? 0);
    return this.finishSearch(enriched, opts);
  }

  /** Search across all projects; results are merged and ranked. */
  async searchAll(query: string, limit = 5, opts?: SearchOptions): Promise<SearchEnvelope> {
    const mode = opts?.mode ?? "hybrid";
    const indexes = this.registry.listIndexes();
    if (indexes.length === 0) {
      const env: SearchEnvelope = { results: [] };
      return env;
    }
    const rerankOn = this.wantRerank(opts);
    const mmrOn = this.wantMMR(opts);
    const boostOn = this.wantBoost(opts);
    const boostCfg = this.pathBoostCfg(boostOn);
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
          const { rows, rrfMerged } = await this.searchOnTable(rec.tableName, query, vector, fetchLimit, opts);
          // Boost per table (each row's factor comes from its own path), RRF-
          // merged lists only: the boosted `_score` then drives the cross-table
          // sort in rankCombined. Single-leg lists keep their native metric.
          const adjusted = boostOn && rrfMerged ? applyPathBoost(rows, boostCfg, rec.path) : rows;
          return adjusted.map((r) => this.scope(r, rec.name, rec.lastIndexedAt));
        } catch {
          return [] as ScopedSearchResult[];
        }
      }),
    );

    const ranked = this.rankCombined(perTable.flat(), mode);
    const refined = await this.refineAndSlice(ranked, query, limit, mode, rerankOn, mmrOn);
    const enriched = await this.enrich(refined, opts?.contextLines ?? 0);
    return this.finishSearch(enriched, opts);
  }

  /**
   * The last mile shared by searchIndex/searchAll: the opt-in blame
   * enrichment (BEFORE the char budget — its handful of small fields must not
   * bill against the budget, and the budget keeps dropping whole hits on top
   * of them), then the public payload boundary (no embedding columns), wrapped
   * in the envelope that carries the blame notes.
   */
  private async finishSearch(rows: ScopedSearchResult[], opts?: SearchOptions): Promise<SearchEnvelope> {
    const blame = opts?.blame === true ? await this.applyBlame(rows) : undefined;
    const env: SearchEnvelope = { results: this.stripEmbeddings(applyCharBudget(rows, opts?.maxChars)) };
    if (blame?.notARepo === true) env.blameNotARepo = true;
    if (blame?.skipped !== undefined && blame.skipped > 0) env.blameSkipped = blame.skipped;
    return env;
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
        // Blame is inherited per query (each call stamps its own result group,
        // and the group carries that query's envelope notes).
        const env = project
          ? await this.searchIndex(project, query, limit, opts)
          : await this.searchAll(query, limit, opts);
        const group: BatchSearchGroup = { query, results: env.results };
        if (env.blameNotARepo === true) group.blameNotARepo = true;
        if (env.blameSkipped !== undefined) group.blameSkipped = env.blameSkipped;
        return group;
      }),
    );
  }

  // ------------------------------------------------------------- context pack

  /**
   * One call assembling what an agent otherwise burns 4–6 round-trips on.
   *
   * 1. **Search core** — `searchIndex`/`searchAll` EXACTLY as today (hybrid +
   *    rerank + MMR + doc legs + the shared query cache): reused, never reimplemented.
   *    The search filters (`language` / `symbolType` / `pathGlob`) pass straight
   *    through, so a pack can be scoped like a search call.
   * 2. **Per-hit enrichment, one pass** — the usual `signature`/`indexedAt`/context
   *    lines, plus the hit file's outline capped to the hit's neighborhood and the
   *    hit file's forward imports resolved to indexed files only. Outline/imports
   *    are parsed once per file per call (hits can share a file) and every leg is
   *    best-effort: a missing/unreadable file drops its leg, never the hit.
   * 3. **ONE pack-level budget** — `applyPackBudget` runs once over the assembled
   *    pack: hits are added whole in ranked order while the running total fits, the
   *    top hit is always kept, and the rest are reported as `omitted`. The inner
   *    search deliberately runs WITHOUT `maxChars` — a pack has a single budget, so
   *    the internal legs must not double-bill.
   *
   * All composition, no new engines: every leg already exists and is cached.
   */
  async getContextPack(
    query: string,
    project?: string,
    opts?: {
      limit?: number;
      maxChars?: number;
      contextLines?: number;
      /** Metadata filters, passed straight into the search core (SearchFilters). */
      language?: string | undefined;
      symbolType?: string | undefined;
      pathGlob?: string | undefined;
    },
  ): Promise<ContextPack> {
    const limit = opts?.limit ?? PACK_DEFAULT_LIMIT;
    const contextLines = opts?.contextLines ?? 0;
    // No `maxChars` here on purpose: the pack budget is applied once, below.
    const searchOpts: SearchOptions = { contextLines };
    if (opts?.language !== undefined) searchOpts.language = opts.language;
    if (opts?.symbolType !== undefined) searchOpts.symbolType = opts.symbolType;
    if (opts?.pathGlob !== undefined) searchOpts.pathGlob = opts.pathGlob;
    // The inner search runs WITHOUT `maxChars` on purpose: the pack budget is
    // applied once, below. Packs stay blame-free — their legs are already
    // per-file, and the blame budget belongs to plain searches.
    const { results } = project
      ? await this.searchIndex(project, query, limit, searchOpts)
      : await this.searchAll(query, limit, searchOpts);

    // Per-hit legs, one pass: outlines/imports keyed per file, the indexed-file
    // index built once per project (hits can share a file or a project).
    const outlines = new Map<string, Promise<OutlineEntry[]>>();
    const imports = new Map<string, Promise<DependencyEdge[]>>();
    const projects = new Map<string, { rec: IndexRecord; index: FileIndex }>();
    const packHits = await Promise.all(
      results.map((hit) => this.buildPackHit(hit, outlines, imports, projects)),
    );

    const maxChars = opts?.maxChars ?? PACK_DEFAULT_MAX_CHARS;
    const capped = typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0;
    const budgeted = applyPackBudget(packHits, capped ? maxChars : undefined);
    return {
      query,
      project: project ?? null,
      hits: budgeted.hits,
      totalChars: budgeted.totalChars,
      omitted: budgeted.omitted,
      maxChars: capped ? maxChars : null,
    };
  }

  /** Assembles one hit's legs: the file's outline (neighborhood) + its forward imports. */
  private async buildPackHit(
    hit: ScopedSearchResult,
    outlineCache: Map<string, Promise<OutlineEntry[]>>,
    importCache: Map<string, Promise<DependencyEdge[]>>,
    projects: Map<string, { rec: IndexRecord; index: FileIndex }>,
  ): Promise<ContextPackHit> {
    const entry: ContextPackHit = { hit };
    const abs = hit.filePath ? path.resolve(hit.filePath) : undefined;
    if (!abs) return entry;

    // One indexed-file index per project per call (hits can share a project).
    let project = projects.get(hit.project);
    if (!project) {
      const rec = this.registry.getIndex(hit.project);
      if (!rec) return entry; // project removed mid-flight → the hit keeps no legs
      project = { rec, index: buildFileIndex(this.registry.listCachedFiles(rec.name)) };
      projects.set(hit.project, project);
    }

    const [outline, imports] = await Promise.all([
      cachedFileOutline(abs, outlineCache),
      cachedForwardImports(project.rec, abs, project.index, importCache),
    ]);

    if (outline.length > 0) {
      const neighborhood = sliceOutlineForHit(outline, hit.startLine, hit.endLine);
      if (neighborhood.length > 0) entry.outline = neighborhood;
    }
    if (imports.length > 0) {
      const capped = resolvedImports(imports, PACK_IMPORT_CAP);
      if (capped.imports.length > 0) entry.imports = capped.imports;
      if (capped.truncated) entry.importsTruncated = true;
    }
    return entry;
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
      if (!rec) throw this.indexNotFound(project);
      const rows = await searchSymbol(rec.tableName, name, limit, where);
      return this.stripEmbeddings(await this.enrich(rows.map((r) => this.scope(r, project, rec.lastIndexedAt)), 0));
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
    return this.stripEmbeddings(await this.enrich(perTable.flat().slice(0, limit), 0));
  }

  /** Wraps a raw row with project + freshness metadata. */
  private scope(r: SearchResult, project: string, indexedAt: number | null): ScopedSearchResult {
    return { ...r, project, indexedAt };
  }

  /**
   * Public search results never carry the embedding columns. `vector` and
   * `doc_vector` are ~20 KB of floats per row that no consumer of a search
   * RESULT needs: the reranker/MMR/doc-leg machinery consumed them upstream,
   * inside this class. Dropping them at the public boundary (searchIndex /
   * searchAll / findSymbol) keeps the control-API JSON, the MCP
   * `structuredContent` and the CLI payloads small — a 3-result search goes
   * from ~70 KB to a few KB. `doc` and `id_terms` are kept (they carry real
   * information); the raw rows inside `searchTable*` are untouched.
   */
  private stripEmbeddings(rows: ScopedSearchResult[]): ScopedSearchResult[] {
    return rows.map(({ vector: _vector, doc_vector: _doc_vector, ...rest }) => rest as ScopedSearchResult);
  }

  /**
   * Adds the derived signature to every result and, when contextLines > 0, reads
   * the surrounding lines from the file on disk. Context is read AFTER ranking/
   * slicing so only the final results trigger a file read.
   */
  private async enrich(rows: ScopedSearchResult[], contextLines: number): Promise<ScopedSearchResult[]> {
    for (const r of rows) {
      if (typeof r.content === "string" && r.content.length > 0) {
        r.signature = deriveSignature(r.content, r.language);
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

  // -------------------------------------------------- blame / ownership (C4)

  /**
   * Ownership / blame enrichment (proposal C4) — "who last changed this code,
   * and when". Runs AFTER signature/context enrichment and BEFORE the char
   * budget (see `finishSearch`); the data is fresh from git per search, the
   * same way `contextLines` is fresh from disk — a stale index still reports
   * the truth.
   *
   * Mechanics: the final hits are grouped by `filePath` in rank order, at most
   * BLAME_FILE_CAP files are blamed, and ONE `git blame --porcelain -L min,max`
   * per file covers every hit line range of that file (adjacent chunks share
   * it). The porcelain output is parsed once by the pure `core/blame.ts`, then
   * each hit is stamped from the records of its own line subrange.
   *
   * Guardrails: a not-a-repo territory probes the files' directories once and
   * skips the git calls entirely (a single envelope note replaces all the
   * fields); a per-file blame failure leaves THAT file's fields unset and
   * never fails the search; files beyond the cap are returned as `skipped` —
   * no silent caps.
   */
  private async applyBlame(
    rows: ScopedSearchResult[],
  ): Promise<{ notARepo?: boolean; skipped?: number }> {
    // Group by file, in rank order (Map preserves first-seen order).
    const byFile = new Map<string, ScopedSearchResult[]>();
    for (const r of rows) {
      if (!r.filePath) continue;
      const group = byFile.get(r.filePath);
      if (group) group.push(r);
      else byFile.set(r.filePath, [r]);
    }
    if (byFile.size === 0) return {};
    const files = [...byFile.keys()];
    const taken = files.slice(0, BLAME_FILE_CAP);
    const skipped = files.length - taken.length;

    // One probe per file's directory: outside a git working tree there is
    // nothing to blame. When NONE of the involved files is in a repo, the
    // single envelope note replaces the fields (and no git call is made).
    const repoByDir = new Map<string, boolean>();
    let anyRepo = false;
    for (const file of taken) {
      const dir = path.dirname(file);
      let inRepo = repoByDir.get(dir);
      if (inRepo === undefined) {
        inRepo = await isGitRepo(dir);
        repoByDir.set(dir, inRepo);
      }
      if (inRepo) anyRepo = true;
    }

    if (anyRepo) {
      // The file's own directory anchors its repo — multi-project searches
      // (searchAll) blame each file in the repo it actually lives in. The
      // ≤8 git calls run concurrently: a file's failure omits only its fields.
      await Promise.all(
        taken.map(async (file) => {
          if (repoByDir.get(path.dirname(file)) !== true) return;
          const group = byFile.get(file) ?? [];
          const bounds = hitLineBounds(group);
          if (!bounds) return;
          const dir = path.dirname(file);
          const raw = await blameRange(file, bounds.start, bounds.end, dir);
          if (raw === null) return; // this file's fields stay unset; the search keeps its results
          const records = parseGitBlamePorcelain(raw);
          if (records.length === 0) return;
          for (const r of group) {
            this.stampBlame(r, records, bounds);
          }
        }),
      );
    }

    if (!anyRepo) return { notARepo: true };
    return skipped > 0 ? { skipped } : {};
  }

  /** Stamps one hit with the summary of its own line subrange of the file's blame. */
  private stampBlame(
    r: ScopedSearchResult,
    records: BlameLineRecord[],
    bounds: { start: number; end: number },
  ): void {
    let start = bounds.start;
    let end = bounds.end;
    if (
      typeof r.startLine === "number" &&
      typeof r.endLine === "number" &&
      r.startLine > 0 &&
      r.endLine > 0
    ) {
      start = Math.min(r.startLine, r.endLine);
      end = Math.max(r.startLine, r.endLine);
    }
    // One blame record per line of the `-L` range, so the subrange is normally
    // covered; if the line data somehow does not intersect it, the file-level
    // summary degrades instead of leaving the group's other hits unenriched.
    const sub = records.filter((rec) => rec.line >= start && rec.line <= end);
    const summary = summarizeBlameRange(sub.length > 0 ? sub : records);
    if (!summary) return;
    if (summary.lastAuthor.length > 0) r.lastAuthor = summary.lastAuthor;
    if (summary.lastCommitDate.length > 0) r.lastCommitDate = summary.lastCommitDate;
    if (summary.distinctCommits > 0) r.churnCommits = summary.distinctCommits;
    if (summary.distinctTruncated) r.churnTruncated = true;
  }

  /**
   * Finds occurrences (usages) of a symbol NAME across the indexed code.
   *
   * Practical (non-LSP) approach: fetch candidate chunks whose content contains
   * the token (LIKE scan), then keep only WHOLE-identifier matches per line. This
   * leans on the existing schema (content + symbolName + line ranges) and finds
   * both the definition and call sites. `find_symbol` finds the definition only;
   * this answers "where is it used". The result is honest about its caps: `total`
   * counts every distinct occurrence found BEFORE the limit cut and `truncated`
   * says when the limit bit — no silent caps.
   */
  async findReferences(
    name: string,
    project?: string,
    limit = 50,
    opts?: ReferencesOpts,
  ): Promise<ReferenceResult> {
    if (!name) return { refs: [], total: 0, truncated: false };
    const includeDocs = opts?.includeDocs !== false;
    const where = buildWhere(opts);
    let targets: IndexRecord[];
    if (project) {
      const rec = this.registry.getIndex(project);
      if (!rec) throw this.indexNotFound(project);
      targets = [rec];
    } else {
      targets = this.registry.listIndexes();
    }

    // Candidate scan: the same bounded row cap the dead-code/impact passes pay.
    // Line-level expansion narrows it; the total is counted BEFORE the limit cut.
    const perTable = await Promise.all(
      targets.map(async (rec) => {
        try {
          const chunks = await searchContent(rec.tableName, name, 200000, where);
          return this.expandReferences(chunks, rec.name, name, includeDocs);
        } catch {
          return [] as SymbolReference[];
        }
      }),
    );

    // Dedup by file:line (overlapping chunks can repeat a line), sort, then cap.
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
    return { refs: refs.slice(0, limit), total: refs.length, truncated: refs.length > limit };
  }

  /** Expands matching chunks into per-line references (whole-identifier matches). */
  private expandReferences(
    chunks: SearchResult[],
    project: string,
    name: string,
    includeDocs: boolean,
  ): SymbolReference[] {
    const out: SymbolReference[] = [];
    for (const c of chunks) {
      if (typeof c.content !== "string") continue;
      // Doc artifacts (.md/.mdx/.xml/.rst) are evidence by default; a "who calls
      // X" question usually wants code only (`includeDocs: false`).
      if (!includeDocs && isDocPath(c.filePath)) continue;
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
    if (!rec) throw this.indexNotFound(name);

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
      if (!r) throw this.indexNotFound(opts.project);
      rec = r;
    } else {
      const all = this.registry.listIndexes();
      if (all.length === 0) throw new Error("No indexed project; index a directory first.");
      if (all.length > 1) {
        throw new Error(
          `'${symbol}' could belong to multiple projects (${all.map((p) => p.name).join(", ")}) — " +
          "pass the 'project' (or 'path') argument to disambiguate.`,
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
    if (!rec) throw this.indexNotFound(project);
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

  // ------------------------------------------------------------ change impact

  /**
   * "If I change X, what breaks?" — ONE ranked report joining the three adjacency
   * views that already exist:
   *
   *   1. direct callers (the cached call graph, reverse, depth-bounded),
   *   2. imported-by (the cached dependency graph, reverse),
   *   3. whole-identifier reference count + a few representative `file:line` hits.
   *
   * Severity ranks a caller that CALLS the symbol over a file that merely IMPORTS
   * its module over a loose textual mention; sections are returned in that order,
   * each capped by `limit` with its own `truncated` flag. Test files are split out
   * into `coveredBy` ("exercised by a test") rather than counted as production
   * consumers, and the change site's own fan-out is reported alongside. The only
   * work that is not already cached is the reference pass (one `tableSymbolsWithContent`
   * read — the same pass `find_dead_code` pays) and the join itself. Additive: no
   * schema change, no reindex.
   */
  async getChangeImpact(opts: {
    symbol?: string;
    path?: string;
    project?: string;
    depth?: number;
    limit?: number;
  }): Promise<ChangeImpactReport> {
    const symbol = opts.symbol?.trim();
    const filePath = opts.path?.trim();
    if (!symbol && !filePath) {
      throw new Error("getChangeImpact needs a symbol name and/or a file path.");
    }
    const depth = opts.depth ?? IMPACT_DEFAULT_DEPTH;
    const limit = opts.limit ?? IMPACT_DEFAULT_LIMIT;

    // Project resolution mirrors `getCallGraph`: from the file path, the explicit
    // name, or the single indexed project (an anchor may be a bare symbol name).
    let rec: IndexRecord;
    let absFile: string | undefined;
    if (filePath) {
      absFile = path.resolve(filePath);
      rec = this.resolveProjectForFile(absFile, opts.project);
    } else if (opts.project) {
      const r = this.registry.getIndex(opts.project);
      if (!r) throw this.indexNotFound(opts.project);
      rec = r;
    } else {
      const all = this.registry.listIndexes();
      if (all.length === 0) throw new Error("No indexed project; index a directory first.");
      if (all.length > 1) {
        throw new Error(
          `'${symbol}' could belong to multiple projects (${all.map((p) => p.name).join(", ")}) — " +
          "pass the 'project' (or 'path') argument to disambiguate.`,
        );
      }
      rec = all[0]!;
    }

    const graph = await this.buildCallGraph(rec);
    const anchor = this.resolveImpactAnchor(rec, graph, symbol, absFile);

    // Reference leg: one indexed-content pass (same read `findDeadCode` does).
    const allRows = await tableSymbolsWithContent(rec.tableName);
    const chunks: ImpactChunk[] = [];
    for (const r of allRows) {
      if (typeof r.content !== "string" || r.content.length === 0) continue;
      const chunk: ImpactChunk = {
        filePath: r.filePath,
        startLine: typeof r.startLine === "number" ? r.startLine : 1,
        content: r.content,
      };
      if (r.symbolName) chunk.symbolName = r.symbolName;
      if (r.symbolType) chunk.symbolType = r.symbolType;
      chunks.push(chunk);
    }

    // Imported-by leg: the on-demand import graph (mtime-keyed cache; the first
    // call per project parses every indexed file's imports).
    const depGraph = await this.buildImportGraph(rec);

    return buildImpactReport({
      project: rec.name,
      projectRoot: rec.path,
      anchor,
      callersOf: graph.reverse,
      calleesOf: graph.forward,
      symbolsByKey: graph.symbolsByKey,
      importedBy: depGraph.reverse,
      importsOf: depGraph.forward,
      chunks,
      isTestFile,
      depth,
      limit,
      scanTruncated: allRows.length >= 200000 || graph.truncated,
    });
  }

  /**
   * Resolves the ONE symbol the impact report is anchored on. Name matching
   * mirrors `get_call_graph` (`matchRootSymbols` → exact / prefix / dotted-suffix /
   * dotted-substring), so a bare method name resolves to its qualified indexed
   * form; a file anchor means the callables defined in that file. The candidate →
   * anchor reduction (dedup + the several-matches refusal) is `impact.selectAnchor`.
   */
  private resolveImpactAnchor(
    rec: IndexRecord,
    graph: CallGraphCacheEntry,
    symbol: string | undefined,
    absFile: string | undefined,
  ): ImpactAnchor {
    let matched: CallSymbol[];
    if (symbol) {
      matched = matchRootSymbols(graph.nameToSymbols, symbol);
      if (absFile) matched = matched.filter((s) => s.filePath === absFile);
      if (matched.length === 0) {
        const where = absFile ? ` in ${path.relative(rec.path, absFile)}` : "";
        throw new Error(`No callable symbol '${symbol}' found${where} (project: ${rec.name}).`);
      }
    } else {
      matched = absFile
        ? [...graph.symbolsByKey.values()].filter((s) => s.filePath === absFile)
        : [];
      if (matched.length === 0) {
        throw new Error(
          `No callable symbols found in '${path.relative(rec.path, absFile!)}' (project: ${rec.name}).`,
        );
      }
    }
    return selectAnchor(matched, rec.path, symbol ?? path.relative(rec.path, absFile!));
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
    if (!rec) throw this.indexNotFound(project);
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
      const key = `${name}\0${r.filePath}`;
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
      key: `${c.symbolName}\0${c.filePath}\0${c.declLine}`,
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
      const k = `${c.filePath}\0${c.symbolName}`;
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
        ? (refsByNameFile.get(`${c.filePath}\0${c.symbolName.split(".")[0]}`) ?? 0) > 0
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
      const sig = deriveSignature(c.content, c.language);
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
      if (!rec) throw this.indexNotFound(project);
      return rec;
    }
    const matches = this.registry.listIndexes().filter((r) => {
      const rel = path.relative(r.path, abs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (matches.length === 0) {
      const available = this.registry.listIndexes().map((r) => r.name);
      throw new Error(
        `No indexed project contains '${abs}'` +
          (available.length > 0 ? ` (available: ${available.join(", ")})` : "") + ".",
      );
    }
    if (matches.length === 1) return matches[0]!;
    // Most specific (longest path) wins; an exact tie is genuinely ambiguous.
    matches.sort((a, b) => b.path.length - a.path.length);
    if (matches[0]!.path.length === matches[1]!.path.length) {
      throw new Error(
        `'${abs}' could belong to multiple projects (${matches.map((m) => m.name).join(", ")}) — ` +
          "pass the 'project' (or a more specific 'path') argument to disambiguate.",
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

  /**
   * D1 — the doc-check snapshot for one project, cached on `lastIndexedAt`
   * (same discipline as `buildCallGraph`): one `tableSymbolsWithContent` pass
   * per index version. Chunks keep project-relative posix paths; doc artifacts
   * (.md/.json/.xml/.rst) are dropped — a documentation claim must be proven by
   * code, never by another document. Also collects the reverse-coverage
   * inventory: real candidate symbols, deduped by (name, file), min start line.
   */
  private async docChunks(rec: IndexRecord): Promise<DocChunkCacheEntry> {
    const cached = this.docChunkCache.get(rec.name);
    if (cached && cached.lastIndexedAt === rec.lastIndexedAt) return cached;

    const rows = await tableSymbolsWithContent(rec.tableName);
    const truncated = rows.length >= 200000;
    const chunks: DocCheckChunk[] = [];
    const symbols = new Map<string, DocSymbol>();
    for (const r of rows) {
      if (typeof r.filePath !== "string" || typeof r.content !== "string" || r.content.length === 0) continue;
      const rel = path.relative(rec.path, r.filePath);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const relPosix = rel.replace(/\\/g, "/");
      if (isDocPath(relPosix)) continue;
      const c: DocCheckChunk = {
        filePath: relPosix,
        startLine: typeof r.startLine === "number" ? r.startLine : 1,
        content: r.content,
      };
      if (typeof r.symbolName === "string" && r.symbolName) c.symbolName = r.symbolName;
      if (typeof r.symbolType === "string" && r.symbolType) c.symbolType = r.symbolType;
      chunks.push(c);

      if (
        c.symbolName &&
        c.symbolType &&
        DEAD_CANDIDATE_TYPES.has(c.symbolType) &&
        typeof r.endLine === "number"
      ) {
        const key = `${c.symbolName}\0${relPosix}`;
        const line = c.startLine;
        const ex = symbols.get(key);
        if (!ex) {
          symbols.set(key, {
            symbolName: c.symbolName,
            symbolType: c.symbolType,
            language: typeof r.language === "string" ? r.language : "",
            relativePath: relPosix,
            line,
            content: c.content,
          });
        } else {
          if (line < ex.line) ex.line = line;
          if (c.content.length > ex.content.length) ex.content = c.content;
          if (r.language) ex.language = r.language;
        }
      }
    }
    const entry: DocChunkCacheEntry = {
      lastIndexedAt: rec.lastIndexedAt,
      chunks,
      symbols: [...symbols.values()],
      truncated,
    };
    this.docChunkCache.set(rec.name, entry);
    return entry;
  }

  /** Searches a table according to the chosen mode (hybrid/vector/text). */
  private async searchOnTable(
    table: string,
    query: string,
    vector: number[] | null,
    limit: number,
    opts?: SearchOptions,
  ): Promise<TableSearch> {
    const where = buildWhere(opts);
    const mode = opts?.mode ?? "hybrid";
    const wantDoc = opts?.doc !== false;

    if (mode === "vector") {
      const vec = await searchTable(table, vector!, limit, where);
      if (!wantDoc) return { rows: vec, rrfMerged: false };
      return this.mergeWithExtraLegs(table, query, vector, where, limit, [vec], mode);
    }
    if (mode === "text") {
      const fts = await searchTableText(table, query, limit, where);
      if (!wantDoc) return { rows: fts, rrfMerged: false };
      return this.mergeWithExtraLegs(table, query, vector, where, limit, [fts], mode);
    }

    // hybrid: vector + BM25 → RRF (plus the docstring / identifier legs, when present)
    const pool = Math.max(limit * 3, 10);
    const [vec, fts] = await Promise.all([
      searchTable(table, vector!, pool, where),
      searchTableText(table, query, pool, where),
    ]);
    if (!wantDoc) return this.combine([vec, fts], limit);
    return this.mergeWithExtraLegs(table, query, vector, where, pool, [vec, fts], mode);
  }

  /**
   * Merges non-empty result lists: a single list keeps its native metric, multiple
   * lists go through RRF.
   */
  private combine(lists: SearchResult[][], fetchCount: number): TableSearch {
    const nonEmpty = lists.filter((l) => l.length > 0);
    if (nonEmpty.length === 0) return { rows: [], rrfMerged: false };
    if (nonEmpty.length === 1) return { rows: nonEmpty[0]!.slice(0, fetchCount), rrfMerged: false };
    return {
      rows: rrfMerge(nonEmpty, (r) => String(r.id), 60)
        .slice(0, fetchCount)
        .map(({ item, score }) => ({ ...item, _score: score })),
      rrfMerged: true,
    };
  }

  /**
   * Merges the optional retrieval legs with the base result lists via RRF:
   * the docstring legs (`doc_vector` ANN — needs a query vector — and BM25 over
   * `doc`) and the identifier-part leg (BM25 over `id_terms`). All are gated on
   * the table actually having the columns (tables indexed before 2.4.0 predate
   * `doc`/`doc_vector`; tables indexed before the identifier leg predate
   * `id_terms`), so legacy tables never pay the extra queries.
   *
   * The `id_terms` leg adds BM25 matches against compound identifiers split into
   * their subparts (`getUserName` → "getusername get user name"), so an
   * intent-shaped query ("update user name") can reach code through text, not
   * only through the vector leg. It runs in `hybrid` mode only, and only when
   * the query itself splits into ≥ 2 parts — a single-word query is already
   * served by the `content` leg, and the RRF rank pool stays undiluted for the
   * queries the leg cannot help. It merges **anonymously** (no marker field):
   * only doc hits carry `_docHit: true`.
   *
   * When no extra leg yields anything, the base lists keep their legacy
   * semantics untouched (`combine`'s native single-leg metrics).
   */
  private async mergeWithExtraLegs(
    table: string,
    query: string,
    vector: number[] | null,
    where: string | undefined,
    fetchCount: number,
    base: SearchResult[][],
    mode: string,
  ): Promise<TableSearch> {
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
    if (mode === "hybrid" && wantIdTermsLeg(query, cols.has("id_terms"))) {
      const hits = await searchTableText(table, query, fetchCount, where, ["id_terms"]);
      if (hits.length > 0) lists.push(hits);
    }
    if (lists.length === base.length) return this.combine(base, fetchCount);
    return {
      rows: rrfMerge(lists, (r) => String(r.id), 60)
        .slice(0, fetchCount)
        .map(({ item, score }) => {
          const row: SearchResult = { ...item, _score: score };
          if (docIds.has(String(row.id))) row._docHit = true;
          return row;
        }),
      rrfMerged: true,
    };
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

  /** Is path/surface boosting active for this call? */
  private wantBoost(opts?: SearchOptions): boolean {
    const flag = opts?.boost;
    return flag === true || (CONFIG.BOOST_ENABLED && flag !== false);
  }

  /**
   * The `search.boost` parameters handed to the pure boost pass. `enabled`
   * echoes the resolved call-level decision (`wantBoost`), so the pass runs
   * exactly when the caller wants it — a config-off session boosted per-call
   * (`boost: true`) uses the same weights, and anything skipped never reaches
   * `applyPathBoost` at all (its input is returned byte-identical there too).
   */
  private pathBoostCfg(enabled: boolean): PathBoostConfig {
    return {
      enabled,
      shortPath: CONFIG.BOOST_SHORT_PATH,
      sourceRoot: CONFIG.BOOST_SOURCE_ROOT,
      testDemotion: CONFIG.BOOST_TEST_DEMOTION,
      generatedDemotion: CONFIG.BOOST_GENERATED_DEMOTION,
      sourceRoots: CONFIG.BOOST_SOURCE_ROOTS,
    };
  }

  /**
   * Probes once (cached) whether the configured reranker model exists on the
   * resolved embedding backend (Ollama `/api/show`, llama-server `/v1/models`).
   * Default-on reranking must not pay a per-search storm of failed calls when the
   * model isn't installed, so reranking is disabled for the session if it's absent.
   * Public: the `doctor` diagnostic reports the same probe's verdict instead of
   * asking the backend a second time (one implementation, one cached answer).
   */
  async ensureRerankAvailable(): Promise<boolean> {
    if (this.rerankAvailable !== null) return this.rerankAvailable;
    if (!CONFIG.RERANK_MODEL) {
      this.rerankAvailable = false;
      return false;
    }
    try {
      const backend = await resolveEmbedBackend();
      const rerankUrl = CONFIG.RERANK_URL || backend.url;
      const found =
        backend.provider === "llamacpp"
          ? await probeLlamaServer(rerankUrl).then(
              (listing) => listing.up && modelTagPresent(listing.models, CONFIG.RERANK_MODEL),
            )
          : await fetch(`${rerankUrl}/api/show`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: CONFIG.RERANK_MODEL }),
            }).then((resp) => resp.ok);
      this.rerankAvailable = found;
      if (!found) {
        console.error(
          `[manager] reranker model '${CONFIG.RERANK_MODEL}' not found on the ${backend.provider} backend; ` +
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

  // ---------------------------------------------------- API diff (proposal C2)

  /**
   * Public API diff between two git refs ("did this release break anything
   * public?"). The BASE surface is re-parsed from git (`git ls-tree` →
   * `git show` → the same `chunkCode` recipe, in bounded concurrency — see
   * `extractRefSurface`); the HEAD surface comes from the index (the working
   * tree) unless an explicit `head` ref is given, in which case it is extracted
   * from that ref the same way. Read-only: no index mutation, no reindex,
   * nothing persisted, no embedding.
   *
   * `notARepo` / `unknownRef` / `invalidRef` are REPORTED, not thrown; files
   * that fail to read or parse at a ref are listed in `unparsedFiles` instead of
   * being skipped silently; `scannedFiles` + `truncated` surface the coverage of
   * the historical pass.
   */
  async getApiDiff(
    project: string,
    base: string,
    opts?: {
      /** The head ref (tag / SHA / branch). Defaults to the working tree = the index. */
      head?: string;
      /** Cap on returned entries (default 200); `counts` always covers everything. */
      limit?: number;
      /** Cap on files parsed per historical side (default `API_DIFF_MAX_FILES`). */
      maxFiles?: number;
      /** Keep only symbols that are exported on at least one side (default false). */
      exportedOnly?: boolean;
      /** List `unchanged` symbols too (default false — they are always counted). */
      includeUnchanged?: boolean;
    },
  ): Promise<ApiDiffResult> {
    const rec = this.registry.getIndex(project);
    if (!rec) throw this.indexNotFound(project);
    const limit = opts?.limit ?? 200;
    const head = opts?.head ?? WORKING_TREE;

    const result: ApiDiffResult = {
      project: rec.name,
      base,
      head,
      headIsIndex: !opts?.head,
      entries: [],
      counts: { removed: 0, signatureChanged: 0, visibilityNarrowed: 0, added: 0, unchanged: 0, breaking: 0 },
      unparsedFiles: [],
      scannedFiles: 0,
      truncated: false,
    };

    if (!(await isGitRepo(rec.path))) {
      result.notARepo = true;
      return result;
    }
    // Refs are validated before they reach a git argv (and reported, not thrown).
    if (!safeGitRef(base)) {
      result.invalidRef = "base";
      return result;
    }
    if (opts?.head !== undefined && !safeGitRef(opts.head)) {
      result.invalidRef = "head";
      return result;
    }
    if (!(await gitRefExists(rec.path, base))) {
      result.unknownRef = "base";
      return result;
    }
    if (opts?.head !== undefined && !(await gitRefExists(rec.path, opts.head))) {
      result.unknownRef = "head";
      return result;
    }

    // `exactOptionalPropertyTypes`: only carry `maxFiles` when the caller set it.
    const refOpts = opts?.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {};
    const baseSurface = await extractRefSurface(rec.path, base, refOpts);
    if (!baseSurface) {
      result.unknownRef = "base";
      return result;
    }
    result.scannedFiles = baseSurface.scannedFiles;
    result.truncated = baseSurface.truncated;
    result.unparsedFiles = baseSurface.unparsed.map((u) => ({ ...u, side: "base" as const }));

    let headSymbols: ApiSymbol[];
    if (opts?.head !== undefined) {
      const headSurface = await extractRefSurface(rec.path, opts.head, refOpts);
      if (!headSurface) {
        result.unknownRef = "head";
        return result;
      }
      headSymbols = headSurface.symbols;
      result.truncated = result.truncated || headSurface.truncated;
      result.unparsedFiles.push(...headSurface.unparsed.map((u) => ({ ...u, side: "head" as const })));
      result.scannedFiles += headSurface.scannedFiles;
    } else {
      headSymbols = await this.indexSurface(rec);
    }

    const entries = compareSurfaces(baseSurface.symbols, headSymbols);
    result.counts = countDiff(entries);
    const visible = opts?.includeUnchanged === true ? entries : entries.filter((e) => e.kind !== "unchanged");
    result.entries = (opts?.exportedOnly === true
      ? visible.filter((e) => e.base?.exported === true || e.head?.exported === true)
      : visible
    ).slice(0, limit);
    if (result.entries.length < visible.length) result.truncated = true;
    return result;
  }

  /**
   * The project's CURRENT surface, straight from the index: symbol rows only
   * (the indexer's character-fallback corpora carry no symbols), exportedness
   * recovered from the chunk text with the shared `detectExported` recipe. No
   * re-parse, no Ollama — the index *is* the working tree's surface.
   */
  private async indexSurface(rec: IndexRecord): Promise<ApiSymbol[]> {
    return surfaceFromIndexRows(rec.path, await tableSymbolsWithContent(rec.tableName));
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

  // ---------------------------------------------------- doc–code conformance (D1)

  /**
   * Deterministic doc–code conformance check (proposal D1): assemble the pure
   * engine's state (docs from disk, code chunks from the cached snapshot, the
   * path universe from the indexed file set + root listing + manifest) and run
   * it. NO Ollama calls — same state in, same report out. Optional drift
   * window (`since` ref or `window: true`) post-filters findings to those whose
   * doc or code side actually changed since the anchor; anything that degrades
   * is reported in `notes`, never silently widened.
   */
  async checkDocs(opts: {
    project?: string;
    path?: string;
    files?: string[];
    ignore?: string[];
    limit?: number;
    maxChars?: number;
    undocumentedLimit?: number;
    noUndocumented?: boolean;
    since?: string;
    window?: boolean;
  } = {}): Promise<DocCheckReport> {
    // Project resolution (the getCallGraph pattern): from a file path, an
    // explicit name, or the single indexed project.
    let rec: IndexRecord;
    const filePath = opts.path?.trim();
    if (filePath) {
      rec = this.resolveProjectForFile(path.resolve(filePath), opts.project);
    } else if (opts.project) {
      const r = this.registry.getIndex(opts.project);
      if (!r) throw this.indexNotFound(opts.project);
      rec = r;
    } else {
      const all = this.registry.listIndexes();
      if (all.length === 0) throw new Error("No indexed project; index a directory first.");
      if (all.length > 1) {
        throw new Error(
          `check_docs could target multiple projects (${all.map((p) => p.name).join(", ")}) — " +
          "pass the 'project' (or 'path') argument.`,
        );
      }
      rec = all[0]!;
    }

    // Per-project doc set: explicit args win, then `.cidx.json doccheck`.
    const cfg = readProjectConfig(rec.path);
    const files = opts.files ?? cfg?.doccheck?.files;
    const ignore = [...(opts.ignore ?? []), ...(cfg?.doccheck?.ignore ?? [])];

    const [discovery, manifest, snapshot] = await Promise.all([
      collectDocFiles(rec.path, { files, ignore }),
      readProjectManifest(rec.path),
      this.docChunks(rec),
    ]);

    // Read the docs (unreadable files are reported in notes, never fatal).
    const docs: DocFile[] = [];
    const notes: string[] = [];
    let docsUnreadable = 0;
    for (const abs of discovery.files) {
      const relPosix = path.relative(rec.path, abs).replace(/\\/g, "/");
      let text: string;
      try {
        text = await readFile(abs, "utf-8");
      } catch {
        docsUnreadable++;
        notes.push(`unreadable doc skipped: ${relPosix}`);
        continue;
      }
      docs.push({
        relPath: relPosix,
        lines: text.split("\n"),
        fileClass: HISTORICAL_FILE_RE.test(relPosix) ? "historical" : "current",
        suppressed: new Set<number>(),
      });
    }

    // The path-claim universe: indexed files ∪ checked docs ∪ every walked file
    // (`.sh`, `.wasm`, LICENSE, … — the index is an under-approximation of the
    // repo, the doc walk is not) ∪ root names.
    const repoFiles = new Set<string>(discovery.allFiles);
    for (const d of docs) repoFiles.add(d.relPath);
    for (const f of this.registry.listCachedFiles(rec.name)) {
      const rel = path.relative(rec.path, f).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..")) repoFiles.add(rel);
    }

    const state: DocCheckState = {
      project: rec.name,
      projectRoot: rec.path,
      docs,
      chunks: snapshot.chunks,
      repoFiles,
      rootNames: new Set(listRootFiles(rec.path)),
      manifest,
      exportedSymbols: snapshot.symbols,
      lastIndexedAt: rec.lastIndexedAt,
    };

    const report = runDocCheck(state, {
      limit: opts.limit,
      maxChars: opts.maxChars ?? CONFIG.DOC_CHECK_MAX_CHARS,
      undocumentedLimit: opts.undocumentedLimit ?? CONFIG.DOC_CHECK_UNDOCUMENTED,
      noUndocumented: opts.noUndocumented,
    });

    report.checked.truncated = discovery.truncated || snapshot.truncated;
    if (docsUnreadable > 0) report.checked.docsUnreadable = docsUnreadable;
    if (notes.length > 0) report.notes.push(...notes);

    if (opts.since || opts.window) {
      await this.applyDocCheckWindow(rec, report, docs, opts.since, !!opts.window);
    }
    return report;
  }

  /**
   * Drift-window post-filter: keep a finding only when its doc file changed
   * since the anchor OR its evidence file did. The anchor is `since` (a git
   * ref, resolved to its commit time) or, with `window: true`, the most recent
   * commit that touched any checked doc. Anything that fails to resolve
   * degrades to the full scan with a note — never a silent no-op.
   */
  private async applyDocCheckWindow(
    rec: IndexRecord,
    report: DocCheckReport,
    docs: DocFile[],
    since: string | undefined,
    window: boolean,
  ): Promise<void> {
    const isRepo = await isGitRepo(rec.path);
    if (!isRepo) {
      report.notes.push("window requested but the project is not a git repo — full scan");
      return;
    }

    let anchor: number | null = null;
    let anchorLabel = "";
    if (since) {
      const ref = safeGitRef(since);
      anchor = ref ? await gitCommitTimeAt(rec.path, ref) : null;
      if (anchor === null) {
        report.notes.push(`since '${since}' did not resolve to a commit — full scan`);
      } else {
        anchorLabel = ref!;
      }
    }
    if (window) {
      // The most recent commit that touched any checked doc.
      let newest = 0;
      const changed = new Set<string>();
      for (const d of docs) {
        const hits = await searchGitLog(rec.path, { path: d.relPath, limit: 1 });
        const ts = hits[0]?.timestamp ?? 0;
        if (ts > 0) changed.add(d.relPath);
        if (ts > newest) newest = ts;
      }
      if (newest === 0) {
        report.notes.push("window requested but no doc commit was found — full scan");
      } else if (anchor === null || newest > anchor) {
        anchor = newest;
        anchorLabel = `last doc commit (${new Date(newest).toISOString()})`;
      }
    }

    if (anchor === null) return; // degraded to full scan; the note explains why

    const gitSince = `@${Math.floor(anchor / 1000)}`;
    const codeHits = await searchGitLog(rec.path, { since: gitSince, withFiles: true, limit: 1000 });
    const codeChanged = new Set<string>();
    for (const h of codeHits) for (const f of h.files ?? []) codeChanged.add(f.replace(/\\/g, "/"));
    const docsChanged = new Set<string>();
    for (const d of docs) {
      const hits = await searchGitLog(rec.path, { path: d.relPath, since: gitSince, limit: 1 });
      if (hits.length > 0) docsChanged.add(d.relPath);
    }

    const keep = (f: { doc: { path: string }; evidence?: { path: string }[] }): boolean => {
      if (docsChanged.has(f.doc.path)) return true;
      if (!f.evidence || f.evidence.length === 0) return false;
      return f.evidence.some((e) => codeChanged.has(e.path));
    };
    const findingsBefore = report.findings.length;
    const reviewBefore = report.needsReview.length;
    report.findings = report.findings.filter(keep);
    report.needsReview = report.needsReview.filter(keep);
    report.checked.window = {
      since: anchorLabel || new Date(anchor).toISOString(),
      docsChanged: docsChanged.size,
      codeChanged: codeChanged.size,
    };
    if (report.findings.length !== findingsBefore || report.needsReview.length !== reviewBefore) {
      report.notes.push(
        `drift window: ${findingsBefore - report.findings.length} finding(s) and ${reviewBefore - report.needsReview.length} review item(s) predate the window`,
      );
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
