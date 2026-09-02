import { test, expect, describe } from "bun:test";
import { formatBatchResults } from "../src/server/format";
import type { BatchSearchGroup } from "../src/core/index-manager";

function result(file: string, content: string): BatchSearchGroup["results"][number] {
  return {
    id: `${file}-0`,
    filePath: file,
    content,
    vector: [0.1],
    language: "typescript",
    symbolName: "fn",
    symbolType: "function",
    startLine: 1,
    endLine: 3,
    project: "demo",
  };
}

describe("formatBatchResults", () => {
  test("empty groups → aggregate 'not found' message", () => {
    expect(formatBatchResults([])).toBe("No relevant code chunk found for any query.");
  });

  test("single group renders a '## Query' header + the per-query body", () => {
    const out = formatBatchResults([{ query: "login", results: [result("a.ts", "code()")] }]);
    expect(out).toContain('## Query: "login" (1 result)'); // singular
    expect(out).toContain("a.ts:1-3");
    expect(out).toContain("code()");
  });

  test("pluralizes '(N results)' when N !== 1", () => {
    const out = formatBatchResults([
      {
        query: "auth",
        results: [result("a.ts", "x"), result("b.ts", "y")],
      },
    ]);
    expect(out).toContain('## Query: "auth" (2 results)');
  });

  test("multiple groups are separated and each has its own header", () => {
    const out = formatBatchResults([
      { query: "login", results: [result("a.ts", "aa")] },
      { query: "logout", results: [result("b.ts", "bb")] },
    ]);
    expect(out).toContain('## Query: "login"');
    expect(out).toContain('## Query: "logout"');
    expect(out).toContain("aa");
    expect(out).toContain("bb");
    // Two groups → exactly one group separator block ("---") between them.
    expect(out.split("\n---\n\n").length).toBeGreaterThanOrEqual(2);
  });

  test("a group with zero results shows a per-query 'not found' under its header", () => {
    const out = formatBatchResults([
      { query: "hit", results: [result("a.ts", "x")] },
      { query: "miss", results: [] },
    ]);
    expect(out).toContain('## Query: "miss" (0 results)');
    expect(out).toContain("No relevant code chunk found.");
    // The other group's results are still present.
    expect(out).toContain("a.ts");
  });
});
