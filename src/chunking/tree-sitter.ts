import { readFile } from "node:fs/promises";
import Parser from "web-tree-sitter";

// --- Embedded wasm assets ---
// wasm files imported with `with { type: "file" }` are EMBEDDED into the single
// binary by `bun build --compile` and return a valid file path at runtime. This
// way it works both in dev mode (node_modules) and in the compiled binary — the
// runtime dependency on node_modules is eliminated.
import coreWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };

import jsWasm from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import tsWasm from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import tsxWasm from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import pyWasm from "tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import goWasm from "tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import rustWasm from "tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
import javaWasm from "tree-sitter-wasms/out/tree-sitter-java.wasm" with { type: "file" };
import cppWasm from "tree-sitter-wasms/out/tree-sitter-cpp.wasm" with { type: "file" };
import cWasm from "tree-sitter-wasms/out/tree-sitter-c.wasm" with { type: "file" };
import csharpWasm from "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm" with { type: "file" };
import phpWasm from "tree-sitter-wasms/out/tree-sitter-php.wasm" with { type: "file" };
import rubyWasm from "tree-sitter-wasms/out/tree-sitter-ruby.wasm" with { type: "file" };
import kotlinWasm from "tree-sitter-wasms/out/tree-sitter-kotlin.wasm" with { type: "file" };
import swiftWasm from "tree-sitter-wasms/out/tree-sitter-swift.wasm" with { type: "file" };
import scalaWasm from "tree-sitter-wasms/out/tree-sitter-scala.wasm" with { type: "file" };

/** Grammar name → embedded wasm file path. */
const GRAMMAR_WASM: Record<string, string> = {
  javascript: jsWasm,
  typescript: tsWasm,
  tsx: tsxWasm,
  python: pyWasm,
  go: goWasm,
  rust: rustWasm,
  java: javaWasm,
  cpp: cppWasm,
  c: cWasm,
  c_sharp: csharpWasm,
  php: phpWasm,
  ruby: rubyWasm,
  kotlin: kotlinWasm,
  swift: swiftWasm,
  scala: scalaWasm,
};

/**
 * File extension → grammar name.
 * Extensions not listed here (json, md, etc.) fall back to character-based chunking.
 *
 * Note: `.lua` was evaluated but `tree-sitter-lua` corrupts subsequent parses in
 * the shared-WASM multi-grammar runtime (nondeterministic symbol loss); it is
 * intentionally NOT bundled. Lua files still get character-based fallback chunking.
 */
export const EXT_TO_GRAMMAR: Record<string, string> = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".c": "c", ".h": "c", ".cs": "c_sharp", ".php": "php", ".rb": "ruby",
  ".kt": "kotlin", ".kts": "kotlin", ".swift": "swift",
  ".scala": "scala", ".sc": "scala",
};

let initPromise: Promise<void> | null = null;
const grammarCache = new Map<string, Promise<Parser.Language>>();
let sharedParser: Parser | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      // Load the Emscripten core wasm from the embedded file.
      locateFile: () => coreWasm,
    });
  }
  return initPromise;
}

async function loadGrammar(grammar: string): Promise<Parser.Language> {
  const wasmPath = GRAMMAR_WASM[grammar];
  if (!wasmPath) throw new Error(`No embedded grammar: ${grammar}`);
  const bytes = await readFile(wasmPath);
  return Parser.Language.load(bytes);
}

/** Grammar corresponding to the extension; null if none (or if loading fails). */
export async function languageForExt(ext: string): Promise<Parser.Language | null> {
  const grammar = EXT_TO_GRAMMAR[ext.toLowerCase()];
  if (!grammar || !GRAMMAR_WASM[grammar]) return null;
  await ensureInit();
  let p = grammarCache.get(grammar);
  if (!p) {
    p = loadGrammar(grammar);
    grammarCache.set(grammar, p);
  }
  try {
    return await p;
  } catch {
    grammarCache.delete(grammar); // do not keep a failed load in the cache
    return null;
  }
}

/** Single shared parser (assumes a single worker; setLanguage is called per file). */
export async function getParser(): Promise<Parser> {
  await ensureInit();
  if (!sharedParser) sharedParser = new Parser();
  return sharedParser;
}

export type { Parser };
