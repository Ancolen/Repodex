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

describe("chunkCode — doc formats (xml/rst)", () => {
  // Godot engine class reference dump (`godot --doctool`), trimmed to shape.
  const CLASS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<class name="EventBus" inherits="Node" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <brief_description>Signal-only communication bus.</brief_description>
  <description>Every combat system talks through signals on this bus.</description>
  <method name="connect">
    <return type="Error" />
    <param index="0" name="signal" type="StringName" />
    <description>Connects a callable to the named signal.</description>
  </method>
</class>
`;

  test("xml chunks via fallback with the 'xml' language label", async () => {
    const chunks = await chunkCode("doc/classes/EventBus.xml", CLASS_XML);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.language).toBe("xml");
      expect(c.symbolName).toBeUndefined();
    }
    expect(chunks.some((c) => c.content.includes("brief_description"))).toBe(true);
  });

  test("rst chunks via fallback with the 'rst' language label", async () => {
    const rst = [
      "Telegraphs",
      "=========",
      "",
      "Every attack must be readable before it lands.",
      "",
      "* windup + ground marker + sound",
      "",
    ].join("\n");
    const chunks = await chunkCode("docs/combat/telegraphs.rst", rst);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.language).toBe("rst");
      expect(c.symbolName).toBeUndefined();
    }
  });

  test("md keeps its 'markdown' label (was unlabeled before TEXT_LANG_BY_EXT)", async () => {
    const chunks = await chunkCode("README.md", "# Title\n\nSome prose.\n");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.language).toBe("markdown");
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
