/**
 * File collection / ignore logic tests for indexer.ts (does not require embedding).
 * Sets up a temporary directory tree; verifies that collectFiles collects allowed extensions
 * and respects ignoredDirs + .gitignore + .cidxignore rules.
 */
import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIgnore, collectFiles, isPathIgnored, indexFile } from "../src/services/indexer";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-idx-"));
  const w = (rel: string, content = "x") => {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  // Allowed source files
  w("src/app.ts", "export function a() {}");
  w("src/util.py", "def b(): pass");
  w("src/lib.go", "package main");
  w("README.md", "# doc");
  w("config.json", "{}");
  // Non-allowed extension
  w("notes.txt", "ignore me");
  w("image.png", "binary");
  // Inside global ignoredDirs (node_modules, .git, dist, target)
  w("node_modules/dep/index.js", "module");
  w(".git/HEAD", "ref");
  w("dist/bundle.js", "built");
  w("target/release/app.rs", "built");
  // Ignored by .gitignore
  w(".gitignore", "secret/\n*.log\n");
  w("secret/key.ts", "const k = 1");
  w("app.log", "logline");
  // Ignored by .cidxignore
  w(".cidxignore", "vendor/\n");
  w("vendor/v.ts", "vendored");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isPathIgnored", () => {
  test("path outside baseDir is not ignored (false)", async () => {
    const ig = await buildIgnore(root);
    expect(isPathIgnored(ig, root, "/etc/passwd")).toBe(false);
  });

  test("path under ignoredDir is ignored", async () => {
    const ig = await buildIgnore(root);
    expect(isPathIgnored(ig, root, join(root, "node_modules/dep/index.js"))).toBe(true);
    expect(isPathIgnored(ig, root, join(root, "dist/bundle.js"))).toBe(true);
  });
});

describe("collectFiles", () => {
  test("only files with allowed extensions that are not ignored are collected", async () => {
    const ig = await buildIgnore(root);
    const files = await collectFiles(root, ig);
    const rel = files.map((f) => f.slice(root.length + 1)).sort();

    // Allowed sources included
    expect(rel).toContain("src/app.ts");
    expect(rel).toContain("src/util.py");
    expect(rel).toContain("src/lib.go");
    expect(rel).toContain("README.md");
    expect(rel).toContain("config.json");

    // Non-allowed extensions excluded
    expect(rel).not.toContain("notes.txt");
    expect(rel).not.toContain("image.png");

    // ignoredDirs excluded
    expect(rel.some((r) => r.startsWith("node_modules/"))).toBe(false);
    expect(rel.some((r) => r.startsWith(".git/"))).toBe(false);
    expect(rel.some((r) => r.startsWith("dist/"))).toBe(false);
    expect(rel.some((r) => r.startsWith("target/"))).toBe(false);

    // .gitignore excluded
    expect(rel).not.toContain("secret/key.ts");
    // .cidxignore excluded
    expect(rel).not.toContain("vendor/v.ts");
  });

  test("only files in allowSet are collected (git-tracked simulation)", async () => {
    const ig = await buildIgnore(root);
    const only = new Set([join(root, "src/app.ts")]);
    const files = await collectFiles(root, ig, only);
    expect(files).toEqual([join(root, "src/app.ts")]);
  });

  test("unreachable subdirectory is silently skipped (upper scan continues)", async () => {
    const ig = await buildIgnore(root);
    // Non-existent root -> empty list (does not throw).
    const files = await collectFiles(join(root, "no-such-directory"), ig);
    expect(files).toEqual([]);
  });
});

describe("collectFiles — maxFileSizeBytes guard (oversized-file filter)", () => {
  let sroot: string;
  const BIG = "x".repeat(240); // 240 bytes
  const EXACT = `// ${"y".repeat(102)}\n`; // exactly 120 bytes
  const SMALL = "export const a = 1;"; // 19 bytes

  beforeAll(() => {
    sroot = mkdtempSync(join(tmpdir(), "mcp-idx-size-"));
    writeFileSync(join(sroot, "small.ts"), SMALL);
    writeFileSync(join(sroot, "exact.ts"), EXACT);
    writeFileSync(join(sroot, "big.ts"), BIG);
  });
  afterAll(() => rmSync(sroot, { recursive: true, force: true }));

  test("no limit (undefined / 0) collects everything", async () => {
    const ig = await buildIgnore(sroot);
    for (const limit of [undefined, 0]) {
      const rel = (await collectFiles(sroot, ig, null, null, limit)).map((f) => f.slice(sroot.length + 1)).sort();
      expect(rel).toEqual(["big.ts", "exact.ts", "small.ts"]);
    }
  });

  test("files strictly larger than the limit are absent", async () => {
    const ig = await buildIgnore(sroot);
    const rel = (await collectFiles(sroot, ig, null, null, 120)).map((f) => f.slice(sroot.length + 1)).sort();
    // 240 > 120 excluded; 120 == limit kept (the rule is strictly-larger).
    expect(rel).toEqual(["exact.ts", "small.ts"]);
  });

  test("a tight limit keeps only the small file", async () => {
    const ig = await buildIgnore(sroot);
    const rel = (await collectFiles(sroot, ig, null, null, 20)).map((f) => f.slice(sroot.length + 1));
    expect(rel).toEqual(["small.ts"]);
  });
});

describe("indexFile — maxFileSizeBytes guard", () => {
  test("oversized file is skipped before chunking, flagged and logged", async () => {
    const target = { indexName: "size-guard-test", tableName: "idx_size_guard_test", baseDir: root };
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await indexFile(target, join(root, "src/app.ts"), undefined, undefined, undefined, null, 10);
      expect(r).toEqual({ chunks: 0, dim: null, skippedOversized: true });
      expect(errSpy).toHaveBeenCalled();
      const log = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(log).toContain("exceeds maxFileSizeBytes");
      expect(log).toContain("src/app.ts");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("indexFile — AbortSignal (mid-file cancellation guarantee)", () => {
  test("returns immediately with an already aborted signal (no embedding/DB)", async () => {
    const target = { indexName: "abort-test", tableName: "idx_abort_test", baseDir: root };
    const ac = new AbortController();
    ac.abort(); // abort initially
    // Give a real allowed file; because signal.aborted is true, indexFile
    // must return {chunks: 0, dim: null} without going to embedding or DB at all.
    const r = await indexFile(target, join(root, "src/app.ts"), undefined, ac.signal);
    expect(r).toEqual({ chunks: 0, dim: null });
  });
});
