/**
 * Dead-code tests: pure-logic coverage of scoring + exported detection + the
 * single-pass reference counter. No Ollama, no LanceDB.
 *
 * The definition-rule counting cases are the load-bearing ones: a recursive call
 * inside a body must count as a reference (no false-dead), while the declaration
 * line itself is not double-counted, and identically-named symbols across files
 * share a count (collision → conservative: neither is flagged).
 */
import { test, expect, describe } from "bun:test";
import {
  detectExported,
  scoreDeadCode,
  countReferences,
  matchNamesFor,
  buildNameRegex,
  type CountSymbol,
  type CountChunk,
} from "../src/core/deadcode";

// ---- detectExported (per language, recovered from chunk content) ----

describe("detectExported", () => {
  test("JS/TS: `export` wrapper at chunk head", () => {
    expect(detectExported("foo", "function", "typescript", "export function foo() {}")).toBe(true);
    expect(detectExported("foo", "function", "typescript", "export default function foo() {}")).toBe(true);
    expect(detectExported("foo", "function", "typescript", "function foo() {}")).toBe(false);
  });
  test("Rust: `pub fn/struct/…`", () => {
    expect(detectExported("foo", "function", "rust", "pub fn foo() {}")).toBe(true);
    expect(detectExported("Foo", "struct", "rust", "pub struct Foo {}")).toBe(true);
    expect(detectExported("foo", "function", "rust", "fn foo() {}")).toBe(false);
  });
  test("Go: uppercase-first name = exported", () => {
    expect(detectExported("Handler", "function", "go", "func Handler() {}")).toBe(true);
    expect(detectExported("handler", "function", "go", "func handler() {}")).toBe(false);
  });
  test("Java/C#: `public` keyword", () => {
    expect(detectExported("foo", "function", "java", "public static void foo() {}")).toBe(true);
    expect(detectExported("foo", "function", "c_sharp", "public void Foo() {}")).toBe(true);
  });
  test("C/Python/Ruby: unreliable → false (never guesses exported)", () => {
    expect(detectExported("foo", "function", "c", "int foo(void) {}")).toBe(false);
    expect(detectExported("foo", "function", "python", "def foo(): pass")).toBe(false);
    expect(detectExported("foo", "function", "ruby", "def foo; end")).toBe(false);
  });
  test("GDScript: class_name registers globally (exported-equivalent)", () => {
    expect(detectExported("Player", "class", "gdscript", "class_name Player\nextends Node2D\n")).toBe(true);
    expect(detectExported("foo", "function", "gdscript", "func foo():\n\treturn 1\n")).toBe(false);
  });
});

// ---- scoreDeadCode (multi-signal demotions) ----

describe("scoreDeadCode", () => {
  const base = {
    symbolType: "function",
    language: "typescript",
    content: "function unusedHelper() {}",
    referenceCount: 0,
    ownerClassReferenced: false,
    isCommonName: false,
  };

  test("plain zero-ref non-exported helper → likely dead", () => {
    const r = scoreDeadCode({ ...base, symbolName: "unusedHelper" });
    expect(r.confidence).toBe(80);
    expect(r.category).toBe("likely dead");
    expect(r.signals.map((s) => s.signal)).toEqual([]);
  });

  test("exported demotes −30 → uncertain", () => {
    const r = scoreDeadCode({
      ...base,
      symbolName: "api",
      content: "export function api() {}",
    });
    expect(r.confidence).toBe(50);
    expect(r.category).toBe("uncertain");
    expect(r.signals.map((s) => s.signal)).toContain("exported");
  });

  test("polymorphic (@Override) demotes −35 → uncertain/review", () => {
    const r = scoreDeadCode({
      ...base,
      symbolType: "method",
      content: "  @Override\n  protected void onEvent() {}",
      symbolName: "onEvent",
    });
    // exported? no. owner-class? no. poly? yes (−35). dynamic-hook onEvent? matches on[A-Z_] (−25)... but
    // onEvent also hits constructor? no. So −35 −25 = 80−60 = 20.
    expect(r.signals.map((s) => s.signal)).toContain("polymorphic");
    expect(r.confidence).toBeLessThanOrEqual(40);
    expect(r.category).toBe("review");
  });

  test("dynamic-hook name (handle*) demotes −25", () => {
    const r = scoreDeadCode({ ...base, symbolName: "handleClick" });
    expect(r.signals.map((s) => s.signal)).toContain("dynamic-hook-name");
    expect(r.confidence).toBe(55); // 80 − 25
  });

  test("constructor-like name demotes −30 and is not also double-counted as hook", () => {
    const r = scoreDeadCode({ ...base, symbolName: "create" });
    const sigs = r.signals.map((s) => s.signal);
    expect(sigs).toContain("constructor-like");
    expect(sigs).not.toContain("dynamic-hook-name");
    expect(r.confidence).toBe(50); // 80 − 30
  });

  test("method with referenced owner class demotes −20", () => {
    const r = scoreDeadCode({
      ...base,
      symbolType: "method",
      symbolName: "Foo.bar",
      ownerClassReferenced: true,
    });
    expect(r.signals.map((s) => s.signal)).toContain("owner-class-referenced");
    expect(r.confidence).toBe(60); // 80 − 20
  });

  test("Python private (_foo) boosts +10", () => {
    const r = scoreDeadCode({ ...base, language: "python", symbolName: "_helper" });
    expect(r.signals.map((s) => s.signal)).toContain("private-by-convention");
    expect(r.confidence).toBe(90);
  });

  // Regression lock: GDScript's leading underscore is the virtual/override marker,
  // NOT a privacy signal — boosting it toward "dead" would flag every engine-invoked
  // method. (Python's +10 rule is deliberately NOT copied.)
  test("GDScript single underscore does NOT get private-by-convention", () => {
    const r = scoreDeadCode({ ...base, language: "gdscript", symbolName: "_collect" });
    expect(r.signals.map((s) => s.signal)).not.toContain("private-by-convention");
  });

  test("Godot virtuals are dynamic hooks (never dead on 0 refs)", () => {
    for (const name of ["_ready", "_init", "_process", "_physics_process", "_input", "_draw"]) {
      const r = scoreDeadCode({ ...base, language: "gdscript", symbolName: name });
      expect(r.signals.map((s) => s.signal)).toContain("dynamic-hook-name");
    }
  });

  test("GDScript _on_* signal handlers demote −25 (wired via editor/scenes)", () => {
    const r = scoreDeadCode({ ...base, language: "gdscript", symbolName: "_on_Button_pressed" });
    expect(r.signals.map((s) => s.signal)).toContain("signal-handler-convention");
    expect(r.confidence).toBe(55); // 80 − 25
  });

  test("common-name demotes −15", () => {
    const r = scoreDeadCode({ ...base, symbolName: "init", isCommonName: true });
    // init → constructor-like (−30) + common-name (−15) = 35
    expect(r.signals.map((s) => s.signal)).toContain("common-name");
    expect(r.confidence).toBe(35);
  });

  test("clamp never exceeds [0,100]", () => {
    const r = scoreDeadCode({
      symbolType: "trait",
      language: "rust",
      content: "pub trait T : X {} trait Y {}",
      symbolName: "render", // exported +30 demote, poly −35, hook −25 = 80 −90 → clamp 0... but exported on trait "pub trait" matches
      referenceCount: 0,
      ownerClassReferenced: false,
      isCommonName: true,
    });
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(100);
  });
});

// ---- matchNamesFor + buildNameRegex ----

describe("matchNamesFor / buildNameRegex", () => {
  test("dotted name yields full + bare segment", () => {
    expect(matchNamesFor("Foo.bar")).toEqual(["Foo.bar", "bar"]);
    expect(matchNamesFor("plain")).toEqual(["plain"]);
  });
  test("regex is whole-identifier and longest-literal wins", () => {
    const re = buildNameRegex(["a", "abc", "ab"])!;
    expect(re).not.toBeNull();
    // re is global → stateful; reset lastIndex before each exec (countReferences does this per line).
    re.lastIndex = 0;
    expect(re.exec("foo abc baz")?.[1]).toBe("abc"); // longest alternation matches
    re.lastIndex = 0;
    expect(re.exec("foo ab baz")?.[1]).toBe("ab");
    re.lastIndex = 0;
    expect(re.exec("xabcd")).toBeNull(); // "abc" not whole-identifier (trailing 'd'); "a"/"ab" blocked by leading 'x'
  });
  test("empty input → null regex", () => {
    expect(buildNameRegex([])).toBeNull();
  });
});

// ---- countReferences (definition rule) ----

function sym(key: string, matchNames: string[], filePath: string, line: number): CountSymbol {
  return { key, matchNames, filePath, declarationLine: line };
}
function chunk(filePath: string, startLine: number, content: string): CountChunk {
  return { filePath, startLine, content };
}

describe("countReferences — definition rule", () => {
  test("a caller bumps refCount to 1 (not dead)", () => {
    const symbols = [sym("foo@/a.ts:1", ["foo"], "/a.ts", 1)];
    const chunks = [
      chunk("/a.ts", 1, "function foo() {}"),
      chunk("/b.ts", 1, "foo();"),
    ];
    const counts = countReferences(symbols, chunks);
    expect(counts.get("foo@/a.ts:1")).toBe(1);
  });

  test("declaration line is the definition and is NOT counted", () => {
    const symbols = [sym("foo@/a.ts:1", ["foo"], "/a.ts", 1)];
    // Only the declaration exists; `foo` on line 1 is the def → 0 refs.
    const chunks = [chunk("/a.ts", 1, "function foo() {}")];
    expect(countReferences(symbols, chunks).get("foo@/a.ts:1")).toBe(0);
  });

  test("a recursive call inside the body IS counted (no false-dead on recursion)", () => {
    const symbols = [sym("fact@/a.ts:1", ["fact"], "/a.ts", 1)];
    // Line 1 = declaration (def, skipped). Line 4 = `fact(n - 1)` → a reference.
    const chunks = [chunk("/a.ts", 1, ["function fact(n) {", "  if (n <= 1) return 1;", "  return n * fact(n - 1);", "}"].join("\n"))];
    expect(countReferences(symbols, chunks).get("fact@/a.ts:1")).toBe(1);
  });

  test("dotted Class.method matches the bare segment when called on an instance", () => {
    const symbols = [sym("Foo.bar@/a.ts:1", ["Foo.bar", "bar"], "/a.ts", 1)];
    const chunks = [
      chunk("/a.ts", 1, "class Foo { bar() {} }"),
      chunk("/b.ts", 1, "const f = new Foo(); f.bar();"),
    ];
    expect(countReferences(symbols, chunks).get("Foo.bar@/a.ts:1")).toBe(1);
  });

  test("colliding name `init` in two files → both share the same refCount (collision, conservative)", () => {
    const symbols = [
      sym("init@/a.ts:1", ["init"], "/a.ts", 1),
      sym("init@/b.ts:1", ["init"], "/b.ts", 1),
    ];
    const chunks = [
      chunk("/a.ts", 1, "function init() {}"),
      chunk("/b.ts", 1, "function init() {}"),
      chunk("/c.ts", 1, "init();"), // ambiguous: counts for both
    ];
    const counts = countReferences(symbols, chunks);
    expect(counts.get("init@/a.ts:1")).toBe(1);
    expect(counts.get("init@/b.ts:1")).toBe(1);
  });

  test("no chunks / no names → 0 refs for every symbol", () => {
    const symbols = [sym("x@/a.ts:1", ["x"], "/a.ts", 1)];
    expect(countReferences(symbols, []).get("x@/a.ts:1")).toBe(0);
    expect(countReferences([], [chunk("/a.ts", 1, "x")]).size).toBe(0);
  });
});
