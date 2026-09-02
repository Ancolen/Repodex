/**
 * Advanced behaviors of the Chunker: split large text with overlap, split large class
 * into methods, merge split parts in fileOutline,
 * fallback for extensions without grammar, and line numbering accuracy.
 */
import { test, expect, describe } from "bun:test";
import { chunkCode, fileOutline } from "../src/chunking/chunker";
import { CONFIG } from "../src/config";

const MAX = CONFIG.MAX_CHUNK_SIZE;

describe("large content splitting (splitLarge / overlap)", () => {
  test("a single function exceeding MAX is split into multiple overlapping parts", async () => {
    // A single TS function with a body larger than MAX.
    const body = Array.from({ length: 400 }, (_, i) => `  const v${i} = ${i} * 2;`).join("\n");
    const src = `export function huge() {\n${body}\n}\n`;
    expect(src.length).toBeGreaterThan(MAX);

    const chunks = await chunkCode("huge.ts", src);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk must not exceed MAX.
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(MAX);
      expect(c.startLine).toBeGreaterThanOrEqual(1);
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
    }
  });

  test("large file without grammar (.md) is split into character-based parts", async () => {
    const big = "line content ".repeat(400); // ~5600 char, no newline
    const chunks = await chunkCode("README.md", big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.symbolName === undefined)).toBe(true);
    // In character fallback, the first chunk starts at line 1.
    expect(chunks[0]!.startLine).toBe(1);
  });

  test("there is overlap between consecutive chunks (contents intersect)", async () => {
    const line = "abcdefghij".repeat(20); // 200 char/line
    const big = Array.from({ length: 60 }, () => line).join("\n"); // ~12k char
    const chunks = await chunkCode("notes.md", big);
    expect(chunks.length).toBeGreaterThan(1);
    // Since STEP < MAX, the end of chunk i and the start of chunk i+1 must intersect:
    // total covered length will be greater than the file length (proof of overlap).
    const totalLen = chunks.reduce((s, c) => s + c.content.length, 0);
    expect(totalLen).toBeGreaterThan(big.length);
  });
});

describe("large class is split into methods (emitClass)", () => {
  test("class larger than MAX: header + each method as separate chunk, methods named Class.method", async () => {
    // Make each method body large so that the class exceeds MAX.
    const methodBody = Array.from({ length: 40 }, (_, i) => `    this.x += ${i};`).join("\n");
    const mk = (name: string) => `  ${name}(): void {\n${methodBody}\n  }`;
    const src = `export class Big {\n${mk("alpha")}\n${mk("beta")}\n${mk("gamma")}\n}\n`;
    expect(src.length).toBeGreaterThan(MAX);

    const chunks = await chunkCode("big.ts", src);
    const names = chunks.map((c) => c.symbolName).filter(Boolean) as string[];
    // Methods should output with qualified names like "Big.alpha".
    expect(names).toContain("Big.alpha");
    expect(names).toContain("Big.beta");
    expect(names).toContain("Big.gamma");
    // Method chunks have 'method' type.
    const methodChunks = chunks.filter((c) => c.symbolName?.startsWith("Big."));
    expect(methodChunks.length).toBe(3);
    expect(methodChunks.every((c) => c.symbolType === "method")).toBe(true);
  });

  test("small class remains as a single chunk (not split into methods)", async () => {
    const src = `export class Small {\n  a() { return 1; }\n  b() { return 2; }\n}\n`;
    const chunks = await chunkCode("small.ts", src);
    const classChunks = chunks.filter((c) => c.symbolType === "class");
    expect(classChunks.length).toBe(1);
    expect(classChunks[0]!.symbolName).toBe("Small");
    // Methods do not output as separate chunks (class is below MAX).
    expect(chunks.some((c) => c.symbolName === "Small.a")).toBe(false);
  });
});

describe("fileOutline", () => {
  test("parts of the same split symbol merge into a single entry (line range expands)", async () => {
    const body = Array.from({ length: 400 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const src = `export function huge() {\n${body}\n}\n`;
    const chunks = await chunkCode("huge.ts", src);
    // The huge function should be split into multiple parts.
    const hugeChunks = chunks.filter((c) => c.symbolName === "huge");
    expect(hugeChunks.length).toBeGreaterThan(1);

    const outline = await fileOutline("huge.ts", src);
    const hugeEntries = outline.filter((o) => o.symbolName === "huge");
    // There should be a single 'huge' entry in the outline, spanning all parts.
    expect(hugeEntries.length).toBe(1);
    expect(hugeEntries[0]!.startLine).toBe(1);
    expect(hugeEntries[0]!.endLine).toBeGreaterThan(10);
  });

  test("returns empty outline for a file without symbols", async () => {
    expect(await fileOutline("x.md", "plain text\nanother line")).toEqual([]);
    expect(await fileOutline("x.ts", "")).toEqual([]);
  });
});

describe("line numbering accuracy", () => {
  test("startLine of the function matches the actual line in the source", async () => {
    const src = `// line 1\n// line 2\nfunction onThird() {\n  return 3;\n}\n`;
    const chunks = await chunkCode("x.ts", src);
    const fn = chunks.find((c) => c.symbolName === "onThird");
    expect(fn).toBeDefined();
    expect(fn!.startLine).toBe(3);
  });
});
