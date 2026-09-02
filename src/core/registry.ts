import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { CONFIG } from "../config";

export type IndexStatus = "indexing" | "ready" | "error";

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

/**
 * Central meta store (bun:sqlite).
 * - indexes:    indexed projects
 * - file_cache: per-file mtime cache (to skip unchanged files)
 * - jobs:       async job persistence (survives daemon restarts)
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
  }

  // ---------------------------------------------------------------- indexes
  upsertIndex(rec: IndexRecord): void {
    this.db
      .query(
        `INSERT INTO indexes
           (name, path, table_name, status, file_count, chunk_count,
            embed_model, embed_dim, last_indexed_at, created_at, error)
         VALUES
           ($name, $path, $table, $status, $fileCount, $chunkCount,
            $embedModel, $embedDim, $lastIndexedAt, $createdAt, $error)
         ON CONFLICT(name) DO UPDATE SET
           path=$path, table_name=$table, status=$status,
           file_count=$fileCount, chunk_count=$chunkCount,
           embed_model=$embedModel, embed_dim=$embedDim,
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
    // Delete all registry records
    this.db.query(`DELETE FROM indexes WHERE name = $name`).run({ $name: name });
    // Cascading: file_cache also deleted via the indexes FK
    this.db.query(`DELETE FROM file_cache WHERE index_name = $name`).run({ $name: name });
    // Delete stale job records for this index (payload contains the index name)
    // Since jobs have JSON payload, we do a LIKE match on the indexName field in the JSON.
    this.db
      .query(
        `DELETE FROM jobs
         WHERE payload LIKE $pattern ESCAPE '\\'`,
      )
      .run({ $pattern: `%"indexName":"${name.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&")}"%` });
  }

  private rowToIndex(r: Record<string, unknown>): IndexRecord {
    return {
      name: r.name as string,
      path: r.path as string,
      tableName: r.table_name as string,
      status: r.status as IndexStatus,
      fileCount: r.file_count as number,
      chunkCount: r.chunk_count as number,
      embedModel: (r.embed_model as string | null) ?? null,
      embedDim: (r.embed_dim as number | null) ?? null,
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

  close(): void {
    this.db.close();
  }
}
