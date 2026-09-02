import { test, expect, describe } from "bun:test";
import { applyCharBudget, resultSize } from "../src/utils/budget";

// resultSize = content.length + context lines joined + HEADER_CHARS (120).
function mk(content: string, before: string[] = [], after: string[] = []): {
  content: string;
  contextBefore: string[];
  contextAfter: string[];
} {
  return { content, contextBefore: before, contextAfter: after };
}

describe("resultSize", () => {
  test("content length + header overhead", () => {
    expect(resultSize(mk("abcde"))).toBe(5 + 120);
  });
  test("includes before/after context joined by newline", () => {
    // before "a\nb" = 3, after "c\nd" = 3, content "x" = 1, + 120
    expect(resultSize(mk("x", ["a", "b"], ["c", "d"]))).toBe(1 + 3 + 3 + 120);
  });
  test("missing content treated as 0", () => {
    expect(resultSize({})).toBe(120);
  });
});

describe("applyCharBudget", () => {
  test("no-op when maxChars is undefined / non-finite / <= 0", () => {
    const rows = [mk("hello"), mk("world")];
    expect(applyCharBudget(rows, undefined)).toBe(rows);
    expect(applyCharBudget(rows, 0)).toBe(rows);
    expect(applyCharBudget(rows, -10)).toBe(rows);
    expect(applyCharBudget(rows, Number.NaN)).toBe(rows);
  });

  test("empty input → empty", () => {
    expect(applyCharBudget([], 1000)).toEqual([]);
  });

  test("always keeps the top result, even if it alone exceeds the budget", () => {
    const rows = [mk("x".repeat(5000))];
    expect(applyCharBudget(rows, 100)).toHaveLength(1);
    // Even when there are more results, top-1 survives a tiny budget.
    expect(applyCharBudget([mk("x".repeat(5000)), mk("y")], 1)).toHaveLength(1);
  });

  test("drops trailing whole results to fit the budget", () => {
    // Each result is 10 + 120 = 130 chars. Budget 270 fits exactly two (130+130).
    const rows = [mk("0123456789"), mk("0123456789"), mk("0123456789")];
    const out = applyCharBudget(rows, 270);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toBe(rows[1]);
  });

  test("exact boundary: budget equal to cumulative size keeps everything up to it", () => {
    // 3 × 130 = 390. Budget 390 → all three fit (<=, not <).
    const rows = [mk("0123456789"), mk("0123456789"), mk("0123456789")];
    expect(applyCharBudget(rows, 390)).toHaveLength(3);
    // Budget 389 → the third would push to 390 > 389, so only two.
    expect(applyCharBudget(rows, 389)).toHaveLength(2);
  });

  test("large budget keeps everything", () => {
    const rows = [mk("a"), mk("b"), mk("c")];
    expect(applyCharBudget(rows, 1_000_000)).toHaveLength(3);
  });
});
