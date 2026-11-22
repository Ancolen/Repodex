/**
 * ANN/FTS coverage repair (2.10.0).
 *
 * LanceDB adds new rows to an existing index only through native `optimize()`;
 * these tests pin the measured semantics the maintenance path depends on:
 *   - new rows land BEHIND an existing FTS index (coverage gap),
 *   - `compactTable` (optimize) closes that gap,
 *   - an index that reports 0 indexed rows over a non-empty table is rebuilt
 *     deterministically by `ensureFtsIndex` (`createIndex(..., { replace: true })`).
 *
 * Real temp-LanceDB tables through the project's own helpers; fixed 4-dim
 * vectors, no embedding backend.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import type { CodeRecord } from "../src/services/db";

const db = await import("../src/services/db");
const { isolatedHome } = await import("./helpers/isolated-cidx-home");

function record(file: string, chunk: number): CodeRecord {
  return {
    id: `${file}#${chunk}`,
    filePath: file,
    content: `export function fn_${chunk}() { return ${chunk}; }`,
    vector: [0.1, 0.2, 0.3, 0.4],
    language: "typescript",
    symbolName: `fn_${chunk}`,
    symbolType: "function",
    startLine: 1,
    endLine: 2,
    doc: null,
    doc_vector: null,
    id_terms: null,
  };
}

function rows(prefix: string, count: number, base = 0): CodeRecord[] {
  return Array.from({ length: count }, (_, i) => record(`/proj/src/${prefix}_${i}.ts`, base + i));
}

beforeAll(async () => {
  await db.initDB();
  expect(isolatedHome.length).toBeGreaterThan(0);
});

describe("indexCoverage / auto-repair (real temp LanceDB)", () => {
  test("a gap appears after rows land behind the FTS index, and optimize closes it", async () => {
    const table = "cov_gap";
    await db.insertChunks(table, rows("base", 20));
    await db.ensureFtsIndex(table);

    const full = await db.indexCoverage(table);
    expect(full).not.toBeNull();
    expect(full!.gapRatio).toBe(0);
    const content = full!.columns.find((c) => c.column === "content");
    expect(content?.indexedRows).toBe(20);
    expect(content?.unindexedRows).toBe(0);

    // 10 new rows behind the index (the incremental-sync/watcher shape).
    await db.insertChunks(table, rows("late", 10, 100));
    const gap = await db.indexCoverage(table);
    expect(gap!.gapRatio).toBeGreaterThan(0);
    const gapContent = gap!.columns.find((c) => c.column === "content");
    expect(gapContent?.indexedRows).toBe(20);
    expect(gapContent?.unindexedRows).toBe(10);

    // Native optimize adds the new rows to the existing index.
    await db.compactTable(table);
    const repaired = await db.indexCoverage(table);
    expect(repaired!.gapRatio).toBe(0);
    expect(repaired!.columns.find((c) => c.column === "content")?.indexedRows).toBe(30);
  }, 30_000);

  test("ensureFtsIndex rebuilds an index that reports zero coverage", async () => {
    const table = "cov_dead";
    const first = rows("old", 20);
    await db.insertChunks(table, first);
    await db.ensureFtsIndex(table);

    // Empty the table, then re-populate it: the existing index keeps 0 indexed
    // rows while the table now has data (the pathological state).
    for (const file of new Set(first.map((r) => r.filePath))) {
      await db.deleteFileRecords(table, file);
    }
    await db.insertChunks(table, rows("new", 10, 200));
    const dead = await db.indexCoverage(table);
    expect(dead!.columns.find((c) => c.column === "content")?.indexedRows).toBe(0);
    expect(dead!.gapRatio).toBe(1);

    const built = await db.ensureFtsIndex(table);
    expect(built).toBeGreaterThanOrEqual(1);
    const repaired = await db.indexCoverage(table);
    expect(repaired!.gapRatio).toBe(0);
    expect(repaired!.columns.find((c) => c.column === "content")?.indexedRows).toBe(10);
  }, 30_000);

  test("a missing table returns null (honest absence, not zeros)", async () => {
    expect(await db.indexCoverage("cov_does_not_exist")).toBeNull();
  });
});
