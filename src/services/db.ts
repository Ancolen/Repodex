import { mkdir } from "node:fs/promises";
import * as lancedb from "@lancedb/lancedb";
import { CONFIG } from "../config";

/**
 * The DB record of a code chunk.
 * Fixed schema — tree-sitter metadata fields (symbolName, startLine ...) are
 * present in every record (LanceDB expects the same columns in all rows).
 */
export interface CodeRecord {
  id: string;
  filePath: string;
  content: string;
  vector: number[];
  language?: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
  endLine?: number;
  [key: string]: unknown; // for LanceDB Data compatibility
}

export interface SearchResult extends CodeRecord {
  /** Vector search distance (lower = closer). May be absent in FTS-only results. */
  _distance?: number;
  /** BM25 / RRF combined relevance score (higher = more relevant). */
  _score?: number;
  /** Second-stage reranker relevance (0–1, higher = more relevant). Present only when reranking ran. */
  _rerankScore?: number;
}

/** Metadata filters that narrow search results. */
export interface SearchFilters {
  /** Language (e.g. "python", "typescript"). Exact match. */
  language?: string | undefined;
  /** Symbol type (e.g. "function", "class", "method"). Exact match. */
  symbolType?: string | undefined;
  /** File path pattern. The `*` wildcard is converted to SQL LIKE `%`. */
  pathGlob?: string | undefined;
}

let db: lancedb.Connection | null = null;

/** Opens the LanceDB connection (central DB_DIR). */
export async function initDB(): Promise<void> {
  await mkdir(CONFIG.DB_DIR, { recursive: true });
  db = await lancedb.connect(CONFIG.DB_DIR);
}

function getDB(): lancedb.Connection {
  if (!db) throw new Error("DB not initialized. initDB() must be called first.");
  return db;
}

/** Escapes single quotes for a SQL string literal. */
function sqlLit(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Escapes a literal text to be used inside a LIKE pattern:
 * first single quotes (string literal), then LIKE meta characters (`\`, `%`, `_`).
 * `\` is used as the escape character → `ESCAPE '\'` must be added to the query.
 * Without this, the `_` (which means "any single character" in LIKE) in snake_case
 * symbol names leads to false positive matches (e.g. 'get_user' → 'getXuser').
 */
function sqlLikeLit(s: string): string {
  return s.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&");
}

/** Standard ESCAPE suffix to append to LIKE queries. */
const LIKE_ESCAPE = ` ESCAPE '\\'`;

/**
 * Serializes write operations (insert/delete/createTable) to the same LanceDB
 * table on a per-project basis. Prevents the race where the watcher or concurrent
 * first-inserts try to create/modify the same table at the same time.
 * (The race between the background full-index job and the watcher is also
 * prevented by the `isBusy` check in IndexManager; this lock is an extra safeguard.)
 */
const tableWriteLocks = new Map<string, Promise<unknown>>();
function lockTable<T>(table: string, fn: () => Promise<T>): Promise<T> {
  const prev = tableWriteLocks.get(table) ?? Promise.resolve();
  // Don't break the chain even if the previous task failed (swallow the error, then run).
  const run = prev.then(fn, fn);
  tableWriteLocks.set(
    table,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Builds a LanceDB `where` SQL predicate from SearchFilters.
 * Returns undefined if there are no filters.
 */
export function buildWhere(filters?: SearchFilters): string | undefined {
  if (!filters) return undefined;
  const clauses: string[] = [];
  if (filters.language) clauses.push(`language = '${sqlLit(filters.language)}'`);
  if (filters.symbolType) clauses.push(`symbolType = '${sqlLit(filters.symbolType)}'`);
  if (filters.pathGlob) {
    // Simple glob → LIKE. Stored filePath values are ABSOLUTE and SQL '%' spans
    // '/', so the anchor depends on the leading character:
    //   starts with '/' → anchored at the absolute path start;
    //   otherwise       → '%' prepended (project-relative usage, e.g. 'src/*'
    //                     or 'docs/*', matches anywhere in the path).
    // '*' → '%'; '**/' → '*' ('%' spans '/', so it covers zero-or-more dirs);
    // '**' → '*'. With no wildcard, substring match (%...%) — the same with or
    // without the anchor.
    // First escape LIKE meta characters (\ % _), THEN turn glob '*' into '%';
    // this way a literal '_'/'%' in the path doesn't cause a false match.
    const anchored = filters.pathGlob.startsWith("/");
    const collapsed = filters.pathGlob.replace(/\*\*\//g, "*").replace(/\*\*/g, "*");
    const esc = collapsed.replace(/[\\%_]/g, "\\$&");
    const hasWildcard = esc.includes("*");
    const body = hasWildcard ? esc.replace(/\*/g, "%") : `%${esc}%`;
    const like = hasWildcard && !anchored ? `%${body}` : body;
    clauses.push(`filePath LIKE '${sqlLit(like)}'${LIKE_ESCAPE}`);
  }
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

/**
 * Adds chunks to the given table.
 *
 * Deletes old records **by filePath, not by id**: when a file changes and produces
 * FEWER chunks (code deleted/shortened), this prevents old high-index chunks
 * (`file#7`, `file#8`, ...) from remaining stale in the table. Although records
 * always belong to a single file, to be safe all distinct filePaths in the records
 * are cleaned up. The table is created if it does not exist.
 *
 * Writes are serialized per table (against a concurrent createTable race).
 */
export async function insertChunks(table: string, records: CodeRecord[]): Promise<void> {
  if (records.length === 0) return;
  return lockTable(table, async () => {
    const conn = getDB();
    const names = await conn.tableNames();
    if (names.includes(table)) {
      const t = await conn.openTable(table);
      const paths = [...new Set(records.map((r) => r.filePath))];
      const inList = paths.map((p) => `'${sqlLit(p)}'`).join(",");
      await t.delete(`filePath IN (${inList})`);
      await t.add(records);
    } else {
      await conn.createTable(table, records);
    }
  });
}

/** Deletes all chunks belonging to a file. */
export async function deleteFileRecords(table: string, filePath: string): Promise<void> {
  return lockTable(table, async () => {
    const conn = getDB();
    const names = await conn.tableNames();
    if (!names.includes(table)) return;
    const t = await conn.openTable(table);
    await t.delete(`filePath = '${sqlLit(filePath)}'`);
  });
}

/** Vector (semantic) search; with an optional metadata filter. */
export async function searchTable(
  table: string,
  queryVector: number[],
  limit = 5,
  where?: string,
): Promise<SearchResult[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  let q = t.search(queryVector).limit(limit);
  if (where) q = q.where(where);
  return (await q.toArray()) as SearchResult[];
}

/**
 * Full-text (BM25) search; with an optional metadata filter.
 * Requires an FTS index on `content` (returns empty if absent).
 */
export async function searchTableText(
  table: string,
  queryText: string,
  limit = 5,
  where?: string,
): Promise<SearchResult[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  try {
    let q = t.query().fullTextSearch(queryText, { columns: ["content"] }).limit(limit);
    if (where) q = q.where(where);
    return (await q.toArray()) as SearchResult[];
  } catch {
    // If there is no FTS index or the query resolves to empty tokens: silently return empty.
    return [];
  }
}

/**
 * Search by symbol name (exact + prefix). Requires no vector/FTS; it is a small
 * `where` scan. It is the basis of the `find_symbol` tool.
 */
export async function searchSymbol(
  table: string,
  name: string,
  limit = 20,
  extraWhere?: string,
): Promise<SearchResult[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  const eq = sqlLit(name);
  const lk = sqlLikeLit(name);
  // Exact match, or methods that start with 'name' or are of the form 'Class.name'.
  // Literal '_'/'%' in LIKE patterns are escaped (ESCAPE '\') → no false positives
  // in snake_case symbol names.
  const clauses = [
    `symbolName = '${eq}'`,
    `symbolName LIKE '${lk}%'${LIKE_ESCAPE}`,
    `symbolName LIKE '%.${lk}'${LIKE_ESCAPE}`,
    `symbolName LIKE '%.${lk}%'${LIKE_ESCAPE}`,
  ];
  let where = `(${clauses.join(" OR ")})`;
  if (extraWhere) where = `${where} AND (${extraWhere})`;
  const rows = (await t.query().where(where).limit(limit).toArray()) as SearchResult[];
  return rows;
}

/** Lightweight chunk metadata (no vectors/content) for repo aggregation. */
export interface ChunkMeta {
  filePath: string;
  language?: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Returns the metadata columns of every chunk in a table (no `vector`/`content`),
 * for repository overview aggregation. `maxRows` caps memory on huge tables.
 */
export async function tableMetadata(table: string, maxRows = 200000): Promise<ChunkMeta[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  const rows = (await t
    .query()
    .select(["filePath", "language", "symbolName", "symbolType", "startLine", "endLine"])
    .limit(maxRows)
    .toArray()) as ChunkMeta[];
  return rows;
}

/** Chunk metadata plus its full `content` (no vector). */
export interface ChunkMetaWithContent extends ChunkMeta {
  content?: string;
}

/**
 * Like `tableMetadata` but keeps `content` (selects explicit columns so the
 * large `vector` column is never pulled). The basis of dependency-graph and
 * dead-code analysis, both of which read each chunk's text in one pass.
 * `maxRows` caps memory on huge tables (and is surfaced as `truncated` upstream).
 */
export async function tableSymbolsWithContent(
  table: string,
  maxRows = 200000,
): Promise<ChunkMetaWithContent[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  const rows = (await t
    .query()
    .select(["filePath", "language", "symbolName", "symbolType", "startLine", "endLine", "content"])
    .limit(maxRows)
    .toArray()) as ChunkMetaWithContent[];
  return rows;
}

/**
 * Returns chunks whose `content` contains `term` as a substring (LIKE scan).
 * The basis of `find_references`: candidate chunks are fetched cheaply here, then
 * filtered to whole-identifier matches in JS. LIKE meta-characters are escaped.
 */
export async function searchContent(
  table: string,
  term: string,
  limit = 200,
  extraWhere?: string,
): Promise<SearchResult[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  const lk = sqlLikeLit(term);
  let where = `content LIKE '%${lk}%'${LIKE_ESCAPE}`;
  if (extraWhere) where = `${where} AND (${extraWhere})`;
  return (await t.query().where(where).limit(limit).toArray()) as SearchResult[];
}

/** Drops a table entirely (index removal). */
export async function dropTable(table: string): Promise<void> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (names.includes(table)) await conn.dropTable(table);
}

/**
 * If the table exceeds `minRows` rows and does not yet have a vector index,
 * builds an ANN index on the `vector` column (default: IVF_PQ, chosen by LanceDB
 * based on column statistics). On small tables, brute-force is already fast enough,
 * so no index is built (training cost + memory).
 *
 * @returns true if an index was built.
 */
export async function ensureVectorIndex(table: string, minRows: number): Promise<boolean> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return false;
  const t = await conn.openTable(table);

  const rows = await t.countRows();
  if (rows < minRows) return false;

  const existing = await t.listIndices();
  const hasVectorIndex = existing.some((ix) => ix.columns.includes("vector"));
  if (hasVectorIndex) return false;

  await t.createIndex("vector");
  return true;
}

/**
 * Builds a full-text (BM25) index on the `content` column (if absent).
 * Required for the BM25 leg of hybrid search. Skipped if the table is empty.
 *
 * @returns true if an index was built.
 */
export async function ensureFtsIndex(table: string): Promise<boolean> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return false;
  const t = await conn.openTable(table);

  if ((await t.countRows()) === 0) return false;

  const existing = await t.listIndices();
  const hasFts = existing.some(
    (ix) => ix.columns.includes("content") && /fts|inverted/i.test(ix.indexType),
  );
  if (hasFts) return false;

  await t.createIndex("content", { config: lancedb.Index.fts() });
  return true;
}

export async function listTables(): Promise<string[]> {
  return getDB().tableNames();
}
