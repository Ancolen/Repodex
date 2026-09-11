/**
 * Public-API diff tests (proposal C2).
 *
 * Layers covered, no Ollama anywhere:
 *   1. the PURE comparator (`compareSurfaces` / `countDiff` / `paramList`) and the
 *      index-side projection (`surfaceFromIndexRows`),
 *   2. the git helpers (`safeGitRef`, `gitRefExists`, `gitLsTreeFiles`,
 *      `gitShowFile`) against a scripted temp git repo,
 *   3. the ENGINE (`IndexManager.getApiDiff`) over that repo across two tags:
 *      removed / renamed / signature-changed / visibility-narrowed / added all
 *      classified correctly, unparsed files reported, caps flagged, and the two
 *      head sides (a git ref, and the working tree through the index).
 *
 * The historical side is REALLY parsed — `git show` → the same `chunkCode` recipe
 * the indexer uses — so the fixture proves the end-to-end extraction, not a mock.
 *
 * The engine tests touch LanceDB, and `CONFIG` resolves the data root at import
 * time while `bun test` shares one module registry across files — so a per-file
 * `process.env.CIDX_HOME` only holds if this file is the first to import it
 * (it wasn't: the fixture table leaked into the real `~/.cidx/db`). The whole
 * run therefore sits on the throw-away root pinned by the `[test]` preload
 * (`tests/helpers/isolated-cidx-home.ts`); the fixture's sqlite registry lives
 * in that same directory, and the preload removes it on exit.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isolatedHome } from "./helpers/isolated-cidx-home";
import type { CodeRecord } from "../src/services/db";
// Type-only imports are erased, so they cannot resolve CONFIG at import time —
// they keep the tests typed without adding another config consumer to the file.
import type { ApiSymbol as ApiSymbolType, ApiDiffEntry as ApiDiffEntryType } from "../src/core/apidiff";

const {
  compareSurfaces,
  countDiff,
  paramList,
  paramsDiffer,
  fileSurface,
  extractRefSurface,
  surfaceFromIndexRows,
} = await import("../src/core/apidiff");
const { gitRefExists, gitLsTreeFiles, gitShowFile, safeGitRef } = await import("../src/services/git");
const db = await import("../src/services/db");
const { CONFIG } = await import("../src/config");
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { chunkCode } = await import("../src/chunking/chunker");

// ------------------------------------------------------------ 1. comparator

/** Shorthand for building a surface symbol. */
function sym(name: string, opts: Partial<ApiSymbolType> = {}): ApiSymbolType {
  return {
    symbolName: name,
    symbolType: "function",
    relativePath: "src/api.ts",
    language: "typescript",
    startLine: 1,
    endLine: 2,
    content: `function ${name}() {}`,
    signature: `function ${name}(a: string): void`,
    exported: true,
    ...opts,
  };
}

const sigOf = (e: ApiDiffEntryType, side: "base" | "head"): string => e[side]?.signature ?? "";

describe("compareSurfaces", () => {
  test("removed (breaking) and added (non-breaking)", () => {
    const entries = compareSurfaces([sym("gone"), sym("kept")], [sym("kept"), sym("new")]);
    expect(countDiff(entries)).toEqual({
      removed: 1,
      signatureChanged: 0,
      visibilityNarrowed: 0,
      added: 1,
      unchanged: 1,
      breaking: 1,
    });
    const removed = entries.find((e) => e.kind === "removed")!;
    expect(removed.breaking).toBe(true);
    expect(removed.symbolName).toBe("gone");
    expect(removed.head).toBeUndefined(); // nothing to show on the head side
    expect(entries.find((e) => e.symbolName === "new")!.kind).toBe("added");
  });

  test("signature change (arity) is breaking and carries both signatures", () => {
    const base = sym("f", { signature: "export function f(a: string): void" });
    const head = sym("f", { signature: "export function f(a: string, b: number): void" });
    const entries = compareSurfaces([base], [head]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("signature-changed");
    expect(entries[0]!.breaking).toBe(true);
    expect(sigOf(entries[0]!, "base")).toContain("(a: string)");
    expect(sigOf(entries[0]!, "head")).toContain("(a: string, b: number)");
  });

  test("a body-only change is unchanged (only the declaration head compares)", () => {
    const base = sym("f", { signature: "export function f(a: string): void" });
    const head = sym("f", { signature: "export function f(a: string): void", endLine: 40 });
    expect(compareSurfaces([base], [head]).map((e) => e.kind)).toEqual(["unchanged"]);
  });

  test("visibility narrowed (exported → private) is breaking; widening is not", () => {
    const entries = compareSurfaces([sym("f", { exported: true })], [sym("f", { exported: false })]);
    expect(entries[0]!.kind).toBe("visibility-narrowed");
    expect(entries[0]!.breaking).toBe(true);
    expect(entries[0]!.base!.exported).toBe(true);
    expect(entries[0]!.head!.exported).toBe(false);
    expect(
      compareSurfaces([sym("f", { exported: false })], [sym("f", { exported: true })])[0]!.kind,
    ).toBe("unchanged");
  });

  test("a rename surfaces honestly as removed + added (no invented rename pairing)", () => {
    const entries = compareSurfaces([sym("oldName")], [sym("newName")]);
    expect(entries.map((e) => e.kind).sort()).toEqual(["added", "removed"]);
    expect(countDiff(entries).breaking).toBe(1);
  });

  test("breaking kinds sort first; identical ranks keep path/name order", () => {
    const base = [
      sym("a", { relativePath: "src/a.ts" }),
      sym("z", { relativePath: "src/z.ts", signature: "function z(x: number): void" }),
      sym("b", { relativePath: "src/b.ts" }),
    ];
    const head = [
      sym("a", { relativePath: "src/a.ts" }),
      sym("z", { relativePath: "src/z.ts", signature: "function z(x: number, y: number): void" }),
      sym("b", { relativePath: "src/b.ts" }),
    ];
    const entries = compareSurfaces(base, head);
    expect(entries[0]!.kind).toBe("signature-changed");
    expect(entries.slice(1).map((e) => e.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("symbols in different files never join (the path is part of the key)", () => {
    const entries = compareSurfaces(
      [sym("f", { relativePath: "a.ts" })],
      [sym("f", { relativePath: "b.ts" })],
    );
    expect(entries.map((e) => e.kind).sort()).toEqual(["added", "removed"]);
  });
});

describe("paramList / paramsDiffer (per-language, approximate)", () => {
  test("arity differences are breaking", () => {
    expect(paramsDiffer("f(a: string)", "f(a: string, b: number)", "typescript")).toBe(true);
    expect(paramsDiffer("def f(a):", "def f(a, b):", "python")).toBe(true);
  });

  test("default values and return types do not count as breaking", () => {
    expect(
      paramsDiffer("f(a: string, b: number = 1): string", "f(a: string, b: number = 2): string", "typescript"),
    ).toBe(false);
    expect(paramsDiffer("f(a: string): Promise<void>", "f(a: string): void", "typescript")).toBe(false);
    expect(paramsDiffer("def f(a, b=1):", "def f(a, b):", "python")).toBe(false);
  });

  test("type annotations are cut, so only the names compare", () => {
    expect(paramList("f(req: Request, res: Response): void", "typescript")).toEqual(["req", "res"]);
    expect(paramList("fn f(x: i32, y: &str)", "rust")).toEqual(["x", "y"]);
  });

  test("Go keeps the FIRST token (name Type); Java the last (Type name)", () => {
    expect(paramList("f(ctx context.Context, n int)", "go")).toEqual(["ctx", "n"]);
    expect(paramList("f(String name, int size)", "java")).toEqual(["name", "size"]);
  });

  test("Python's implicit receiver is dropped on both sides", () => {
    expect(paramsDiffer("def f(self, a):", "def f(a):", "python")).toBe(false);
    expect(paramList("def f(self, a, *, b=1):", "python")).toEqual(["a", "b"]);
  });

  test("decoration and keywords are stripped (`...rest`, `&mut`, `const`, `?`)", () => {
    expect(paramList("f(...rest: string[], done?: () => void)", "typescript")).toEqual(["rest", "done"]);
    expect(paramList("f(const std::string& name)", "cpp")).toEqual(["name"]);
    expect(paramList("fn f(mut x: u8)", "rust")).toEqual(["x"]);
  });

  test("no comparable parameter list → never 'changed' (conservative)", () => {
    expect(paramList("class Foo", "typescript")).toBeNull();
    expect(paramsDiffer("class Foo", "class Foo: Bar", "typescript")).toBe(false);
    expect(paramList("f()", "typescript")).toEqual([]);
    expect(paramsDiffer("f()", "f(a: string)", "typescript")).toBe(true);
  });
});

describe("surfaceFromIndexRows (the working-tree side)", () => {
  test("projects rows into symbols: relative path, longest chunk, exportedness", () => {
    const abs = path.join(SEP, "proj", "src", "api.ts");
    const symbols = surfaceFromIndexRows(path.join(SEP, "proj"), [
      {
        filePath: abs,
        language: "typescript",
        symbolName: "Kept.m",
        symbolType: "method",
        startLine: 10,
        endLine: 12,
        content: "  m(): number { return 1; }",
      },
      {
        filePath: abs,
        language: "typescript",
        symbolName: "pub",
        symbolType: "function",
        startLine: 1,
        endLine: 3,
        content: "export function pub(a: string): string { return a; }",
      },
      {
        filePath: abs,
        language: "typescript",
        symbolName: "pub",
        symbolType: "function",
        startLine: 1,
        endLine: 8,
        content: "export function pub(a: string): string {\n  return a;\n}\n",
      },
      // A row without a name/lines (character-fallback chunks) is skipped.
      { filePath: abs, startLine: 1, endLine: 1, content: "plain text" },
    ]);
    expect(symbols.map((s) => s.symbolName)).toEqual(["Kept.m", "pub"]); // path, then name
    const pub = symbols.find((s) => s.symbolName === "pub")!;
    expect(pub.exported).toBe(true);
    expect(pub.signature).toBe("export function pub(a: string): string");
    expect(symbols.find((s) => s.symbolName === "Kept.m")!.exported).toBe(false);
  });
});

// --------------------------------------------------- 2. the git helpers

const HOME = isolatedHome;
const SEP = path.sep;
const REPO = mkdtempSync(path.join(tmpdir(), "cidx-apidiff-"));

/** Runs git in the fixture repo, throwing on failure (test helper). */
function git(args: string[]): string {
  const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
function commit(msg: string): void {
  git(["add", "-A"]);
  git(["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", msg]);
}

/** The fixture's source file at v1 (kept in sync with the assertions below). */
const API_V1 = [
  "export function kept(a: string): string {",
  "  return a;",
  "}",
  "",
  "export function removed(x: number): number {",
  "  return x;",
  "}",
  "",
  "export function renamedOld(x: number): number {",
  "  return x;",
  "}",
  "",
  "export function changedArity(a: string): string {",
  "  return a;",
  "}",
  "",
  "export function onlyDefaultChanged(a: string, b: number = 1): string {",
  "  return a;",
  "}",
  "",
  "export function bodyOnlyChanged(a: string): string {",
  "  return a + 'v1';",
  "}",
  "",
  "export function widened(a: string): void {",
  "  return;",
  "}",
  "",
  "function privateStable(v: string): void {",
  "  return;",
  "}",
  "",
  "export class Client {",
  "  version(): string { return '1'; }",
  "}",
].join("\n");

/**
 * The same file at v2: a rename, an arity change, a default-only change, a
 * body-only change, a dropped `export`, an addition — and two unchanged symbols.
 */
const API_V2 = [
  "export function kept(a: string): string {",
  "  return a;",
  "}",
  "",
  "export function renamedNew(x: number): number {",
  "  return x;",
  "}",
  "",
  "export function changedArity(a: string, b: number): string {",
  "  return a;",
  "}",
  "",
  "export function onlyDefaultChanged(a: string, b: number = 2): string {",
  "  return a;",
  "}",
  "",
  "export function bodyOnlyChanged(a: string): string {",
  "  return a + 'v2';",
  "}",
  "",
  "function widened(a: string): void {",
  "  return;",
  "}",
  "",
  "function privateStable(v: string): void {",
  "  return;",
  "}",
  "",
  "export class Client {",
  "  version(): string { return '2'; }",
  "}",
  "",
  "export function addedNew(z: boolean): boolean {",
  "  return z;",
  "}",
].join("\n");

const BROKEN = "export function broken( {\n  return 1;\n";
const PY_V2 = "def py_only(a):\n    return a\n";

beforeAll(async () => {
  git(["init", "-b", "main"]);
  mkdirSync(path.join(REPO, "src"), { recursive: true });
  writeFileSync(path.join(REPO, "src", "api.ts"), API_V1);
  writeFileSync(path.join(REPO, "src", "broken.ts"), BROKEN);
  writeFileSync(path.join(REPO, "README.md"), "# fixture\n");
  commit("v1");
  git(["tag", "v1"]);

  writeFileSync(path.join(REPO, "src", "api.ts"), API_V2);
  rmSync(path.join(REPO, "src", "broken.ts"));
  writeFileSync(path.join(REPO, "src", "extra.py"), PY_V2);
  commit("v2");
  git(["tag", "v2"]);

  await db.initDB();
});

afterAll(() => {
  // HOME (the shared isolated root) is removed by the preload's own hook.
  rmSync(REPO, { recursive: true, force: true });
});

describe("git ref helpers", () => {
  test("safeGitRef accepts refnames/SHAs and rejects option-, glob- and object-syntax", () => {
    expect(safeGitRef("v1.2.0")).toBe("v1.2.0");
    expect(safeGitRef("HEAD~3")).toBe("HEAD~3");
    expect(safeGitRef("feature/x")).toBe("feature/x");
    expect(safeGitRef("refs/tags/v1")).toBe("refs/tags/v1");
    expect(safeGitRef("3f2a1b9c")).toBe("3f2a1b9c");
    // Rejected: parsed as an option / a glob / an object:path spec / a reflog.
    for (const bad of ["", "  ", "-upload-pack=x", "--all", "a:b", "a..b", "a b", "a*", "v1.lock", ".", "@{1}"]) {
      expect(safeGitRef(bad)).toBeNull();
    }
  });

  test("gitRefExists reports an unknown ref (false) instead of throwing", async () => {
    expect(await gitRefExists(REPO, "v1")).toBe(true);
    expect(await gitRefExists(REPO, "v2")).toBe(true);
    expect(await gitRefExists(REPO, "no-such-ref")).toBe(false);
  });

  test("gitLsTreeFiles lists the files tracked at a ref", async () => {
    const v1 = await gitLsTreeFiles(REPO, "v1");
    expect(v1).toEqual(["README.md", "src/api.ts", "src/broken.ts"]);
    const v2 = await gitLsTreeFiles(REPO, "v2");
    expect(v2).toContain("src/extra.py");
    expect(v2).not.toContain("src/broken.ts");
    expect(await gitLsTreeFiles(REPO, "nope")).toBeNull();
  });

  test("gitShowFile returns the ref's content (not the working tree's)", async () => {
    const old = await gitShowFile(REPO, "v1", "src/api.ts");
    expect(old).toContain("export function removed(x: number): number");
    expect(old).not.toContain("addedNew");
    expect(await gitShowFile(REPO, "v1", "src/missing.ts")).toBeNull();
  });
});

describe("fileSurface (the historical parse)", () => {
  test("extracts the same symbols the indexer would, with exportedness", async () => {
    const s = await fileSurface("src/api.ts", API_V1);
    expect(s.parseFailed).toBe(false);
    const names = s.symbols.map((x) => x.symbolName).sort();
    expect(names).toContain("kept");
    expect(names).toContain("removed");
    expect(names).toContain("Client"); // a small class is ONE chunk (methods stay inside it)
    const kept = s.symbols.find((x) => x.symbolName === "kept")!;
    expect(kept.exported).toBe(true);
    expect(kept.signature).toBe("export function kept(a: string): string");
    expect(s.symbols.find((x) => x.symbolName === "privateStable")!.exported).toBe(false);
  });

  test("a non-AST extension is out of scope; a parse error is REPORTED, not skipped", async () => {
    expect(await fileSurface("README.md", "# fixture\n")).toEqual({ symbols: [], parseFailed: false });
    const broken = await fileSurface("src/broken.ts", BROKEN);
    expect(broken.symbols).toHaveLength(0);
    expect(broken.parseFailed).toBe(true); // → `unparsed` in the report, never a silent skip
  });
});

describe("extractRefSurface", () => {
  test("only AST extensions are scanned; unparsed files are listed", async () => {
    const s = await extractRefSurface(REPO, "v1");
    expect(s).not.toBeNull();
    expect(s!.scannedFiles).toBe(2); // README.md has no grammar
    expect(s!.truncated).toBe(false);
    expect(s!.unparsed).toEqual([{ path: "src/broken.ts", reason: "parse-error" }]);
    expect(s!.symbols.every((x) => x.language.length > 0)).toBe(true);
  });

  test("the file cap is reported, not silent", async () => {
    const s = await extractRefSurface(REPO, "v2", { maxFiles: 1 });
    expect(s!.truncated).toBe(true);
    expect(s!.scannedFiles).toBe(1);
  });

  test("an unlistable ref yields null (the engine reports unknownRef)", async () => {
    expect(await extractRefSurface(REPO, "gone")).toBeNull();
  });
});

// ---------------------------------------------------------- 3. the engine

const DB_PATH = path.join(HOME, `apidiff-${randomUUID()}.db`);
const NON_REPO = mkdtempSync(path.join(tmpdir(), "cidx-apidiff-norepo-"));

let registry: InstanceType<typeof Registry>;
let manager: InstanceType<typeof IndexManager>;

/** Index rows for `src/api.ts` at v2, exactly as the indexer would have written them. */
async function indexRowsAtV2(): Promise<CodeRecord[]> {
  const abs = path.join(REPO, "src", "api.ts");
  const chunks = await chunkCode(abs, API_V2);
  return chunks.map((c, i) => ({
    id: `api.ts#${i}`,
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
  })) as CodeRecord[];
}

beforeAll(async () => {
  // The fixture table must land in the throw-away root, never the user's
  // `~/.cidx`: if the preload ever stops running, fail here instead of
  // silently writing into real user data.
  expect(CONFIG.DB_DIR.startsWith(HOME)).toBe(true);
  registry = new Registry(DB_PATH);
  registry.upsertIndex({
    name: "fixture",
    path: REPO,
    tableName: "idx_apidiff_fixture",
    status: "ready",
    fileCount: 1,
    chunkCount: 1,
    embedModel: null,
    embedDim: null,
    lastIndexedAt: null,
    createdAt: 1,
    error: null,
  });
  registry.upsertIndex({
    name: "plain",
    path: NON_REPO,
    tableName: "idx_apidiff_plain",
    status: "ready",
    fileCount: 0,
    chunkCount: 0,
    embedModel: null,
    embedDim: null,
    lastIndexedAt: null,
    createdAt: 1,
    error: null,
  });
  await db.insertChunks("idx_apidiff_fixture", await indexRowsAtV2());
  manager = new IndexManager(registry, new JobQueue());
});

afterAll(() => {
  registry.close();
  rmSync(DB_PATH, { force: true });
  rmSync(NON_REPO, { recursive: true, force: true });
});

type ApiDiffReport = Awaited<ReturnType<InstanceType<typeof IndexManager>["getApiDiff"]>>;

describe("getApiDiff — engine across two tags (head = a ref)", () => {
  let diff: ApiDiffReport;
  /** The same diff, with the `unchanged` symbols listed too. */
  let diffAll: ApiDiffReport;

  beforeAll(async () => {
    // head = a git ref, so the whole diff comes from git, never from the index.
    diff = await manager.getApiDiff("fixture", "v1", { head: "v2" });
    diffAll = await manager.getApiDiff("fixture", "v1", { head: "v2", includeUnchanged: true });
  });

  test("the report identifies both refs and is not flagged partial", () => {
    expect(diff.project).toBe("fixture");
    expect(diff.base).toBe("v1");
    expect(diff.head).toBe("v2");
    expect(diff.headIsIndex).toBe(false);
    expect(diff.notARepo).toBeUndefined();
    expect(diff.unknownRef).toBeUndefined();
    expect(diff.truncated).toBe(false);
    expect(diff.scannedFiles).toBe(4); // 2 AST files at v1 + 2 at v2
  });

  test("the broken file is reported as unparsed, not skipped", () => {
    expect(diff.unparsedFiles).toEqual([{ path: "src/broken.ts", reason: "parse-error", side: "base" }]);
  });

  test("removed / renamed / added / signature-changed / narrowed are all classified", () => {
    const byName = new Map(diff.entries.map((e) => [e.symbolName, e]));
    expect(byName.get("removed")!.kind).toBe("removed");
    expect(byName.get("removed")!.breaking).toBe(true);
    // The rename is an honest removed + added pair.
    expect(byName.get("renamedOld")!.kind).toBe("removed");
    expect(byName.get("renamedNew")!.kind).toBe("added");
    // Arity change → breaking, with the before/after signatures side by side.
    const arity = byName.get("changedArity")!;
    expect(arity.kind).toBe("signature-changed");
    expect(arity.breaking).toBe(true);
    expect(sigOf(arity, "base")).toContain("(a: string)");
    expect(sigOf(arity, "head")).toContain("(a: string, b: number)");
    expect(byName.get("addedNew")!.kind).toBe("added");
    expect(byName.get("addedNew")!.breaking).toBe(false);
    // Dropped `export` → visibility narrowed, breaking.
    const widened = byName.get("widened")!;
    expect(widened.kind).toBe("visibility-narrowed");
    expect(widened.base!.exported).toBe(true);
    expect(widened.head!.exported).toBe(false);
    // A body-only change and a default-value change are NOT breaking: the
    // declaration head is what compares, so both classify as unchanged.
    const allByName = new Map(diffAll.entries.map((e) => [e.symbolName, e]));
    expect(allByName.get("bodyOnlyChanged")!.kind).toBe("unchanged");
    expect(allByName.get("onlyDefaultChanged")!.kind).toBe("unchanged");
    expect(allByName.get("kept")!.kind).toBe("unchanged");
    expect(allByName.get("Client")!.kind).toBe("unchanged");
    // The Python-only file exists at v2 only → its symbol is added.
    expect(byName.get("py_only")!.language).toBe("python");
  });

  test("counts cover the whole diff and breaking-first order holds", () => {
    expect(diff.counts).toEqual({
      removed: 2,
      signatureChanged: 1,
      visibilityNarrowed: 1,
      added: 3,
      unchanged: diff.counts.unchanged,
      breaking: 4,
    });
    expect(diff.counts.unchanged).toBeGreaterThan(3);
    // With `includeUnchanged` the same counts come out of the same entries.
    expect(diffAll.counts).toEqual(diff.counts);
    const firstNonBreaking = diffAll.entries.findIndex((e) => !e.breaking);
    expect(diffAll.entries.slice(0, firstNonBreaking).every((e) => e.breaking)).toBe(true);
  });

  test("exportedOnly keeps everything public on at least one side (incl. narrowed)", async () => {
    const r = await manager.getApiDiff("fixture", "v1", { head: "v2", exportedOnly: true });
    const names = new Set(r.entries.map((e) => e.symbolName));
    expect(names.has("removed")).toBe(true);
    expect(names.has("widened")).toBe(true); // exported at base → still visible
    expect(names.has("privateStable")).toBe(false); // private on both sides
    expect(names.has("renamedNew")).toBe(true);
  });

  test("a limit caps the entries and flags the report; counts stay complete", async () => {
    const r = await manager.getApiDiff("fixture", "v1", { head: "v2", limit: 2 });
    expect(r.entries).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.counts.breaking).toBe(4);
  });

  test("maxFiles bounds the historical pass", async () => {
    const r = await manager.getApiDiff("fixture", "v1", { head: "v2", maxFiles: 1 });
    expect(r.scannedFiles).toBe(2);
    expect(r.truncated).toBe(true);
  });

  test("a non-repo project reports notARepo; a bad ref is reported, not thrown", async () => {
    const plain = await manager.getApiDiff("plain", "v1");
    expect(plain.notARepo).toBe(true);
    expect(plain.entries).toEqual([]);

    const unknown = await manager.getApiDiff("fixture", "v1", { head: "ghost" });
    expect(unknown.unknownRef).toBe("head");
    const unknownBase = await manager.getApiDiff("fixture", "ghost");
    expect(unknownBase.unknownRef).toBe("base");

    const invalid = await manager.getApiDiff("fixture", "--upload-pack=x");
    expect(invalid.invalidRef).toBe("base");
    await expect(manager.getApiDiff("nope", "v1")).rejects.toThrow("Index not found");
  });
});

describe("getApiDiff — engine with the default head (the index = working tree)", () => {
  let diff: ApiDiffReport;
  let diffAll: ApiDiffReport;

  beforeAll(async () => {
    // The fixture's working tree sits at v2, and the index holds exactly the v2
    // rows of src/api.ts — so this diff must agree with the head-ref one there.
    diff = await manager.getApiDiff("fixture", "v1");
    diffAll = await manager.getApiDiff("fixture", "v1", { includeUnchanged: true });
  });

  test("the head side is labelled as the index and the src/api.ts verdict is identical", () => {
    expect(diff.headIsIndex).toBe(true);
    expect(diff.head).toBe("(working tree)");
    const api = diff.entries.filter((e) => e.relativePath === "src/api.ts");
    const byName = new Map(api.map((e) => [e.symbolName, e]));
    expect(byName.get("removed")!.kind).toBe("removed");
    expect(byName.get("renamedOld")!.kind).toBe("removed");
    expect(byName.get("renamedNew")!.kind).toBe("added");
    expect(byName.get("changedArity")!.kind).toBe("signature-changed");
    expect(byName.get("widened")!.kind).toBe("visibility-narrowed");
    // `src/extra.py` is NOT in the index, so it contributes nothing on the head side.
    expect(byName.has("py_only")).toBe(false);
    expect(diff.counts.breaking).toBe(4);
  });

  test("unchanged symbols are counted but not listed unless asked", () => {
    expect(diff.counts.unchanged).toBeGreaterThan(0);
    expect(diff.entries.every((e) => e.kind !== "unchanged")).toBe(true);
    const allByName = new Map(diffAll.entries.map((e) => [e.symbolName, e]));
    expect(allByName.get("kept")!.kind).toBe("unchanged");
    expect(allByName.get("Client")!.kind).toBe("unchanged");
    expect(diffAll.entries[0]!.breaking).toBe(true); // still breaking-first
  });
});
