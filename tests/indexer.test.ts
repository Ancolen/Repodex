/**
 * File collection / ignore logic tests for indexer.ts (does not require embedding).
 * Sets up a temporary directory tree; verifies that collectFiles collects allowed extensions
 * and respects ignoredDirs + .gitignore + .mcpignore rules.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
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
  // Ignored by .mcpignore
  w(".mcpignore", "vendor/\n");
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
    // .mcpignore excluded
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
