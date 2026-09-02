import { mkdir } from "node:fs/promises";
import * as lancedb from "@lancedb/lancedb";
import { CONFIG } from "../config";

/**
 * The DB record of a code chunk.
 * Fixed schema — tree-sitter metadata fields (symbolName, startLine ...) are
 * present in every record (LanceDB expects the same columns in all rows).
 *
 * `doc` / `doc_vector` (docstring embedding leg, 2.4.0): the symbol's
 * docstring/doc comment and its embedding. Null on chunks without a symbol
 * doc. Tables created before 2.4.0 lack these columns — `insertChunks` strips
 * the fields for those (legacy tables gain them on a full reindex).
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
  /** Docstring / doc comment of the symbol (null when none). */
  doc?: string | null;
  /** Embedding of `doc`, same model/dim as `vector` (null when no doc). */
  doc_vector?: number[] | null;
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
 * LEGACY COMPATIBILITY: tables created before 2.4.0 have no `doc`/`doc_vector`
 * columns; adding records with unknown fields fails at the Arrow layer, so the
 * fields are stripped for those tables (search skips the doc legs there too).
 * A full reindex recreates the table with the full schema.
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
      await t.add(await stripUnknownColumns(t, records));
    } else {
      await conn.createTable(table, records);
    }
  });
}

/**
 * Drops `doc` / `doc_vector` from records when the table predates those columns
 * (LanceDB rejects unknown fields with "Found field not in schema").
 */
async function stripUnknownColumns(t: lancedb.Table, records: CodeRecord[]): Promise<CodeRecord[]> {
  const cols = new Set((await t.schema()).fields.map((f) => f.name));
  if (cols.has("doc") && cols.has("doc_vector")) return records;
  return records.map((r) => {
    const { doc, doc_vector, ...rest } = r;
    void doc;
    void doc_vector;
    return rest as CodeRecord;
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

/**
 * Column names of a table (empty set when the table does not exist). Used to
 * adapt to legacy tables that predate the `doc` / `doc_vector` columns and to
 * decide which search legs are available.
 */
export async function tableColumns(table: string): Promise<Set<string>> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return new Set();
  const t = await conn.openTable(table);
  return new Set((await t.schema()).fields.map((f) => f.name));
}

/** Vector (semantic) search; with an optional metadata filter. */
export async function searchTable(
  table: string,
  queryVector: number[],
  limit = 5,
  where?: string,
  column: string = "vector",
): Promise<SearchResult[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  // The vector column is always explicit: once a table carries a second vector
  // column (`doc_vector`), LanceDB refuses to guess which one to search.
  // `nearestTo` (unlike `search`) is statically a VectorQuery, so `.column` typechecks.
  let q = t.query().nearestTo(queryVector).column(column).limit(limit);
  if (where) q = q.where(where);
  return (await q.toArray()) as SearchResult[];
}

/**
 * Full-text (BM25) search; with an optional metadata filter.
 * Requires an FTS index on the searched columns (returns empty if absent).
 * `columns` defaults to `content`; the docstring leg passes `doc`.
 */
export async function searchTableText(
  table: string,
  queryText: string,
  limit = 5,
  where?: string,
  columns: string[] = ["content"],
): Promise<SearchResult[]> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return [];
  const t = await conn.openTable(table);
  try {
    let q = t.query().fullTextSearch(queryText, { columns }).limit(limit);
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
 * Total rows in a table (0 when the table does not exist). Used to report the
 * table's true chunk count after a job — an incremental sync's per-job write
 * count would otherwise masquerade as the total.
 */
export async function countTableRows(table: string): Promise<number> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return 0;
  const t = await conn.openTable(table);
  return await t.countRows();
}

/**
 * If the table exceeds `minRows` rows and does not yet have a vector index,
 * builds an ANN index on the given vector column (default `vector`; pass
 * `doc_vector` for the docstring leg — skipped when the column is absent,
 * i.e. legacy tables). On small tables, brute-force is already fast enough,
 * so no index is built (training cost + memory).
 *
 * @returns true if an index was built.
 */
export async function ensureVectorIndex(table: string, minRows: number, column = "vector"): Promise<boolean> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return false;
  const t = await conn.openTable(table);

  if (!(await tableColumns(table)).has(column)) return false;

  const rows = await t.countRows();
  if (rows < minRows) return false;

  const existing = await t.listIndices();
  const hasVectorIndex = existing.some((ix) => ix.columns.includes(column));
  if (hasVectorIndex) return false;

  await t.createIndex(column);
  return true;
}

/**
 * Builds full-text (BM25) indexes on the `content` column and — when the table
 * has the docstring column — on `doc` (both if absent). Required for the BM25
 * legs of hybrid search. Skipped if the table is empty.
 *
 * @returns the number of indexes built.
 */
export async function ensureFtsIndex(table: string): Promise<number> {
  const conn = getDB();
  const names = await conn.tableNames();
  if (!names.includes(table)) return 0;
  const t = await conn.openTable(table);

  if ((await t.countRows()) === 0) return 0;

  const existing = await t.listIndices();
  const hasFtsOn = (col: string) =>
    existing.some((ix) => ix.columns.includes(col) && /fts|inverted/i.test(ix.indexType));

  let built = 0;
  if (!hasFtsOn("content")) {
    await t.createIndex("content", { config: lancedb.Index.fts() });
    built++;
  }
  // The doc column duplicates docstring text only; BM25 over it gives the text
  // leg of the docstring search. Legacy tables without the column are skipped.
  if ((await tableColumns(table)).has("doc") && !hasFtsOn("doc")) {
    try {
      await t.createIndex("doc", { config: lancedb.Index.fts() });
      built++;
    } catch (err) {
      // Never fail the whole job over the optional doc leg.
      console.error(`[db] failed to build FTS index on 'doc' for '${table}':`, err);
    }
  }
  return built;
}

export async function listTables(): Promise<string[]> {
  return getDB().tableNames();
}
