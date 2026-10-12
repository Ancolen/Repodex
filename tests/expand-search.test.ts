/**
 * Query expansion (proposal S4) — the IndexManager orchestration over a REAL
 * fixture table (the throw-away `[test]` data root, same recipe as
 * tests/querylog.test.ts and tests/search-payload.test.ts).
 *
 * `text` mode + rerank/MMR/boost off → the search core never needs an embedding
 * backend; the ONE wire call an expanded search makes (the expansion generate)
 * is intercepted by a fake fetch pinned to the Ollama backend URL, so every
 * scenario here is fully deterministic and offline:
 *
 * - the merge: the original query's ranking (lists[0], weight 1) keeps rank
 *   dominance; variant rankings (0.5) only corroborate or fill in;
 * - the degrade contract: ANY expansion failure (no model configured, backend
 *   down, malformed response, no usable variants) returns the plain base
 *   search unchanged, with the reason on the envelope (`expanded` 0 +
 *   `expandNote`);
 * - the query-log invariant: exactly ONE row per expanded search — the variant
 *   searches are internal and never log;
 * - the no-expand path: zero wire calls, byte-identical envelope shape.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const db = await import("../src/services/db");
const CFG = (await import("../src/config")).CONFIG;
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { chunkCode } = await import("../src/chunking/chunker");
const { isolatedHome } = await import("./helpers/isolated-cidx-home");
const { setEmbedBackend, resetEmbedBackend } = await import("../src/services/embed");
const { setExpandConfig } = await import("../src/services/expand");

describe("IndexManager expansion (real fixture, fake wire)", () => {
  const HOME = isolatedHome;
  const PROJECT = mkdtempSync(join(tmpdir(), "cidx-expand-proj-"));
  const DB_PATH = join(HOME, `expand-${randomUUID()}.db`);
  const TABLE = "idx_expand_fixture";

  // Three widgets, one file: the original query hits A, the two variants hit B
  // and C — every scenario's merge is fully observable in the result order.
  const LIB = [
    "export function alphaWidgetProbe(input: string): string {",
    "  return input.trim();",
    "}",
    "",
    "export function betaWidgetProbe(input: number): number {",
    "  return input + 1;",
    "}",
    "",
    "export function gammaWidgetSweep(input: boolean): boolean {",
    "  return !input;",
    "}",
  ].join("\n");

  const TXT = { mode: "text", rerank: false, mmr: false, boost: false } as const;
  const EXPAND = { ...TXT, expand: true } as const;

  let registry: InstanceType<typeof Registry>;
  let manager: InstanceType<typeof IndexManager>;

  // ---- fake wire -----------------------------------------------------------
  type Responder = (prompt: string) => string;
  let respond: Responder = () => '{"variants":[]}';
  let wire: { url: string; body: any }[] = [];
  let realFetch: typeof fetch | null = null;

  function installFetch(responder: Responder): void {
    respond = responder;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(init.body) : {};
      wire.push({ url, body });
      if (!url.endsWith("/api/generate")) throw new Error(`unexpected fetch target: ${url}`);
      return new Response(JSON.stringify({ response: respond(body.prompt ?? "") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }
  function restoreFetch(): void {
    if (realFetch) {
      globalThis.fetch = realFetch;
      realFetch = null;
    }
    wire = [];
  }

  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(HOME)).toBe(true);
    await db.initDB();
    mkdirSync(join(PROJECT, "src"), { recursive: true });
    writeFileSync(join(PROJECT, "src", "widgets.ts"), LIB);

    registry = new Registry(DB_PATH);
    registry.upsertIndex({
      name: "expfix",
      path: PROJECT,
      tableName: TABLE,
      status: "ready",
      fileCount: 1,
      chunkCount: 3,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });

    const abs = join(PROJECT, "src", "widgets.ts");
    const chunks = await chunkCode(abs, LIB);
    expect(chunks.length).toBe(3);
    await db.insertChunks(
      TABLE,
      chunks.map((c, i) => ({
        id: `widgets.ts#${i}`,
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
    await db.ensureFtsIndex(TABLE);

    manager = new IndexManager(registry, new JobQueue());
    // The expansion call resolves the embedding backend for its URL — pin it
    // so nothing probes live servers, and pin the client config (tests never
    // edit CONFIG).
    setEmbedBackend({ provider: "ollama", url: CFG.OLLAMA_URL, reason: "explicit" });
    setExpandConfig({ model: "test-expander", url: "", maxVariants: 3, timeoutMs: 1000 });
  });

  afterAll(() => {
    setExpandConfig(null);
    resetEmbedBackend();
    manager?.stopAll?.();
    registry?.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB_PATH}${suffix}`, { force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  beforeEach(() => {
    wire = [];
  });
  afterEach(restoreFetch);

  test("expanded search merges the variant ranking; the original query keeps rank dominance", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe"]}');
    const env = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, EXPAND);
    expect(env.expanded).toBe(1);
    expect(env.expandNote).toBeUndefined();
    const contents = env.results.map((r) => r.content);
    // Original rank-1 (weight 1 = 1/61) stays above the variant's rank-1
    // (weight 0.5 = 0.5/61) — the merge math, observable.
    expect(contents[0]).toContain("alphaWidgetProbe");
    expect(contents[1]).toContain("betaWidgetProbe");
    // The wire saw exactly ONE expansion generate call (variants are ONE call).
    expect(wire).toHaveLength(1);
    expect(wire[0]!.body.prompt).toContain("Query: alphaWidgetProbe");
  });

  test("dup-of-original variant is dropped and the cap (maxVariants) holds", async () => {
    installFetch(() =>
      JSON.stringify({
        variants: ["betaWidgetProbe", "gammaWidgetSweep", "alphaWidgetProbe", "deltaWidgetProbe", "alphaWidgetProbe"],
      }),
    );
    setExpandConfig({ model: "test-expander", url: "", maxVariants: 2, timeoutMs: 1000 });
    try {
      const env = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, EXPAND);
      expect(env.expanded).toBe(2); // cap 2; the alpha dup of the original never counts
      env.results.forEach((r) => {
        // the un-capped / un-generated variants never searched anything
        expect(r.content).not.toContain("deltaWidgetProbe");
      });
      expect(wire).toHaveLength(1);
    } finally {
      setExpandConfig({ model: "test-expander", url: "", maxVariants: 3, timeoutMs: 1000 });
    }
  });

  test("zero usable variants → note, base results unchanged", async () => {
    installFetch(() => '{"variants":[]}');
    const base = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, TXT);
    const expanded = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, EXPAND);
    expect(expanded.expanded).toBe(0);
    expect(expanded.expandNote ?? "").toContain("no usable variants");
    expect(JSON.stringify(expanded.results)).toBe(JSON.stringify(base.results));
  });

  test("malformed model output degrades transparently (no JSON → note + base results)", async () => {
    installFetch(() => "I would rather not answer in JSON today.");
    const base = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, TXT);
    const expanded = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, EXPAND);
    expect(expanded.expanded).toBe(0);
    expect(expanded.expandNote ?? "").toContain("no JSON object");
    expect(JSON.stringify(expanded.results)).toBe(JSON.stringify(base.results));
    // The base ranking was REUSED, not re-searched: only the one generate call.
    expect(wire).toHaveLength(1);
  });

  test("no configured model degrades with the note before ANY wire call", async () => {
    setExpandConfig({ model: "", url: "", maxVariants: 3, timeoutMs: 100 });
    try {
      installFetch(() => {
        throw new Error("must not be called");
      });
      const base = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, TXT);
      const expanded = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, EXPAND);
      expect(expanded.expanded).toBe(0);
      expect(expanded.expandNote ?? "").toContain("no expansion model is configured");
      expect(JSON.stringify(expanded.results)).toBe(JSON.stringify(base.results));
      expect(wire).toHaveLength(0);
    } finally {
      setExpandConfig({ model: "test-expander", url: "", maxVariants: 3, timeoutMs: 1000 });
    }
  });

  test("variant searches never write query-log rows; the caller's query logs exactly once", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe","gammaWidgetSweep"]}');
    const before = manager.queryLogStats().total;
    await manager.searchIndex("expfix", "  alphaWidgetProbe  ", 5, EXPAND);
    const stats = manager.queryLogStats();
    expect(stats.total).toBe(before + 1); // ONE row: the original, never the variants
    const row = stats.topQueries.find((t) => t.query === "alphaWidgetProbe");
    expect(row).toBeDefined();
    for (const t of stats.topQueries) {
      expect(t.query).not.toContain("betaWidgetProbe");
      expect(t.query).not.toContain("gammaWidgetSweep");
    }
  });

  test("three variants corroborate: every widget surfaces in the merged ranking", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe","gammaWidgetSweepbetaWidgetProbe","another betaWidgetProbe variant"]}');
    setExpandConfig({ model: "test-expander", url: "", maxVariants: 3, timeoutMs: 1000 });
    try {
      const env = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, EXPAND);
      expect(env.expanded).toBe(3);
      const joined = env.results.map((r) => r.content).join("\n");
      expect(joined).toContain("alphaWidgetProbe"); // the original still shows
      expect(env.results.length).toBeGreaterThan(1);
    } finally {
      setExpandConfig({ model: "test-expander", url: "", maxVariants: 3, timeoutMs: 1000 });
    }
  });

  test("cross-project expansion merges per-variant rankings under the same rules", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe","gammaWidgetSweep"]}');
    const env = await manager.searchAll("alphaWidgetProbe", 5, EXPAND);
    expect(env.expanded).toBe(2);
    expect(env.expandNote).toBeUndefined();
    const joined = env.results.map((r) => r.content).join("\n");
    expect(joined).toContain("alphaWidgetProbe");
    expect(joined).toContain("betaWidgetProbe");
    expect(joined).toContain("gammaWidgetSweep");
    // The cross-project merge also dedups by (project, row id): three sources,
    // three unique results (the original's own hits were part of each list).
    expect(env.results).toHaveLength(3);
  });

  test("degenerate base (no hits) plus variants still returns a merged list", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe"]}');
    const base = await manager.searchIndex("expfix", "zzzNoTokensMatchThis", 5, TXT);
    expect(base.results).toEqual([]);
    const env = await manager.searchIndex("expfix", "zzzNoTokensMatchThis", 5, EXPAND);
    expect(env.expanded).toBe(1);
    expect(env.results.length).toBeGreaterThan(0); // the variant rescued the search
    expect(env.results[0]!.content).toContain("betaWidgetProbe");
  });

  test("searchBatch inherits expand; each group carries its own envelope fields", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe"]}');
    const before = manager.queryLogStats().total;
    const groups = await manager.searchBatch(["alphaWidgetProbe", "alphaWidgetProbe"], "expfix", 5, EXPAND);
    expect(groups).toHaveLength(1); // de-duped
    expect(groups[0]!.expanded).toBe(1);
    expect(groups[0]!.expandNote).toBeUndefined();
    expect(manager.queryLogStats().total).toBe(before + 1); // one row per DISTINCT query
  });

  test("blame and expansion notes ride the same envelope", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe"]}');
    const env = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, { ...TXT, blame: true, expand: true });
    expect(env.blameNotARepo).toBe(true); // the tmpdir fixture is no git repo
    expect(env.expanded).toBe(1);
  });

  test("maxChars budgets the MERGED list (top-1 kept)", async () => {
    installFetch(() => '{"variants":["betaWidgetProbe","gammaWidgetSweep"]}');
    const env = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, { ...EXPAND, maxChars: 1 });
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.content).toContain("alphaWidgetProbe");
  });

  test("the no-expand path makes zero wire calls and carries no expansion fields", async () => {
    installFetch(() => {
      throw new Error("no expansion call expected");
    });
    const r1 = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, TXT);
    const r2 = await manager.searchIndex("expfix", "alphaWidgetProbe", 5, TXT);
    expect(wire).toHaveLength(0);
    expect(JSON.stringify(r2.results)).toBe(JSON.stringify(r1.results)); // deterministic
    expect(r1.expanded).toBeUndefined();
    expect(r1.expandNote).toBeUndefined();
  });
});