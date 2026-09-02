import { test, expect, describe } from "bun:test";
import { chunkCode, fileOutline } from "../src/chunking/chunker";

const TS_SOURCE = `import { foo } from "./foo";

export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private total = 0;

  add(n: number): void {
    this.total += n;
  }

  reset(): void {
    this.total = 0;
  }
}
`;

describe("chunkCode", () => {
  test("returns empty array for empty content", async () => {
    expect(await chunkCode("x.ts", "")).toEqual([]);
    expect(await chunkCode("x.ts", "   \n  ")).toEqual([]);
  });

  test("generates chunks at TypeScript function/class boundaries and provides line numbers", async () => {
    const chunks = await chunkCode("calc.ts", TS_SOURCE);
    expect(chunks.length).toBeGreaterThan(0);

    const names = chunks.map((c) => c.symbolName).filter(Boolean);
    expect(names).toContain("add");
    expect(names).toContain("Calculator");

    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
      expect(c.content.length).toBeGreaterThan(0);
    }

    // 'add' function should be near the beginning of the file
    const addFn = chunks.find((c) => c.symbolName === "add" && c.symbolType === "function");
    expect(addFn).toBeDefined();
    expect(addFn!.startLine).toBeLessThan(6);
  });

  test("character-based fallback for extension without grammar (symbols are empty)", async () => {
    const chunks = await chunkCode("notes.txt", "line1\nline2\nline3\n");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.symbolName).toBeUndefined();
    expect(chunks[0]!.startLine).toBe(1);
  });
});

describe("fileOutline", () => {
  test("returns the symbol outline of the file sorted by line number", async () => {
    const outline = await fileOutline("calc.ts", TS_SOURCE);
    const names = outline.map((o) => o.symbolName);
    expect(names).toContain("add");
    expect(names).toContain("Calculator");
    // Ascending by line number
    for (let i = 1; i < outline.length; i++) {
      expect(outline[i]!.startLine).toBeGreaterThanOrEqual(outline[i - 1]!.startLine);
    }
  });
});
