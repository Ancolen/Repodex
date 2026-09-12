/**
 * `IndexManager.findReferences` engine tests over a real fixture project.
 *
 * The honesty contract is the point: `total` counts every distinct occurrence
 * found BEFORE the limit cut, `truncated` says when the limit bit (no silent
 * caps), and `includeDocs` gates doc artifacts (.md/.mdx/.xml/.rst) as
 * evidence. The fixture's sqlite registry and LanceDB table live on the
 * throw-away root pinned by the `[test]` preload (see tests/apidiff.test.ts
 * for the rationale). No Ollama — the vectors are dummies.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const { randomUUID } = await import("node:crypto");
const db = await import("../src/services/db");
const CFG = (await import("../src/config")).CONFIG;
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { chunkCode } = await import("../src/chunking/chunker");
const { isolatedHome } = await import("./helpers/isolated-cidx-home");

describe("IndexManager.findReferences — honesty counters + includeDocs (real fixture)", () => {
  const HOME = isolatedHome;
  const PROJECT = mkdtempSync(path.join(os.tmpdir(), "cidx-refs-proj-"));
  const DB_PATH = path.join(HOME, `refs-${randomUUID()}.db`);
  const TABLE = "idx_refs_fixture";

  const LIB = [
    "export function realEngine(input: string): string {",
    "  return realEngine(input.trim());",
    "}",
    "",
    "export function caller() {",
    "  return realEngine('x');",
    "}",
  ].join("\n");

  const GUIDE = "# Guide\nUse `realEngine` everywhere.\n";

  let registry: InstanceType<typeof Registry>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(HOME)).toBe(true);
    await db.initDB();
    mkdirSync(path.join(PROJECT, "docs"), { recursive: true });
    mkdirSync(path.join(PROJECT, "src"), { recursive: true });
    writeFileSync(path.join(PROJECT, "src", "lib.ts"), LIB);
    writeFileSync(path.join(PROJECT, "docs", "guide.md"), GUIDE);

    registry = new Registry(DB_PATH);
    registry.upsertIndex({
      name: "reffix",
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
    registry.setFileMtime("reffix", path.join(PROJECT, "src", "lib.ts"), 1);

    const rows: Record<string, unknown>[] = [];
    for (const [abs, text] of [
      [path.join(PROJECT, "src", "lib.ts"), LIB],
      [path.join(PROJECT, "docs", "guide.md"), GUIDE],
    ] as const) {
      const chunks = await chunkCode(abs, text);
      chunks.forEach((c, i) => {
        rows.push({
          id: `${path.basename(abs)}#${i}`,
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
        });
      });
    }
    await db.insertChunks(TABLE, rows);
    manager = new IndexManager(registry, new JobQueue());
  });

  afterAll(() => {
    manager?.stopAll?.();
    registry?.close();
    rmSync(DB_PATH, { force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("limit cut is honest: total is counted before the cap, truncated says so", async () => {
    const r = await manager.findReferences("realEngine", "reffix", 2);
    // The fixture has ≥ 3 distinct code occurrences (definition, recursion, call site).
    expect(r.total).toBeGreaterThanOrEqual(3);
    expect(r.refs).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  test("below the limit: everything kept, nothing truncated", async () => {
    const r = await manager.findReferences("realEngine", "reffix", 50);
    expect(r.refs).toHaveLength(r.total);
    expect(r.truncated).toBe(false);
    // Grouped per file:line, deterministic order.
    const sorted = [...r.refs].sort(
      (a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.line - b.line),
    );
    expect(r.refs).toEqual(sorted);
  });

  test("doc artifacts are evidence by default and excludable via includeDocs:false", async () => {
    const withDocs = await manager.findReferences("realEngine", "reffix", 50);
    expect(withDocs.refs.some((ref) => ref.filePath.endsWith(".md"))).toBe(true);

    const codeOnly = await manager.findReferences("realEngine", "reffix", 50, { includeDocs: false });
    expect(codeOnly.refs.some((ref) => ref.filePath.endsWith(".md"))).toBe(false);
    expect(codeOnly.total).toBeLessThan(withDocs.total);
    expect(codeOnly.total).toBeGreaterThanOrEqual(3);
  });

  test("unknown project → the self-healing error", async () => {
    await expect(manager.findReferences("realEngine", "nope")).rejects.toThrow(/Index not found: nope/);
  });
});