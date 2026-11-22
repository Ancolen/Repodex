/**
 * Duplicate native-index cleanup plan (2.10.1) — `cidx doctor --fix`'s pure
 * decision layer. Groups by (column set, index type), keeps the best-covered
 * index, never mixes index types (an FTS and an ANN on one column serve
 * different search legs and are not redundant).
 */
import { describe, test, expect } from "bun:test";
import { planDuplicateIndexDrops, type NativeIndexInfo } from "../src/core/index-dedupe";

function ix(name: string, column: string, indexType = "IVF_PQ"): NativeIndexInfo {
  return { name, columns: [column], indexType };
}

describe("planDuplicateIndexDrops", () => {
  test("keeps the best-covered index and drops the rest", () => {
    const plans = planDuplicateIndexDrops(
      [ix("vector_a", "vector"), ix("vector_b", "vector"), ix("vector_c", "vector")],
      new Map([
        ["vector_a", 100],
        ["vector_b", 200],
        ["vector_c", 150],
      ]),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({
      columns: ["vector"],
      indexType: "IVF_PQ",
      action: "drop",
      keep: "vector_b",
      drop: ["vector_a", "vector_c"],
    });
  });

  test("a shared native name plans a rebuild — dropIndex would remove the only index", () => {
    const plans = planDuplicateIndexDrops(
      [ix("vector_idx", "vector"), ix("vector_idx", "vector")],
      new Map([
        ["vector_idx", 240117],
      ]),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({
      columns: ["vector"],
      indexType: "IVF_PQ",
      action: "rebuild",
      keep: "vector_idx",
      drop: [],
    });
  });

  test("a mix of shared and distinct names still rebuilds (never a partial drop)", () => {
    const plans = planDuplicateIndexDrops(
      [ix("vector_idx", "vector"), ix("vector_idx", "vector"), ix("other", "vector")],
      new Map(),
    );
    expect(plans[0]?.action).toBe("rebuild");
    expect(plans[0]?.drop).toEqual([]);
  });

  test("unknown coverage never beats a known one; a full tie keeps the earliest", () => {
    const known = planDuplicateIndexDrops(
      [ix("a", "vector"), ix("b", "vector")],
      new Map<string, number | null>([
        ["a", null],
        ["b", 10],
      ]),
    );
    expect(known[0]?.keep).toBe("b");
    expect(known[0]?.drop).toEqual(["a"]);

    const tie = planDuplicateIndexDrops(
      [ix("a", "vector"), ix("b", "vector")],
      new Map([
        ["a", null],
        ["b", null],
      ]),
    );
    expect(tie[0]?.keep).toBe("a");
    expect(tie[0]?.drop).toEqual(["b"]);
  });

  test("different index types on one column are never grouped", () => {
    const plans = planDuplicateIndexDrops(
      [ix("ann", "vector", "IVF_PQ"), ix("fts", "vector", "FTS")],
      new Map([
        ["ann", 10],
        ["fts", 10],
      ]),
    );
    expect(plans).toEqual([]);
  });

  test("a single index, and a different column, yield no plan", () => {
    expect(planDuplicateIndexDrops([ix("only", "vector")], new Map())).toEqual([]);
    expect(
      planDuplicateIndexDrops([ix("v", "vector"), ix("d", "doc_vector")], new Map()),
    ).toEqual([]);
  });

  test("multi-column sets are grouped by their sorted column list", () => {
    const plans = planDuplicateIndexDrops(
      [
        { name: "a", columns: ["content", "doc"], indexType: "FTS" },
        { name: "b", columns: ["doc", "content"], indexType: "FTS" },
      ],
      new Map(),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.columns).toEqual(["content", "doc"]);
    expect(plans[0]?.drop).toEqual(["b"]);
  });
});
