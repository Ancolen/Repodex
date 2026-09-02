import { test, expect, describe } from "bun:test";
import { rrfMerge } from "../src/utils/rrf";
import { buildWhere } from "../src/services/db";

describe("rrfMerge", () => {
  const keyOf = (x: { id: string }) => x.id;

  test("an item high up in both lists gets the highest score", () => {
    const vec = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const fts = [{ id: "b" }, { id: "a" }, { id: "d" }];
    const merged = rrfMerge([vec, fts], keyOf);
    // a and b are at the top in both lists; they should be the first two results.
    const top2 = merged.slice(0, 2).map((m) => m.item.id).sort();
    expect(top2).toEqual(["a", "b"]);
    // Scores in descending order
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i]!.score).toBeLessThanOrEqual(merged[i - 1]!.score);
    }
  });

  test("deduplication: same id returned only once", () => {
    const merged = rrfMerge([[{ id: "x" }], [{ id: "x" }]], keyOf);
    expect(merged.length).toBe(1);
    expect(merged[0]!.item.id).toBe("x");
  });

  test("empty lists are safe", () => {
    expect(rrfMerge<{ id: string }>([], keyOf)).toEqual([]);
    expect(rrfMerge([[], []], keyOf)).toEqual([]);
  });

  test("rank effect softens as k increases", () => {
    const list = [{ id: "a" }, { id: "b" }];
    const small = rrfMerge([list], keyOf, 1);
    const large = rrfMerge([list], keyOf, 1000);
    // Score difference between the first two items decreases with large k
    const diffSmall = small[0]!.score - small[1]!.score;
    const diffLarge = large[0]!.score - large[1]!.score;
    expect(diffLarge).toBeLessThan(diffSmall);
  });
});

describe("buildWhere", () => {
  test("undefined if no filter", () => {
    expect(buildWhere()).toBeUndefined();
    expect(buildWhere({})).toBeUndefined();
  });

  test("language + symbolType equality condition", () => {
    const w = buildWhere({ language: "python", symbolType: "class" });
    expect(w).toBe("language = 'python' AND symbolType = 'class'");
  });

  test("pathGlob: wildcard '*' → LIKE '%'", () => {
    expect(buildWhere({ pathGlob: "src/*" })).toBe("filePath LIKE 'src/%' ESCAPE '\\'");
  });

  test("pathGlob: without wildcard → substring (%...%)", () => {
    expect(buildWhere({ pathGlob: "auth" })).toBe("filePath LIKE '%auth%' ESCAPE '\\'");
  });

  test("pathGlob: literal '_' is escaped (does not become LIKE wildcard)", () => {
    // '_' in 'my_file' should be a literal in LIKE, not "any single character".
    expect(buildWhere({ pathGlob: "my_file" })).toBe("filePath LIKE '%my\\_file%' ESCAPE '\\'");
  });

  test("single quote is escaped against SQL injection", () => {
    const w = buildWhere({ language: "py'x" });
    expect(w).toBe("language = 'py''x'");
  });
});
