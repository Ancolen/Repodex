/**
 * tree-sitter language mapping and grammar loading tests.
 */
import { test, expect, describe } from "bun:test";
import { EXT_TO_GRAMMAR, languageForExt, getParser } from "../src/chunking/tree-sitter";
import { fileOutline } from "../src/chunking/chunker";

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

  test("Godot extensions mapped correctly", () => {
    expect(EXT_TO_GRAMMAR[".gd"]).toBe("gdscript");
    // Godot text formats are char-fallback: no grammar mapping.
    expect(EXT_TO_GRAMMAR[".gdshader"]).toBeUndefined();
    expect(EXT_TO_GRAMMAR[".tscn"]).toBeUndefined();
    expect(EXT_TO_GRAMMAR[".tres"]).toBeUndefined();
    expect(EXT_TO_GRAMMAR[".godot"]).toBeUndefined();
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
    for (const ext of [".ts", ".py", ".go", ".rs", ".cs", ".java", ".cpp", ".c", ".php", ".rb", ".tsx", ".js", ".kt", ".swift", ".scala", ".gd"]) {
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

// tree-sitter-lua was removed because it nondeterministically dropped symbols
// after OTHER grammars parsed on the shared WASM heap (see docs/status.md).
// Every new grammar must pass this interleaving suite — one isolated green
// parse is not enough.
describe("shared-parser determinism (Lua precedent)", () => {
  const gd = `class_name Demo
signal ready_now(count: int)

func _ready() -> void:
	print("x")

func helper(a: int) -> int:
	return a * 2

class Inner extends Resource:
	func keep() -> void:
		pass
`;
  const ts = `export function one(): number { return 1; }
export class Thing { m(): number { return 2; } }
`;
  const py = `def foo(x):
    return x

class Bar:
    def baz(self):
        return 1
`;
  const go = `package m

func Do() int { return 1 }
`;
  const rs = `pub struct S { pub x: i32 }
pub fn f(s: S) -> i32 { s.x }
`;
  const rb = `def helper
  1
end

class Q
  def hi
    2
  end
end
`;

  test("gdscript outline is stable across interleaved grammar switches", async () => {
    const snap = await fileOutline("demo.gd", gd);
    expect(snap.length).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      await fileOutline("a.ts", ts);
      await fileOutline("b.py", py);
      await fileOutline("c.go", go);
      await fileOutline("d.rs", rs);
      await fileOutline("e.rb", rb);
      const again = await fileOutline("demo.gd", gd);
      expect(again).toEqual(snap);
    }
  });

  test("other grammars stay stable after gdscript parses (no reverse corruption)", async () => {
    const snapTs = await fileOutline("a.ts", ts);
    const snapPy = await fileOutline("b.py", py);
    const snapGo = await fileOutline("c.go", go);
    const snapRs = await fileOutline("d.rs", rs);
    const snapRb = await fileOutline("e.rb", rb);
    await fileOutline("demo.gd", gd);
    await fileOutline("demo.gd", gd);
    expect(await fileOutline("a.ts", ts)).toEqual(snapTs);
    expect(await fileOutline("b.py", py)).toEqual(snapPy);
    expect(await fileOutline("c.go", go)).toEqual(snapGo);
    expect(await fileOutline("d.rs", rs)).toEqual(snapRs);
    expect(await fileOutline("e.rb", rb)).toEqual(snapRb);
  });
});
