/**
 * Batched full-index commits (`replaceFileRecords`).
 *
 * The full index commits a whole SLICE of files with one delete+add pair
 * instead of one pair per file (the per-file pattern produced one dataset
 * version per file and quadratic manifest growth). These tests pin the
 * semantics that make the batched path equivalent to the single-file one:
 * every file in the slice is replaced by filePath, files outside the slice are
 * untouched, and a file that now yields no chunks is deleted.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import {
  countTableRows,
  initDB,
  insertChunks,
  replaceFileRecords,
  scanTableBatches,
  type CodeRecord,
} from "../src/services/db";

const TABLE = "idx_batch_replace_test";

function rec(filePath: string, i: number): CodeRecord {
  return {
    id: `${filePath}#${i}`,
    filePath,
    content: `content ${filePath} ${i}`,
    vector: [0.1, 0.2, 0.3, 0.4],
    language: "typescript",
    symbolName: `s${i}`,
    symbolType: "function",
    startLine: i,
    endLine: i,
    doc: null,
    doc_vector: null,
    id_terms: null,
  };
}

async function rowsByFile(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await scanTableBatches(TABLE, 64, async (rows) => {
    for (const r of rows) counts[r.filePath] = (counts[r.filePath] ?? 0) + 1;
  });
  return counts;
}

beforeAll(async () => {
  await initDB();
});

describe("replaceFileRecords — batched full-index commits", () => {
  test("creates the table from the first write batch", async () => {
    await replaceFileRecords(TABLE, [rec("a.ts", 0), rec("a.ts", 1)], ["a.ts"]);
    expect(await countTableRows(TABLE)).toBe(2);
    expect(await rowsByFile()).toEqual({ "a.ts": 2 });
  });

  test("replaces every file in the slice and leaves outside files intact", async () => {
    await replaceFileRecords(TABLE, [rec("a.ts", 0), rec("b.ts", 0), rec("b.ts", 1)], ["a.ts", "b.ts"]);
    expect(await countTableRows(TABLE)).toBe(3);
    expect(await rowsByFile()).toEqual({ "a.ts": 1, "b.ts": 2 });
  });

  test("a delete-only batch removes a file's rows without touching the rest", async () => {
    await replaceFileRecords(TABLE, [], ["b.ts"]);
    expect(await countTableRows(TABLE)).toBe(1);
    expect(await rowsByFile()).toEqual({ "a.ts": 1 });
  });

  test("insertChunks keeps the single-file contract (delete by filePath, then add)", async () => {
    await insertChunks(TABLE, [rec("a.ts", 0), rec("a.ts", 1), rec("a.ts", 2)]);
    expect((await rowsByFile())["a.ts"]).toBe(3);
    expect(await countTableRows(TABLE)).toBe(3);
  });

  test("a delete-only batch on a missing table is a no-op", async () => {
    await replaceFileRecords("idx_batch_replace_missing", [], ["x.ts"]);
    expect(await countTableRows("idx_batch_replace_missing")).toBe(0);
  });
});
