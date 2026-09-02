import { test, expect, describe } from "bun:test";
import { cosine, selectMMR } from "../src/utils/mmr";

// A small 2-D fixture. v0 and v1 are duplicates; v2 is orthogonal; v3 ≈ v0.
const v0 = [1, 0];
const v1 = [1, 0];
const v2 = [0, 1];
const v3 = [0.9, 0.1];
const vecs = [v0, v1, v2, v3];
const rel = [0.9, 0.8, 0.5, 0.4]; // v0 most relevant, then its duplicate v1

describe("cosine", () => {
  test("identical → 1, orthogonal → 0, opposite → -1", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
  test("zero-length vector → 0 (no NaN)", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("selectMMR", () => {
  test("λ=1 → pure relevance (top-K by relevance, duplicates kept)", () => {
    expect(selectMMR(vecs, rel, 2, 1)).toEqual([0, 1]);
  });

  test("λ=0.5 → keeps the most relevant then diversifies away from the duplicate", () => {
    // First pick: most relevant (v0). Second pick: NOT the duplicate v1 (cos 1.0
    // penalizes it); the orthogonal v2 wins despite lower relevance.
    expect(selectMMR(vecs, rel, 2, 0.5)).toEqual([0, 2]);
  });

  test("relevance scale is irrelevant (min-max normalized)", () => {
    // Same selection as λ=1 above even though the scale is 1000×.
    const scaled = selectMMR(vecs, rel.map((r) => r * 1000), 2, 1);
    expect(scaled).toEqual([0, 1]);
  });

  test("constant relevance → pure diversity among equals", () => {
    // All equally relevant: the duplicate v1 must be delayed in favor of v2/v3.
    const out = selectMMR(vecs, [1, 1, 1, 1], 3, 0.5);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(0); // first pick (tie → iteration order)
    expect(out[1]).toBe(2); // orthogonal beats the duplicate
  });

  test("never returns duplicate indices", () => {
    for (const lambda of [0, 0.3, 0.5, 0.7, 1]) {
      const out = selectMMR(vecs, rel, 4, lambda);
      expect(new Set(out).size).toBe(out.length);
      expect(out).toHaveLength(4);
    }
  });

  test("limit > pool size → clamps to pool size", () => {
    expect(selectMMR(vecs, rel, 99, 0.5)).toHaveLength(4);
  });

  test("empty pool → []", () => {
    expect(selectMMR([], [], 5, 0.5)).toEqual([]);
  });

  test("limit 0 → []", () => {
    expect(selectMMR(vecs, rel, 0, 0.5)).toEqual([]);
  });
});
