/**
 * Context-pack composition tests (A1 `get_context_pack`).
 *
 * The pack is assembly, not a new engine, so these pin the two composition rules
 * from the proposal:
 *   - a pack's OUTLINE leg reflects the hit's FILE (real chunker outline, capped to
 *     the hit's neighborhood — `sliceOutlineForHit`);
 *   - a pack's IMPORTS leg resolves to INDEXED files only (extract → resolve →
 *     `resolvedImports`, no phantom edges, capped with `importsTruncated`).
 * Pure legs: no Ollama, no LanceDB, no daemon.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileOutline, type OutlineEntry } from "../src/chunking/chunker";
import { extractImports } from "../src/chunking/imports";
import { buildFileIndex, resolveImports } from "../src/core/resolve";
import { resolvedImports, sliceOutlineForHit } from "../src/core/index-manager";
import type { DependencyEdge } from "../src/core/index-manager";

// ------------------------------------------------------- outline neighborhood

const OUTLINE: OutlineEntry[] = [
  { symbolName: "Helper", symbolType: "class", startLine: 1, endLine: 20 },
  { symbolName: "alpha", symbolType: "function", startLine: 22, endLine: 30 },
  { symbolName: "beta", symbolType: "function", startLine: 32, endLine: 40 },
  { symbolName: "gamma", symbolType: "function", startLine: 42, endLine: 50 },
  { symbolName: "delta", symbolType: "function", startLine: 52, endLine: 60 },
  { symbolName: "Tail", symbolType: "class", startLine: 62, endLine: 90 },
];

describe("sliceOutlineForHit", () => {
  test("the symbol containing the chunk comes first", () => {
    const s = sliceOutlineForHit(OUTLINE, 24, 28); // inside alpha
    expect(s[0]).toEqual({ symbolName: "alpha", symbolType: "function", startLine: 22, endLine: 30 });
  });

  test("every symbol overlapping the chunk range is kept, then the next ones below it", () => {
    const s = sliceOutlineForHit(OUTLINE, 24, 44); // alpha, beta, gamma overlap
    expect(s.map((o) => o.symbolName)).toEqual(["alpha", "beta", "gamma", "delta", "Tail"]);
  });

  test("symbols entirely ABOVE the chunk are dropped (not its neighborhood)", () => {
    const s = sliceOutlineForHit(OUTLINE, 42, 50);
    const names = s.map((o) => o.symbolName);
    expect(names).not.toContain("Helper");
    expect(names).not.toContain("alpha");
    expect(names).toEqual(["gamma", "delta", "Tail"]);
  });

  test("the 'below' window is capped separately from the overlapping run", () => {
    const s = sliceOutlineForHit(OUTLINE, 24, 28, 12, 2);
    expect(s.map((o) => o.symbolName)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("the whole neighborhood is capped at max", () => {
    const s = sliceOutlineForHit(OUTLINE, 24, 44, 3, 4);
    expect(s).toHaveLength(3);
    expect(s.map((o) => o.symbolName)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("file order is preserved", () => {
    const s = sliceOutlineForHit(OUTLINE, 24, 44);
    const starts = s.map((o) => o.startLine);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  test("a chunk spanning nothing returns empty; no line info passes the outline through (capped)", () => {
    expect(sliceOutlineForHit([], 10, 20)).toEqual([]);
    expect(sliceOutlineForHit(OUTLINE, undefined, undefined, 2).map((o) => o.symbolName)).toEqual([
      "Helper",
      "alpha",
    ]);
  });
});

// --------------------------------------------------------------- imports leg

/** Keeps only edges that resolved to an indexed file, capped, overflow reported. */
describe("resolvedImports", () => {
  const edge = (raw: string, status: DependencyEdge["status"], relPath?: string): DependencyEdge => {
    const e: DependencyEdge = { raw, language: "typescript", line: 1, status };
    if (relPath) e.relativePath = relPath;
    return e;
  };
  const edges = [
    edge("./a", "resolved", "src/a.ts"),
    edge("react", "external"),
    edge("./missing", "unresolved"),
    edge("./b", "resolved", "src/b.ts"),
  ];

  test("external / unresolved legs never reach the pack (indexed files only)", () => {
    const r = resolvedImports(edges, 10);
    expect(r.imports.map((e) => e.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.imports.every((e) => e.status === "resolved")).toBe(true);
    expect(r.truncated).toBe(false);
  });

  test("caps at the limit and reports the overflow instead of dropping it silently", () => {
    const r = resolvedImports(edges, 1);
    expect(r.imports).toHaveLength(1);
    expect(r.truncated).toBe(true);
    const exact = resolvedImports(edges, 2);
    expect(exact.imports).toHaveLength(2);
    expect(exact.truncated).toBe(false);
  });
});

// -------------------------------------------- real legs against a real fixture

const ROOT = mkdtempSync(path.join(tmpdir(), "cidx-pack-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const FIXTURE = [
  "/** Drives the fixture: one entry point, one class, one free function. */",
  "export function runJob(id: string): string {",
  "  return `job:${id}`;",
  "}",
  "",
  "export class JobQueue {",
  "  enqueue(id: string): void {}",
  "  size(): number { return 0; }",
  "}",
  "",
  "export function drainAll(): void {}",
].join("\n");

describe("pack legs against the fixture file", () => {
  const file = path.join(ROOT, "fixture.ts");
  writeFileSync(file, FIXTURE);

  test("the outline leg reflects the hit's file", async () => {
    const outline = await fileOutline(file, FIXTURE);
    const names = outline.map((o) => o.symbolName);
    expect(names).toEqual(["runJob", "JobQueue", "drainAll"]);
    expect(outline.map((o) => o.symbolType)).toEqual(["function", "class", "function"]);

    // A hit inside JobQueue.enqueue: the pack's outline must be THIS file's shape,
    // capped to the hit's neighborhood (JobQueue + what follows it).
    const hit = outline.find((o) => o.symbolName === "JobQueue")!;
    const neighborhood = sliceOutlineForHit(outline, hit.startLine, hit.endLine);
    expect(neighborhood.map((o) => o.symbolName)).toEqual(["JobQueue", "drainAll"]);
    // ...and a hit on the first symbol keeps its own file-order neighborhood.
    const firstHit = outline[0]!;
    expect(sliceOutlineForHit(outline, firstHit.startLine, firstHit.endLine).map((o) => o.symbolName)).toEqual([
      "runJob",
      "JobQueue",
      "drainAll",
    ]);
  });

  test("the imports leg resolves to indexed files only", async () => {
    const mainFile = path.join(ROOT, "main.ts");
    const mainBody = [
      'import { runJob } from "./fixture";',
      'import { nope } from "./notindexed";',
      'import React from "react";',
      "",
      "export function main(): string { return runJob('x'); }",
    ].join("\n");
    writeFileSync(mainFile, mainBody);

    // The project's indexed set: the fixture is indexed, "notindexed.ts" is NOT.
    const indexed = [file];
    const index = buildFileIndex(indexed);
    const specs = await extractImports(mainFile, mainBody);
    expect(specs.length).toBe(3);

    const leg = resolvedImports(
      resolveImports(specs, ROOT, index, mainFile).map((d) => {
        const e: DependencyEdge = { raw: d.raw, language: d.language, line: d.line, status: d.status };
        if (d.resolvedPath) e.path = d.resolvedPath;
        if (d.relativePath) e.relativePath = d.relativePath;
        return e;
      }),
      10,
    );
    expect(leg.imports.map((e) => path.relative(ROOT, e.path ?? ""))).toEqual(["fixture.ts"]);
    // The acceptance rule: every leg edge points at a file in the indexed set.
    for (const e of leg.imports) {
      expect(indexed).toContain(e.path ?? "");
    }
    expect(leg.truncated).toBe(false);
  });

  test("outline + imports legs stay empty for a file with neither (no leg, no failure)", async () => {
    const plain = path.join(ROOT, "plain.ts");
    writeFileSync(plain, "const x = 1;\n");
    const outline = await fileOutline(plain, "const x = 1;\n");
    expect(outline).toEqual([]);
    expect(sliceOutlineForHit(outline, 1, 1)).toEqual([]);

    const specs = await extractImports(plain, "const x = 1;\n");
    expect(specs).toHaveLength(0);
  });
});
