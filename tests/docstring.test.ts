import { test, expect, describe } from "bun:test";
import { chunkCode } from "../src/chunking/chunker";
import { MAX_DOC_CHARS } from "../src/chunking/docstring";

// --- Fixtures --------------------------------------------------------------

const PY_SOURCE = `"""Module docstring stays in the loose chunk."""

def helper(x):
    """Multiplies the input by two.

    Returns the doubled value.
    """
    return x * 2

# helper is used below
def other():
    pass
`;

const JS_SOURCE = `/**
 * Retries the request with exponential backoff.
 * Stops after maxAttempts tries.
 */
export function retry(maxAttempts) {
  return maxAttempts;
}

// a plain one-liner above other
export function other() {}
`;

const GO_SOURCE = `package main

// Server handles incoming requests.
// It is safe for concurrent use.
type Server struct {
	addr string
}

func main() {}
`;

const RUST_SOURCE = `/// Calculates the fibonacci number at n.
/// Uses an iterative loop.
pub fn fib(n: u64) -> u64 {
    n
}
`;

const GD_SOURCE = `class_name Player
extends CharacterBody2D

## Moves the player by the given velocity.
## Handles collisions with the world.
func move(v: Vector2) -> void:
	pass

func plain() -> void:
	pass
`;

// --- Extraction ------------------------------------------------------------

describe("docstring extraction", () => {
  test("python: function docstring extracted (delimiters stripped)", async () => {
    const chunks = await chunkCode("m.py", PY_SOURCE);
    const fn = chunks.find((c) => c.symbolName === "helper");
    expect(fn).toBeDefined();
    expect(fn!.doc).toBeDefined();
    expect(fn!.doc).toContain("Multiplies the input by two.");
    expect(fn!.doc).not.toContain('"""');
    // The docstring is NOT removed from content.
    expect(fn!.content).toContain('"""');
  });

  test("python: function without docstring falls back to a preceding comment", async () => {
    const chunks = await chunkCode("m.py", PY_SOURCE);
    const fn = chunks.find((c) => c.symbolName === "other");
    expect(fn).toBeDefined();
    expect(fn!.doc).toContain("helper is used below");
  });

  test("js: JSDoc block comment extracted, plain one-liner too", async () => {
    const chunks = await chunkCode("m.js", JS_SOURCE);
    const fn = chunks.find((c) => c.symbolName === "retry");
    expect(fn).toBeDefined();
    expect(fn!.doc).toContain("Retries the request with exponential backoff.");
    const other = chunks.find((c) => c.symbolName === "other");
    expect(other!.doc).toContain("a plain one-liner above other");
  });

  test("go: comment run above a type declaration is collected", async () => {
    const chunks = await chunkCode("m.go", GO_SOURCE);
    const server = chunks.find((c) => c.symbolName === "Server");
    expect(server).toBeDefined();
    expect(server!.doc).toContain("Server handles incoming requests.");
    expect(server!.doc).toContain("It is safe for concurrent use.");
  });

  test("rust: /// doc comments extracted", async () => {
    const chunks = await chunkCode("m.rs", RUST_SOURCE);
    const fn = chunks.find((c) => c.symbolName === "fib");
    expect(fn).toBeDefined();
    expect(fn!.doc).toContain("Calculates the fibonacci number at n.");
  });

  test("gdscript: ## doc comments extracted", async () => {
    const chunks = await chunkCode("m.gd", GD_SOURCE);
    const fn = chunks.find((c) => c.symbolName === "move");
    expect(fn).toBeDefined();
    expect(fn!.doc).toContain("Moves the player by the given velocity.");
    const plain = chunks.find((c) => c.symbolName === "plain");
    expect(plain!.doc).toBeUndefined();
  });

  test("doc goes only to the first chunk of an oversized symbol", async () => {
    // One function big enough to split (maxChunkSize 1500).
    const body = Array.from({ length: 200 }, (_, i) => `  x${i} = ${i};`).join("\n");
    const src = `/** Doc for the big one. */\nexport function big() {\n${body}\n}\n`;
    const chunks = await chunkCode("big.js", src);
    const big = chunks.filter((c) => c.symbolName === "big");
    expect(big.length).toBeGreaterThan(1);
    expect(big[0]!.doc).toContain("Doc for the big one.");
    for (const c of big.slice(1)) expect(c.doc).toBeUndefined();
  });

  test("very long doc comment is capped at MAX_DOC_CHARS", async () => {
    const long = "/** " + "x".repeat(3000) + " */\nexport function f() {}\n";
    const chunks = await chunkCode("long.js", long);
    const fn = chunks.find((c) => c.symbolName === "f");
    expect(fn!.doc!.length).toBeLessThanOrEqual(MAX_DOC_CHARS);
  });

  test("class doc comment lands on the class chunk; methods get their own", async () => {
    // A big class body forces header + per-method splitting; without it the
    // whole class is one chunk and the method docs stay inside its content.
    const filler = Array.from({ length: 150 }, (_, i) => `  field${i} = ${i};`).join("\n");
    const src = `/** The calculator. */
class Calc {
${filler}
  /** Adds n to the total. */
  add(n) { return n; }
  /** Resets the total. */
  reset() { return 0; }
}
`;
    const chunks = await chunkCode("calc.js", src);
    const cls = chunks.find((c) => c.symbolName === "Calc");
    expect(cls!.doc).toContain("The calculator.");
    const add = chunks.find((c) => c.symbolName === "Calc.add");
    expect(add).toBeDefined();
    expect(add!.doc).toContain("Adds n to the total.");
    const reset = chunks.find((c) => c.symbolName === "Calc.reset");
    expect(reset!.doc).toContain("Resets the total.");
  });
});