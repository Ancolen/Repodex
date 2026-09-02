import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Registry, type IndexRecord } from "../src/core/registry";

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
});
