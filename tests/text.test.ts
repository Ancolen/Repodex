/**
 * Pure text-helper tests: signature derivation + whole-identifier line matching.
 * These back the search-result enrichment (signature) and find_references logic
 * without requiring LanceDB.
 */
import { test, expect, describe } from "bun:test";
import { deriveSignature, matchIdentifierLines, escapeRegExp } from "../src/utils/text";

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
