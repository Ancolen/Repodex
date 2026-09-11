/**
 * Change impact — fixture-project test + engine contract (LanceDB-free).
 *
 * The fixture is a REAL project written to a temp dir and parsed with the REAL
 * engines (`chunkCode`, `extractImports` → `resolveImports`, `buildCallEdges`) —
 * exactly the three adjacency sources `IndexManager.getChangeImpact` feeds the
 * join. The assertions then run `buildImpactReport` on that adjacency: one symbol
 * with a caller, a module importer and a textual mention must land in all three
 * sections, ranked in severity order, with its test file split out into
 * `coveredBy`.
 *
 * No LanceDB, no Ollama: the table read is the engine's only uncovered line, and
 * the anchor/project-resolution errors below are checked on the real method
 * (they fire before any table access, mirroring `callgraph-engine.test.ts`).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chunkCode } from "../src/chunking/chunker";
import { extractImports } from "../src/chunking/imports";
import { resolveImports, buildFileIndex } from "../src/core/resolve";
import { buildCallEdges } from "../src/core/callgraph";
import type { CallChunk, CallSymbol } from "../src/core/callgraph";
import { buildImpactReport, selectAnchor } from "../src/core/impact";
import type { ChangeImpactReport, ImpactChunk, ImpactSymbolMeta } from "../src/core/impact";
import { Registry } from "../src/core/registry";
import { JobQueue } from "../src/core/job-queue";
import { IndexManager } from "../src/core/index-manager";

// ---------------------------------------------------------------- the fixture

const FILES: Record<string, string> = {
  "src/slug.ts": `export function formatSlug(input: string): string {
  return input.trim().toLowerCase().replace(/\\s+/g, "-");
}
`,
  "src/api.ts": `import { formatSlug } from "./slug";

export function createPost(title: string): string {
  return formatSlug(title);
}
`,
  // Imports the module without naming the symbol (a side-effect import).
  "src/report.ts": `import "./slug";

export function renderReport(rows: string[]): string {
  return rows.join("\\n");
}
`,
  // Mentions the symbol in a comment/string but neither imports nor calls it.
  "src/notes.ts": `// Notes: the legacy formatter is formatSlug; migrate when the API settles.
export const NOTES = "see formatSlug";
`,
  // A test: it calls the symbol, so it "covers" rather than "consumes".
  "tests/slug.test.ts": `import { formatSlug } from "../src/slug";

export function runSlugSuite(): boolean {
  return formatSlug(" Hello World ") === "hello-world";
}
`,
};

const CALLABLE_TYPES = new Set(["function", "method", "constructor"]);

/** The centralized test-file patterns, inlined for the pure join. */
const isTestFile = (p: string): boolean => /(^|\/)(tests?|__tests?__|spec)\//.test(p.replace(/\\/g, "/"));

let ROOT = "";

beforeAll(async () => {
  ROOT = mkdtempSync(join(tmpdir(), "cidx-impact-fx-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(ROOT, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
});

afterAll(() => {
  if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

/** Builds the three adjacency sources the engine builds, from the fixture. */
async function buildFixtureAdjacency() {
  const absFiles = Object.keys(FILES).map((rel) => join(ROOT, rel));
  const index = buildFileIndex(new Set(absFiles));

  const symbolsByKey = new Map<string, ImpactSymbolMeta>();
  const symbols: CallSymbol[] = [];
  const bodies: CallChunk[] = [];
  const scanChunks: ImpactChunk[] = [];

  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(ROOT, rel);
    for (const c of await chunkCode(abs, content)) {
      scanChunks.push({ filePath: abs, startLine: c.startLine, content: c.content });
      if (c.symbolName && c.symbolType && CALLABLE_TYPES.has(c.symbolType)) {
        const keyStr = `${c.symbolName}\0${abs}`;
        const sym: CallSymbol = {
          key: keyStr,
          symbolName: c.symbolName,
          symbolType: c.symbolType,
          matchNames: [c.symbolName],
          filePath: abs,
          declarationLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
        };
        symbols.push(sym);
        symbolsByKey.set(keyStr, sym);
        bodies.push({ callerKey: keyStr, filePath: abs, startLine: c.startLine, content: c.content });
      }
    }
  }

  // Forward imports (index-validated, like `buildImportGraph`) + the inverse.
  const importsOf = new Map<string, string[]>();
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(ROOT, rel);
    const specs = await extractImports(abs, content);
    if (specs.length === 0) continue;
    const resolved = resolveImports(specs, ROOT, index, abs)
      .filter((r) => r.status === "resolved" && r.resolvedPath)
      .map((r) => r.resolvedPath!);
    if (resolved.length > 0) importsOf.set(abs, resolved);
  }
  const importedBy = new Map<string, string[]>();
  for (const [importer, targets] of importsOf) {
    for (const t of targets) {
      if (!importedBy.has(t)) importedBy.set(t, []);
      const list = importedBy.get(t)!;
      if (!list.includes(importer)) list.push(importer);
    }
  }

  const { forward, reverse } = buildCallEdges(symbols, bodies);
  return { symbolsByKey, forward, reverse, importsOf, importedBy, scanChunks };
}

let report: ChangeImpactReport;
let adjacency: Awaited<ReturnType<typeof buildFixtureAdjacency>>;

beforeAll(async () => {
  adjacency = await buildFixtureAdjacency();
  report = buildImpactReport({
    project: "impactfx",
    projectRoot: ROOT,
    anchor: {
      key: `formatSlug\0${join(ROOT, "src/slug.ts")}`,
      symbol: "formatSlug",
      symbolType: "function",
      file: join(ROOT, "src/slug.ts"),
      relativeFile: "src/slug.ts",
      startLine: 1,
      endLine: 3,
    },
    callersOf: adjacency.reverse,
    calleesOf: adjacency.forward,
    symbolsByKey: adjacency.symbolsByKey,
    importedBy: adjacency.importedBy,
    importsOf: adjacency.importsOf,
    chunks: adjacency.scanChunks,
    isTestFile,
  });
});

describe("get_change_impact — fixture project (one symbol, three sections)", () => {
  test("the fixture really has a caller, an importer and a textual mention", () => {
    // Guard the fixture itself: the parse found the symbol and its edges.
    expect([...adjacency.symbolsByKey.values()].map((s) => s.symbolName)).toEqual([
      "formatSlug",
      "createPost",
      "renderReport",
      "runSlugSuite",
    ]);
    expect(adjacency.reverse.get(`formatSlug\0${join(ROOT, "src/slug.ts")}`)?.size).toBe(2);
    expect(adjacency.importedBy.get(join(ROOT, "src/slug.ts"))).toHaveLength(3);
  });

  test("section 1 — the direct caller", () => {
    expect(report.callers.total).toBeGreaterThanOrEqual(1);
    const caller = report.callers.items.find((c) => c.symbol === "createPost");
    expect(caller).toBeDefined();
    expect(caller!.relativeFile).toBe("src/api.ts");
    expect(caller!.depth).toBe(1);
    expect(caller!.startLine).toBe(3);
  });

  test("section 2 — the module importers, ranked by how directly they use it", () => {
    const files = report.importers.items.map((i) => i.relativeFile);
    expect(files).toContain("src/report.ts");
    expect(files).toContain("src/api.ts");
    // The importer that also mentions the symbol outranks the side-effect import.
    expect(files.indexOf("src/api.ts")).toBeLessThan(files.indexOf("src/report.ts"));
    expect(report.importers.items.find((i) => i.relativeFile === "src/report.ts")!.alsoReferences).toBe(false);
    expect(report.importers.total).toBe(2);
  });

  test("section 3 — the textual mention", () => {
    expect(report.referenceCount).toBeGreaterThanOrEqual(3);
    const notes = report.references.items.filter((r) => r.relativeFile === "src/notes.ts");
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.text).toContain("formatSlug");
    // The mention-only file appears nowhere stronger than the reference section.
    expect(report.callers.items.some((c) => c.relativeFile === "src/notes.ts")).toBe(false);
    expect(report.importers.items.some((i) => i.relativeFile === "src/notes.ts")).toBe(false);
  });

  test("the sections are ranked by severity: caller > importer > mention", () => {
    const callerFile = report.callers.items[0]!.relativeFile;
    const weakest = report.references.items.at(-1)!.relativeFile;
    expect(report.callers.items.map((c) => c.relativeFile)).not.toContain(weakest);
    expect(callerFile).not.toBe(weakest);
    // Every section reports its own total + truncation state.
    for (const section of [report.callers, report.importers, report.references, report.coveredBy]) {
      expect(section.total).toBeGreaterThanOrEqual(section.items.length);
      expect(section.truncated).toBe(false);
    }
  });

  test("the test file is 'covered by', not 'consumed by'", () => {
    const covered = report.coveredBy.items.find((c) => c.relativeFile === "tests/slug.test.ts");
    expect(covered).toBeDefined();
    expect(covered!.via).toEqual(["call", "import", "reference"]);
    expect(report.callers.items.some((c) => c.symbol === "runSlugSuite")).toBe(false);
    expect(report.importers.items.some((i) => i.relativeFile === "tests/slug.test.ts")).toBe(false);
  });

  test("the change site's fan-out and scan sizes are reported", () => {
    expect(report.project).toBe("impactfx");
    expect(report.fanOut.importedFiles).toBe(0); // slug.ts imports nothing indexed
    // `formatSlug` only calls methods on its argument (trim/toLowerCase/replace) —
    // not indexed symbols, so the in-index call fan-out is empty. Honest zero.
    expect(report.fanOut.calledSymbols).toBe(0);
    expect(report.fanOut.imports).toEqual([]);
    expect(report.scannedSymbols).toBe(4);
    expect(report.scannedChunks).toBe(adjacency.scanChunks.length);
    expect(report.truncated).toBe(false);
  });
});

// ------------------------------------------------- engine contract (no LanceDB)

const DB_PATH = join(tmpdir(), `mcp-impact-${randomUUID()}.db`);
let manager: IndexManager;
let registry: Registry;

beforeAll(() => {
  registry = new Registry(DB_PATH);
  manager = new IndexManager(registry, new JobQueue());
});
afterAll(() => {
  rmSync(DB_PATH, { force: true });
});

describe("getChangeImpact — anchor + project resolution", () => {
  test("needs a symbol and/or a path", async () => {
    await expect(manager.getChangeImpact({})).rejects.toThrow(/symbol name and\/or a file path/);
  });

  test("a symbol with zero indexed projects → helpful error", async () => {
    await expect(manager.getChangeImpact({ symbol: "formatSlug" })).rejects.toThrow(/No indexed project/);
  });

  test("a symbol with several projects and no --project → ambiguous error", async () => {
    const base = { status: "ready" as const, fileCount: 1, chunkCount: 1, embedModel: null, embedDim: null, lastIndexedAt: null, createdAt: 1, error: null };
    registry.upsertIndex({ ...base, name: "alpha", path: "/alpha", tableName: "idx_alpha" });
    registry.upsertIndex({ ...base, name: "beta", path: "/beta", tableName: "idx_beta" });
    await expect(manager.getChangeImpact({ symbol: "formatSlug" })).rejects.toThrow(/could belong to multiple projects/);
  });

  test("an unknown --project → not-found error", async () => {
    await expect(manager.getChangeImpact({ symbol: "formatSlug", project: "nope" })).rejects.toThrow(/Index not found/);
  });

  test("a path outside every indexed project → error", async () => {
    await expect(manager.getChangeImpact({ path: "/nonexistent/outside.ts" })).rejects.toThrow(/No indexed project contains/);
  });
});

describe("selectAnchor — one anchor per ranked report", () => {
  const meta = (name: string, file: string): ImpactSymbolMeta => ({
    key: `${name}\0${file}`,
    symbolName: name,
    symbolType: "function",
    filePath: file,
    declarationLine: 1,
    endLine: 2,
    content: `function ${name}() {}`,
  });

  test("dedupes several chunks of the same symbol and derives the signature", () => {
    const a = selectAnchor([meta("formatSlug", "/fx/src/slug.ts"), meta("formatSlug", "/fx/src/slug.ts")], "/fx", "formatSlug");
    expect(a.symbol).toBe("formatSlug");
    expect(a.relativeFile).toBe("src/slug.ts");
    expect(a.signature).toBe("function formatSlug()");
    expect(a.key).toBe(`formatSlug\0/fx/src/slug.ts`);
  });

  test("several distinct matches are refused, naming the candidates", () => {
    expect(() => selectAnchor([meta("get", "/a.ts"), meta("get", "/b.ts"), meta("run", "/c.ts")], "/fx", "get"))
      .toThrow(/matches 3 callable symbols \(get, run\).*one anchor/);
  });

  test("long candidate lists are truncated but counted", () => {
    const many = Array.from({ length: 12 }, (_, i) => meta(`s${i}`, `/f${i}.ts`));
    expect(() => selectAnchor(many, "/fx", "s")).toThrow(/12 total/);
  });

  test("an empty candidate list is refused", () => {
    expect(() => selectAnchor([], "/fx", "nope")).toThrow(/No callable symbol 'nope' found/);
  });
});
