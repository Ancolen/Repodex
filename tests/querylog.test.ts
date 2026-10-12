/**
 * Search analytics / query log (proposal A3).
 *
 * 1. Registry-level: record / prune / off-switch / aggregation over a temp
 *    sqlite file (the existing registry test pattern). A second independent
 *    bun:sqlite connection verifies the RAW column round-trip — the public API
 *    exposes only the aggregated stats + the row count.
 * 2. IndexManager-level: every `searchIndex`/`searchAll` call writes EXACTLY
 *    one row per (project, query) on the exit path; `searchBatch` funnels
 *    through those two (dedupe → one row per distinct query, no double
 *    logging). Real fixture table over the throw-away `[test]` data root (see
 *    tests/search-payload.test.ts): text mode + rerank/MMR off → no embedding
 *    backend needed anywhere.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Registry, type QueryLogRow } from "../src/core/registry";

// ------------------------------------------------------- 1. registry engine

function tempDbPath(): string {
  return join(tmpdir(), `cidx-querylog-${crypto.randomUUID()}.db`);
}

function row(query: string, overrides: Partial<QueryLogRow> = {}): QueryLogRow {
  return {
    ts: 1700000000000,
    project: "proj",
    query,
    mode: "text",
    resultCount: 0,
    latencyMs: 5,
    ...overrides,
  };
}

/** The raw recorded rows, read through an independent connection (WAL readers). */
interface RawQueryLogRow {
  ts: number;
  project: string | null;
  query: string;
  mode: string;
  result_count: number;
  latency_ms: number;
}

function rawRows(dbPath: string): RawQueryLogRow[] {
  const db = new Database(dbPath);
  try {
    return db
      .query(
        `SELECT ts, project, query, mode, result_count, latency_ms
           FROM query_log ORDER BY id ASC`,
      )
      .all() as RawQueryLogRow[];
  } finally {
    db.close();
  }
}

describe("Registry query log (proposal A3)", () => {
  let reg: Registry;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
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

  test("record + aggregate: counts, top queries, zero-hit, latency, repeat rate", () => {
    reg.recordQueryLog(row("alpha", { resultCount: 3, latencyMs: 10 }), 100);
    reg.recordQueryLog(row("alpha", { resultCount: 1, latencyMs: 30 }), 100);
    reg.recordQueryLog(row("beta", { resultCount: 0, latencyMs: 20, project: null }), 100);

    expect(reg.countQueryLog()).toBe(3);
    const stats = reg.queryLogStats();
    expect(stats.total).toBe(3);
    expect(stats.avgLatencyMs).toBe(20);
    expect(stats.maxLatencyMs).toBe(30);
    expect(stats.repeatRate).toBe(0.333); // 3 rows, 2 distinct → (3-2)/3, rounded to 3
    // Frequency order, tie-broken by query ASC; alpha's mean result count is 2.
    expect(stats.topQueries.map((t) => t.query)).toEqual(["alpha", "beta"]);
    expect(stats.topQueries[0]!.count).toBe(2);
    expect(stats.topQueries[0]!.avgResultCount).toBe(2);
    // A cross-project (null-project) search answered with nothing → zero-hit.
    expect(stats.zeroHit).toEqual([{ query: "beta", count: 1 }]);
  });

  test("the project filter excludes cross-project (null-project) rows", () => {
    reg.recordQueryLog(row("alpha", { resultCount: 2 }), 100);
    reg.recordQueryLog(row("beta", { project: null }), 100);

    const scoped = reg.queryLogStats({ project: "proj" });
    expect(scoped.total).toBe(1);
    expect(scoped.topQueries.map((t) => t.query)).toEqual(["alpha"]);
    expect(scoped.zeroHit).toEqual([]);
    // …and they still count toward the global stats:
    expect(reg.queryLogStats().total).toBe(2);
    // An unknown project name is a valid (empty) filter, not an error:
    expect(reg.queryLogStats({ project: "nope" }).total).toBe(0);
    // Empty string behaves like no filter (the global view):
    expect(reg.queryLogStats({ project: "" }).total).toBe(2);
  });

  test("topQueries / zeroHitTop caps are honored and sorted deterministically", () => {
    // Frequencies 5,4,3,2,1 — all zero-hit so both sections list every query.
    for (let i = 1; i <= 5; i++) {
      const q = `q${i}`;
      for (let c = 0; c < i; c++) reg.recordQueryLog(row(q), 1000);
    }
    expect(reg.countQueryLog()).toBe(15);

    const top = reg.queryLogStats({ topQueries: 2 }).topQueries;
    expect(top.map((t) => `${t.query}:${t.count}`)).toEqual(["q5:5", "q4:4"]);

    const zero = reg.queryLogStats({ zeroHitTop: 2 }).zeroHit;
    expect(zero.map((z) => `${z.query}:${z.count}`)).toEqual(["q5:5", "q4:4"]);
  });

  test("raw column round-trip: mode/ts/latency/project are stored", () => {
    reg.recordQueryLog(row("alpha", { resultCount: 3, latencyMs: 12, ts: 1700000000123 }), 100);
    const rows = rawRows(dbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toBe("alpha");
    expect(rows[0]!.project).toBe("proj");
    expect(rows[0]!.mode).toBe("text");
    expect(rows[0]!.result_count).toBe(3);
    expect(rows[0]!.latency_ms).toBe(12);
    expect(rows[0]!.ts).toBe(1700000000123);
  });

  test("off switch: size <= 0 (and NaN) never writes", () => {
    reg.recordQueryLog(row("alpha"), 0);
    reg.recordQueryLog(row("beta"), -1);
    reg.recordQueryLog(row("gamma"), Number.NaN);
    expect(reg.countQueryLog()).toBe(0);
    expect(reg.queryLogStats()).toEqual({
      total: 0,
      topQueries: [],
      zeroHit: [],
      avgLatencyMs: 0,
      maxLatencyMs: 0,
      repeatRate: 0,
    });
  });

  test("write-time prune caps the table at `size`, deleting the OLDEST rows", () => {
    for (const q of ["q1", "q2", "q3", "q4", "q5"]) reg.recordQueryLog(row(q), 4);
    expect(reg.countQueryLog()).toBe(4);
    expect(rawRows(dbPath).map((r) => r.query)).toEqual(["q2", "q3", "q4", "q5"]);
  });

  test("pruneQueryLog keeps the newest `keepRows` and returns how many it deleted", () => {
    for (let i = 0; i < 5; i++) reg.recordQueryLog(row(`q${i}`), 1000);
    expect(reg.pruneQueryLog(2)).toBe(3);
    expect(reg.countQueryLog()).toBe(2);
    expect(rawRows(dbPath).map((r) => r.query)).toEqual(["q3", "q4"]);
    // Keeping more than exist is a no-op; 0 keeps nothing; negative is a no-op.
    expect(reg.pruneQueryLog(10)).toBe(0);
    expect(reg.pruneQueryLog(0)).toBe(2);
    expect(reg.countQueryLog()).toBe(0);
    expect(reg.pruneQueryLog(-3)).toBe(0);
  });

  test("a failed log write never throws (a log failure must not fail a search)", () => {
    const dead = new Registry(tempDbPath());
    dead.close();
    const origError = console.error;
    console.error = () => {};
    try {
      expect(() => dead.recordQueryLog(row("x"))).not.toThrow();
      expect(() => dead.recordQueryLog(row("y"), 0)).not.toThrow();
    } finally {
      console.error = origError;
    }
  });
});

// ------------------------------------------------- 2. IndexManager wiring

/**
 * `IndexManager.searchIndex`/`searchAll` over a REAL fixture project: the
 * fixture's sqlite registry and LanceDB table live on the throw-away root
 * pinned by the `[test]` preload. No Ollama — `text` mode needs no vectors and
 * the reranker/MMR are explicitly off, so no wire call is ever made.
 */
const { randomUUID } = await import("node:crypto");
const db = await import("../src/services/db");
const CFG = (await import("../src/config")).CONFIG;
const { Registry: Registry2 } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { chunkCode } = await import("../src/chunking/chunker");
const { isolatedHome } = await import("./helpers/isolated-cidx-home");

describe("IndexManager writes the query log (real fixture)", () => {
  const HOME = isolatedHome;
  const PROJECT = mkdtempSync(join(tmpdir(), "cidx-querylog-proj-"));
  const DB_PATH = join(HOME, `querylog-${randomUUID()}.db`);
  const TABLE = "idx_querylog_fixture";

  const LIB = [
    "export function queryLogProbe(input: string): string {",
    "  return input.trim();",
    "}",
  ].join("\n");

  const TXT = { mode: "text" as const, rerank: false, mmr: false };

  let registry: InstanceType<typeof Registry2>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(HOME)).toBe(true);
    await db.initDB();
    mkdirSync(join(PROJECT, "src"), { recursive: true });
    writeFileSync(join(PROJECT, "src", "lib.ts"), LIB);

    registry = new Registry2(DB_PATH);
    registry.upsertIndex({
      name: "qlfix",
      path: PROJECT,
      tableName: TABLE,
      status: "ready",
      fileCount: 1,
      chunkCount: 1,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });
    registry.setFileMtime("qlfix", join(PROJECT, "src", "lib.ts"), 1);

    const abs = join(PROJECT, "src", "lib.ts");
    const chunks = await chunkCode(abs, LIB);
    await db.insertChunks(
      TABLE,
      chunks.map((c, i) => ({
        id: `lib.ts#${i}`,
        filePath: abs,
        content: c.content,
        vector: [0.1, 0.2, 0.3],
        language: c.language ?? null,
        symbolName: c.symbolName ?? null,
        symbolType: c.symbolType ?? null,
        startLine: c.startLine,
        endLine: c.endLine,
        doc: null,
        doc_vector: null,
        id_terms: null,
      })),
    );
    // The BM25 index is what serves text mode; build it eagerly so the
    // "queryLogProbe" query really hits (the assertions below stay valid even
    // if it didn't — they compare against the observed result count).
    try {
      await db.ensureFtsIndex(TABLE);
    } catch {
      /* FTS is optional for these assertions */
    }
    manager = new IndexManager(registry, new JobQueue());
  });

  afterAll(() => {
    manager?.stopAll?.();
    registry?.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("every searchIndex call writes exactly one row (per query, trimmed)", async () => {
    const { results } = await manager.searchIndex("qlfix", "queryLogProbe", 5, TXT);
    await manager.searchIndex("qlfix", "queryLogProbe", 5, TXT);
    await manager.searchIndex("qlfix", "  queryLogProbe  ", 5, TXT); // same query, whitespace
    await manager.searchIndex("qlfix", "zMkq NoMatchToken anywhere", 5, TXT);

    const stats = manager.queryLogStats();
    expect(stats.total).toBe(4); // 4 calls → 4 rows (not more, not less)
    expect(stats.topQueries).toHaveLength(2);
    expect(stats.topQueries[0]!.query).toBe("queryLogProbe"); // trimmed
    expect(stats.topQueries[0]!.count).toBe(3);
    // Whitespace variants collapse into ONE logical query:
    expect(stats.topQueries[1]!.query).toBe("zMkq NoMatchToken anywhere");
    // avg result count mirrors what the searches actually returned:
    expect(stats.topQueries[0]!.avgResultCount).toBe(results.length);
    // 4 rows over 2 distinct queries → exactly half the searches were repeats:
    expect(stats.repeatRate).toBe(0.5);
    // The miss is the index-gap signal:
    expect(stats.zeroHit.map((z) => z.query)).toContain("zMkq NoMatchToken anywhere");
  });

  test("cross-project (searchAll) rows are logged without a project", async () => {
    const scopedBefore = manager.queryLogStats({ project: "qlfix" }).total;
    const globalBefore = manager.queryLogStats().total;
    await manager.searchAll("queryLogProbe", 5, TXT);
    expect(manager.queryLogStats().total).toBe(globalBefore + 1);
    expect(manager.queryLogStats({ project: "qlfix" }).total).toBe(scopedBefore);
    // A searchAll against an empty daemon is still one completed search (and
    // likewise never names a project):
    await manager.searchAll("anything at all", 5, TXT);
    expect(manager.queryLogStats({ project: "qlfix" }).total).toBe(scopedBefore);
  });

  test("searchBatch logs per DISTINCT query — no double logging", async () => {
    const before = manager.queryLogStats().total;
    const groups = await manager.searchBatch(
      ["zzzFirstMissing one", "zzzFirstMissing one", "zzzSecondMissing two"],
      "qlfix",
      5,
      TXT,
    );
    expect(groups).toHaveLength(2); // de-duped
    const after = manager.queryLogStats();
    expect(after.total).toBe(before + 2); // 3 queries → 2 rows
    const zeroQ = after.zeroHit.map((z) => z.query);
    expect(zeroQ).toContain("zzzFirstMissing one");
    expect(zeroQ).toContain("zzzSecondMissing two");
  });

  test("logged rows carry the mode/latency/project columns as written", () => {
    const read = new Database(DB_PATH);
    try {
      const rows = read
        .query("SELECT project, mode, latency_ms FROM query_log ORDER BY id ASC")
        .all() as { project: string | null; mode: string; latency_ms: number }[];
      expect(rows.length).toBeGreaterThanOrEqual(7);
      for (const r of rows) {
        expect(r.mode).toBe("text");
        expect(r.latency_ms).toBeGreaterThanOrEqual(0);
      }
      // searchIndex rows name the project; searchAll / zero-index rows do not.
      expect(rows.some((r) => r.project === "qlfix")).toBe(true);
      expect(rows.some((r) => r.project === null)).toBe(true);
    } finally {
      read.close();
    }
  });

  test("the stats engine stays a pass-through for caps and unknown projects", async () => {
    const capped = manager.queryLogStats({ project: "qlfix", topQueries: 1, zeroHitTop: 1 });
    expect(capped.topQueries).toHaveLength(1);
    const unknown = manager.queryLogStats({ project: "no-such-project" });
    expect(unknown.total).toBe(0);
    expect(unknown.topQueries).toEqual([]);
  });
});