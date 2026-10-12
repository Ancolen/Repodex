/**
 * Table stats / compact (proposal O3).
 *
 * 1. Registry-level: `countFileCache` / `embeddingCacheStats` over a temp
 *    sqlite file (the existing registry test pattern).
 * 2. db-level: `tableStats` presence/shape/unknowns and `compactTable` no-op
 *    + real fragment-merge safety on REAL (temp-LanceDB) tables built through
 *    the project's own `insertChunks`/`ensureFtsIndex` over the throw-away
 *    `[test]` data root — no embedding backend anywhere (fixed 4-dim arrays).
 * 3. `collectStats`: the `GET /stats` payload shape through FAKE ports — the
 *    doctor-style port pattern, so every honest unknown (missing table, absent
 *    disk entry, unreadable walk entry) is observable without a daemon.
 * 4. Manager-level: `compactIndex` refuses while a REAL index job holds the
 *    table (stubbed, hanging embed wire) and compacts once it finishes; the
 *    unknown-project error is the self-healing wording.
 * 5. Formatters: `formatStatsSections` + `formatCompactResult` (pure).
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job } from "../src/core/types";
import type { CodeRecord } from "../src/services/db";
import type { IndexRecord } from "../src/core/registry";
import type { StatsPorts } from "../src/core/stats";
import type { StatsReport } from "../src/core/stats";

import { Registry, type EmbedCacheStats } from "../src/core/registry";
import { measureDiskUsage } from "../src/core/doctor";

// The `[test]` preload pins $CIDX_HOME first, so these resolve to the isolated root.
const db = await import("../src/services/db");
const CFG = (await import("../src/config")).CONFIG;
const { isolatedHome } = await import("./helpers/isolated-cidx-home");
const { collectStats, compactBusyMessage, jobIsActive } = await import("../src/core/stats");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { setEmbedBackend, resetEmbedBackend } = await import("../src/services/embed");
const fmt = await import("../src/server/format");

// ------------------------------------------------- 1. registry-level counts

describe("Registry countFileCache / embeddingCacheStats (proposal O3)", () => {
  let reg: Registry;
  let dbPath: string;

  const mkRecord = (name: string): IndexRecord => ({
    name,
    path: `/tmp/${name}`,
    tableName: `idx_${name}`,
    status: "ready",
    fileCount: 0,
    chunkCount: 4,
    embedModel: null,
    embedDim: null,
    lastIndexedAt: 1700000000000,
    createdAt: 1,
    error: null,
  });

  beforeEach(() => {
    dbPath = join(tmpdir(), `cidx-stats-${randomUUID()}.db`);
    reg = new Registry(dbPath);
  });

  afterEach(() => {
    reg.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("file_cache count: per project and global", () => {
    reg.upsertIndex(mkRecord("a"));
    reg.upsertIndex(mkRecord("b"));
    reg.setFileMtime("a", "/tmp/a/x.ts", 1);
    reg.setFileMtime("a", "/tmp/a/y.ts", 1);
    reg.setFileMtime("b", "/tmp/b/x.ts", 1);
    expect(reg.countFileCache("a")).toBe(2);
    expect(reg.countFileCache("b")).toBe(1);
    expect(reg.countFileCache("missing")).toBe(0);
    expect(reg.countFileCache()).toBe(3); // every project
  });

  test("embeddingCacheStats: rows + estimated size from the vector BLOBs", () => {
    expect(reg.embeddingCacheStats()).toEqual({ rows: 0, estimatedBytes: 0 });
    // Every vector is stored as float32 → a dim-N vector is a BLOB of N*4 bytes.
    reg.putCachedEmbeddings("m-a", [
      { hash: "h1", vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }, // 24 B
      { hash: "h2", vector: [1.1, 1.2, 1.3, 1.4, 1.5, 1.6] }, // 24 B
      { hash: "h3", vector: [2.1, 2.2, 2.3, 2.4] }, // 16 B
    ]);
    const stats: EmbedCacheStats = reg.embeddingCacheStats();
    expect(stats.rows).toBe(3);
    expect(stats.estimatedBytes).toBe(24 + 24 + 16);
  });
});

// ------------------------------------------------- 2. db-level table stats

const FIX_TABLE = "idx_stats_fixture";
const FRAG_TABLE = "idx_stats_frag";

/** The three chunks of the fixture table (two rows of alpha, one of beta). */
const FIX_ROWS = [
  { file: "/proj/src/alpha.ts", symbol: "alpha", chunk: 0 },
  { file: "/proj/src/alpha.ts", symbol: "alpha", chunk: 1 },
  { file: "/proj/src/beta.ts", symbol: "beta", chunk: 0 },
];

function fixRecord(row: { file: string; symbol: string; chunk: number }): CodeRecord {
  const content = `export function ${row.symbol}() { return ${row.chunk}; }\n// chunk ${row.chunk}`;
  return {
    id: `${row.file}#${row.chunk}`,
    filePath: row.file,
    content,
    vector: [0.1, 0.2, 0.3, 0.4],
    language: "typescript",
    symbolName: row.symbol,
    symbolType: "function",
    startLine: 1,
    endLine: 2,
    doc: null,
    doc_vector: null,
    id_terms: null,
  };
}

describe("db tableStats / compactTable on real temp-LanceDB tables (proposal O3)", () => {
  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(isolatedHome)).toBe(true);
    await db.initDB();
    await db.insertChunks(FIX_TABLE, FIX_ROWS.map(fixRecord));
    // The BM25/FTS indexes are what make `indices` observable without an ANN
    // build (needs many more rows to train than a fixture can carry).
    await db.ensureFtsIndex(FIX_TABLE);
    // FRAG_TABLE: one insert per file → one fragment per file, so a later
    // `compactTable` has small fragments to merge.
    for (const file of ["one", "two", "three"]) {
      await db.insertChunks(
        FRAG_TABLE,
        [0, 1].map((chunk) =>
          fixRecord({ file: `/proj/src/${file}.ts`, symbol: file, chunk }),
        ),
      );
    }
  });

  test("tableStats: rows, fragments and FTS index presence + coverage", async () => {
    const s = await db.tableStats(FIX_TABLE);
    expect(s).not.toBeNull();
    expect(s!.unknowns).toEqual([]);
    expect(s!.numRows).toBe(FIX_ROWS.length);
    expect(s!.numFragments).toBeGreaterThanOrEqual(1);
    // The FTS leg of the fixture: every index reports its columns, type and
    // native coverage (the cheap `indexStats` numbers).
    expect(s!.indices.length).toBeGreaterThan(0);
    for (const ix of s!.indices) {
      expect(ix.indexType).toMatch(/fts|inverted/i);
      expect(ix.indexedRows).toBeDefined();
      expect(ix.indexedRows!).toBeLessThanOrEqual(FIX_ROWS.length);
    }
    expect(s!.indices.map((ix) => ix.columns)).toContainEqual(["content"]);
  });

  test("size sanity: the fixture table's on-disk directory is measured by the doctor's walk", () => {
    // The same read-only walk `GET /stats` reuses (reused, never forked).
    const disk = measureDiskUsage(CFG.ROOT_DIR);
    const entry = disk.tables.find((t) => t.name === FIX_TABLE);
    expect(entry).toBeDefined();
    expect(entry!.bytes).toBeGreaterThan(0);
  });

  test("tableStats on an absent table is null — an honest 'missing', not zeros", async () => {
    expect(await db.tableStats("idx_stats_missing")).toBeNull();
  });

  test("compactTable is a SAFE no-op on an already-compact table", async () => {
    const before = await db.countTableRows(FIX_TABLE);
    const r = await db.compactTable(FIX_TABLE);
    expect(r.table).toBe(FIX_TABLE);
    // Zero compaction/prune numbers — a no-op, never a rewrite.
    expect(r.compaction.fragmentsRemoved).toBe(0);
    expect(r.compaction.filesRemoved).toBe(0);
    expect(r.prune.oldVersionsRemoved).toBe(0);
    // And the table is untouched: same rows, still readable.
    expect(await db.countTableRows(FIX_TABLE)).toBe(before);
  });

  test("compactTable merges small fragments natively and preserves every row", async () => {
    const statsBefore = await db.tableStats(FRAG_TABLE);
    expect(statsBefore!.numRows).toBe(6);
    expect(statsBefore!.numFragments).toBe(3); // one insert per file
    expect(statsBefore!.numSmallFragments).toBe(3); // all of them compactable
    const r = await db.compactTable(FRAG_TABLE);
    expect(r.table).toBe(FRAG_TABLE);
    expect(r.compaction.fragmentsRemoved).toBe(3);
    expect(r.compaction.fragmentsAdded).toBe(1);
    expect(r.compaction.filesRemoved).toBe(3);
    expect(r.compaction.filesAdded).toBe(1);
    const statsAfter = await db.tableStats(FRAG_TABLE);
    expect(statsAfter!.numRows).toBe(6);
    expect(statsAfter!.numFragments).toBe(1);
  });

  test("compactTable refuses a table that does not exist", async () => {
    expect(db.compactTable("idx_stats_missing")).rejects.toThrow("does not exist");
  });
});

// --------------------------------------------------- 3. collectStats shape

describe("collectStats — the /stats payload shape (fake ports)", () => {
  const DISK = {
    root: "/tmp/cidx-fake-home",
    rootExists: true,
    totalBytes: 1234,
    entries: [
      { name: "meta.db", bytes: 100 },
      { name: "meta.db-wal", bytes: 10 },
      { name: "daemon.log", bytes: 30 },
    ],
    tables: [{ name: "idx_a", bytes: 500 }],
    errors: 1,
  };

  const recA: IndexRecord = {
    name: "a",
    path: "/tmp/a",
    tableName: "idx_a",
    status: "ready",
    fileCount: 9,
    chunkCount: 42,
    embedModel: "model-a",
    embedDim: 4,
    lastIndexedAt: 1700000000000,
    createdAt: 1,
    error: null,
  };
  const recB: IndexRecord = {
    name: "b",
    path: "/tmp/b",
    tableName: "idx_b",
    status: "ready",
    fileCount: 1,
    chunkCount: 7,
    embedModel: null,
    embedDim: null,
    lastIndexedAt: null,
    createdAt: 2,
    error: null,
  };

  const jobB: Job = {
    id: "job-1",
    type: "index",
    status: "running",
    payload: {},
    priority: 0,
    progress: { processed: 4, total: 8 },
    createdAt: 1,
  };

  const nativeA = {
    numRows: 42,
    numFragments: 5,
    numSmallFragments: 2,
    indices: [{ columns: ["vector"], indexType: "IVF_PQ", indexedRows: 40, unindexedRows: 2 }],
    unknowns: ["table stats partially unavailable: probe failed"],
  };

  function ports(overrides: Partial<StatsPorts> = {}): StatsPorts {
    const base: StatsPorts = {
      indexes: () => [recA, recB],
      activeJob: (name) => (name === "b" ? jobB : null),
      fileCacheCount: (indexName) => {
        if (indexName === undefined) return 11;
        return indexName === "a" ? 9 : 0;
      },
      embeddingCacheStats: () => ({ rows: 2, estimatedBytes: 32 }),
      diskUsage: () => DISK,
      tableStats: async (table) => (table === "idx_a" ? nativeA : null),
      ...overrides,
    };
    return base;
  }

  test("per-project stats carry the registry counts, sizes, index presence and job", async () => {
    const r = await collectStats(ports());
    expect(r.generatedAt).toBeGreaterThan(0);
    expect(r.home).toBe("/tmp/cidx-fake-home");
    expect(r.projects).toHaveLength(2);

    const a = r.projects[0]!;
    expect(a.name).toBe("a");
    expect(a.table).toBe("idx_a");
    expect(a.rows).toBe(42); // the registry's chunk count (the proposal's row count)
    expect(a.cachedFiles).toBe(9);
    expect(a.lastIndexedAt).toBe(1700000000000);
    expect(a.tableBytes).toBe(500); // measured from the disk walk
    expect(a.fragments).toBe(5);
    expect(a.smallFragments).toBe(2);
    expect(a.indices).not.toBeNull();
    expect(a.indices![0]!.unindexedRows).toBe(2);
    expect(a.notes).toEqual(["table stats partially unavailable: probe failed"]);
    expect(a.job).toBeNull();

    const b = r.projects[1]!;
    expect(b.tableBytes).toBeNull(); // no disk entry → unknown, never 0
    expect(b.indices).toBeNull(); // table absent from disk
    expect(b.fragments).toBeNull();
    expect(b.lastIndexedAt).toBeNull();
    expect(b.cachedFiles).toBe(0);
    expect(b.notes[0]).toContain("not found on disk");
    expect(b.job).toEqual({ id: "job-1", type: "index", status: "running", processed: 4, total: 8 });
  });

  test("global stats: data-root total, meta.db (incl. WAL), cache, unreadable entries", async () => {
    const r = await collectStats(ports());
    expect(r.global.rootExists).toBe(true);
    expect(r.global.totalBytes).toBe(1234);
    expect(r.global.tables).toEqual([{ name: "idx_a", bytes: 500 }]);
    // meta.db AND its WAL side file are both "the meta store on disk".
    expect(r.global.metaDbBytes).toBe(110);
    expect(r.global.embeddingCache).toEqual({ rows: 2, estimatedBytes: 32 });
    expect(r.global.unreadableEntries).toBe(1);
  });

  test("a data root that does not exist yet keeps its global picture honest", async () => {
    const r = await collectStats(
      ports({
        diskUsage: () => ({ ...DISK, rootExists: false, entries: [], tables: [], totalBytes: 0, errors: 0 }),
      }),
    );
    expect(r.global.rootExists).toBe(false);
    expect(r.global.metaDbBytes).toBe(0);
    expect(r.projects).toHaveLength(2); // the registry still knows the projects
    expect(r.projects[0]!.tableBytes).toBeNull();
  });

  test("the project filter narrows the per-project list, never the globals", async () => {
    const r = await collectStats(ports(), { project: "a" });
    expect(r.projects).toHaveLength(1);
    expect(r.projects[0]!.name).toBe("a");
    expect(r.global.totalBytes).toBe(1234);
  });

  test("an unknown project name yields zero projects (the handler 404s first)", async () => {
    const r = await collectStats(ports(), { project: "zzz" });
    expect(r.projects).toHaveLength(0);
  });

  test("the busy-table helpers", () => {
    expect(jobIsActive(null)).toBe(false);
    expect(jobIsActive({ ...jobB, status: "completed" })).toBe(false);
    expect(jobIsActive({ ...jobB, status: "queued" })).toBe(true);
    expect(jobIsActive({ ...jobB, status: "running" })).toBe(true);
    expect(compactBusyMessage("api", { type: "index", status: "running" })).toContain("'api' is busy");
    expect(compactBusyMessage("api", { type: "index", status: "running" })).toContain("quiescent");
  });
});

// --------------------------------------------- 4. manager-level compactIndex

const MGR_TABLE = "idx_stats_fix";
const MGR_INDEX = "statsfix";
const MGR_LIB = "export function statsFixProbe(): string {\n  return 'x';\n}\n";

/**
 * A controllable embed wire: when ARMED, the first call hangs (the job that
 * `syncIndex` enqueues is then genuinely RUNNING), later calls answer
 * deterministically with fixed 4-dim vectors — no backend, no network.
 */
const wire = { calls: 0, hangArmed: false, pending: null as null | (() => void) };
let realFetch: typeof globalThis.fetch | null = null;

const MGR_VEC = [0.1, 0.2, 0.3, 0.4];

function installHangWire(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    wire.calls++;
    if (wire.hangArmed) {
      wire.hangArmed = false;
      await new Promise<void>((resolve) => {
        wire.pending = resolve;
      });
    }
    // /api/embeddings is the single-text endpoint (embedding: [...]); /api/embed
    // the batch one (embeddings: [[...]]) — one vector per requested text.
    const url = String(input);
    const bodyRaw = init?.body;
    const body = typeof bodyRaw === "string" ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
    const texts: string[] = Array.isArray(body.input)
      ? (body.input as unknown[])
          .filter((t): t is string => typeof t === "string")
      : typeof body.prompt === "string"
        ? [body.prompt]
        : [];
    if (url.endsWith("/api/embeddings")) {
      return new Response(JSON.stringify({ embedding: MGR_VEC }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ embeddings: texts.map(() => MGR_VEC) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

function uninstallHangWire(): void {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
  wire.pending = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("IndexManager.compactIndex — the busy rule and the compaction", () => {
  const PROJECT = mkdtempSync(join(tmpdir(), "cidx-stats-proj-"));
  const DB_PATH = join(isolatedHome, `stats-mgr-${randomUUID()}.db`);
  let registry: InstanceType<typeof Registry>;
  let queue: InstanceType<typeof JobQueue>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(isolatedHome)).toBe(true);
    await db.initDB();
    mkdirSync(join(PROJECT, "src"), { recursive: true });
    writeFileSync(join(PROJECT, "src", "lib.ts"), MGR_LIB);
    // The stubbed backend is pinned: `resolveAuto` would otherwise probe live.
    setEmbedBackend({ provider: "ollama", url: CFG.OLLAMA_URL, reason: "explicit" });
    installHangWire();
    registry = new Registry(DB_PATH);
    queue = new JobQueue({ registry });
    manager = new IndexManager(registry, queue);
    registry.upsertIndex({
      name: MGR_INDEX,
      path: PROJECT,
      tableName: MGR_TABLE,
      status: "ready",
      fileCount: 0,
      chunkCount: 0,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: null,
      createdAt: 1,
      error: null,
    });
  });

  afterEach(() => {
    // Never leak a hung wire into another test.
    wire.pending?.();
    wire.pending = null;
  });

  afterAll(async () => {
    uninstallHangWire();
    resetEmbedBackend();
    // Watchers/jobs first — the registry must not be touched after close().
    await manager?.shutdown();
    registry?.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${DB_PATH}${suffix}`, { force: true });
      } catch {
        /* ignore */
      }
    }
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("refuses with the shared busy wording while an index job holds the table", async () => {
    // Armed: the job's FIRST embed call hangs → nothing is written yet.
    wire.hangArmed = true;
    manager.syncIndex(MGR_INDEX);
    const job = manager.activeJob(MGR_INDEX);
    expect(job).not.toBeNull();
    expect(jobIsActive(job)).toBe(true);
    for (let i = 0; i < 100 && !(wire.calls > 0 && wire.pending); i++) await sleep(10);
    expect(wire.pending).not.toBeNull(); // the job is parked mid-embed

    let busy: Error | null = null;
    try {
      await manager.compactIndex(MGR_INDEX);
    } catch (err) {
      busy = err as Error;
    }
    expect(busy).not.toBeNull();
    expect(busy!.message).toBe(compactBusyMessage(MGR_INDEX, { type: job!.type, status: job!.status }));

    // The refusal must NOT have touched the table: the job never reached an
    // insert, and the refusal ran before any table write could interleave.
    expect(await db.tableStats(MGR_TABLE)).toBeNull();

    // Release the wire → the job finishes → compaction gets its turn.
    wire.pending?.();
    wire.pending = null;
    await queue.waitForJob(job!.id);
    // The finished job's mapping is cleared (activeJob → null) and the project
    // is back to "ready".
    expect(manager.activeJob(MGR_INDEX)).toBeNull();
    expect(registry.getIndex(MGR_INDEX)!.status).toBe("ready");

    const r = await manager.compactIndex(MGR_INDEX);
    expect(r.table).toBe(MGR_TABLE);
    expect(await db.countTableRows(MGR_TABLE)).toBeGreaterThan(0);
  }, 20000);

  test("an unknown project raises the self-healing not-found error", async () => {
    let err: Error | null = null;
    try {
      await manager.compactIndex("nope");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("nope");
    expect(err!.message).toContain(MGR_INDEX); // names the available projects
  });
});

// ------------------------------------------------------- 5. the formatters

describe("formatStatsSections / formatCompactResult (pure formatters)", () => {
  const report: StatsReport = {
    generatedAt: 1700000000000,
    home: "/tmp/home",
    global: {
      rootExists: true,
      totalBytes: 2000,
      tables: [
        { name: "idx_a", bytes: 1500 },
        { name: "idx_b", bytes: 500 },
      ],
      metaDbBytes: 300,
      embeddingCache: { rows: 4, estimatedBytes: 1024 },
      unreadableEntries: 0,
    },
    projects: [
      {
        name: "api",
        path: "/p/api",
        table: "idx_api",
        status: "ready",
        rows: 42,
        cachedFiles: 9,
        lastIndexedAt: 1700000000000,
        tableBytes: 1500,
        fragments: 5,
        smallFragments: 2,
        indices: [{ columns: ["vector"], indexType: "IVF_PQ", indexedRows: 40, unindexedRows: 2 }],
        notes: [],
        job: null,
      },
      {
        name: "ghost",
        path: "/p/ghost",
        table: "idx_ghost",
        status: "ready",
        rows: 0,
        cachedFiles: 0,
        lastIndexedAt: null,
        tableBytes: null,
        fragments: null,
        smallFragments: null,
        indices: null,
        notes: ["table 'idx_ghost' not found on disk — reindex to rebuild it"],
        job: { id: "j", type: "index", status: "running", processed: 1, total: 4 },
      },
    ],
  };

  test("project lines come first with the honest unknowns, then the global block", () => {
    const sections = fmt.formatStatsSections(report);
    expect(sections).toHaveLength(1);
    const text = sections[0]!;
    // Per-project block first…
    expect(text).toContain("Tables & disk (2 project(s)");
    expect(text).toContain("• api [ready] — idx_api: 42 row(s) · 9 cached file(s) · 1.5 KB");
    expect(text).toContain("vector [IVF_PQ] 40/42 rows +2 unindexed");
    expect(text).toContain("fragments: 5 (2 small) — compact would merge them");
    // honest unknowns as text, never invented zeros:
    expect(text).toContain("table not found on disk");
    expect(text).toContain("size unknown");
    expect(text).toContain("job: index running (25%)");
    // …then the global data-root block, tables largest-first.
    expect(text).toContain("Data root — /tmp/home:");
    expect(text).toContain("total 2.0 KB");
    expect(text).toContain("idx_a 1.5 KB, idx_b 500 B");
    expect(text).toContain("meta.db 300 B");
    expect(text).toContain("embedding cache 4 row(s) ≈ 1.0 KB");
  });

  test("the compact line: nothing-to-do, a merge, and a prune", () => {
    const noop = fmt.formatCompactResult({
      table: "idx_api",
      compaction: { fragmentsRemoved: 0, fragmentsAdded: 0, filesRemoved: 0, filesAdded: 0 },
      prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
    });
    expect(noop).toContain("nothing to do");

    const merged = fmt.formatCompactResult({
      table: "idx_api",
      compaction: { fragmentsRemoved: 4, fragmentsAdded: 1, filesRemoved: 4, filesAdded: 1 },
      prune: { bytesRemoved: 0, oldVersionsRemoved: 0 },
    });
    expect(merged).toContain("4 fragment(s) merged into 1");
    expect(merged).toContain("4 file(s) into 1");

    const pruned = fmt.formatCompactResult({
      table: "idx_api",
      compaction: { fragmentsRemoved: 0, fragmentsAdded: 0, filesRemoved: 0, filesAdded: 0 },
      prune: { bytesRemoved: 8192, oldVersionsRemoved: 3 },
    });
    expect(pruned).toContain("3 old version(s) pruned (8.0 KB freed)");
  });
});