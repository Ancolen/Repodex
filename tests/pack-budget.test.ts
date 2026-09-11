/**
 * Pack-level budget tests (`applyPackBudget` + the size estimators it uses).
 *
 * A context pack has ONE budget, applied once over the assembled entries: entries
 * are added whole, in ranked order, while the running total fits; the top entry is
 * always kept; everything after the first non-fitting entry is counted in `omitted`
 * (dropped whole — never truncated, never silently lost).
 */
import { test, expect, describe } from "bun:test";
import {
  applyPackBudget,
  importsSize,
  outlineSize,
  packEntrySize,
  resultSize,
  IMPORT_LINE_CHARS,
  OUTLINE_LINE_CHARS,
  PACK_FRAME_CHARS,
  type PackEntry,
} from "../src/utils/budget";

/** Builds a pack entry: hit content (plus optional context lines) and optional legs. */
function entry(
  content: string,
  opts?: {
    before?: string[];
    after?: string[];
    outline?: { symbolName: string; symbolType: string }[];
    imports?: { raw: string; relativePath?: string }[];
  },
): PackEntry {
  const hit: PackEntry["hit"] = { content };
  if (opts?.before) hit.contextBefore = opts.before;
  if (opts?.after) hit.contextAfter = opts.after;
  const e: PackEntry = { hit };
  if (opts?.outline) e.outline = opts.outline;
  if (opts?.imports) e.imports = opts.imports;
  return e;
}

/** entry("0123456789") → 10 content + 120 hit framing + 80 pack framing. */
const SIZE_210 = 10 + 120 + PACK_FRAME_CHARS;

describe("pack entry size", () => {
  test("hit size + pack framing", () => {
    expect(packEntrySize(entry("abcde"))).toBe(resultSize({ content: "abcde" }) + PACK_FRAME_CHARS);
  });

  test("context lines count toward the hit (whole-hit discipline)", () => {
    // content 1 + before "a\nb" 3 + after "c" 1 + 120 + 80
    expect(packEntrySize(entry("x", { before: ["a", "b"], after: ["c"] }))).toBe(1 + 3 + 1 + 120 + PACK_FRAME_CHARS);
  });

  test("outline adds one line per symbol (name + type + per-line constant)", () => {
    const outline = [
      { symbolName: "runJob", symbolType: "function" }, // 6 + 8
      { symbolName: "Job", symbolType: "class" }, // 3 + 5
    ];
    expect(outlineSize(outline)).toBe(6 + 8 + 3 + 5 + 2 * OUTLINE_LINE_CHARS);
    expect(packEntrySize(entry("x", { outline }))).toBe(packEntrySize(entry("x")) + outlineSize(outline));
  });

  test("imports add one line per edge (raw + rendered path + per-line constant)", () => {
    const imports = [{ raw: "./a", relativePath: "src/a.ts" }, { raw: "node:fs" }];
    // "./a" 3 + "src/a.ts" 8 + 30, and "node:fs" 7 + "" 0 + 30 (no path → nothing rendered)
    expect(importsSize(imports)).toBe(3 + 8 + IMPORT_LINE_CHARS + (7 + 0 + IMPORT_LINE_CHARS));
    expect(packEntrySize(entry("x", { imports }))).toBe(packEntrySize(entry("x")) + importsSize(imports));
  });

  test("absent legs contribute nothing", () => {
    expect(outlineSize(undefined)).toBe(0);
    expect(importsSize(undefined)).toBe(0);
    expect(packEntrySize(entry("x"))).toBe(packEntrySize({ hit: { content: "x" }, outline: [], imports: [] }));
  });
});

describe("applyPackBudget", () => {
  test("no-op when maxChars is unset / non-finite / <= 0 — everything kept, size still reported", () => {
    const rows = [entry("0123456789"), entry("0123456789")];
    for (const budget of [undefined, 0, -5, Number.NaN]) {
      const r = applyPackBudget(rows, budget);
      expect(r.hits).toBe(rows);
      expect(r.hits).toHaveLength(2);
      expect(r.omitted).toBe(0);
      expect(r.totalChars).toBe(2 * SIZE_210);
    }
  });

  test("empty input → empty pack", () => {
    const r = applyPackBudget([], 1000);
    expect(r.hits).toEqual([]);
    expect(r.totalChars).toBe(0);
    expect(r.omitted).toBe(0);
  });

  test("top-1 is ALWAYS kept, even when it alone exceeds the budget", () => {
    const rows = [entry("x".repeat(5000)), entry("0123456789"), entry("0123456789")];
    const r = applyPackBudget(rows, 500);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toBe(rows[0]);
    expect(r.hits[0]!.hit.content).toBe("x".repeat(5000)); // whole, not truncated
    expect(r.omitted).toBe(2);
    expect(r.totalChars).toBe(5000 + 120 + PACK_FRAME_CHARS);
  });

  test("adds whole entries while the running total fits; running-budget arithmetic holds", () => {
    const rows = [entry("0123456789"), entry("0123456789"), entry("0123456789"), entry("0123456789")];
    // 210 each: budget 420 fits exactly two (210 + 210 <= 420); the third would hit 630.
    const r = applyPackBudget(rows, 420);
    expect(r.hits).toHaveLength(2);
    expect(r.hits.every((h) => h.hit.content === "0123456789")).toBe(true);
    expect(r.omitted).toBe(2);
    expect(r.totalChars).toBe(420);
    // One char short and the second entry no longer fits.
    const tight = applyPackBudget(rows, 419);
    expect(tight.hits).toHaveLength(1);
    expect(tight.omitted).toBe(3);
    expect(tight.totalChars).toBe(210);
  });

  test("exact boundary: a budget equal to the cumulative size keeps everything", () => {
    const rows = [entry("0123456789"), entry("0123456789"), entry("0123456789")];
    const all = applyPackBudget(rows, 3 * SIZE_210);
    expect(all.hits).toHaveLength(3);
    expect(all.omitted).toBe(0);
    expect(all.totalChars).toBe(3 * SIZE_210);
  });

  test("ranked order is preserved", () => {
    const rows = [entry("aaa"), entry("bb"), entry("c")];
    const r = applyPackBudget(rows, 5000);
    expect(r.hits.map((h) => h.hit.content)).toEqual(["aaa", "bb", "c"]);
  });

  test("a big limit with a small budget degrades gracefully (top-1 + honest omitted)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => entry(`chunk-${i}`.padEnd(50, ".")));
    const r = applyPackBudget(rows, 300);
    expect(r.hits).toHaveLength(1);
    expect(r.omitted).toBe(9);
    expect(r.totalChars).toBe(packEntrySize(rows[0]!));
  });

  test("the legs count against the SAME budget: a fat outline can push a hit out", () => {
    const fatOutline = Array.from({ length: 12 }, (_, i) => ({ symbolName: `symbol${i}`, symbolType: "function" }));
    const rows = [entry("x"), entry("x", { outline: fatOutline })];
    const r = applyPackBudget(rows, 500);
    expect(r.hits).toHaveLength(1);
    expect(r.omitted).toBe(1);
    // And the arithmetic is the entry size, legs included.
    expect(r.totalChars).toBe(packEntrySize(rows[0]!));
  });

  test("no entry is ever partially included (sizes are all-or-nothing)", () => {
    const rows = [entry("a".repeat(200)), entry("b".repeat(200)), entry("c".repeat(200))];
    const r = applyPackBudget(rows, 250);
    for (const h of r.hits) {
      expect([200, 0]).toContain(h.hit.content.length);
    }
  });
});
