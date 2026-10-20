/**
 * Fuzzy symbol-name fallback of `find_symbol` (proposal S2).
 *
 * Mechanism (verified against the pinned `@lancedb/lancedb` 0.30.0, which is
 * why the design's trigram-column fallback was NOT needed): `symbolName` is
 * BM25-indexed with an n-gram (trigram) tokenizer, and the query side uses a
 * structured `MatchQuery` — a STRING query does not apply the column's n-gram
 * analyzer on 0.30.0 (verified: it returns nothing), while `MatchQuery`
 * tokenizes the query text with the same analyzer, so the typo `getUserNme`
 * and the real `getUserName` overlap on most trigrams and BM25 ranks the
 * intended symbol first. Pure BM25 — no embedding model anywhere in the path.
 *
 * Contracts under test:
 *  - exact/prefix stay byte-identical when they hit (the fallback runs only
 *    on a strict miss, and `fuzzy: false` restores the pre-S2 shape);
 *  - every fallback hit carries `fuzzy: true` and respects `limit`;
 *  - results are ordered by BM25 relevance (non-increasing `_score`);
 *  - tables without the n-gram symbol FTS index never fuzzy (their next
 *    index job builds it — no crash, just an honest empty tier).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const { randomUUID } = await import("node:crypto");
const db = await import("../src/services/db");
const CFG = (await import("../src/config")).CONFIG;
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { isolatedHome } = await import("./helpers/isolated-cidx-home");
import type { CodeRecord } from "../src/services/db";

/** Symbols of the main fixture: camelCase, snake_case and a compound one. */
const SYMBOLS: [string, string][] = [
  ["getUserName", "export function getUserName(session: Session): string { return session.name; }"],
  ["getUserEmail", "export function getUserEmail(session: Session): string { return session.email; }"],
  ["get_user_name", "def get_user_name(session): return session.name"],
  ["refreshCache", "export function refreshCache(store: Store) { store.flush(); }"],
  ["buildIndex", "function buildIndex(rows: Row[]): Index { return {}; }"],
  ["IndexManager", "export class IndexManager { }"],
  ["parseJSONString", "export function parseJSONString(raw: string) { return {}; }"],
  ["searchTableText", "export async function searchTableText(table: string, q: string) { return []; }"],
];

const row = (symbol: string, file: string, i: number): CodeRecord => ({
  id: `${file}#${i}`,
  filePath: `/p/${file}.ts`,
  content: `export function ${symbol}(session: Session) { return session; }`,
  vector: [0.1, 0.2, 0.3],
  language: "typescript",
  symbolName: symbol,
  symbolType: symbol === "IndexManager" ? "class" : "function",
  startLine: 1,
  endLine: 1,
  doc: null,
  doc_vector: null,
  id_terms: null,
});

const MAIN_TABLE = "idx_fuzzy_main";
const LEGACY_TABLE = "idx_fuzzy_legacy";
/** A second legacy-era table used to prove the enable-by-index-job path. */
const UPGRADE_TABLE = "idx_fuzzy_upgrade";
/** A table holding TWO chunks of one split symbol (find_symbol dedupe). */
const SPLIT_TABLE = "idx_fuzzy_split";

/** Legacy-era disjoint symbols: no trigram overlap with the typo queries below. */
const LEGACY_SYMBOLS: [string, string][] = [
  ["legacyOnlySymbol", "export function legacyOnlySymbol(a: number): number { return a; }"],
  ["payloadHelper", "export function payloadHelper(v: string): string { return v; }"],
];

describe("hasNgramTokens — the query-side gate (pure)", () => {
  test("names with a ≥3-char word can produce trigrams", () => {
    expect(db.hasNgramTokens("getUserName")).toBe(true);
    expect(db.hasNgramTokens("get_user_name")).toBe(true); // splits on `_` → 3 words
    expect(db.hasNgramTokens("fs.readFile")).toBe(true);
    expect(db.hasNgramTokens("md5hash")).toBe(true);
    expect(db.hasNgramTokens("получитьПользователя")).toBe(true);
    expect(db.hasNgramTokens("ab cde")).toBe(true);
  });

  test("a name of nothing shorter than 3 chars yields no tokens", () => {
    expect(db.hasNgramTokens("")).toBe(false);
    expect(db.hasNgramTokens("ab")).toBe(false);
    expect(db.hasNgramTokens("x.y")).toBe(false); // separators split, parts stay short
    expect(db.hasNgramTokens("us er")).toBe(false);
    expect(db.hasNgramTokens("---")).toBe(false);
    expect(db.hasNgramTokens("a_b")).toBe(false);
  });

  test("the n-gram size constant matches the index configuration", () => {
    expect(db.SYMBOL_NGRAM_SIZE).toBe(3);
  });
});

describe("fuzzy symbol leg (db level, real LanceDB table)", () => {
  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(isolatedHome)).toBe(true);
    await db.initDB();
    await db.insertChunks(
      MAIN_TABLE,
      SYMBOLS.map(([symbol, content], i) => ({ ...row(symbol, symbol, i), content })),
    );
    await db.ensureFtsIndex(MAIN_TABLE);
  });

  test("a typo ranks the intended symbol first, by descending BM25", async () => {
    const hits = await db.searchSymbolFuzzy(MAIN_TABLE, "getUserNme", 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.symbolName).toBe("getUserName");
    const scores = hits.map((h) => h._score ?? Number.NEGATIVE_INFINITY);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
    // The runner-up set is the trigram-overlap neighborhood, not noise.
    expect(hits.map((h) => h.symbolName)).toContain("getUserEmail");
  });

  test("the query side is case-insensitive (analyzer lowercases both sides)", async () => {
    const hits = await db.searchSymbolFuzzy(MAIN_TABLE, "GETUSERNME", 20);
    expect(hits[0]!.symbolName).toBe("getUserName");
  });

  test("another class typo finds its symbol", async () => {
    const hits = await db.searchSymbolFuzzy(MAIN_TABLE, "IdexManagr", 20);
    expect(hits[0]!.symbolName).toBe("IndexManager");
  });

  test("a token-less query resolves to nothing (gate, no FTS error)", async () => {
    expect(await db.searchSymbolFuzzy(MAIN_TABLE, "ab", 20)).toEqual([]);
    expect(await db.searchSymbolFuzzy(MAIN_TABLE, "", 20)).toEqual([]);
  });

  test("`limit` caps the hits", async () => {
    const hits = await db.searchSymbolFuzzy(MAIN_TABLE, "getUserNme", 2);
    expect(hits.length).toBe(2);
  });

  test("metadata filters compose with the fuzzy query", async () => {
    // IndexManager is the fixture's only class.
    const hits = await db.searchSymbolFuzzy(MAIN_TABLE, "IdexManagr", 20, "symbolType = 'class'");
    expect(hits.map((r) => r.symbolName)).toEqual(["IndexManager"]);
    // A filter no fixture row satisfies empties the tier (composed, not ignored —
    // note the function-typed `buildIndex` DOES share the weak trigram "dex").
    expect(await db.searchSymbolFuzzy(MAIN_TABLE, "IdexManagr", 20, "symbolType = 'method'")).toEqual([]);
  });
});

describe("legacy table — no n-gram symbol index, no fuzzy (db level)", () => {
  beforeAll(async () => {
    await db.insertChunks(
      LEGACY_TABLE,
      LEGACY_SYMBOLS.map(([symbol, content], i) => ({ ...row(symbol, symbol, i), content })),
    );
    // Deliberately NO ensureFtsIndex: models a table from before the symbol leg.
  });

  test("no fuzzy, no crash — and exact/prefix still work without any FTS", async () => {
    expect(await db.searchSymbolFuzzy(LEGACY_TABLE, "legacyOnlySymbl", 20)).toEqual([]);
    const strict = await db.searchSymbol(LEGACY_TABLE, "legacyOnlySymbol", 20);
    expect(strict.map((r) => r.symbolName)).toEqual(["legacyOnlySymbol"]);
    // …and even a query whose tokens would overlap, on a table that simply
    // has no symbol FTS index, stays honestly empty.
    expect(await db.searchSymbolFuzzy(LEGACY_TABLE, "payloadHelperx", 20)).toEqual([]);
  });

  test("the next index job builds the leg — reindex enables fuzzy", async () => {
    await db.insertChunks(
      UPGRADE_TABLE,
      LEGACY_SYMBOLS.map(([symbol, content], i) => ({ ...row(symbol, symbol, i), content })),
    );
    expect(await db.searchSymbolFuzzy(UPGRADE_TABLE, "legacyOnlySymbl", 20)).toEqual([]);
    expect(await db.ensureFtsIndex(UPGRADE_TABLE)).toBe(4);
    const hits = await db.searchSymbolFuzzy(UPGRADE_TABLE, "legacyOnlySymbl", 20);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.symbolName).toBe("legacyOnlySymbol");
    // A second run builds nothing (already indexed).
    expect(await db.ensureFtsIndex(UPGRADE_TABLE)).toBe(0);
  });
});

describe("find_symbol fuzzy fallback (IndexManager, two registered projects)", () => {
  const HOME = isolatedHome;
  const PROJECT = mkdtempSync(path.join(os.tmpdir(), "cidx-fuzzy-proj-"));
  const DB_PATH = path.join(HOME, `fuzzy-${randomUUID()}.db`);

  let registry: InstanceType<typeof Registry>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    registry = new Registry(DB_PATH);
    await db.insertChunks(SPLIT_TABLE, [
      {
        ...row("bigSymbol", "split", 0),
        content: "export function bigSymbol() {\n  const a = 1;",
        startLine: 1,
        endLine: 20,
      },
      {
        ...row("bigSymbol", "split", 1),
        content: "  return a;\n}",
        startLine: 15,
        endLine: 30,
      },
    ]);
    registry.upsertIndex({
      name: "fzsplit",
      path: path.join(PROJECT, "split"),
      tableName: SPLIT_TABLE,
      status: "ready",
      fileCount: 1,
      chunkCount: 2,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });
    registry.upsertIndex({
      name: "fzfix",
      path: PROJECT,
      tableName: MAIN_TABLE,
      status: "ready",
      fileCount: SYMBOLS.length,
      chunkCount: SYMBOLS.length,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });
    registry.upsertIndex({
      name: "fzlegacy",
      path: path.join(PROJECT, "legacy"),
      tableName: LEGACY_TABLE,
      status: "ready",
      fileCount: LEGACY_SYMBOLS.length,
      chunkCount: LEGACY_SYMBOLS.length,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });
    manager = new IndexManager(registry, new JobQueue());
  });

  afterAll(() => {
    manager?.stopAll?.();
    registry?.close();
    rmSync(DB_PATH, { force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("typo → the intended symbol, every hit fuzzy-marked, payload stripped", async () => {
    const hits = await manager.findSymbol("getUserNme", "fzfix");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.symbolName).toBe("getUserName");
    for (const r of hits) {
      expect(r.fuzzy).toBe(true);
      expect("vector" in r).toBe(false);
      expect("doc_vector" in r).toBe(false);
      expect(typeof r.content).toBe("string");
      expect(r.project).toBe("fzfix");
    }
  });

  test("cross-project call: only the table with the leg yields fuzzy hits", async () => {
    const hits = await manager.findSymbol("getUserNme");
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) expect(r.fuzzy).toBe(true);
    expect(hits.map((r) => r.project)).not.toContain("fzlegacy");
  });

  test("a pre-S2 table stays strict — empty, never a crash", async () => {
    expect(await manager.findSymbol("legacyOnlySymbl", "fzlegacy")).toEqual([]);
    const exact = await manager.findSymbol("legacyOnlySymbol", "fzlegacy");
    expect(exact.map((r) => r.symbolName)).toEqual(["legacyOnlySymbol"]);
    for (const r of exact) expect("fuzzy" in r).toBe(false);
  });

  test("fuzzy: false restores the strict pre-S2 contract", async () => {
    expect(await manager.findSymbol("getUserNme", "fzfix", 20, undefined, { fuzzy: false })).toEqual([]);
  });

  test("exact/prefix hits are byte-identical with and without the tier enabled", async () => {
    for (const name of ["getUserName", "getUser", "get_user_name"]) {
      const def = await manager.findSymbol(name, "fzfix");
      const strict = await manager.findSymbol(name, "fzfix", 20, undefined, { fuzzy: false });
      expect(def).toEqual(strict);
      for (const r of def) {
        // A strict hit must never carry the marker — or any other new field.
        expect("fuzzy" in r).toBe(false);
      }
    }
  });

  test("a prefix hit is a strict hit (the fallback only answers misses)", async () => {
    const hits = await manager.findSymbol("getUser", "fzfix");
    expect(hits.map((r) => r.symbolName)).toEqual(["getUserName", "getUserEmail"]);
    for (const r of hits) expect("fuzzy" in r).toBe(false);
  });

  test("`limit` also caps fuzzy hits", async () => {
    const hits = await manager.findSymbol("getUserNme", "fzfix", 2);
    expect(hits.length).toBe(2);
    for (const r of hits) expect(r.fuzzy).toBe(true);
  });

  test("a split symbol reports ONE head chunk (no continuation duplicates)", async () => {
    // Regression: both chunks carry symbolName "bigSymbol"; the continuation's
    // derived signature was the middle of the body (`"} } // 2) MMR …"`).
    const hits = await manager.findSymbol("bigSymbol", "fzsplit");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.startLine).toBe(1);
    expect(hits[0]!.signature).toBe("export function bigSymbol()");
  });
});