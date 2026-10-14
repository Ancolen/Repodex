import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  Registry,
  deriveTableName,
  tableNameFor,
  type IndexRecord,
} from "../src/core/registry";

function tempDbPath(): string {
  return join(tmpdir(), `mcp-test-${crypto.randomUUID()}.db`);
}

function makeIndex(name: string, overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    name,
    path: `/tmp/${name}`,
    tableName: `idx_${name}`,
    status: "indexing",
    fileCount: 0,
    chunkCount: 0,
    embedModel: "test-model",
    embedDim: null,
    lastIndexedAt: null,
    createdAt: Date.now(),
    error: null,
    ...overrides,
  };
}

describe("Registry", () => {
  let reg: Registry;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    reg = new Registry(dbPath);
  });

  afterEach(() => {
    reg.close();
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* ignore */
    }
  });

  test("upsert + get + list", () => {
    reg.upsertIndex(makeIndex("alpha"));
    reg.upsertIndex(makeIndex("beta"));
    const a = reg.getIndex("alpha");
    expect(a?.name).toBe("alpha");
    expect(a?.tableName).toBe("idx_alpha");
    expect(reg.listIndexes().length).toBe(2);
    expect(reg.getIndex("nonexistent")).toBeNull();
  });

  test("setIndexStatus / setIndexStats / setIndexEmbedding", () => {
    reg.upsertIndex(makeIndex("alpha"));
    reg.setIndexStatus("alpha", "error", "boom");
    expect(reg.getIndex("alpha")?.status).toBe("error");
    expect(reg.getIndex("alpha")?.error).toBe("boom");

    reg.setIndexStats("alpha", 12, 99, 12345);
    expect(reg.getIndex("alpha")?.fileCount).toBe(12);
    expect(reg.getIndex("alpha")?.chunkCount).toBe(99);

    reg.setIndexEmbedding("alpha", "m2", 768);
    expect(reg.getIndex("alpha")?.embedModel).toBe("m2");
    expect(reg.getIndex("alpha")?.embedDim).toBe(768);
  });

  test("file cache: set/get/list/delete/clear", () => {
    reg.upsertIndex(makeIndex("alpha"));
    reg.setFileMtime("alpha", "/tmp/alpha/a.ts", 111);
    reg.setFileMtime("alpha", "/tmp/alpha/b.ts", 222);
    expect(reg.getFileMtime("alpha", "/tmp/alpha/a.ts")).toBe(111);
    expect(reg.getFileMtime("alpha", "/tmp/alpha/missing.ts")).toBeNull();

    const cached = reg.listCachedFiles("alpha").sort();
    expect(cached).toEqual(["/tmp/alpha/a.ts", "/tmp/alpha/b.ts"]);

    reg.deleteFileCache("alpha", "/tmp/alpha/a.ts");
    expect(reg.listCachedFiles("alpha")).toEqual(["/tmp/alpha/b.ts"]);

    reg.clearFileCache("alpha");
    expect(reg.listCachedFiles("alpha")).toEqual([]);
  });

  test("removeIndex also clears file_cache", () => {
    reg.upsertIndex(makeIndex("alpha"));
    reg.setFileMtime("alpha", "/tmp/alpha/a.ts", 111);
    reg.removeIndex("alpha");
    expect(reg.getIndex("alpha")).toBeNull();
    expect(reg.listCachedFiles("alpha")).toEqual([]);
  });

  test("embedding cache: put + get (round-trip vector)", () => {
    const vec = [0.1, -0.2, 0.3, 0.4];
    reg.putCachedEmbeddings("model-a", [{ hash: "h1", vector: vec }]);
    const got = reg.getCachedEmbedding("model-a", "h1");
    expect(got).not.toBeNull();
    expect(got!.length).toBe(4);
    // Tolerance for Float32 rounding
    for (let i = 0; i < vec.length; i++) {
      expect(Math.abs(got![i]! - vec[i]!)).toBeLessThan(1e-6);
    }
    // Different model key -> separate record
    expect(reg.getCachedEmbedding("model-b", "h1")).toBeNull();
  });

  test("embedding cache prune deletes the oldest records", async () => {
    // Add with small delays so created_at is different
    reg.putCachedEmbeddings("m", [{ hash: "old1", vector: [1] }]);
    reg.putCachedEmbeddings("m", [{ hash: "old2", vector: [2] }]);
    await Bun.sleep(5);
    reg.putCachedEmbeddings("m", [{ hash: "new1", vector: [3] }]);
    expect(reg.countEmbeddingCache()).toBe(3);

    const pruned = reg.pruneEmbeddingCache(1);
    expect(pruned).toBe(2);
    expect(reg.countEmbeddingCache()).toBe(1);
    // The newest should remain
    expect(reg.getCachedEmbedding("m", "new1")).not.toBeNull();
  });

  test("jobs: save/get + markInterruptedJobs", () => {
    const now = Date.now();
    reg.saveJob({
      id: "j1",
      type: "index",
      status: "running",
      payload: null,
      progressProcessed: 1,
      progressTotal: 10,
      progressMessage: null,
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    });
    expect(reg.getJob("j1")?.status).toBe("running");

    const changed = reg.markInterruptedJobs();
    expect(changed).toBe(1);
    expect(reg.getJob("j1")?.status).toBe("failed");
  });

  test("removeIndexDeep clears job rows for index jobs (indexName) and migrate jobs (project)", () => {
    reg.upsertIndex(makeIndex("alpha"));
    const now = Date.now();
    const row = (id: string, type: string, payload: string | null) => ({
      id,
      type,
      status: "completed",
      payload,
      progressProcessed: 0,
      progressTotal: 0,
      progressMessage: null,
      result: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    });
    reg.saveJob(row("m1", "migrate", '{"project":"alpha","targetModel":"model-b"}'));
    reg.saveJob(row("i1", "index", '{"target":{"indexName":"alpha"},"fresh":false}'));
    reg.saveJob(row("o1", "index", '{"target":{"indexName":"other"}}'));
    reg.removeIndexDeep("alpha");
    expect(reg.getJob("m1")).toBeNull();
    expect(reg.getJob("i1")).toBeNull();
    expect(reg.getJob("o1")).not.toBeNull();
  });

  test("jobs: priority defaults to 0 and round-trips through saveJob/getJob", () => {
    const row = (id: string, priority?: number) => ({
      id,
      type: "index",
      status: "queued",
      ...(priority !== undefined ? { priority } : {}),
      payload: null,
      progressProcessed: 0,
      progressTotal: 0,
      progressMessage: null,
      result: null,
      error: null,
      createdAt: 1,
      startedAt: null,
      finishedAt: null,
    });
    // A row literal from before the column existed still persists (as 0).
    reg.saveJob(row("legacy-literal"));
    expect(reg.getJob("legacy-literal")?.priority).toBe(0);
    reg.saveJob(row("bg", -5));
    reg.saveJob(row("boosted", 7));
    expect(reg.getJob("bg")?.priority).toBe(-5);
    expect(reg.getJob("boosted")?.priority).toBe(7);
    // The finish() UPDATE path (same id saved again) keeps the priority.
    reg.saveJob({ ...row("bg", -5), status: "completed", finishedAt: 9 });
    expect(reg.getJob("bg")?.status).toBe("completed");
    expect(reg.getJob("bg")?.priority).toBe(-5);
  });
});

describe("jobs priority — lazy migration on a legacy-shaped DB", () => {
  test("a jobs table predating the priority column is ALTERed with the DEFAULT 0", () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    // A foreign/very-old meta.db: no priority column on jobs at all.
    raw.run(`CREATE TABLE jobs (
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
    )`);
    raw.run(`INSERT INTO jobs (id, type, status, created_at) VALUES ('legacy-1', 'index', 'queued', 1)`);
    raw.close();

    const lazy = new Registry(dbPath);
    try {
      // The legacy row reads as the (interactive) default it was effectively enqueued at.
      expect(lazy.getJob("legacy-1")?.priority).toBe(0);
      expect(lazy.getJob("legacy-1")?.status).toBe("queued");
      expect(lazy.markInterruptedJobs()).toBe(1);
      expect(lazy.getJob("legacy-1")?.status).toBe("failed");
      // The ALTERed table accepts priority writes, and the UPDATE path keeps them.
      lazy.saveJob({
        id: "legacy-2",
        type: "index",
        status: "queued",
        priority: -5,
        payload: null,
        progressProcessed: 0,
        progressTotal: 0,
        progressMessage: null,
        result: null,
        error: null,
        createdAt: 2,
        startedAt: null,
        finishedAt: null,
      });
      expect(lazy.getJob("legacy-2")?.priority).toBe(-5);
      lazy.saveJob({
        id: "legacy-2",
        type: "index",
        status: "completed",
        priority: -5,
        payload: null,
        progressProcessed: 1,
        progressTotal: 1,
        progressMessage: null,
        result: null,
        error: null,
        createdAt: 2,
        startedAt: 2,
        finishedAt: 3,
      });
      expect(lazy.getJob("legacy-2")?.status).toBe("completed");
      expect(lazy.getJob("legacy-2")?.priority).toBe(-5);
    } finally {
      lazy.close();
      rmSync(dbPath, { force: true });
    }
  });

  test("a nullable priority column with a NULL row reads as the default 0", () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
      priority INTEGER, created_at INTEGER NOT NULL, finished_at INTEGER
    )`);
    raw.run(`INSERT INTO jobs (id, type, status, priority, created_at) VALUES ('n1', 'index', 'failed', NULL, 1)`);
    raw.close();

    const r = new Registry(dbPath);
    try {
      expect(r.getJob("n1")?.priority).toBe(0);
    } finally {
      r.close();
      rmSync(dbPath, { force: true });
    }
  });
});

describe("table naming helpers (O2)", () => {
  test("deriveTableName matches the createIndex recipe", () => {
    expect(deriveTableName("my-app")).toBe("idx_my_app");
    expect(deriveTableName("My App!")).toBe("idx_my_app");
    expect(deriveTableName("snake_case")).toBe("idx_snake_case");
    expect(deriveTableName("")).toBe("idx_idx");
    expect(deriveTableName("___")).toBe("idx_idx");
  });

  test("tableNameFor prefers the stored name, falls back to the derivation", () => {
    expect(tableNameFor({ name: "alpha", tableName: "idx_custom_2" })).toBe("idx_custom_2");
    expect(tableNameFor({ name: "alpha", tableName: null })).toBe("idx_alpha");
    expect(tableNameFor({ name: "alpha", tableName: "" })).toBe("idx_alpha");
    expect(tableNameFor({ name: "alpha" })).toBe("idx_alpha");
  });

  test("a registry predating the stored table_name is migrated lazily (ALTER + derived backfill)", () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    // A foreign/very-old meta.db: no table_name column at all.
    raw.run(`CREATE TABLE indexes (
      name TEXT PRIMARY KEY, path TEXT NOT NULL, status TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
      embed_model TEXT, embed_dim INTEGER, last_indexed_at INTEGER,
      created_at INTEGER NOT NULL, error TEXT
    )`);
    raw.run(`INSERT INTO indexes (name, path, status, created_at) VALUES ('my-app', '/tmp/my-app', 'ready', 1)`);
    raw.close();

    const lazy = new Registry(dbPath);
    try {
      const rec = lazy.getIndex("my-app");
      expect(rec?.tableName).toBe("idx_my_app");
      expect(rec?.status).toBe("ready");
      // The altered table keeps accepting upserts (table_name is written back).
      lazy.upsertIndex(makeIndex("my-app", { tableName: "idx_my_app" }));
      expect(lazy.getIndex("my-app")?.embedModel).toBe("test-model");
    } finally {
      lazy.close();
      rmSync(dbPath, { force: true });
    }
  });

  test("rows stored with a null/empty table_name are backfilled from the derivation (idempotent)", () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE indexes (
      name TEXT PRIMARY KEY, path TEXT NOT NULL, table_name TEXT, status TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
      embed_model TEXT, embed_dim INTEGER, last_indexed_at INTEGER,
      created_at INTEGER NOT NULL, error TEXT
    )`);
    raw.run(
      `INSERT INTO indexes (name, path, table_name, status, created_at) VALUES
        ('alpha',  '/tmp/alpha', NULL,        'ready', 1),
        ('beta-x', '/tmp/beta',  '',          'ready', 2),
        ('gamma',  '/tmp/gamma', 'idx_custom','ready', 3)`,
    );
    raw.close();

    const reg1 = new Registry(dbPath);
    expect(reg1.getIndex("alpha")?.tableName).toBe("idx_alpha");
    expect(reg1.getIndex("beta-x")?.tableName).toBe("idx_beta_x");
    expect(reg1.getIndex("gamma")?.tableName).toBe("idx_custom"); // a stored name is never overwritten
    reg1.close();

    // Second open: nothing left to backfill, values stay stable.
    const reg2 = new Registry(dbPath);
    expect(reg2.getIndex("alpha")?.tableName).toBe("idx_alpha");
    expect(reg2.getIndex("beta-x")?.tableName).toBe("idx_beta_x");
    reg2.close();
    rmSync(dbPath, { force: true });
  });
});

describe("commitTableSwap (O2)", () => {
  let reg: Registry;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    reg = new Registry(dbPath);
  });

  afterEach(() => {
    reg.close();
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* ignore */
    }
  });

  test("flips the serving table, model, framing and stats and marks the index ready", () => {
    reg.upsertIndex(makeIndex("alpha"));
    reg.commitTableSwap("alpha", {
      tableName: "idx_alpha_mig",
      embedModel: "model-b",
      embedDim: 4,
      framing: "embeddinggemma-2",
      chunkCount: 12,
      lastIndexedAt: 555,
    });
    const rec = reg.getIndex("alpha");
    expect(rec).not.toBeNull();
    expect(rec!.tableName).toBe("idx_alpha_mig");
    expect(rec!.embedModel).toBe("model-b");
    expect(rec!.embedDim).toBe(4);
    expect(rec!.framing).toBe("embeddinggemma-2");
    expect(rec!.chunkCount).toBe(12);
    expect(rec!.lastIndexedAt).toBe(555);
    expect(rec!.status).toBe("ready");
    expect(rec!.error).toBeNull();
  });

  test("clears a stale error alongside the swap (the new table is complete)", () => {
    reg.upsertIndex(makeIndex("alpha"));
    reg.setIndexStatus("alpha", "error", "boom");
    reg.commitTableSwap("alpha", {
      tableName: "idx_alpha_mig",
      embedModel: "model-b",
      embedDim: null,
      framing: null, // unframed stays unframed across the swap
      chunkCount: 0,
      lastIndexedAt: 556,
    });
    const rec = reg.getIndex("alpha");
    expect(rec!.status).toBe("ready");
    expect(rec!.error).toBeNull();
    expect(rec!.framing).toBeNull();
  });
});

describe("index note — zero-file explanation (lazy migration)", () => {
  test("setIndexNote writes and clears the ephemeral note", () => {
    const dbPath = tempDbPath();
    const reg = new Registry(dbPath);
    try {
      reg.upsertIndex(makeIndex("mynote", { status: "ready" }));
      expect(reg.getIndex("mynote")?.note ?? null).toBeNull();
      reg.setIndexNote("mynote", "collected 0 files — 3 with a disallowed extension");
      expect(reg.getIndex("mynote")?.note).toBe("collected 0 files — 3 with a disallowed extension");
      reg.setIndexNote("mynote", null);
      expect(reg.getIndex("mynote")?.note ?? null).toBeNull();
    } finally {
      reg.close();
      rmSync(dbPath, { force: true });
    }
  });

  test("an indexes table predating the note column is ALTERed and reads null", () => {
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    // A foreign/very-old meta.db: no note column on indexes at all.
    raw.run(`CREATE TABLE indexes (
      name TEXT PRIMARY KEY, path TEXT NOT NULL, table_name TEXT NOT NULL,
      status TEXT NOT NULL, file_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0, embed_model TEXT, embed_dim INTEGER,
      last_indexed_at INTEGER, created_at INTEGER NOT NULL, error TEXT
    )`);
    raw.run(`INSERT INTO indexes (name, path, table_name, status, created_at)
             VALUES ('legacy', '/tmp/legacy', 'idx_legacy', 'ready', 1)`);
    raw.close();

    const lazy = new Registry(dbPath);
    try {
      const rec = lazy.getIndex("legacy");
      expect(rec).not.toBeNull();
      expect(rec?.note ?? null).toBeNull();
      // The ALTERed table accepts note writes, and the unrelated update paths
      // (stats/status) leave a written note untouched.
      lazy.setIndexNote("legacy", "collected 0 files — 2 ignored by .gitignore/.cidxignore/ignoredDirs");
      expect(lazy.getIndex("legacy")?.note).toContain("collected 0 files");
      lazy.setIndexStats("legacy", 0, 0, Date.now());
      expect(lazy.getIndex("legacy")?.note).toContain("collected 0 files");
    } finally {
      lazy.close();
      rmSync(dbPath, { force: true });
    }
  });
});
