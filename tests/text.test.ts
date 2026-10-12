/**
 * Pure text-helper tests: signature derivation + whole-identifier line matching.
 * These back the search-result enrichment (signature) and find_references logic
 * without requiring LanceDB.
 */
import { test, expect, describe } from "bun:test";
import {
  deriveSignature,
  matchIdentifierLines,
  escapeRegExp,
  alignEndToCodePoint,
  alignStartToCodePoint,
  sanitizeLoneSurrogates,
} from "../src/utils/text";

describe("deriveSignature", () => {
  test("extracts a JS/TS function signature without the body", () => {
    const sig = deriveSignature(`function loginUser(req, res) {\n  return ok();\n}`);
    expect(sig).toBe("function loginUser(req, res)");
  });

  test("extracts a Python def signature and drops the trailing colon", () => {
    const sig = deriveSignature(`def greet(name):\n    return f"hi {name}"`);
    expect(sig).toBe("def greet(name)");
  });

  test("skips leading blank lines", () => {
    const sig = deriveSignature(`\n\n  class Animal {\n  speak() {}\n}`);
    expect(sig).toBe("class Animal");
  });

  test("collapses a multi-line signature head", () => {
    const sig = deriveSignature(`func NewServer(\n  addr string,\n) *Server {\n  return nil\n}`);
    expect(sig.startsWith("func NewServer(")).toBe(true);
    expect(sig.includes("{")).toBe(false);
  });

  test("an inline object-TYPE brace does not end the head (the checkDocs case)", () => {
    // `async checkDocs(opts: {` — the brace opens the parameter's object type,
    // not the body; the head continues until the real body brace.
    const sig = deriveSignature(
      "async checkDocs(opts: {\n    project?: string;\n    path?: string;\n}): Promise<DocCheckReport> {\n  x;",
    );
    expect(sig).toBe("async checkDocs(opts: { project?: string; path?: string; }): Promise<DocCheckReport>");
  });

  test("an Allman-style lone body brace still ends the head", () => {
    const sig = deriveSignature("function f()\n{\n  return 1;\n}");
    expect(sig).toBe("function f()");
  });

  test("a leading JSDoc block comment is not the signature (typescript)", () => {
    const sig = deriveSignature(
      "/**\n * Generic sibling of applyCharBudget.\n * @param maxChars budget\n */\nexport function applyBudgetBySize(rows: Row[], maxChars: number): void {",
      "typescript",
    );
    expect(sig).toBe("export function applyBudgetBySize(rows: Row[], maxChars: number): void");
  });

  test("a single-line block comment then the declaration (typescript)", () => {
    const sig = deriveSignature("/* keep in sync */\nfunction f(a: number) {\n  return a;\n}", "typescript");
    expect(sig).toBe("function f(a: number)");
  });

  test("line comments above the declaration are skipped (go)", () => {
    const sig = deriveSignature("// NOTE: retry with backoff.\n//go:noinline\nfunc Retry(fn func() error) error {\n\treturn fn()\n}", "go");
    expect(sig).toBe("func Retry(fn func() error) error");
  });

  test("a Python decorator + comment never becomes the signature", () => {
    const sig = deriveSignature('@app.get("/x")\n# handler for /x\ndef handler(req: Request):\n    return ok()', "python");
    expect(sig).toBe("def handler(req: Request)");
  });

  test("a bare module docstring opens nothing (python)", () => {
    const sig = deriveSignature('"""Module docstring.\n\nMore text.\n"""\ndef f():', "python");
    expect(sig).toBe("def f()");
  });

  test("a Rust attribute line is not the signature", () => {
    const sig = deriveSignature("#[derive(Debug, Clone)]\npub struct Point {\n    x: f64,\n}", "rust");
    expect(sig).toBe("pub struct Point");
  });

  test("a C# attribute line is not the signature", () => {
    const sig = deriveSignature("[Fact]\npublic void Parses_Input() {\n}", "c_sharp");
    expect(sig).toBe("public void Parses_Input()");
  });

  test("languages without a comment style keep the legacy first-line behavior", () => {
    // markdown: `#` is a heading, not a comment — legacy head collection applies untouched.
    expect(deriveSignature("# Title\n\nSome prose.", "markdown")).toBe("# Title Some prose.");
    expect(deriveSignature("# Title\n\nSome prose.")).toBe("# Title Some prose.");
  });

  test("empty content yields empty signature", () => {
    expect(deriveSignature("")).toBe("");
    expect(deriveSignature("   \n  ")).toBe("");
  });
});

describe("matchIdentifierLines", () => {
  test("matches whole identifier only, not substrings", () => {
    const content = `getUser();\ngetUserName();\nconst x = getUser;`;
    const hits = matchIdentifierLines(content, 1, "getUser");
    expect(hits.map((h) => h.line)).toEqual([1, 3]); // line 2 (getUserName) excluded
  });

  test("returns absolute line numbers using baseLine", () => {
    const content = `a\nfoo()\nbar(foo)`;
    const hits = matchIdentifierLines(content, 10, "foo");
    expect(hits.map((h) => h.line)).toEqual([11, 12]);
    expect(hits[0]!.text).toBe("foo()");
  });

  test("snake_case names do not match across underscores", () => {
    const content = `get_user()\nget_userX()\nxget_user()`;
    const hits = matchIdentifierLines(content, 1, "get_user");
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  test("empty name yields no matches", () => {
    expect(matchIdentifierLines("anything", 1, "")).toEqual([]);
  });
});

describe("escapeRegExp", () => {
  test("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });
});

describe("alignEndToCodePoint", () => {
  test("slides the cut forward past a high surrogate half", () => {
    // "ab🄄c": cutting at 3 would leave the high half at the end.
    expect(alignEndToCodePoint("ab🄄c", 3)).toBe(4);
  });

  test("leaves ordinary cuts alone", () => {
    expect(alignEndToCodePoint("abcd", 3)).toBe(3);
    expect(alignEndToCodePoint("abcd", 4)).toBe(4);
  });

  test("out-of-range ends pass through (slice clamps)", () => {
    expect(alignEndToCodePoint("ab", 5)).toBe(5);
    expect(alignEndToCodePoint("ab", 0)).toBe(0);
  });
});

describe("alignStartToCodePoint", () => {
  test("slides the cut back off a low surrogate half", () => {
    // "ab🄄": starting at 3 would begin with the lone low half.
    expect(alignStartToCodePoint("ab🄄", 3)).toBe(2);
  });

  test("leaves ordinary starts alone", () => {
    expect(alignStartToCodePoint("abcd", 2)).toBe(2);
    expect(alignStartToCodePoint("\uDC00x", 0)).toBe(0); // nothing before 0
  });
});

describe("sanitizeLoneSurrogates", () => {
  test("valid surrogate pairs pass through untouched", () => {
    const s = "a🔄b📡 c";
    expect(sanitizeLoneSurrogates(s)).toBe(s);
  });

  test("lone halves become U+FFFD", () => {
    expect(sanitizeLoneSurrogates("a\uDC04b")).toBe("a�b");
    expect(sanitizeLoneSurrogates("a\uD83Db")).toBe("a�b");
  });

  test("mix: pairs kept, stragglers replaced, output JSON-wire-safe", () => {
    const out = sanitizeLoneSurrogates("x\uD83Dy\uDC00z🔄w");
    expect(out).toBe("x�y�z🔄w");
    // The property that matters at the wire: no surrogate escapes after
    // JSON.stringify (strict parsers — llama.cpp's nlohmann — reject them).
    expect(JSON.stringify(out)).not.toMatch(/\\ud[0-9a-f]{3}/i);
  });
});
