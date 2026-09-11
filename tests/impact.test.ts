/**
 * Change-impact join — PURE tests over synthetic adjacency maps (no LanceDB, no
 * Ollama, no disk). `buildImpactReport` is the only new logic in
 * `get_change_impact`; its three inputs are the already-cached call graph, the
 * already-cached dependency graph, and one indexed-content reference pass.
 *
 * Covered here: the severity ordering (caller > importer > textual mention),
 * per-section caps + `total` + `truncated`, the test-file split into `coveredBy`,
 * the change site's own fan-out, the caller traversal (depth / cycles / minimum
 * depth / work cap) and the reference scan (definition rule, overlap dedup,
 * honest counts under a sample cap).
 */
import { describe, expect, test } from "bun:test";
import {
  buildImpactReport,
  collectReferenceHits,
  FANOUT_SAMPLE_CAP,
  flattenCallers,
  type ImpactAnchor,
  type ImpactChunk,
  type ImpactSymbolMeta,
} from "../src/core/impact";
import { matchNamesFor } from "../src/core/deadcode";

const ROOT = "/proj";

/** The call-graph key shape: `${symbolName}\0${filePath}`. */
const key = (name: string, file: string): string => `${name}\0${file}`;

function meta(keyStr: string, name: string, file: string, decl = 1, end = 10, type = "function"): ImpactSymbolMeta {
  return { key: keyStr, symbolName: name, symbolType: type, filePath: file, declarationLine: decl, endLine: end };
}

const SLUG = "/proj/src/slug.ts";
const API = "/proj/src/api.ts";
const REPORT = "/proj/src/report.ts";
const ANCHOR_KEY = key("formatSlug", SLUG);

function anchor(): ImpactAnchor {
  return {
    key: ANCHOR_KEY,
    symbol: "formatSlug",
    symbolType: "function",
    file: SLUG,
    relativeFile: "src/slug.ts",
    startLine: 3,
    endLine: 5,
  };
}

/** The adjacency every test starts from (mutate per case). */
function input(overrides: Partial<Parameters<typeof buildImpactReport>[0]> = {}) {
  const symbols = new Map<string, ImpactSymbolMeta>([
    [ANCHOR_KEY, meta(ANCHOR_KEY, "formatSlug", SLUG, 3, 5)],
    [key("createPost", API), meta(key("createPost", API), "createPost", API)],
    [key("renderReport", REPORT), meta(key("renderReport", REPORT), "renderReport", REPORT)],
  ]);
  return {
    project: "fx",
    projectRoot: ROOT,
    anchor: anchor(),
    callersOf: new Map<string, Set<string>>([[ANCHOR_KEY, new Set([key("createPost", API)])]]),
    calleesOf: new Map<string, Set<string>>(),
    symbolsByKey: symbols,
    importedBy: new Map<string, string[]>(),
    importsOf: new Map<string, string[]>(),
    chunks: [] as ImpactChunk[],
    ...overrides,
  };
}

describe("flattenCallers — bounded, cycle-safe caller traversal", () => {
  const A = key("a", "/f1");
  const B = key("b", "/f2");
  const C = key("c", "/f3");
  const chain = new Map<string, Set<string>>([
    [A, new Set([B])],
    [B, new Set([C])],
  ]);

  test("collects callers breadth-first with their depth", () => {
    const r = flattenCallers([A], chain, 3);
    expect(r.callers).toEqual([
      { key: B, depth: 1 },
      { key: C, depth: 2 },
    ]);
    expect(r.truncated).toBe(false);
  });

  test("depth bounds the traversal by design (not a truncation)", () => {
    const r = flattenCallers([A], chain, 1);
    expect(r.callers).toEqual([{ key: B, depth: 1 }]);
    expect(r.truncated).toBe(false);
  });

  test("a consumer reachable by several paths is reported once, at its minimum depth", () => {
    const g = new Map<string, Set<string>>([
      [A, new Set([B, C])],
      [B, new Set([C])],
    ]);
    const r = flattenCallers([A], g, 3);
    // C is a DIRECT caller; the longer path through B must not duplicate it.
    expect(r.callers).toEqual([
      { key: B, depth: 1 },
      { key: C, depth: 1 },
    ]);
  });

  test("a call cycle terminates (and the anchor is never its own consumer)", () => {
    const g = new Map<string, Set<string>>([
      [A, new Set([B])],
      [B, new Set([C])],
      [C, new Set([A, B])], // back-edges to the root and to a visited caller
    ]);
    const r = flattenCallers([A], g, 6);
    expect(r.callers.map((c) => c.key)).toEqual([B, C]);
    expect(r.truncated).toBe(false);
  });

  test("the work cap sets truncated rather than walking forever", () => {
    const g = new Map<string, Set<string>>([
      [A, new Set([B, key("x", "/f9"), key("y", "/f9"), key("z", "/f9")])],
    ]);
    const r = flattenCallers([A], g, 3, 2);
    expect(r.callers).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  test("depth 0 collects nothing", () => {
    expect(flattenCallers([A], chain, 0).callers).toEqual([]);
  });
});

describe("collectReferenceHits — the whole-identifier reference pass", () => {
  const chunk = (filePath: string, startLine: number, content: string, symbolName?: string): ImpactChunk => {
    const c: ImpactChunk = { filePath, startLine, content };
    if (symbolName) c.symbolName = symbolName;
    return c;
  };

  test("the declaration line is the definition, not a reference", () => {
    const scan = collectReferenceHits(
      matchNamesFor("formatSlug"),
      "/proj/src/slug.ts",
      1,
      [chunk("/proj/src/slug.ts", 1, "export function formatSlug(s: string): string {\n  return s;\n}")],
    );
    expect(scan.count).toBe(0);
    expect(scan.hits).toEqual([]);
  });

  test("overlapping chunks do not double-count a line", () => {
    const same = "export function createPost(t: string) {\n  return formatSlug(t);\n}";
    const scan = collectReferenceHits(matchNamesFor("formatSlug"), "/proj/src/slug.ts", 1, [
      chunk("/proj/src/api.ts", 5, same, "createPost"),
      chunk("/proj/src/api.ts", 5, same, "createPost"), // the overlap window of the next chunk
    ]);
    expect(scan.count).toBe(1);
    expect(scan.files.size).toBe(1);
    expect(scan.hits).toHaveLength(1);
    expect(scan.hits[0]!.line).toBe(6);
  });

  test("a line counts once, every distinct line counts, across files", () => {
    const scan = collectReferenceHits(matchNamesFor("formatSlug"), "/proj/src/slug.ts", 1, [
      chunk("/proj/src/api.ts", 5, "formatSlug(t);\nformatSlug(u);", "createPost"),
      chunk("/proj/src/notes.ts", 1, "// see formatSlug"),
    ]);
    expect(scan.count).toBe(3);
    expect(scan.files.size).toBe(2);
  });

  test("the bare segment of a dotted symbol matches too", () => {
    const scan = collectReferenceHits(
      matchNamesFor("IndexManager.getDependencies"),
      "/proj/src/im.ts",
      1,
      [chunk("/proj/src/other.ts", 1, "this.getDependencies(file);", "run")],
    );
    expect(scan.count).toBe(1);
  });

  test("a hit carries its containing symbol", () => {
    const scan = collectReferenceHits(matchNamesFor("formatSlug"), "/proj/src/slug.ts", 1, [
      chunk("/proj/src/api.ts", 5, "return formatSlug(t);", "createPost"),
    ]);
    expect(scan.hits[0]!.inSymbol).toBe("createPost");
    expect(scan.hits[0]!.text).toBe("return formatSlug(t);");
  });

  test("count and files stay exact when the sample list is capped", () => {
    const scan = collectReferenceHits(
      matchNamesFor("formatSlug"),
      "/proj/src/slug.ts",
      1,
      [
        chunk("/proj/src/a.ts", 1, "formatSlug(1);"),
        chunk("/proj/src/b.ts", 1, "formatSlug(2);"),
        chunk("/proj/src/c.ts", 1, "formatSlug(3);"),
      ],
      2,
    );
    expect(scan.count).toBe(3);
    expect(scan.files.size).toBe(3);
    expect(scan.hits).toHaveLength(2);
  });
});

describe("buildImpactReport — the join", () => {
  test("ranks sections by severity: caller > importer > textual mention", () => {
    const chunks: ImpactChunk[] = [
      { filePath: API, startLine: 4, content: "  return formatSlug(title);", symbolName: "createPost" },
      { filePath: "/proj/src/notes.ts", startLine: 1, content: "// the legacy formatter is formatSlug" },
    ];
    const report = buildImpactReport(input({
      importedBy: new Map<string, string[]>([[SLUG, [API, REPORT]]]),
      chunks,
    }));

    expect(report.callers.items.map((c) => c.symbol)).toEqual(["createPost"]);
    expect(report.callers.items[0]!.depth).toBe(1);
    // The importer that also mentions the symbol ranks first within its section.
    expect(report.importers.items.map((i) => i.relativeFile)).toEqual(["src/api.ts", "src/report.ts"]);
    expect(report.importers.items[0]!.alsoReferences).toBe(true);
    expect(report.importers.items[1]!.alsoReferences).toBe(false);
    // The mention-only file is a textual reference, nothing stronger.
    expect(report.referenceCount).toBe(2);
    expect(report.references.items.map((r) => r.relativeFile)).toEqual(["src/api.ts", "src/notes.ts"]);
  });

  test("test files are 'covered by', never 'consumed by'", () => {
    const isTestFile = (p: string): boolean => p.includes("/tests/");
    const testFile = "/proj/tests/slug.test.ts";
    const chunks: ImpactChunk[] = [
      { filePath: testFile, startLine: 4, content: "  expect(formatSlug('A B')).toBe('a-b');" },
    ];
    const report = buildImpactReport(input({
      callersOf: new Map<string, Set<string>>([[
        ANCHOR_KEY,
        new Set([key("runSlugSuite", testFile), key("createPost", API)]),
      ]]),
      symbolsByKey: (() => {
        const m = input().symbolsByKey;
        m.set(key("runSlugSuite", testFile), meta(key("runSlugSuite", testFile), "runSlugSuite", testFile));
        return m;
      })(),
      importedBy: new Map<string, string[]>([[SLUG, [testFile, API]]]),
      chunks,
      isTestFile,
    }));

    expect(report.callers.items.map((c) => c.symbol)).toEqual(["createPost"]);
    expect(report.callers.total).toBe(1);
    expect(report.importers.items.map((i) => i.relativeFile)).toEqual(["src/api.ts"]);
    expect(report.references.items).toEqual([]);
    expect(report.referenceCount).toBe(1); // the test mention still counts as a mention
    expect(report.coveredBy.items).toHaveLength(1);
    expect(report.coveredBy.items[0]!.relativeFile).toBe("tests/slug.test.ts");
    expect(report.coveredBy.items[0]!.via).toEqual(["call", "import", "reference"]);
    expect(report.coveredBy.total).toBe(1);
  });

  test("each section is capped by limit with an honest total + truncated", () => {
    const callerKeys = [key("c1", "/f1"), key("c2", "/f2"), key("c3", "/f3")];
    const symbols = input().symbolsByKey;
    callerKeys.forEach((k, i) => symbols.set(k, meta(k, `c${i + 1}`, `/f${i + 1}`)));
    const chunks: ImpactChunk[] = [1, 2, 3].map((n) => ({
      filePath: `/proj/src/r${n}.ts`,
      startLine: n,
      content: `formatSlug(${n});`,
    }));
    const report = buildImpactReport(input({
      callersOf: new Map<string, Set<string>>([[ANCHOR_KEY, new Set(callerKeys)]]),
      symbolsByKey: symbols,
      importedBy: new Map<string, string[]>([[SLUG, ["/i1", "/i2"]]]),
      chunks,
      limit: 2,
      refSamples: 1,
    }));

    expect(report.callers.items).toHaveLength(2);
    expect(report.callers.total).toBe(3);
    expect(report.callers.truncated).toBe(true);
    expect(report.importers.items).toHaveLength(2);
    expect(report.importers.total).toBe(2);
    expect(report.importers.truncated).toBe(false);
    expect(report.references.items).toHaveLength(1);
    expect(report.references.total).toBe(3);
    expect(report.references.truncated).toBe(true);
    expect(report.truncated).toBe(true);
  });

  test("the change site's own fan-out is reported", () => {
    const report = buildImpactReport(input({
      importsOf: new Map<string, string[]>([[SLUG, ["/proj/src/a.ts", "/proj/src/b.ts"]]]),
      calleesOf: new Map<string, Set<string>>([[
        ANCHOR_KEY,
        new Set([key("trim", "/f9"), key("lower", "/f9"), key("other", "/f9")]),
      ]]),
    }));
    expect(report.fanOut.importedFiles).toBe(2);
    expect(report.fanOut.calledSymbols).toBe(3);
    expect(report.fanOut.imports).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("the fan-out path list is capped while the count stays exact", () => {
    const files = Array.from({ length: FANOUT_SAMPLE_CAP + 3 }, (_, i) => `/proj/src/m${i}.ts`);
    const report = buildImpactReport(input({
      importsOf: new Map<string, string[]>([[SLUG, files]]),
    }));
    expect(report.fanOut.importedFiles).toBe(FANOUT_SAMPLE_CAP + 3);
    expect(report.fanOut.imports).toHaveLength(FANOUT_SAMPLE_CAP);
    expect(report.truncated).toBe(false); // a capped sample list is not a capped section
  });

  test("callers beyond depth 1 are labelled with their depth and sorted by it", () => {
    const midKey = key("mid", API);
    const topKey = key("top", "/proj/src/app.ts");
    const symbols = input().symbolsByKey;
    symbols.set(midKey, meta(midKey, "mid", API));
    symbols.set(topKey, meta(topKey, "top", "/proj/src/app.ts", 1, 10, "function"));
    symbols.get(topKey)!.content = "function top() { createPost('x'); }";
    const report = buildImpactReport(input({
      callersOf: new Map<string, Set<string>>([
        [ANCHOR_KEY, new Set([key("createPost", API), midKey])],
        [key("createPost", API), new Set([topKey])],
      ]),
      symbolsByKey: symbols,
      depth: 2,
    }));
    expect(report.callers.items.map((c) => `${c.symbol}:${c.depth}`)).toEqual([
      "createPost:1",
      "mid:1",
      "top:2",
    ]);
    expect(report.callers.items[2]!.signature).toBeDefined();
  });

  test("an anchor with no adjacency at all yields empty sections and no truncation", () => {
    const report = buildImpactReport(input({
      callersOf: new Map<string, Set<string>>(),
    }));
    expect(report.callers).toEqual({ items: [], total: 0, truncated: false });
    expect(report.importers).toEqual({ items: [], total: 0, truncated: false });
    expect(report.references).toEqual({ items: [], total: 0, truncated: false });
    expect(report.coveredBy).toEqual({ items: [], total: 0, truncated: false });
    expect(report.referenceCount).toBe(0);
    expect(report.truncated).toBe(false);
    expect(report.scanTruncated).toBeUndefined();
  });

  test("coverage, scan sizes and the project are surfaced; a table cap is reported", () => {
    const report = buildImpactReport(input({ scanTruncated: true }));
    expect(report.project).toBe("fx");
    expect(report.anchor.symbol).toBe("formatSlug");
    expect(report.anchor.relativeFile).toBe("src/slug.ts");
    expect(report.anchor.startLine).toBe(3);
    expect(report.scannedSymbols).toBe(3);
    expect(report.scannedChunks).toBe(0);
    expect(report.scanTruncated).toBe(true);
  });
});
