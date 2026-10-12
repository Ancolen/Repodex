/**
 * Path/surface boost (proposal S3) — pure signal tests + the IndexManager
 * wiring.
 *
 * Pure part: every boost signal is a small multiplicative factor derived from
 * the project-relative path alone, so each one is tested in isolation (neutral
 * weights for the others) plus the all-defaults product. `applyPathBoost`
 * itself is tested against the two load-bearing invariants: only RRF-merged
 * (`_score`) lists are re-scored, and the disabled / single-leg paths return
 * the input byte-identical (same array reference, same values).
 *
 * Manager part: a real LanceDB fixture (two files — `src/util.ts` and
 * `build/gen.ts` — with identical RRF-reachable ranks) proves the call sites:
 * hybrid-style RRF ordering flips only when both hits carry equal RRF scores,
 * the per-call `boost: false` opt-out restores the raw order, and single-leg
 * (`doc: false`) results are untouched. No embedding backend: `text` mode
 * needs no query vector. The manager-level wiring tests are at the end of this
 * file (search-payload.test.ts pattern).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyPathBoost,
  pathBoostFactor,
  relativeToProject,
  underSourceRoot,
  isGeneratedPath,
  BOOST_PATH_NORM_CHARS,
  type PathBoostConfig,
} from "../src/utils/boost";
import { isTestFile } from "../src/core/filekinds";

/** The production defaults, as one call-site cfg. */
const CFG = (over: Partial<PathBoostConfig> = {}): PathBoostConfig => ({
  enabled: true,
  shortPath: 0.1,
  sourceRoot: 0.05,
  testDemotion: 0.85,
  generatedDemotion: 0.8,
  sourceRoots: ["src", "lib", "app"],
  ...over,
});

/** All signals off but the one under test: 1 + 0 for boosts, 1 for demotions. */
const only = (sig: Partial<PathBoostConfig>): PathBoostConfig =>
  CFG({ shortPath: 0, sourceRoot: 0, testDemotion: 1, generatedDemotion: 1, sourceRoots: [], ...sig });

describe("pathBoostFactor — shortPath signal", () => {
  const logBonus = (len: number, weight: number) => 1 + weight * (1 - Math.log1p(len) / Math.log1p(BOOST_PATH_NORM_CHARS));

  test("shorter paths score strictly higher; the bonus fades with log(length)", () => {
    const a = pathBoostFactor("a.ts", only({ shortPath: 0.1 }));
    const b = pathBoostFactor("src/one/deep/file.ts", only({ shortPath: 0.1 }));
    const long160 = pathBoostFactor(`${"x/".repeat(79)}f.ts`, only({ shortPath: 0.1 }));
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(long160);
    expect(a).toBeCloseTo(logBonus("a.ts".length, 0.1), 12);
  });

  test("a path at the normalization reference gets no shortPath bonus at all", () => {
    expect(BOOST_PATH_NORM_CHARS).toBe(160);
    const long = "d".repeat(BOOST_PATH_NORM_CHARS);
    expect(pathBoostFactor(long, only({ shortPath: 0.1 }))).toBe(1);
    // Beyond the reference it must not turn into a penalty either.
    expect(pathBoostFactor(long + "/x.ts", only({ shortPath: 0.1 }))).toBe(1);
  });

  test("the bonus never exceeds the configured weight (shortest path)", () => {
    const f = pathBoostFactor("a.ts", only({ shortPath: 0.1 }));
    expect(f).toBeGreaterThan(1);
    expect(f).toBeLessThan(1 + 0.1);
  });

  test("weight 0 keeps the factor at exactly 1", () => {
    expect(pathBoostFactor("src/deep/nest.ts", only({ shortPath: 0 }))).toBe(1);
  });
});

describe("pathBoostFactor — sourceRoot signal", () => {
  const cfg = only({ sourceRoot: 0.05, sourceRoots: ["src", "lib", "app"] });

  test("paths under a conventional source root get the bonus (whole-segment match)", () => {
    for (const p of ["src/util.ts", "lib/j.ts", "app/m.ts", "src/one/level/under.ts"]) {
      expect(pathBoostFactor(p, cfg)).toBe(1.05);
    }
  });

  test("prefix look-alikes do NOT match — root, not substring", () => {
    for (const p of ["src.ts", "src-a/b.ts", "scripts/src.ts", "docs/overview.md", "asrc/a.ts"]) {
      expect(pathBoostFactor(p, cfg)).toBe(1);
    }
  });

  test("segment rules are separator-aware (Windows-style paths)", () => {
    expect(pathBoostFactor("lib\\j.ts", cfg)).toBe(1.05);
    expect(underSourceRoot("nested\\src\\a.ts", ["src"])).toBe(false);
  });

  test("an explicit ./ root and trailing/mixed slashes are tolerated in the config", () => {
    expect(underSourceRoot("src/a.ts", ["./src/", "\\src"])).toBe(true);
    expect(underSourceRoot("src/a.ts", ["/", ""])).toBe(false);
  });
});

describe("pathBoostFactor — test demotion (shared filekinds patterns)", () => {
  const cfg = only({ testDemotion: 0.85 });

  test("demotes every isTestFile shape, and nothing else", () => {
    for (const p of ["tests/util.test.ts", "test_main.py", "foo_test.go", "__tests__/a.ts", "spec/client.spec.ts"]) {
      expect(isTestFile(p)).toBe(true);
      expect(pathBoostFactor(p, cfg)).toBe(0.85);
    }
    for (const p of ["src/util.ts", "contest.ts", "src/latest.ts"]) {
      expect(isTestFile(p)).toBe(false);
      expect(pathBoostFactor(p, cfg)).toBe(1);
    }
  });

  test("no separate pattern fork: boost delegates to src/core/filekinds.isTestFile", () => {
    // Spot-check a pattern that only the shared helper knows (tests/ dir rule).
    expect(pathBoostFactor("tests/helpers/isolated-cidx-home.ts", CFG())).toBeLessThan(1);
  });
});

describe("pathBoostFactor — generated/artifact demotion", () => {
  const cfg = only({ generatedDemotion: 0.8 });

  test("demotes generated directories as whole segments", () => {
    for (const p of ["build/out.js", "gen/x.ts", "dist/bundle.js", "vendor/lib.js", "node_modules/pkg/index.js"]) {
      expect(isGeneratedPath(p)).toBe(true);
      expect(pathBoostFactor(p, cfg)).toBe(0.8);
    }
  });

  test("demotes generated file suffixes (.pb.go, .min.<ext>)", () => {
    for (const p of ["src/contract.pb.go", "static/app.min.js", "static/app.min.mjs"]) {
      expect(isGeneratedPath(p)).toBe(true);
      expect(pathBoostFactor(p, cfg)).toBe(0.8);
    }
  });

  test("look-alikes are not penalized (segment boundary + suffix anchoring)", () => {
    for (const p of ["src/builder.ts", "builder/thing.ts", "src/builddir/x.ts", "src/gen.ts", "src/gen.tsx", "app/vendorish.ts", "src/mini.ts"]) {
      expect(isGeneratedPath(p)).toBe(false);
      expect(pathBoostFactor(p, cfg)).toBe(1);
    }
  });
});

describe("pathBoostFactor — signals multiply", () => {
  test("test file inside a generated directory is demoted once per signal", () => {
    expect(pathBoostFactor("tests/gen/foo_test.go", only({ testDemotion: 0.85, generatedDemotion: 0.8 }))).toBeCloseTo(0.68, 12);
  });

  test("production defaults: a src hit gets shortPath × sourceRoot, a test hit keeps its demotion", () => {
    const src = pathBoostFactor("src/util.ts", CFG());
    expect(src).toBeCloseTo((1 + 0.1 * (1 - Math.log1p("src/util.ts".length) / Math.log1p(160))) * 1.05, 12);
    const test = pathBoostFactor("tests/probe.test.ts", CFG());
    expect(test).toBeCloseTo((1 + 0.1 * (1 - Math.log1p("tests/probe.test.ts".length) / Math.log1p(160))) * 0.85, 12);
    expect(test).toBeLessThan(1.02);
    // A deep hit keeps the source-root bonus but loses most of the shortPath part.
    const deep = pathBoostFactor("src/a/b/c/d/e/f/g/h/deep.ts", CFG());
    expect(deep).toBeLessThan(src);
    expect(deep).toBeGreaterThan(1.05);
  });
});

describe("relativeToProject", () => {
  test("strips the project root", () => {
    expect(relativeToProject("/p/src/util.ts", "/p")).toBe("src/util.ts");
    expect(relativeToProject("/p/src/util.ts", "/p/")).toBe("src/util.ts");
    expect(relativeToProject("/p/src/util.ts", "/p//")).toBe("src/util.ts");
  });

  test("no root / outside root → the path as-is (signals still match segments)", () => {
    expect(relativeToProject("/p/src/util.ts", undefined)).toBe("/p/src/util.ts");
    expect(relativeToProject("/q/src/util.ts", "/p")).toBe("/q/src/util.ts");
    expect(relativeToProject("src/util.ts", "/p")).toBe("src/util.ts");
  });

  test("a root that is only a prefix of a path is not stripped", () => {
    expect(relativeToProject("/project/src/util.ts", "/proj")).toBe("/project/src/util.ts");
    expect(relativeToProject("/project/src/util.ts", "/project")).toBe("src/util.ts");
  });

  test("backslash normalization", () => {
    expect(relativeToProject("C:\\p\\src\\util.ts", "C:/p")).toBe("src/util.ts");
  });
});

describe("applyPathBoost — RRF lists", () => {
  const build = { id: "a", filePath: "/p/build/gen.ts", _score: 1 / 60 + 1 / 61 };
  const src = { id: "b", filePath: "/p/src/util.ts", _score: 1 / 60 + 1 / 61 };

  test("equal-RRF hits: a build/ hit and a src/ hit FLIP in favor of src/", () => {
    const results = [build, src];
    const boosted = applyPathBoost(results, CFG(), "/p");
    expect(boosted.map((r) => r.id)).toEqual(["b", "a"]);
    expect(boosted[0]!._score).toBeGreaterThan(boosted[1]!._score);
    // Inputs untouched (rows are shallow copies; the originals keep raw scores).
    expect(build._score).toBeCloseTo(1 / 60 + 1 / 61, 12);
    expect(src._score).toBeCloseTo(1 / 60 + 1 / 61, 12);
    expect(boosted[0]).not.toBe(src);
  });

  test("the same flip does NOT happen when the RRF scores differ (boost nudges, never decides)", () => {
    const strongBuild = { id: "a", filePath: "/p/build/gen.ts", _score: 1 / 60 + 1 / 61 };
    const weakSrc = { id: "b", filePath: "/p/src/util.ts", _score: 0.005 };
    const boosted = applyPathBoost([strongBuild, weakSrc], CFG(), "/p");
    expect(boosted.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("per-signal factors land on the re-scored rows", () => {
    const boosted = applyPathBoost(
      [{ id: "a", filePath: "/p/build/gen.ts", _score: 0.02 }, { id: "b", filePath: "/p/src/util.ts", _score: 0.02 }],
      CFG(),
      "/p",
    );
    expect(boosted[0]!.id).toBe("b");
    expect(boosted[0]!._score).toBeCloseTo(0.02 * pathBoostFactor("src/util.ts", CFG()), 12);
    expect(boosted[1]!._score).toBeCloseTo(0.02 * pathBoostFactor("build/gen.ts", CFG()), 12);
  });

  test("stable ties: equal scores and equal factors keep their original order", () => {
    const rows = [
      { id: "x", filePath: "/p/src/a.ts", _score: 0.01 },
      { id: "y", filePath: "/p/src/b.ts", _score: 0.01 },
    ];
    expect(applyPathBoost(rows, CFG(), "/p").map((r) => r.id)).toEqual(["x", "y"]);
  });

  test("config disabled → the input is returned byte-identical (same reference)", () => {
    const results = [build, src];
    expect(applyPathBoost(results, CFG({ enabled: false }), "/p")).toBe(results);
    expect(applyPathBoost(results, { ...CFG(), enabled: false }, "/p").map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("empty list → the input reference", () => {
    const empty: { _score?: number }[] = [];
    expect(applyPathBoost(empty, CFG(), "/p")).toBe(empty);
  });
});

describe("applyPathBoost — single-leg and mixed lists are structurally untouched", () => {
  const vectorLeg = [
    { id: "a", filePath: "/p/build/gen.ts", _distance: 0.1 },
    { id: "b", filePath: "/p/src/util.ts", _distance: 0.2 },
  ];
  const textLeg = [
    { id: "a", filePath: "/p/build/gen.ts" },
    { id: "b", filePath: "/p/src/util.ts" },
  ];

  test("a _distance-only (vector) list keeps its rows, references and order — even with boost on", () => {
    const out = applyPathBoost(vectorLeg as { filePath: string; _distance: number; _score?: number }[], CFG(), "/p");
    expect(out).toBe(vectorLeg);
    expect(out[0]).toBe(vectorLeg[0]);
    expect(out[1]).toBe(vectorLeg[1]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]!._distance).toBe(0.1);
  });

  test("a metric-less list is returned as-is too", () => {
    expect(applyPathBoost(textLeg as { filePath: string; _score?: number }[], CFG(), "/p")).toBe(textLeg);
  });

  // NOTE on native single-leg text lists: the LanceDB text leg surfaces its
  // raw BM25 metric under the SAME `_score` field the RRF merge writes, so the
  // pure function (given rows that all carry `_score`) cannot tell provenance
  // — the native-vs-RRF gate lives in the caller (`searchOnTable` reports
  // `rrfMerged`; see the IndexManager wiring tests at the bottom of this file).

  test("a mixed list is treated as unboostable, not half-adjusted", () => {
    const mixed = [{ id: "a", filePath: "/p/build/gen.ts", _distance: 0.3 }, { id: "b", filePath: "/p/src/util.ts", _score: 0.02 }];
    const out = applyPathBoost(mixed as { filePath: string; _score?: number; _distance?: number }[], CFG(), "/p");
    expect(out).toBe(mixed);
    expect(out[1]!._score).toBe(0.02);
  });

  test("disabled → untouched regardless of shape", () => {
    const rrf = [{ id: "a", filePath: "/p/build/gen.ts", _score: 0.9 }, { id: "b", filePath: "/p/src/util.ts", _score: 0.8 }];
    const off = CFG({ enabled: false });
    expect(applyPathBoost(rrf, off, "/p")).toBe(rrf);
    expect(applyPathBoost(vectorLeg as { filePath: string; _score?: number; _distance?: number }[], off, "/p")).toBe(vectorLeg);
  });
});

describe("applyPathBoost — project-relative path resolution", () => {
  test("with a project root the signals are project-relative", () => {
    const rows = [{ id: "a", filePath: "/p/src/a.ts", _score: 1 }];
    const [row] = applyPathBoost(rows, only({ sourceRoot: 0.05, sourceRoots: ["src"] }), "/p");
    expect(row?._score).toBeCloseTo(1.05, 12);
  });

  test("without a root, an absolute src path gets no sourceRoot bonus but segment signals still fire", () => {
    const srcRows = [{ id: "a", filePath: "/p/src/a.ts", _score: 1 }];
    const [src] = applyPathBoost(srcRows, only({ sourceRoot: 0.05, sourceRoots: ["src"] }));
    expect(src?._score).toBe(1);
    const genRows = [{ id: "b", filePath: "/p/build/a.ts", _score: 1 }];
    const [gen] = applyPathBoost(genRows, only({ generatedDemotion: 0.8 }));
    expect(gen?._score).toBeCloseTo(0.8, 12);
  });

  test("a row without a usable path gets the neutral factor 1", () => {
    const rows = [{ id: "a", _score: 1 } as { id: string; _score?: number }];
    expect(applyPathBoost(rows, CFG(), "/p")[0]?._score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// IndexManager wiring over a real fixture table (search-payload.test.ts
// pattern): RRF tie broken only by the boost, per-call opt-out, single-leg
// native metric untouched, searchAll path. No embedding backend — `text` mode
// needs no query vector, and the RRF merge is forced by the docstring leg
// (the table carries a `doc` column with matching text), not by a vector.
// ---------------------------------------------------------------------------

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const { randomUUID } = await import("node:crypto");
const db = await import("../src/services/db");
const CFG_MANAGER = (await import("../src/config")).CONFIG;
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { isolatedHome } = await import("./helpers/isolated-cidx-home");

describe("IndexManager boost wiring (real LanceDB fixture, no backend)", () => {
  const HOME = isolatedHome;
  const PROJECT = mkdtempSync(path.join(os.tmpdir(), "cidx-boost-proj-"));
  const DB_PATH = path.join(HOME, `boost-${randomUUID()}.db`);
  const TABLE = `idx_boost_${randomUUID()}`;
  const NAME = "boostp";

  const SRC_FILE = path.join(PROJECT, "src", "util.ts");
  const BUILD_FILE = path.join(PROJECT, "build", "gen.ts");
  // Content leg ranks are deterministic on term frequency: the build file
  // mentions the probe token twice, the src file once → BUILD first.
  const SRC_CONTENT = "export function probeHelper() { return 1; }";
  const BUILD_CONTENT = "export function probeHelper() { probeHelper(); }";
  // The doc leg is the mirror image → SRC first there. RRF over the two legs
  // then sums to the SAME fused score for both rows (1/61 + 1/62): an exact
  // tie that only the boost signals are allowed to break.
  const SRC_DOC = "probeHelper probeHelper utility helper";
  const BUILD_DOC = "generated probeHelper stub output";

  const row = (id: string, filePath: string, content: string, doc: string) => ({
    id,
    filePath,
    content,
    vector: [0.1, 0.2, 0.3],
    language: "typescript",
    symbolName: "probeHelper",
    symbolType: "function",
    startLine: 1,
    endLine: 1,
    doc,
    doc_vector: null,
    id_terms: null,
  });

  let registry: InstanceType<typeof Registry>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    expect(CFG_MANAGER.DB_DIR.startsWith(HOME)).toBe(true);
    await db.initDB();
    mkdirSync(path.join(PROJECT, "src"), { recursive: true });
    mkdirSync(path.join(PROJECT, "build"), { recursive: true });
    writeFileSync(SRC_FILE, SRC_CONTENT);
    writeFileSync(BUILD_FILE, BUILD_CONTENT);

    registry = new Registry(DB_PATH);
    registry.upsertIndex({
      name: NAME,
      path: PROJECT,
      tableName: TABLE,
      status: "ready",
      fileCount: 2,
      chunkCount: 2,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });

    await db.insertChunks(TABLE, [
      row("build/gen.ts#0", BUILD_FILE, BUILD_CONTENT, BUILD_DOC),
      row("src/util.ts#0", SRC_FILE, SRC_CONTENT, SRC_DOC),
    ]);
    await db.ensureFtsIndex(TABLE);
    manager = new IndexManager(registry, new JobQueue());
  });

  afterAll(() => {
    manager?.stopAll?.();
    registry?.close();
    void db.dropTable(TABLE);
    rmSync(DB_PATH, { force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("equal-RRF build/ vs src/ hits flip in favor of src/ under the default boost", async () => {
    const rows = await manager.searchIndex(NAME, "probeHelper", 5, { mode: "text", rerank: false, mmr: false });
    expect(rows.map((r) => r.filePath)).toEqual([SRC_FILE, BUILD_FILE]);
    for (const r of rows) expect(typeof r._score).toBe("number");
    expect(rows[0]!._score!).toBeGreaterThan(rows[1]!._score!);
  });

  test("per-call boost:false restores the raw RRF order (the exact tie)", async () => {
    const rows = await manager.searchIndex(NAME, "probeHelper", 5, {
      mode: "text",
      rerank: false,
      mmr: false,
      boost: false,
    });
    expect(rows.map((r) => r.filePath)).toEqual([BUILD_FILE, SRC_FILE]);
    // The raw RRF scores are fused to the same value — prove the boost was the
    // only thing that could have broken this tie in the previous test.
    expect(Math.abs(rows[0]!._score! - rows[1]!._score!)).toBeLessThan(1e-12);
  });

  test("single-leg (doc:false) results keep their native metric untouched by the boost", async () => {
    // doc:false → the docstring leg never fires → the list passes through as a
    // single-leg native-BM25 list (raw `_score`, unbounded — not a fused rank).
    const boosted = await manager.searchIndex(NAME, "probeHelper", 5, {
      mode: "text",
      doc: false,
      rerank: false,
      mmr: false,
    });
    const raw = await manager.searchIndex(NAME, "probeHelper", 5, {
      mode: "text",
      doc: false,
      rerank: false,
      mmr: false,
      boost: false,
    });
    for (const r of [...boosted, ...raw]) {
      expect(r._docHit).toBeUndefined();
      expect(r.symbolName).toBe("probeHelper");
    }
    expect(boosted[0]!._score!).toBeGreaterThan(1 / 60); // native BM25, above the RRF maximum
    // Identical ordering and metric with the boost on or off: the boost never
    // re-scales a native metric.
    expect(boosted.map((r) => r.filePath)).toEqual([BUILD_FILE, SRC_FILE]);
    expect(raw.map((r) => r.filePath)).toEqual([BUILD_FILE, SRC_FILE]);
    expect(boosted.map((r) => r._score)).toEqual(raw.map((r) => r._score));
  });

  test("searchAll wiring: per-table boost then cross-table sort", async () => {
    const boosted = await manager.searchAll("probeHelper", 5, { mode: "text", rerank: false, mmr: false });
    expect(boosted.map((r) => r.filePath)).toEqual([SRC_FILE, BUILD_FILE]);
    expect(boosted.every((r) => r.project === NAME)).toBe(true);
    const raw = await manager.searchAll("probeHelper", 5, { mode: "text", rerank: false, mmr: false, boost: false });
    expect(raw.map((r) => r.filePath)).toEqual([BUILD_FILE, SRC_FILE]);
  });
});