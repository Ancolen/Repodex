/**
 * maxFileSizeBytes — the oversized-file guard (per-project `.cidx.json` +
 * global `indexing.maxFileSizeBytes` default).
 *
 * The pure units (parse validation, collectFiles filter, indexFile skip) live
 * in tests/project-config.test.ts / tests/indexer.test.ts; this file drives
 * the JOB-level behavior against temp-LanceDB + a stubbed embedding wire
 * (fake global fetch, never a live backend):
 * - the full-index filter prunes a previously-indexed file that GREW past the
 *   limit (the `.cidx.json` `languages` semantics: absence from collectFiles
 *   output = removed by the deleted-file cleanup);
 * - a file that grows BETWEEN collect and index is skipped by the indexFile
 *   guard and counted as `skippedOversized`, its old records survive that run,
 *   and the NEXT sync prunes them;
 * - the IndexManager persists the counts on the job result (honesty surface);
 * - the watcher write path keeps fresh oversized copies out of the table.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { CONFIG } from "../src/config";
import { Registry } from "../src/core/registry";
import { JobQueue } from "../src/core/job-queue";
import { IndexManager } from "../src/core/index-manager";
import { indexDirectory } from "../src/services/indexer";
import { startWatcher } from "../src/services/watcher";
import { initDB, countTableRows, scanTableBatches, dropTable } from "../src/services/db";
import { setEmbedBackend, resetEmbedBackend } from "../src/services/embed";

/** The fixture limit, written into every fixture's `.cidx.json`. */
const LIMIT = 100;
const SMALL = "export function small() { return 1; }"; // 38 bytes — under the limit
const BASE = "export function base() { return 2; }"; // 38 bytes — under the limit
const GROWN = "x".repeat(240); // 240 bytes — over the limit

// ------------------------------------------------------- stubbed embed wire

/** Deterministic 4-dim stub embedding (content-shape-dependent, model-agnostic). */
function vecFor(text: string): number[] {
  return [(text.length % 7) + 1, 2, 3, 4];
}

let realFetch: typeof globalThis.fetch | null = null;
function installFetch(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const bodyRaw = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const texts: string[] = Array.isArray(bodyRaw.input)
      ? (bodyRaw.input as unknown[]).filter((t): t is string => typeof t === "string")
      : typeof bodyRaw.prompt === "string"
        ? [bodyRaw.prompt]
        : [];
    // /api/embeddings is the single-text endpoint; /api/embed the batch one.
    if (url.endsWith("/api/embeddings")) {
      return new Response(JSON.stringify({ embedding: vecFor(texts[0] ?? "") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ embeddings: texts.map((t) => vecFor(t)) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeAll(() => {
  installFetch();
  // Pin the stubbed backend for the whole file — resolveAuto would otherwise
  // probe live (and a live server would answer with an unstubbed wire shape).
  setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
});
afterAll(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
  resetEmbedBackend();
});

// ---------------------------------------------------------------- fixtures

function makeFixture(name: string): { root: string; writeSrc(rel: string, content: string): string } {
  const root = mkdtempSync(join(tmpdir(), `cidx-maxfs-${name}-`));
  writeFileSync(join(root, ".cidx.json"), JSON.stringify({ maxFileSizeBytes: LIMIT }));
  return {
    root,
    writeSrc(rel: string, content: string): string {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
  };
}

function tempRegistry(): { registry: Registry; dbPath: string } {
  const dbPath = join(tmpdir(), `cidx-maxfs-reg-${randomUUID()}.db`);
  return { registry: new Registry(dbPath), dbPath };
}

function rmDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
}

async function tableFilePaths(table: string): Promise<Set<string>> {
  const seen = new Set<string>();
  await scanTableBatches(table, 500, async (rows) => {
    for (const r of rows) seen.add(r.filePath);
  });
  return seen;
}

/** Polls until `fn()` is true; fails with a diagnostic after `timeoutMs`. */
async function until(fn: () => Promise<boolean> | boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const targetOf = (indexName: string, tableName: string, baseDir: string) => ({
  indexName,
  tableName,
  baseDir,
});

function upsertFixtureRecord(registry: Registry, name: string, table: string, path: string): void {
  registry.upsertIndex({
    name,
    path,
    tableName: table,
    status: "ready",
    fileCount: 0,
    chunkCount: 0,
    embedModel: CONFIG.OLLAMA_MODEL,
    embedDim: null,
    lastIndexedAt: 1,
    createdAt: 1,
    error: null,
  });
}

// ============================================ 1. full index filter + prune

describe("indexDirectory — the maxFileSizeBytes filter + prune-on-grow", () => {
  let fx: ReturnType<typeof makeFixture>;
  const INDEX = "maxfs-prune";

  beforeAll(async () => {
    await initDB();
    fx = makeFixture("prune");
    fx.writeSrc("src/small.ts", SMALL);
    fx.writeSrc("src/base.ts", BASE);
  });
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  test("a newly oversized file is filtered out of the collect set and pruned on the next sync", async () => {
    const table = `idx_maxfs_prune_${randomUUID().slice(0, 6)}`;
    const { registry, dbPath } = tempRegistry();
    try {
      upsertFixtureRecord(registry, INDEX, table, fx.root);
      const target = targetOf(INDEX, table, fx.root);

      // Run A — all three files index normally (the two .ts sources AND the
      // fixture's own `.cidx.json` — extension .json is an allowed one).
      const runA = await indexDirectory(target, { registry });
      expect(runA.files).toBe(3);
      expect(runA.chunks).toBeGreaterThan(0);
      expect(runA.deleted).toBe(0);
      expect(runA.skippedOversized).toBe(0);
      expect((await tableFilePaths(table)).size).toBe(3);

      // The file grows past the limit on disk.
      fx.writeSrc("src/base.ts", GROWN);

      // Run B — the sync excludes it from collectFiles, so the deleted-file
      // cleanup prunes its records (the `.cidx.json` `languages` semantics).
      const runB = await indexDirectory(target, { registry });
      expect(runB.files).toBe(2); // src/small.ts + .cidx.json processed (mtime-skips)
      expect(runB.deleted).toBe(1);
      expect(runB.skippedOversized).toBe(0);
      const pathsB = await tableFilePaths(table);
      expect(pathsB.has(join(fx.root, "src/base.ts"))).toBe(false);
      expect(pathsB.has(join(fx.root, "src/small.ts"))).toBe(true);
      const cached = registry.listCachedFiles(INDEX).sort();
      expect(cached).toEqual([join(fx.root, ".cidx.json"), join(fx.root, "src/small.ts")]);
    } finally {
      registry.close();
      rmDb(dbPath);
      await dropTable(table);
    }
  });
});

// ============ 2. a grow between collect and indexFile: guard → skip → prune

describe("indexDirectory — the indexFile guard catches a grow between collect and index", () => {
  let fx: ReturnType<typeof makeFixture>;
  const INDEX = "maxfs-race";

  beforeAll(async () => {
    await initDB();
    fx = makeFixture("race");
    fx.writeSrc("src/only.ts", BASE);
  });
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  test("the guard skips it, counts it, and the next sync prunes the old records", async () => {
    const table = `idx_maxfs_race_${randomUUID().slice(0, 6)}`;
    const { registry, dbPath } = tempRegistry();
    try {
      upsertFixtureRecord(registry, INDEX, table, fx.root);
      const target = targetOf(INDEX, table, fx.root);

      // Run A: the (still small) file indexes; its records + cache entry exist.
      const runA = await indexDirectory(target, { registry });
      expect(runA.skippedOversized).toBe(0);
      expect((await tableFilePaths(table)).size).toBe(2); // src/only.ts + .cidx.json

      // Run B: the file is UNDER the limit when collectFiles stats it, and
      // GROWN past it by the time indexFile stats it again — scripted by
      // growing it in the pre-loop onProgress(0, total) hook (there is no
      // await between that call and the first indexFile's stat).
      let grew = false;
      const errSpy = spyOn(console, "error").mockImplementation(() => {});
      let capturedLog = "";
      let runB: Awaited<ReturnType<typeof indexDirectory>>;
      try {
        runB = await indexDirectory(target, {
          registry,
          onProgress: (processed) => {
            if (!grew && processed === 0) {
              fx.writeSrc("src/only.ts", GROWN);
              grew = true;
            }
          },
        });
        // Read the capture BEFORE mockRestore — bun:test resets the mock's
        // call log on restore.
        capturedLog = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      } finally {
        errSpy.mockRestore();
      }
      expect(grew).toBe(true);
      // Skipped by the indexFile guard (it fires BEFORE chunking/embedding and
      // BEFORE the mtime cache write) — and honestly counted:
      expect(runB.skippedOversized).toBe(1);
      expect(runB.files).toBe(2); // src/only.ts + .cidx.json processed
      expect(runB.chunks).toBe(0);
      expect(capturedLog).toContain("exceeds maxFileSizeBytes");
      // The records from run A survive this run (removal waits for the sync
      // that no longer sees the file in collectFiles):
      expect((await tableFilePaths(table)).size).toBe(2);

      // Run C: the file is absent from collectFiles → cleanup prunes it.
      const runC = await indexDirectory(target, { registry });
      expect(runC.skippedOversized).toBe(0);
      expect(runC.deleted).toBe(1);
      const pathsC = await tableFilePaths(table);
      expect(pathsC.has(join(fx.root, "src/only.ts"))).toBe(false);
      expect(pathsC.size).toBe(1); // only the fixture's own .cidx.json remains
    } finally {
      registry.close();
      rmDb(dbPath);
      await dropTable(table);
    }
  });
});

// ============================ 3. the manager persists the counts (honesty)

describe("IndexManager — the persisted job result surfaces the counts", () => {
  let fx: ReturnType<typeof makeFixture>;
  let registry: Registry | null = null;
  let dbPath = "";
  let queue: InstanceType<typeof JobQueue> | null = null;
  let manager: InstanceType<typeof IndexManager> | null = null;
  const INDEX = "maxfs-mgr";

  beforeAll(async () => {
    await initDB();
    fx = makeFixture("mgr");
    fx.writeSrc("src/a.ts", SMALL);
    fx.writeSrc("src/b.ts", BASE);
  });

  afterAll(async () => {
    // Watchers first — no chokidar debounce may touch the registry after close.
    await manager?.shutdown();
    registry?.close();
    rmDb(dbPath);
    rmSync(fx.root, { recursive: true, force: true });
  });

  test("a plain sync writes skippedOversized/deleted into the persisted job result", async () => {
    dbPath = join(tmpdir(), `cidx-maxfs-mgr-${randomUUID()}.db`);
    registry = new Registry(dbPath);
    queue = new JobQueue({ registry });
    manager = new IndexManager(registry, queue);
    const table = `idx_maxfs_mgr_${randomUUID().slice(0, 6)}`;
    upsertFixtureRecord(registry, INDEX, table, fx.root);

    // Job 1: everything under the limit → 3 files indexed (two .ts + the
    // fixture's own .cidx.json), 0 skipped.
    const rec = manager.syncIndex(INDEX);
    expect(rec.status).toBe("indexing");
    const job = manager.activeJob(INDEX);
    expect(job?.type).toBe("index");
    await queue.waitForJob(job!.id);
    const persisted = registry.getJob(job!.id);
    expect(persisted?.status).toBe("completed");
    const result1 = JSON.parse(persisted?.result ?? "null") as Record<string, unknown>;
    expect(result1).toMatchObject({ files: 3, deleted: 0, skippedOversized: 0 });

    // Job 2: a file grew past the limit → the sync prunes it; the persisted
    // result reports the prune (not the skip — collectFiles filtered it out).
    fx.writeSrc("src/b.ts", GROWN);
    manager.syncIndex(INDEX);
    const job2 = manager.activeJob(INDEX);
    await queue.waitForJob(job2!.id);
    const result2 = JSON.parse(registry.getJob(job2!.id)?.result ?? "null") as Record<string, unknown>;
    expect(result2).toMatchObject({ files: 2, deleted: 1, skippedOversized: 0 });

    // The table reflects the pruned file set.
    const paths = await tableFilePaths(table);
    expect(paths.has(join(fx.root, "src/b.ts"))).toBe(false);
    expect(paths.has(join(fx.root, "src/a.ts"))).toBe(true);
  });
});

// ==================== 4. the watcher write path (fresh oversized copies)

describe("startWatcher — the write path respects maxFileSizeBytes", () => {
  let fx: ReturnType<typeof makeFixture>;
  let registry: Registry | null = null;
  let dbPath = "";
  let watcher: ReturnType<typeof startWatcher> | null = null;
  const INDEX = "maxfs-watch";

  beforeAll(async () => {
    await initDB();
    fx = makeFixture("watch");
  });

  afterAll(async () => {
    await watcher?.close();
    watcher = null;
    registry?.close();
    rmDb(dbPath);
    rmSync(fx.root, { recursive: true, force: true });
  });

  test(
    "small writes are indexed; an oversized write never lands in the table",
    async () => {
      dbPath = join(tmpdir(), `cidx-maxfs-watch-${randomUUID()}.db`);
      registry = new Registry(dbPath);
      const table = `idx_maxfs_watch_${randomUUID().slice(0, 6)}`;
      upsertFixtureRecord(registry, INDEX, table, fx.root);

      // Keep the debounce short; chokidar's awaitWriteFinish still adds ~250ms.
      watcher = startWatcher(targetOf(INDEX, table, fx.root), {
        registry,
        debounceMs: 10,
      });
      // Writing before the initial scan completes means the file counts as
      // "initial" (ignoreInitial) — its event never fires. Wait for ready.
      await new Promise<void>((res) => watcher.once("ready", () => res()));
      const errSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        // A small write goes through the normal watcher path into the table.
        fx.writeSrc("src/watch.ts", SMALL);
        const watchPath = join(fx.root, "src/watch.ts");
        await until(async () => (await tableFilePaths(table)).has(watchPath));

        // An oversized write is skipped by the indexFile guard — no records.
        fx.writeSrc("src/watchbig.ts", GROWN);
        // A second small write proves the pipeline is still alive afterwards.
        fx.writeSrc("src/watch2.ts", SMALL);
        const watch2Path = join(fx.root, "src/watch2.ts");
        await until(async () => (await tableFilePaths(table)).has(watch2Path));

        // Give any late oversized event ample time (awaitWriteFinish 200ms +
        // debounce ≈ 300ms); then assert it never landed.
        await new Promise((r) => setTimeout(r, 1500));
        const paths = await tableFilePaths(table);
        expect(paths.has(join(fx.root, "src/watchbig.ts"))).toBe(false);
        // Read the capture BEFORE mockRestore (restore resets the call log) —
        // all reads happen inside the try for that reason.
        expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
          "exceeds maxFileSizeBytes",
        );
      } finally {
        errSpy.mockRestore();
      }
    },
    30000,
  );
});