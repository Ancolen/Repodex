import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { CONFIG } from "../config";

export type IndexStatus = "indexing" | "ready" | "error";

/**
 * The LanceDB table name derived from a project name (`idx_<sanitized-name>`) —
 * the exact recipe `createIndex` pins into `IndexRecord.tableName`. Kept as ONE
 * shared derivation so the stored name, a legacy backfill and the doctor all
 * agree on what a project's table is called.
 */
export function deriveTableName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `idx_${s.length > 0 ? s : "idx"}`;
}

/**
 * The LanceDB table a project record is served from: the name STORED on the
 * record when it carries one, else the derived default. This is the single
 * helper every table-name consumer goes through. It matters because the O2
 * model migration legitimately flips the STORED name to the shadow table
 * (`idx_<x>_mig`), so "the name on the record" and "the name derived from the
 * project name" can differ — deriving from scratch at a call site would point
 * at a stale table after a migration.
 */
export function tableNameFor(record: { name: string; tableName?: string | null }): string {
  const stored = record.tableName;
  return stored != null && stored.length > 0 ? stored : deriveTableName(record.name);
}

/** Represents an indexed project in the registry. */
export interface IndexRecord {
  name: string;
  path: string;
  tableName: string;
  status: IndexStatus;
  fileCount: number;
  chunkCount: number;
  embedModel: string | null;
  embedDim: number | null;
  /**
   * The embedding task-framing identity the table was built with (per-model
   * framing layer, `src/core/framing.ts`): a preset id ("embeddinggemma-2" |
   * "qwen3-embedding") or null for unframed. Nullable like the other optional
   * columns (CodeRecord.doc): rows stored before the column existed read as
   * null, and null is also the legitimate pin for records resolving to no
   * framing — the two are the same behavior, so legacy rows need no backfill
   * and keep byte-identical search.
   */
  framing?: string | null;
  lastIndexedAt: number | null;
  createdAt: number;
  error: string | null;
}

/** Persistent row representation of jobs (mapped to Job in core/types.ts). */
export interface JobRow {
  id: string;
  type: string;
  status: string;
  payload: string | null; // JSON
  progressProcessed: number;
  progressTotal: number;
  progressMessage: string | null;
  result: string | null; // JSON
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// ------------------------------------------------- query log (proposal A3)

/**
 * One recorded search (local query log, proposal A3). Written from the exit
 * path of `IndexManager.searchIndex`/`searchAll` — exactly one row per
 * (project, query) call. Never leaves `~/.cidx`: privacy is "local-only, no
 * query embeddings persisted".
 */
export interface QueryLogRow {
  /** When the search started (epoch ms). */
  ts: number;
  /** The project searched, or null for a cross-project (`searchAll`) query. */
  project: string | null;
  query: string;
  /** Search mode: "hybrid" | "vector" | "text". */
  mode: string;
  resultCount: number;
  latencyMs: number;
}

/** Options of `Registry.queryLogStats`. */
export interface QueryLogStatsOpts {
  /**
   * Only aggregate rows recorded for this project. Cross-project searches are
   * logged with `project = null` and therefore count toward the global stats
   * only.
   */
  project?: string | undefined;
  /** How many of the most frequent queries to report (default 10). */
  topQueries?: number | undefined;
  /** How many zero-hit queries to report (default 20). */
  zeroHitTop?: number | undefined;
}

/** One aggregated query-frequency entry. */
export interface QueryTopEntry {
  query: string;
  count: number;
  /** Mean result count over this query's rows (rounded to 2 decimals). */
  avgResultCount: number;
}

/** One aggregated zero-hit query entry — the index-gap signal. */
export interface QueryZeroHitEntry {
  query: string;
  count: number;
}

/** Aggregated search analytics (proposal A3) — pure sqlite aggregation, no LLM. */
export interface QueryLogStats {
  /** Rows currently covered by the aggregation (respecting the project filter). */
  total: number;
  topQueries: QueryTopEntry[];
  /** Queries that returned 0 results — a bad query or an index gap. */
  zeroHit: QueryZeroHitEntry[];
  /** Mean search latency in ms over the covered rows (rounded to 1 decimal). */
  avgLatencyMs: number;
  maxLatencyMs: number;
  /**
   * Fraction of searches that repeated an identical query already in the log:
   * `1 − distinctQueries/total` (rounded to 3 decimals, 0..1) — the cache-hit
   * estimate: the shared query-embedding cache already absorbs these.
   */
  repeatRate: number;
}

/** Row count + estimated size of the embedding cache (proposal O3 table stats). */
export interface EmbedCacheStats {
  rows: number;
  /** Summed vector-BLOB bytes — the bulk of every row, so an honest estimate. */
  estimatedBytes: number;
}

// ---------------------------------------- doccheck reports (proposal D1c, watch)

/**
 * The LATEST stored doc–code conformance report for one project (proposal D1c
 * watch mode): the `doccheck` job UPSERTs a row on every run and `cidx
 * doccheck <project> --last` reads it back. One row per project (PRIMARY KEY
 * on the name) — the registry deliberately keeps only the most recent
 * snapshot; the full report rides as JSON.
 */
export interface DocCheckReportRow {
  project: string;
  /** Epoch ms of the moment the doccheck job stored the snapshot. */
  ts: number;
  /** `verdict.consistent` — zero drift findings. */
  consistent: boolean;
  /** `verdict.findings` (hard drift). */
  findings: number;
  /** `verdict.needsReview` (NOT failures). */
  needsReview: number;
  /** The full `DocCheckReport` as JSON. */
  reportJson: string;
}

/**
/** Rounds a (possibly NULL aggregate) number to `digits` decimals; non-finite → 0. */
function round(x: number | null | undefined, digits: number): number {
  if (x === null || x === undefined || !Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * Central meta store (bun:sqlite).
 * - indexes:      indexed projects
 * - file_cache:   per-file mtime cache (to skip unchanged files)
 * - jobs:         async job persistence (survives daemon restarts)
 * - query_log:    local search analytics (proposal A3, `cidx stats`)
 * - doccheck_reports: latest doc-check snapshot per project (D1c watch mode)
 */
export class Registry {
  private db: Database;

  constructor(dbPath: string = CONFIG.META_DB_PATH) {
    mkdirSync(CONFIG.ROOT_DIR, { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS indexes (
        name            TEXT PRIMARY KEY,
        path            TEXT NOT NULL,
        table_name      TEXT NOT NULL,
        status          TEXT NOT NULL,
        file_count      INTEGER NOT NULL DEFAULT 0,
        chunk_count     INTEGER NOT NULL DEFAULT 0,
        embed_model     TEXT,
        embed_dim       INTEGER,
        framing         TEXT,
        last_indexed_at INTEGER,
        created_at      INTEGER NOT NULL,
        error           TEXT
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_cache (
        index_name TEXT NOT NULL,
        file_path  TEXT NOT NULL,
        mtime_ms   REAL NOT NULL,
        PRIMARY KEY (index_name, file_path)
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id                 TEXT PRIMARY KEY,
        type               TEXT NOT NULL,
        status             TEXT NOT NULL,
        payload            TEXT,
        progress_processed INTEGER NOT NULL DEFAULT 0,
        progress_total     INTEGER NOT NULL DEFAULT 0,
        progress_message   TEXT,
        result             TEXT,
        error              TEXT,
        created_at         INTEGER NOT NULL,
        started_at         INTEGER,
        finished_at        INTEGER
      );
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        model      TEXT NOT NULL,
        hash       TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        vector     BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (model, hash)
      );
    `);

    // Search analytics (proposal A3): one row per completed search call, pruned
    // to the most recent `search.queryLogSize` rows at write time. `id` is a
    // rowid alias, so "oldest" is simply the lowest id (even for equal ts).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS query_log (
        id           INTEGER PRIMARY KEY,
        ts           INTEGER NOT NULL,
        project      TEXT,
        query        TEXT NOT NULL,
        mode         TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        latency_ms   INTEGER NOT NULL
      );
    `);

    // Latest stored doc–code conformance report per project (proposal D1c watch
    // mode): the `doccheck` job UPSERTs on every run, `cidx doccheck --last`
    // reads the snapshot back. SQLite has no BOOLEAN — `consistent` is 0/1.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS doccheck_reports (
        project      TEXT PRIMARY KEY,
        ts           INTEGER NOT NULL,
        consistent   INTEGER NOT NULL,
        findings     INTEGER NOT NULL DEFAULT 0,
        needs_review INTEGER NOT NULL DEFAULT 0,
        report_json  TEXT NOT NULL
      );
    `);

    // Stored table names (O2): ensure the column on a registry that predates it,
    // then backfill any row stored without one. Both are idempotent.
    this.ensureTableNameColumn();
    this.backfillTableNames();
    // Stored embedding framing (per-model task prefixes): ensure the column on
    // a registry that predates it, idempotent (see ensureFramingColumn).
    this.ensureFramingColumn();
  }

  /**
   * Lazy schema migration: a foreign/partly-rebuilt meta.db whose `indexes`
   * table predates the stored table name gets the column added lazily rather
   * than failing every boot. The shipped schema always created it (NOT NULL);
   * the ALTER-added column is nullable and is immediately backfilled.
   */
  private ensureTableNameColumn(): void {
    const cols = this.db.query(`PRAGMA table_info(indexes)`).all() as { name: string | null }[];
    if (!cols.some((c) => c.name === "table_name")) {
      this.db.run(`ALTER TABLE indexes ADD COLUMN table_name TEXT`);
    }
  }

  /** One-time, idempotent: rows stored without a table name get the derived one. */
  private backfillTableNames(): void {
    const rows = this.db
      .query(`SELECT name FROM indexes WHERE table_name IS NULL OR table_name = ''`)
      .all() as { name: string | null }[];
    if (rows.length === 0) return;
    const stmt = this.db.query(`UPDATE indexes SET table_name = $t WHERE name = $n`);
    for (const r of rows) {
      if (r.name) stmt.run({ $t: deriveTableName(r.name), $n: r.name });
    }
    console.error(`[registry] backfilled ${rows.length} index record(s) with a derived table name.`);
  }

  /**
   * Lazy schema migration for the stored embedding framing: a foreign meta.db
   * whose `indexes` table predates the column gets it added lazily rather than
   * failing every boot. No data backfill follows — DELIBERATELY, unlike
   * `table_name`: null IS the legacy value (an unframed index), so rows stored
   * without a framing are already correct and must stay byte-identical, with
   * no forced reindex. (`rowToIndex` normalizes an empty string to null, so a
   * corrupt '' reads as the unframed pin it can only mean.) Idempotent, like
   * the rest of `migrate()`.
   */
  private ensureFramingColumn(): void {
    const cols = this.db.query(`PRAGMA table_info(indexes)`).all() as { name: string | null }[];
    if (!cols.some((c) => c.name === "framing")) {
      this.db.run(`ALTER TABLE indexes ADD COLUMN framing TEXT`);
    }
  }

  // ---------------------------------------------------------------- indexes
  upsertIndex(rec: IndexRecord): void {
    this.db
      .query(
        `INSERT INTO indexes
           (name, path, table_name, status, file_count, chunk_count,
            embed_model, embed_dim, framing, last_indexed_at, created_at, error)
         VALUES
           ($name, $path, $table, $status, $fileCount, $chunkCount,
            $embedModel, $embedDim, $framing, $lastIndexedAt, $createdAt, $error)
         ON CONFLICT(name) DO UPDATE SET
           path=$path, table_name=$table, status=$status,
           file_count=$fileCount, chunk_count=$chunkCount,
           embed_model=$embedModel, embed_dim=$embedDim, framing=$framing,
           last_indexed_at=$lastIndexedAt, error=$error`,
      )
      .run({
        $name: rec.name,
        $path: rec.path,
        $table: rec.tableName,
        $status: rec.status,
        $fileCount: rec.fileCount,
        $chunkCount: rec.chunkCount,
        $embedModel: rec.embedModel,
        $embedDim: rec.embedDim,
        $framing: rec.framing ?? null,
        $lastIndexedAt: rec.lastIndexedAt,
        $createdAt: rec.createdAt,
        $error: rec.error,
      });
  }

  getIndex(name: string): IndexRecord | null {
    const row = this.db
      .query(`SELECT * FROM indexes WHERE name = $name`)
      .get({ $name: name }) as Record<string, unknown> | null;
    return row ? this.rowToIndex(row) : null;
  }

  listIndexes(): IndexRecord[] {
    const rows = this.db
      .query(`SELECT * FROM indexes ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToIndex(r));
  }

  setIndexStatus(name: string, status: IndexStatus, error: string | null = null): void {
    this.db
      .query(`UPDATE indexes SET status = $status, error = $error WHERE name = $name`)
      .run({ $name: name, $status: status, $error: error });
  }

  setIndexStats(name: string, fileCount: number, chunkCount: number, lastIndexedAt: number): void {
    this.db
      .query(
        `UPDATE indexes SET file_count=$fc, chunk_count=$cc, last_indexed_at=$ts WHERE name=$name`,
      )
      .run({ $name: name, $fc: fileCount, $cc: chunkCount, $ts: lastIndexedAt });
  }

  /** Records which embedding model/dimension the index was created with. */
  setIndexEmbedding(name: string, model: string, dim: number): void {
    this.db
      .query(`UPDATE indexes SET embed_model=$m, embed_dim=$d WHERE name=$name`)
      .run({ $name: name, $m: model, $d: dim });
  }

  /**
   * Records which embedding task-framing identity the table was pinned with
   * (per-model framing layer): a preset id, or null for unframed. Called at the
   * end of every index job (the embedModel precedent) and on the migration's
   * commit; null keeps the pre-framing pin.
   */
  setIndexFraming(name: string, framing: string | null): void {
    this.db
      .query(`UPDATE indexes SET framing=$f WHERE name=$name`)
      .run({ $name: name, $f: framing });
  }

  /**
   * THE COMMIT POINT of a zero-downtime model migration (O2): one sqlite
   * transaction atomically flips the project's stored table name to the
   * COMPLETED shadow table, pins the new embedding model/dimension and framing
   * and marks the index ready. Before this transaction: a crash leaves the
   * original table + record untouched (the half-built shadow is garbage the
   * doctor flags); after it: the registry points at a complete, self-consistent
   * table — the migration is done no matter what happens next. The framing
   * rides along so a shadow is never committed with a pin that does not
   * describe its vectors.
   */
  commitTableSwap(
    name: string,
    swap: {
      tableName: string;
      embedModel: string;
      embedDim: number | null;
      framing: string | null;
      chunkCount: number;
      lastIndexedAt: number;
    },
  ): void {
    const tx = this.db.transaction((s: {
      tableName: string;
      embedModel: string;
      embedDim: number | null;
      framing: string | null;
      chunkCount: number;
      lastIndexedAt: number;
    }) => {
      this.db
        .query(
          `UPDATE indexes SET
             table_name=$t, embed_model=$m, embed_dim=$d, framing=$f, chunk_count=$c,
             last_indexed_at=$ts, status='ready', error=NULL
           WHERE name=$name`,
        )
        .run({
          $t: s.tableName,
          $m: s.embedModel,
          $d: s.embedDim,
          $f: s.framing,
          $c: s.chunkCount,
          $ts: s.lastIndexedAt,
          $name: name,
        });
    });
    tx(swap);
  }

  removeIndex(name: string): void {
    this.db.query(`DELETE FROM indexes WHERE name = $name`).run({ $name: name });
    this.db.query(`DELETE FROM file_cache WHERE index_name = $name`).run({ $name: name });
  }

  /**
   * Removes all data associated with a project: indexes, file_cache, jobs, AND embedding_cache.
   * This is a FULL CLEANUP that goes beyond removeIndex (which leaves embedding cache entries).
   * Use this for complete removal where you want zero traces.
   */
  removeIndexDeep(name: string): void {
    this.db.query(`DELETE FROM indexes WHERE name = $name`).run({ $name: name });
    this.db.query(`DELETE FROM file_cache WHERE index_name = $name`).run({ $name: name });
    // The stored doccheck snapshot (D1c) belongs to the project — gone with it.
    this.db.query(`DELETE FROM doccheck_reports WHERE project = $name`).run({ $name: name });
    // Stale job records are matched by a LIKE on the indexName field inside the
    // JSON payload (index jobs) and on the project field (migrate jobs, O2).
    const esc = name.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&");
    this.db
      .query(
        `DELETE FROM jobs
         WHERE payload LIKE $byIndexName ESCAPE '\\'
            OR payload LIKE $byProject ESCAPE '\\'`,
      )
      .run({ $byIndexName: `%"indexName":"${esc}"%`, $byProject: `%"project":"${esc}"%` });
  }

  private rowToIndex(r: Record<string, unknown>): IndexRecord {
    return {
      name: r.name as string,
      path: r.path as string,
      // Defensive: a row whose table name is missing/empty (an un-backfilled
      // foreign DB) resolves to the derived name, never to an empty string.
      tableName: tableNameFor({ name: r.name as string, tableName: (r.table_name as string | null) ?? null }),
      status: r.status as IndexStatus,
      fileCount: r.file_count as number,
      chunkCount: r.chunk_count as number,
      embedModel: (r.embed_model as string | null) ?? null,
      embedDim: (r.embed_dim as number | null) ?? null,
      // An empty framing can only be legacy junk (the identity values are
      // non-empty preset ids) — read as the unframed pin it can only mean.
      framing: typeof r.framing === "string" && r.framing.length > 0 ? r.framing : null,
      lastIndexedAt: (r.last_indexed_at as number | null) ?? null,
      createdAt: r.created_at as number,
      error: (r.error as string | null) ?? null,
    };
  }

  // ------------------------------------------------------------- file cache
  getFileMtime(indexName: string, filePath: string): number | null {
    const row = this.db
      .query(`SELECT mtime_ms FROM file_cache WHERE index_name = $i AND file_path = $f`)
      .get({ $i: indexName, $f: filePath }) as { mtime_ms: number } | null;
    return row ? row.mtime_ms : null;
  }

  setFileMtime(indexName: string, filePath: string, mtimeMs: number): void {
    this.db
      .query(
        `INSERT INTO file_cache (index_name, file_path, mtime_ms)
         VALUES ($i, $f, $m)
         ON CONFLICT(index_name, file_path) DO UPDATE SET mtime_ms = $m`,
      )
      .run({ $i: indexName, $f: filePath, $m: mtimeMs });
  }

  deleteFileCache(indexName: string, filePath: string): void {
    this.db
      .query(`DELETE FROM file_cache WHERE index_name = $i AND file_path = $f`)
      .run({ $i: indexName, $f: filePath });
  }

  /** Returns all file paths cached for a project (for sync/cleanup). */
  listCachedFiles(indexName: string): string[] {
    const rows = this.db
      .query(`SELECT file_path FROM file_cache WHERE index_name = $i`)
      .all({ $i: indexName }) as { file_path: string }[];
    return rows.map((r) => r.file_path);
  }

  /** Clears a project's entire file cache (for a full reindex). */
  clearFileCache(indexName: string): void {
    this.db.query(`DELETE FROM file_cache WHERE index_name = $i`).run({ $i: indexName });
  }

  /**
   * Rows of the file cache: a project's cached-file count (pass a name), or
   * every project's (pass nothing). Read-only — feeds the O3 table stats.
   */
  countFileCache(indexName?: string): number {
    const row = indexName
      ? (this.db.query(`SELECT COUNT(*) AS n FROM file_cache WHERE index_name = $i`).get({ $i: indexName }) as {
          n: number;
        })
      : (this.db.query(`SELECT COUNT(*) AS n FROM file_cache`).get() as { n: number });
    return row.n;
  }

  // ------------------------------------------------------------ embed cache
  /** Returns the cached embedding by content-hash + model key. */
  getCachedEmbedding(model: string, hash: string): number[] | null {
    const row = this.db
      .query(`SELECT vector FROM embedding_cache WHERE model = $m AND hash = $h`)
      .get({ $m: model, $h: hash }) as { vector: Uint8Array } | null;
    if (!row) return null;
    // Copy the BLOB and decode as Float32Array (avoids pooled-buffer offset issues).
    const copy = Uint8Array.from(row.vector);
    const f32 = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
    return Array.from(f32);
  }

  /** Writes multiple embeddings to the cache in a single transaction. */
  putCachedEmbeddings(model: string, entries: { hash: string; vector: number[] }[]): void {
    if (entries.length === 0) return;
    const now = Date.now();
    const stmt = this.db.query(
      `INSERT INTO embedding_cache (model, hash, dim, vector, created_at)
       VALUES ($m, $h, $d, $v, $t)
       ON CONFLICT(model, hash) DO NOTHING`,
    );
    const tx = this.db.transaction((rows: { hash: string; vector: number[] }[]) => {
      for (const r of rows) {
        const f32 = Float32Array.from(r.vector);
        const blob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
        stmt.run({ $m: model, $h: r.hash, $d: r.vector.length, $v: blob, $t: now });
      }
    });
    tx(entries);
  }

  countEmbeddingCache(): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM embedding_cache`).get() as { n: number };
    return row.n;
  }

  /** Deletes the oldest records if the cache exceeds 'max' entries. Returns the number deleted. */
  pruneEmbeddingCache(max: number): number {
    const total = this.countEmbeddingCache();
    if (total <= max) return 0;
    const res = this.db
      .query(
        `DELETE FROM embedding_cache WHERE rowid IN (
           SELECT rowid FROM embedding_cache ORDER BY created_at ASC LIMIT $n
         )`,
      )
      .run({ $n: total - max });
    return Number(res.changes);
  }

  /**
   * Row count + estimated size of the embedding cache (O3 table stats). The
   * vector BLOB is the bulk of every row, so its summed byte length is the
   * honest lower bound on the cache's footprint — reported as an estimate.
   */
  embeddingCacheStats(): EmbedCacheStats {
    const row = this.db
      .query(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(vector)), 0) AS bytes FROM embedding_cache`)
      .get() as { n: number; bytes: number };
    return { rows: row.n, estimatedBytes: row.bytes };
  }

  // -------------------------------------------------------------- query log
  /**
   * Records one search into the local query log (proposal A3).
   *
   * Contract: NEVER throws — a log-write failure is reported to stderr and the
   * search that produced the row must carry on. `size` is the configured
   * `search.queryLogSize`: 0 (or any non-positive value) turns logging OFF
   * entirely (no write, no prune); when on, the oldest rows beyond `size` are
   * pruned right after the write (write-time prune, as proposed).
   */
  recordQueryLog(row: QueryLogRow, size: number = CONFIG.QUERY_LOG_SIZE): void {
    if (!(size >= 1)) return; // off (also rejects NaN/negative)
    try {
      this.db
        .query(
          `INSERT INTO query_log (ts, project, query, mode, result_count, latency_ms)
           VALUES ($ts, $project, $query, $mode, $resultCount, $latencyMs)`,
        )
        .run({
          $ts: row.ts,
          $project: row.project,
          $query: row.query,
          $mode: row.mode,
          $resultCount: row.resultCount,
          $latencyMs: row.latencyMs,
        });
      this.pruneQueryLog(size);
    } catch (err) {
      console.error("[registry] query log write failed (the search is unaffected):", err);
    }
  }

  /** Current row count of the query log (what write-time pruning compares against). */
  countQueryLog(): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM query_log`).get() as { n: number };
    return row.n;
  }

  /**
   * Deletes the OLDEST query-log rows beyond `keepRows` (lowest ids = earliest
   * writes). A plain DELETE, as proposed — no cutoff timestamp involved.
   * Returns the number of deleted rows. `keepRows < 0` (or NaN) is a no-op;
   * `keepRows = 0` keeps nothing (the table is emptied).
   */
  pruneQueryLog(keepRows: number): number {
    const keep = Math.floor(keepRows);
    if (!(keep >= 0)) return 0;
    const total = this.countQueryLog();
    if (total <= keep) return 0;
    const res = this.db
      .query(
        `DELETE FROM query_log WHERE id IN (
           SELECT id FROM query_log ORDER BY id ASC LIMIT $n
         )`,
      )
      .run({ $n: total - keep });
    return Number(res.changes);
  }

  /**
   * Aggregates the query log (local sqlite, no LLM). `opts.project` filters the
   * rows to one project (cross-project searches are logged with a null project
   * and count toward the global stats only); `opts.topQueries`/`opts.zeroHitTop`
   * cap how many entries of the frequency / zero-hit lists are reported.
   */
  queryLogStats(opts: QueryLogStatsOpts = {}): QueryLogStats {
    const topLimit = Math.max(0, Math.floor(opts.topQueries ?? 10));
    const zeroLimit = Math.max(0, Math.floor(opts.zeroHitTop ?? 20));
    const params: Record<string, string | number> = {};
    if (typeof opts.project === "string" && opts.project.length > 0) params.$p = opts.project;
    const projectWhere = "$p" in params ? "WHERE project = $p" : "";

    const summary = this.db
      .query(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT query) AS distinctQueries,
                AVG(latency_ms) AS avgLatencyMs,
                MAX(latency_ms) AS maxLatencyMs
           FROM query_log
           ${projectWhere}`,
      )
      .get(params) as
      | { total: number; distinctQueries: number; avgLatencyMs: number | null; maxLatencyMs: number | null }
      | undefined;
    if (!summary || summary.total === 0) {
      return { total: 0, topQueries: [], zeroHit: [], avgLatencyMs: 0, maxLatencyMs: 0, repeatRate: 0 };
    }

    const topRows = this.db
      .query(
        `SELECT query, COUNT(*) AS count, AVG(result_count) AS avgResults
           FROM query_log
           ${projectWhere}
          GROUP BY query
          ORDER BY count DESC, query ASC
          LIMIT $top`,
      )
      .all({ ...params, $top: topLimit }) as { query: string; count: number; avgResults: number | null }[];

    const zeroRows = this.db
      .query(
        `SELECT query, COUNT(*) AS count
           FROM query_log
          WHERE result_count = 0${"$p" in params ? " AND project = $p" : ""}
          GROUP BY query
          ORDER BY count DESC, query ASC
          LIMIT $zero`,
      )
      .all({ ...params, $zero: zeroLimit }) as { query: string; count: number }[];

    return {
      total: summary.total,
      topQueries: topRows.map((r) => ({
        query: r.query,
        count: r.count,
        avgResultCount: round(r.avgResults, 2),
      })),
      zeroHit: zeroRows.map((r) => ({ query: r.query, count: r.count })),
      avgLatencyMs: round(summary.avgLatencyMs, 1),
      maxLatencyMs: round(summary.maxLatencyMs, 0),
      repeatRate: round((summary.total - summary.distinctQueries) / summary.total, 3),
    };
  }

  // -------------------------------------------------------------------- jobs
  saveJob(row: JobRow): void {
    this.db
      .query(
        `INSERT INTO jobs
           (id, type, status, payload, progress_processed, progress_total,
            progress_message, result, error, created_at, started_at, finished_at)
         VALUES
           ($id, $type, $status, $payload, $pp, $pt, $pm, $result, $error,
            $createdAt, $startedAt, $finishedAt)
         ON CONFLICT(id) DO UPDATE SET
           status=$status, payload=$payload, progress_processed=$pp,
           progress_total=$pt, progress_message=$pm, result=$result,
           error=$error, started_at=$startedAt, finished_at=$finishedAt`,
      )
      .run({
        $id: row.id,
        $type: row.type,
        $status: row.status,
        $payload: row.payload,
        $pp: row.progressProcessed,
        $pt: row.progressTotal,
        $pm: row.progressMessage,
        $result: row.result,
        $error: row.error,
        $createdAt: row.createdAt,
        $startedAt: row.startedAt,
        $finishedAt: row.finishedAt,
      });
  }

  getJob(id: string): JobRow | null {
    const row = this.db
      .query(`SELECT * FROM jobs WHERE id = $id`)
      .get({ $id: id }) as Record<string, unknown> | null;
    return row ? this.rowToJob(row) : null;
  }

  listJobs(limit = 100): JobRow[] {
    const rows = this.db
      .query(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT $limit`)
      .all({ $limit: limit }) as Record<string, unknown>[];
    return rows.map((r) => this.rowToJob(r));
  }

  /** Fetches jobs left half-finished ('queued'/'running') when the daemon restarts. */
  unfinishedJobs(): JobRow[] {
    const rows = this.db
      .query(`SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToJob(r));
  }

  /**
   * When the daemon restarts, marks queued/running job rows left over from the
   * previous run as 'failed' (since the in-memory queue is lost).
   * Returns the number of affected rows.
   */
  markInterruptedJobs(): number {
    const res = this.db
      .query(
        `UPDATE jobs SET status='failed', error='daemon restarted', finished_at=$ts
         WHERE status IN ('queued','running')`,
      )
      .run({ $ts: Date.now() });
    return Number(res.changes);
  }

  private rowToJob(r: Record<string, unknown>): JobRow {
    return {
      id: r.id as string,
      type: r.type as string,
      status: r.status as string,
      payload: (r.payload as string | null) ?? null,
      progressProcessed: r.progress_processed as number,
      progressTotal: r.progress_total as number,
      progressMessage: (r.progress_message as string | null) ?? null,
      result: (r.result as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      createdAt: r.created_at as number,
      startedAt: (r.started_at as number | null) ?? null,
      finishedAt: (r.finished_at as number | null) ?? null,
    };
  }

  // ---------------------------------------- doccheck reports (proposal D1c, watch)

  /**
   * Stores the LATEST doc-check snapshot for one project (UPSERT — the D1c
   * doccheck job writes it after every run; only the most recent report per
   * project is kept).
   */
  saveDocCheckReport(row: DocCheckReportRow): void {
    this.db
      .query(
        `INSERT INTO doccheck_reports (project, ts, consistent, findings, needs_review, report_json)
         VALUES ($p, $ts, $c, $f, $r, $j)
         ON CONFLICT(project) DO UPDATE SET
           ts=$ts, consistent=$c, findings=$f, needs_review=$r, report_json=$j`,
      )
      .run({
        $p: row.project,
        $ts: row.ts,
        $c: row.consistent ? 1 : 0,
        $f: row.findings,
        $r: row.needsReview,
        $j: row.reportJson,
      });
  }

  /** The stored latest doc-check snapshot for a project (null = none stored yet). */
  getDocCheckReport(project: string): DocCheckReportRow | null {
    const row = this.db
      .query(`SELECT * FROM doccheck_reports WHERE project = $p`)
      .get({ $p: project }) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      project: row.project as string,
      ts: row.ts as number,
      consistent: row.consistent === 1,
      findings: row.findings as number,
      needsReview: row.needs_review as number,
      reportJson: row.report_json as string,
    };
  }

  close(): void {
    this.db.close();
  }
}
