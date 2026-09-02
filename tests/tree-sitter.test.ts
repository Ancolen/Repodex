/**
 * tree-sitter language mapping and grammar loading tests.
 */
import { test, expect, describe } from "bun:test";
import { EXT_TO_GRAMMAR, languageForExt, getParser } from "../src/chunking/tree-sitter";

describe("EXT_TO_GRAMMAR mapping", () => {
  test("common extensions point to correct grammar", () => {
    expect(EXT_TO_GRAMMAR[".ts"]).toBe("typescript");
    expect(EXT_TO_GRAMMAR[".tsx"]).toBe("tsx");
    expect(EXT_TO_GRAMMAR[".js"]).toBe("javascript");
    expect(EXT_TO_GRAMMAR[".jsx"]).toBe("javascript");
    expect(EXT_TO_GRAMMAR[".mjs"]).toBe("javascript");
    expect(EXT_TO_GRAMMAR[".cjs"]).toBe("javascript");
    expect(EXT_TO_GRAMMAR[".py"]).toBe("python");
    expect(EXT_TO_GRAMMAR[".go"]).toBe("go");
    expect(EXT_TO_GRAMMAR[".rs"]).toBe("rust");
    expect(EXT_TO_GRAMMAR[".java"]).toBe("java");
    expect(EXT_TO_GRAMMAR[".cs"]).toBe("c_sharp");
    expect(EXT_TO_GRAMMAR[".php"]).toBe("php");
    expect(EXT_TO_GRAMMAR[".rb"]).toBe("ruby");
  });

  test("C/C++ extension families mapped correctly", () => {
    for (const e of [".cpp", ".cc", ".cxx", ".hpp", ".hh"]) {
      expect(EXT_TO_GRAMMAR[e]).toBe("cpp");
    }
    expect(EXT_TO_GRAMMAR[".c"]).toBe("c");
    expect(EXT_TO_GRAMMAR[".h"]).toBe("c");
  });

  test("Kotlin/Swift/Scala extensions mapped correctly", () => {
    expect(EXT_TO_GRAMMAR[".kt"]).toBe("kotlin");
    expect(EXT_TO_GRAMMAR[".kts"]).toBe("kotlin");
    expect(EXT_TO_GRAMMAR[".swift"]).toBe("swift");
    expect(EXT_TO_GRAMMAR[".scala"]).toBe("scala");
    expect(EXT_TO_GRAMMAR[".sc"]).toBe("scala");
  });

  test("unmapped extensions are undefined (will fall back)", () => {
    expect(EXT_TO_GRAMMAR[".json"]).toBeUndefined();
    expect(EXT_TO_GRAMMAR[".md"]).toBeUndefined();
    expect(EXT_TO_GRAMMAR[".txt"]).toBeUndefined();
    expect(EXT_TO_GRAMMAR[".yaml"]).toBeUndefined();
  });
});

describe("languageForExt loading", () => {
  test("grammar loaded for supported extensions (non-null)", async () => {
    for (const ext of [".ts", ".py", ".go", ".rs", ".cs", ".java", ".cpp", ".c", ".php", ".rb", ".tsx", ".js", ".kt", ".swift", ".scala"]) {
      const lang = await languageForExt(ext);
      expect(lang).not.toBeNull();
    }
  });

  test("case-insensitive (.PY → python)", async () => {
    const lang = await languageForExt(".PY");
    expect(lang).not.toBeNull();
  });

  test("unsupported extension returns null", async () => {
    expect(await languageForExt(".json")).toBeNull();
    expect(await languageForExt(".md")).toBeNull();
    expect(await languageForExt(".unknownext")).toBeNull();
  });

  test("same grammar returns from cache on second call (same reference)", async () => {
    const a = await languageForExt(".ts");
    const b = await languageForExt(".ts");
    expect(a).toBe(b);
  });

  test("getParser returns a single shared instance", async () => {
    const p1 = await getParser();
    const p2 = await getParser();
    expect(p1).toBe(p2);
  });
});
