/**
 * O2 — zero-downtime model migration.
 *
 * The registry transaction is the commit point: every test builds a real
 * (temp-LanceDB) table, drives `migrateTable` (or a real `syncIndex` escalation
 * through a real JobQueue + IndexManager) with a STUBBED embedding wire
 * (fake global fetch, never a live backend), and asserts the swap semantics:
 * - success flips the registry to the completed shadow and drops the old table;
 * - a forced embed failure mid-build leaves the original table + registry
 *   intact and cleans the shadow;
 * - a failed drop of the superseded table only leaves a doctor-flaggable orphan;
 * - abort before the commit cancels cleanly;
 * - an empty table pins the model in place, a missing table refuses;
 * - the escalation surfaces the migrate job with persisted progress.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodeRecord } from "../src/services/db";
import type { IndexRecord } from "../src/core/registry";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const CONFIG = (await import("../src/config")).CONFIG;
const db = await import("../src/services/db");
const Registry = (await import("../src/core/registry")).Registry;
const JobQueue = (await import("../src/core/job-queue")).JobQueue;
const IndexManager = (await import("../src/core/index-manager")).IndexManager;
const migrateTable = (await import("../src/services/indexer")).migrateTable;
const setEmbedBackend = (await import("../src/services/embed")).setEmbedBackend;
const resetEmbedBackend = (await import("../src/services/embed")).resetEmbedBackend;
const isolatedHome = (await import("./helpers/isolated-cidx-home")).isolatedHome;

// ------------------------------------------------------------------ fixtures

const PROJECT = mkdtempSync(path.join(os.tmpdir(), "cidx-migrate-proj-"));
const INDEX = "migproj";

/** The three "files" of the fixture table: 2 chunks each, two chunks carry a doc. */
const FILES = [
  { p: "/proj/src/a.ts", chunk: "export function alpha() { return 1; }", sym: "alpha", doc: "Alpha does the thing." },
  { p: "/proj/src/b.ts", chunk: "export function beta() { return 2; }", sym: "beta", doc: null },
  // A compound identifier, so the recomputed `id_terms` leg is observable.
  { p: "/proj/src/c.ts", chunk: "export function gammaHelper() { return 3; }", sym: "gammaHelper", doc: "Gamma helper." },
] as const;

/**
 * Deterministic stub embedding, model-dependent (model-b scales the base
 * vector) so "the table really holds new-model vectors" is an observable
 * assertion: a migrated row IS nearest to its own content embedded with the
 * new model, and NOT nearest to the old-model vector of the same content.
 */
function vecFor(text: string, model: string): number[] {
  const m = model === "model-b" ? 2 : 1;
  return [
    ((text.length % 5) + 1) * m,
    m,
    ((text.charCodeAt(0) % 7) + m),
    0.25 * m + (text.length % 3),
  ];
}

function sourceRecords(): CodeRecord[] {
  return FILES.flatMap((f) =>
    [0, 1].map((k) => {
      const content = `${f.chunk}\n// chunk ${k}`;
      return {
        id: `${f.p}#${k}`,
        filePath: f.p,
        content,
        vector: vecFor(content, "model-a"),
        language: "typescript",
        symbolName: f.sym,
        symbolType: "function",
        startLine: 1,
        endLine: 1,
        doc: k === 0 ? f.doc : null,
        doc_vector: null,
        id_terms: null,
      } satisfies CodeRecord;
    }),
  );
}

// ------------------------------------------------------- stubbed embed wire

interface WireCall {
  url: string;
  model: string;
  n: number;
}

/**
 * Mutable wire state. `failModel`+`failCallsBefore` make the Nth embed call for
 * that model fail (a forced mid-migration failure for the failure tests).
 */
const wire: {
  calls: WireCall[];
  failModel: string | null;
  failCallsBefore: number;
  /** If > 0, every batch response returns this many embeddings fewer than requested (silent under-delivery). */
  shortBy: number;
} = {
  calls: [],
  failModel: null,
  failCallsBefore: 0,
  shortBy: 0,
};
let realFetch: typeof globalThis.fetch | null = null;

function installFetch(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const bodyRaw = init?.body;
    const body =
      typeof bodyRaw === "string" ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
    const model = typeof body.model === "string" ? body.model : "";
    const texts: string[] = Array.isArray(body.input)
      ? (body.input as unknown[]).filter((t): t is string => typeof t === "string")
      : typeof body.prompt === "string"
        ? [body.prompt]
        : [];
    wire.calls.push({ url, model, n: texts.length });
    if (wire.failModel !== null && model === wire.failModel) {
      const made = wire.calls.filter((c) => c.model === wire.failModel).length;
      if (made >= wire.failCallsBefore) {
        return new Response("embed exploded", { status: 500 });
      }
    }
    // /api/embeddings is the single-text endpoint (embedding: [...]); /api/embed
    // the batch one (embeddings: [[...]]).
    if (url.endsWith("/api/embeddings")) {
      return new Response(JSON.stringify({ embedding: vecFor(texts[0] ?? "", model) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const embeddings = texts.map((t) => vecFor(t, model));
    if (wire.shortBy > 0) embeddings.length = Math.max(0, embeddings.length - wire.shortBy);
    return new Response(JSON.stringify({ embeddings }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function uninstallFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
}

const targetOf = (table: string) => ({ indexName: INDEX, tableName: table, baseDir: PROJECT });

// The PROJECT directory is shared by both suites (the e2e writes .cidx.json
// into it) — remove it once, when the whole file is done.
// One stubbed wire for the whole file; PROJECT outlives the suites (the e2e
// watchers/queue need it) and is removed only when everything else is done.
beforeAll(() => {
  installFetch();
});
afterAll(() => {
  uninstallFetch();
  rmSync(PROJECT, { recursive: true, force: true });
});

function makeRecord(table: string, overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    name: INDEX,
    path: PROJECT,
    tableName: table,
    status: "ready",
    fileCount: 3,
    chunkCount: 6,
    embedModel: "model-a",
    embedDim: 4,
    lastIndexedAt: 123,
    createdAt: 1,
    error: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------- suites

describe("migrateTable — swap semantics (temp-LanceDB + stubbed embed wire)", () => {
  let registry: InstanceType<typeof Registry>;
  let dbPath: string;
  let table: string;

  beforeAll(async () => {
    expect(CONFIG.DB_DIR.startsWith(isolatedHome)).toBe(true);
    await db.initDB();
  });

  beforeEach(() => {
    dbPath = path.join(isolatedHome, `migrate-${randomUUID()}.db`);
    table = `idx_migr_${randomUUID().slice(0, 8)}`.replaceAll("-", "_");
    registry = new Registry(dbPath);
    registry.upsertIndex(makeRecord(table));
    registry.setFileMtime(INDEX, FILES[0]!.p, 1);
    registry.setFileMtime(INDEX, FILES[1]!.p, 2);
    registry.setFileMtime(INDEX, FILES[2]!.p, 3);
    setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
    wire.calls = [];
    wire.failModel = null;
    wire.shortBy = 0;
  });

  afterEach(() => {
    resetEmbedBackend();
    registry.close();
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* ignore */
    }
  });

  test("rebuilds all rows into the shadow, flips the registry and drops the old table", async () => {
    await db.insertChunks(table, sourceRecords());
    const progress: { processed: number; total: number; message?: string }[] = [];
    const result = await migrateTable(targetOf(table), "model-b", {
      registry,
      onProgress: (processed, total, message) =>
        progress.push({ processed, total, ...(message !== undefined ? { message } : {}) }),
    });

    expect(result.kind).toBe("swapped");
    expect(result.fromTable).toBe(table);
    expect(result.toTable).toBe(`${table}_mig`);
    expect(result.rows).toBe(6);
    expect(result.dim).toBe(4);
    expect(result.originalDropped).toBe(true);

    // Registry flip: name, model, dim, stats, freshness.
    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(`${table}_mig`);
    expect(rec.embedModel).toBe("model-b");
    expect(rec.embedDim).toBe(4);
    expect(rec.chunkCount).toBe(6);
    expect(rec.status).toBe("ready");
    expect(rec.lastIndexedAt).toBeGreaterThan(123);

    // Physical swap: old table gone, shadow complete with the full schema.
    const names = await db.listTables();
    expect(names).not.toContain(table);
    const shadow = result.toTable;
    const cols = await db.tableColumns(shadow);
    for (const col of ["doc", "doc_vector", "id_terms"] as const) {
      expect(cols.has(col)).toBe(true);
    }

    // The shadow serves NEW-model vectors: the row IS nearest to its own
    // content embedded with the new model (distance ~0), and NOT to the
    // old-model vector of the same content (the vectors really moved).
    const content0 = `${FILES[0]!.chunk}\n// chunk 0`;
    const newHits = await db.searchTable(shadow, vecFor(content0, "model-b"), 3);
    expect(newHits[0]?.content).toBe(content0);
    expect(newHits[0]?._distance ?? 9).toBeLessThan(1e-6);
    const oldHits = await db.searchTable(shadow, vecFor(content0, "model-a"), 3);
    expect(oldHits[0]?._distance ?? 0).toBeGreaterThan(0.5);

    // BM25/FTS was rebuilt too.
    const fts = await db.searchTableText(shadow, "alpha", 5);
    expect(fts.length).toBeGreaterThan(0);

    // The docstring leg was re-embedded with the new model.
    const docHits = await db.searchTable(
      shadow,
      vecFor("Alpha does the thing.", "model-b"),
      3,
      undefined,
      "doc_vector",
    );
    expect(docHits[0]?.filePath).toBe(FILES[0]!.p);
    expect(docHits[0]?._distance ?? 9).toBeLessThan(1e-6);

    // id_terms was recomputed (rows copied from a table that had none).
    const syms = await db.searchSymbol(shadow, "gammaHelper", 5);
    expect(syms.length).toBe(2);
    expect(syms[0]?.id_terms ?? "").toContain("gammahelper gamma helper");

    // The file cache survives (a migration neither re-scans the disk nor
    // invalidates the mtime cache).
    expect(registry.listCachedFiles(INDEX)).toContain(FILES[0]!.p);

    // Progress covers the whole table (0/n at the start, n/n at the end).
    expect(progress[0]?.total).toBe(6);
    expect(progress[0]?.processed).toBe(0);
    expect(progress[progress.length - 1]?.processed).toBe(6);
  });

  test("a forced embed failure mid-build leaves the original table + registry intact, shadow cleaned", async () => {
    await db.insertChunks(table, sourceRecords());
    wire.failModel = "model-b";
    wire.failCallsBefore = 3; // the 3rd model-b embed call fails → mid-migration

    await expect(migrateTable(targetOf(table), "model-b", { registry })).rejects.toThrow();

    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(table); // never flipped
    expect(rec.embedModel).toBe("model-a");
    expect(rec.status).toBe("ready"); // migrateTable alone does not touch status
    expect(rec.lastIndexedAt).toBe(123);

    const names = await db.listTables();
    expect(names).toContain(table); // original untouched
    expect(names).not.toContain(`${table}_mig`); // partial shadow cleaned
    expect(await db.countTableRows(table)).toBe(6);
  });

  test("a silently SHORT embed response fails the job instead of committing dropped chunks", async () => {
    await db.insertChunks(table, sourceRecords());
    wire.shortBy = 1; // every batch response under-delivers by one embedding

    await expect(migrateTable(targetOf(table), "model-b", { registry })).rejects.toThrow(
      "returned no vector",
    );

    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(table); // never flipped
    expect(rec.embedModel).toBe("model-a");
    const names = await db.listTables();
    expect(names).toContain(table);
    expect(names).not.toContain(`${table}_mig`); // partial shadow cleaned
    expect(await db.countTableRows(table)).toBe(6);
  });

  test("an abort before the swap cancels cleanly (registry + original intact, shadow removed)", async () => {
    await db.insertChunks(table, sourceRecords());
    const ac = new AbortController();
    ac.abort();

    const result = await migrateTable(targetOf(table), "model-b", { registry, signal: ac.signal });

    expect(result.kind).toBe("cancelled");
    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(table);
    expect(rec.embedModel).toBe("model-a");
    expect(rec.status).toBe("ready");
    const names = await db.listTables();
    expect(names).toContain(table);
    expect(names).not.toContain(`${table}_mig`);
    expect(await db.countTableRows(table)).toBe(6);
  });

  test("a drop failure of the superseded table is tolerated (a doctor-flaggable orphan)", async () => {
    await db.insertChunks(table, sourceRecords());
    // Make the ORIGINAL table's directory undeletable (read-execute only):
    // reads still work, the drop fails — exactly the "orphan, not fatal" branch.
    const dirName = readdirSync(CONFIG.DB_DIR).find(
      (n) => n === `${table}.lance` || n === table,
    );
    expect(dirName).toBeDefined();
    const dir = path.join(CONFIG.DB_DIR, dirName!);
    chmodSync(dir, 0o500);
    let result;
    try {
      result = await migrateTable(targetOf(table), "model-b", { registry });
    } finally {
      chmodSync(dir, 0o700);
    }

    // The registry transaction happened anyway; only the drop failed.
    expect(result.kind).toBe("swapped");
    expect(result.originalDropped).toBe(false);
    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(`${table}_mig`);
    expect(rec.embedModel).toBe("model-b");
    // Both tables remain on disk: the live shadow + the superseded orphan.
    const names = await db.listTables();
    expect(names).toContain(`${table}_mig`);
    expect(names).toContain(table);
    expect(await db.countTableRows(`${table}_mig`)).toBe(6);
  });

  test("an existing but EMPTY table pins the new model in place (no shadow built)", async () => {
    await db.insertChunks(table, sourceRecords());
    for (const f of FILES) await db.deleteFileRecords(table, f.p); // table exists, 0 rows

    const result = await migrateTable(targetOf(table), "model-b", { registry });

    expect(result.kind).toBe("swapped");
    expect(result.toTable).toBe(table); // in place — no shadow
    expect(result.rows).toBe(0);
    expect(result.originalDropped).toBe(false);
    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(table);
    expect(rec.embedModel).toBe("model-b");
    expect(rec.chunkCount).toBe(0);
    expect(rec.status).toBe("ready");
    expect((await db.tableColumns(`${table}_mig`)).size).toBe(0); // no shadow was created
  });

  test("a MISSING source table refuses to migrate (a reindex is the honest remedy)", async () => {
    await db.dropTable(table);
    await expect(migrateTable(targetOf(table), "model-b", { registry })).rejects.toThrow(
      "does not exist",
    );
    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(table);
    expect(rec.embedModel).toBe("model-a");
    expect(rec.status).toBe("ready");
  });
});

describe("syncIndex escalation — a real manager + job queue end to end", () => {
  let registry: InstanceType<typeof Registry>;
  let queue: InstanceType<typeof JobQueue>;
  let manager: InstanceType<typeof IndexManager>;
  let dbPath: string;
  let table: string;

  beforeAll(async () => {
    await db.initDB();
    writeFileSync(path.join(PROJECT, ".cidx.json"), '{"embedModel":"model-b"}\n');
  });

  beforeEach(() => {
    dbPath = path.join(isolatedHome, `migrate-e2e-${randomUUID()}.db`);
    table = `idx_mige2e_${randomUUID().slice(0, 8)}`.replaceAll("-", "_");
    // Pin the stubbed backend — resolveAuto would otherwise probe (and answer)
    // live, and the wire shape would not match this file's stub.
    setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
    wire.calls = [];
    wire.failModel = null;
    wire.shortBy = 0;
  });

  afterEach(async () => {
    resetEmbedBackend();
  });

  afterAll(async () => {
    // Close the watchers and jobs FIRST — the registry must not be touched
    // after `close()` (a lingering chokidar debounce or a queued job persisting
    // afterwards crashes with "Cannot use a closed database").
    await manager?.shutdown();
    registry?.close();
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* ignore */
    }
  });

  test("a `.cidx.json` model change enqueues a migrate job; search serves the new model", async () => {
    registry = new Registry(dbPath);
    queue = new JobQueue({ registry });
    manager = new IndexManager(registry, queue);
    registry.upsertIndex(makeRecord(table));
    await db.insertChunks(table, sourceRecords());

    const rec = manager.syncIndex(INDEX);
    expect(rec.status).toBe("indexing");
    const job = manager.activeJob(INDEX);
    expect(job?.type).toBe("migrate");
    await queue.waitForJob(job!.id);

    // Registry flipped to the completed shadow with the target model pinned.
    const flipped = registry.getIndex(INDEX)!;
    expect(flipped.tableName).toBe(`${table}_mig`);
    expect(flipped.embedModel).toBe("model-b");
    expect(flipped.status).toBe("ready");
    expect(flipped.chunkCount).toBe(6);

    // The old table was dropped; the migrate job persisted its result.
    expect(await db.listTables()).not.toContain(table);
    const persisted = registry.getJob(job!.id);
    expect(persisted?.type).toBe("migrate");
    expect(persisted?.status).toBe("completed");

    // Search (post-swap record) embeds the query with the NEW model and finds
    // the row that carries exactly that embedding — the docstring-free public
    // result carries no vector payload. The query is the chunk's exact content,
    // so its stubbed embedding equals the stored row vector (distance ~0).
    const exactContent = `${FILES[1]!.chunk}\n// chunk 0`;
    const { results } = await manager.searchIndex(INDEX, exactContent, 3, {
      mode: "vector",
      rerank: false,
      mmr: false,
      doc: false, // pure vector leg — the docstring leg would RRF the doc rows above it
    });
    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!;
    expect(top.project).toBe(INDEX);
    expect(top.filePath).toBe(FILES[1]!.p);
    expect(top._distance ?? 9).toBeLessThan(1e-6);
    expect(top).not.toHaveProperty("vector");
    expect(top).not.toHaveProperty("doc_vector");

    // A second sync is no longer an escalation: models match, the normal
    // incremental path runs (the model change is consumed). Its job (a plain
    // index sync) is awaited so nothing outlives the test's registry.
    const again = manager.syncIndex(INDEX);
    const job2 = manager.activeJob(INDEX);
    if (job2) await queue.waitForJob(job2.id);
    expect(again.tableName).toBe(`${table}_mig`);
  });
});