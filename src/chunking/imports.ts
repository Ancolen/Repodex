/**
 * Import / dependency extraction.
 *
 * Walks a file's top-level AST nodes and pulls out the module specifiers of its
 * import statements, per language — the "what does this file import" half of the
 * dependency graph. Resolution to real files lives in `src/core/resolve.ts`.
 *
 * Mirrors `chunkCode`'s parse recipe exactly (shared parser, language per file,
 * no `await` between `setLanguage` and `parse`). Import statements are always
 * top-level, so we never recurse into bodies — this is both faster and avoids
 * matching nested requires/dynamic imports.
 *
 * Side-effect-free (no I/O): takes content, returns specs. Unit-testable without
 * LanceDB, like `src/utils/text.ts`.
 *
 * NOTE on node types: the dispatch sets below were verified live against the
 * pinned `tree-sitter-wasms` 0.1.13 / `web-tree-sitter` 0.22.6 by dumping
 * `tree.rootNode.toString()`. If a grammar is ever upgraded, re-verify.
 */
import path from "node:path";
import type Parser from "web-tree-sitter";
import { EXT_TO_GRAMMAR, languageForExt, getParser } from "./tree-sitter";

type Node = Parser.SyntaxNode;

export interface ImportSpec {
  /** Raw specifier exactly as written (no quotes/brackets), e.g. "./a", "os", "github.com/x/y". */
  raw: string;
  /** Grammar name (from EXT_TO_GRAMMAR); picks the resolver. */
  language: string;
  /** 1-based line of the import statement in the file. */
  line: number;
  /** Coarse hint set cheaply during extraction. */
  kind: "relative" | "absolute" | "external" | "system";
  /** Imported local names when trivially available (JS/Python). Omitted otherwise. */
  names?: string[];
}

// ---- shared string helpers ----

function stripQuotes(s: string): string {
  const len = s.length;
  if (len >= 2) {
    const first = s[0]!;
    const last = s[len - 1]!;
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      return s.slice(1, -1);
    }
    if (first === "<" && last === ">") return s.slice(1, -1);
  }
  return s;
}

/** Unquoted text of a string-like node: prefers an inner fragment/content child. */
function innerStringText(node: Node): string {
  for (const child of node.namedChildren) {
    const t = child.type;
    if (t === "string_fragment" || t === "string_content" || t === "raw_string_literal" || t === "escape_sequence") {
      // string_fragment/string_content hold the literal text without delimiters.
      return child.type === "escape_sequence" ? stripQuotes(child.text) : child.text;
    }
  }
  return stripQuotes(node.text);
}

/** First unquoted string found anywhere in the subtree (for messy PHP/Ruby forms). */
function firstStringIn(node: Node): string | null {
  if (
    node.type === "string_fragment" ||
    node.type === "string_content" ||
    node.type === "raw_string_literal"
  ) {
    return node.type === "raw_string_literal" ? stripQuotes(node.text) : node.text;
  }
  if (node.type === "string" || node.type === "string_literal" || node.type === "interpreted_string_literal" || node.type === "encapsed_string") {
    return innerStringText(node);
  }
  for (const child of node.namedChildren) {
    const found = firstStringIn(child);
    if (found !== null) return found;
  }
  return null;
}

// ---- kind classifier (cheap) ----

function jsKind(raw: string): ImportSpec["kind"] {
  if (raw.startsWith(".")) return "relative";
  if (raw.startsWith("/")) return "absolute";
  return "external";
}

// ---- per-language extractors ----
// Each takes a top-level node + the grammar name, returns one spec, several, or null.

function extractJs(node: Node, language: string): ImportSpec | null {
  if (node.type !== "import_statement") return null;
  const source = node.childForFieldName("source");
  if (!source) return null;
  const raw = innerStringText(source);
  if (!raw) return null;
  return { raw, language, line: node.startPosition.row + 1, kind: jsKind(raw) };
}

function extractPython(node: Node, language: string): ImportSpec | ImportSpec[] | null {
  if (node.type === "import_statement") {
    // field `name` is a dotted_name (or `future_import` etc.); reconstruct dotted text.
    const nameNode = node.childForFieldName("name");
    const dottedNode = node.childForFieldName("dotted_name");
    const base = dottedNode ?? nameNode;
    const raw = base ? dottedTextFromPython(base) : "";
    if (!raw) return null;
    return { raw, language, line: node.startPosition.row + 1, kind: pythonKind(raw, 0) };
  }
  if (node.type === "import_from_statement") {
    const modNode = node.childForFieldName("module_name");
    const raw = modNode ? dottedTextFromPython(modNode) : "";
    // Count leading dots for relative imports.
    let dots = 0;
    if (modNode && modNode.type === "relative_import") {
      const prefix = modNode.namedChildren.find((c) => c.type === "import_prefix");
      dots = prefix ? prefix.text.replace(/[^.]/g, "").length : 0;
    }
    if (raw.startsWith(".")) {
      dots = Math.max(dots, raw.match(/^\.+/)?.[0]?.length ?? 0);
    }
    // imported names (best-effort): every dotted_name/identifier child except the module itself.
    // NOTE: compare by startIndex, not reference — web-tree-sitter returns distinct node
    // objects for childForFieldName vs namedChildren for the same underlying node.
    const modStart = modNode?.startIndex ?? -1;
    const names: string[] = [];
    for (const child of node.namedChildren) {
      if (modStart >= 0 && child.startIndex === modStart) continue;
      if (child.type === "dotted_name" || child.type === "identifier" || child.type === "aliased_import") {
        const id = child.type === "dotted_name" ? child.namedChildren[0] : child;
        if (id && (id.type === "identifier" || id.type === "dotted_name")) names.push(id.text);
      }
    }
    if (!raw && dots === 0) return null;
    const out: ImportSpec = {
      raw,
      language,
      line: node.startPosition.row + 1,
      kind: pythonKind(raw, dots),
    };
    if (names.length) out.names = names;
    return out;
  }
  return null;
}

/** Python `dotted_name`/`relative_import` → text like "a.b.c" or ".pkg". */
function dottedTextFromPython(node: Node): string {
  if (node.type === "relative_import") {
    let txt = "";
    const prefix = node.namedChildren.find((c) => c.type === "import_prefix");
    if (prefix) txt += prefix.text.replace(/[^.]/g, "");
    const dotted = node.childForFieldName("module_name") ?? node.namedChildren.find((c) => c.type === "dotted_name");
    if (dotted) txt += dotted.text;
    return txt;
  }
  // dotted_name node's own .text is already "a.b.c".
  return node.text;
}

function pythonKind(raw: string, dots: number): ImportSpec["kind"] {
  if (dots > 0) return "relative";
  if (raw.startsWith(".")) return "relative";
  return "external"; // stdlib / site-packages
}

function extractGo(node: Node, language: string): ImportSpec[] | null {
  if (node.type !== "import_declaration") return null;
  const specs: ImportSpec[] = [];
  for (const child of node.namedChildren) {
    const specList = child.type === "import_spec_list" ? child.namedChildren : [child];
    for (const spec of specList) {
      if (spec.type !== "import_spec") continue;
      const p = spec.childForFieldName("path");
      if (!p) continue;
      const raw = stripQuotes(p.text);
      if (!raw) continue;
      specs.push({ raw, language, line: spec.startPosition.row + 1, kind: goKind(raw) });
    }
  }
  return specs;
}

function goKind(raw: string): ImportSpec["kind"] {
  // A path with a dot in the first segment (e.g. github.com/...) is a module = external.
  const first = raw.split("/")[0] ?? "";
  if (first.includes(".")) return "external";
  return "external";
}

function extractRust(node: Node, language: string): ImportSpec | null {
  if (node.type !== "use_declaration") return null;
  const arg = node.childForFieldName("argument");
  if (!arg) return null;
  // Top-level path only; do not expand braces. Capture leading crate/super/self.
  let raw = "";
  const names: string[] = [];
  if (arg.type === "scoped_use_list") {
    // path: (scoped_identifier) , list: (use_list)
    const p = arg.childForFieldName("path");
    raw = p ? rustPathText(p) : "";
    const list = arg.childForFieldName("list");
    if (list) for (const c of list.namedChildren) if (c.type === "identifier") names.push(c.text);
  } else if (arg.type === "use_list") {
    // `use {a, b}`; no leading path.
    for (const c of arg.namedChildren) if (c.type === "identifier") names.push(c.text);
  } else {
    raw = rustPathText(arg);
  }
  if (!raw && names.length === 0) return null;
  const out: ImportSpec = {
    raw,
    language,
    line: node.startPosition.row + 1,
    kind: rustKind(raw),
  };
  if (names.length) out.names = names;
  return out;
}

function rustPathText(node: Node): string {
  // scoped_identifier / identifier / crate / super / self — text is already "crate::a::b".
  return node.text;
}

function rustKind(raw: string): ImportSpec["kind"] {
  if (raw.startsWith("crate::") || raw.startsWith("self::") || raw.startsWith("super::")) return "relative";
  if (!raw) return "external";
  return "external"; // external crate
}

function extractJava(node: Node, language: string): ImportSpec | null {
  if (node.type !== "import_declaration") return null;
  // scoped_identifier.text already holds the full dotted path (e.g. "com.foo.Bar").
  const scoped = node.childForFieldName("name") ?? node.namedChildren.find((c) => c.type === "scoped_identifier");
  if (!scoped) return null;
  const raw = scoped.text.replace(/\s+/g, "");
  if (!raw) return null;
  return { raw, language, line: node.startPosition.row + 1, kind: "external" };
}

function extractCSharp(node: Node, language: string): ImportSpec | null {
  if (node.type !== "using_directive") return null;
  // qualified_name / identifier .text already holds the full dotted path.
  const qn = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "identifier");
  if (!qn) return null;
  const raw = qn.text.replace(/\s+/g, "");
  if (!raw) return null;
  return { raw, language, line: node.startPosition.row + 1, kind: "external" };
}

function extractC(node: Node, language: string): ImportSpec | null {
  // C / C++ share `preproc_include`. Field `path` is system_lib_string (<…>) or string_literal/string.
  if (node.type !== "preproc_include") return null;
  const p = node.childForFieldName("path");
  if (!p) return null;
  const isSystem = p.type === "system_lib_string";
  const raw = isSystem ? stripQuotes(p.text) : innerStringText(p);
  if (!raw) return null;
  return { raw, language, line: node.startPosition.row + 1, kind: isSystem ? "system" : "relative" };
}

function extractRuby(node: Node, language: string): ImportSpec | null {
  if (node.type !== "call") return null;
  const method = node.childForFieldName("method");
  const mname = method ? method.text : "";
  if (mname !== "require" && mname !== "require_relative" && mname !== "load") return null;
  const args = node.childForFieldName("arguments");
  const raw = args ? firstStringIn(args) : null;
  if (!raw) return null;
  const kind = mname === "require_relative" ? "relative" : "external";
  return { raw, language, line: node.startPosition.row + 1, kind };
}

function extractPhp(node: Node, language: string): ImportSpec | ImportSpec[] | null {
  // require/include expressions are wrapped in an `expression_statement`.
  const target = node.type === "expression_statement" ? node.namedChildren[0] ?? null : node;
  if (!target) return null;
  const t = target.type;
  if (t === "require_once_expression" || t === "require_expression" || t === "include_once_expression" || t === "include_expression") {
    const raw = firstStringIn(target);
    if (!raw) return null;
    return { raw, language, line: target.startPosition.row + 1, kind: "relative" };
  }
  if (t === "namespace_use_declaration") {
    const out: ImportSpec[] = [];
    for (const clause of target.namedChildren) {
      if (clause.type !== "namespace_use_clause") continue;
      const qn = clause.childForFieldName("value") ?? clause.namedChildren.find((c) => c.type === "qualified_name");
      if (qn && qn.type === "qualified_name") {
        out.push({ raw: qn.text.replace(/^\\/, ""), language, line: clause.startPosition.row + 1, kind: "external" });
      }
    }
    return out.length ? out : null;
  }
  return null;
}

function extractKotlin(node: Node, language: string): ImportSpec | null {
  // Kotlin: top-level statements are wrapped; import is `import_header` (often inside `import_list`).
  let header: Node | null = null;
  if (node.type === "import_header") header = node;
  else if (node.type === "import_list") {
    header = node.namedChildren.find((c) => c.type === "import_header") ?? null;
  }
  if (!header) return null;
  const id = header.namedChildren.find((c) => c.type === "identifier") ?? null;
  if (!id) return null;
  const raw = id.text;
  return { raw, language, line: header.startPosition.row + 1, kind: "external" };
}

function extractSwift(node: Node, language: string): ImportSpec | null {
  if (node.type !== "import_declaration") return null;
  const id = node.namedChildren.find((c) => c.type === "identifier" || c.type === "simple_identifier") ?? null;
  if (!id) return null;
  return { raw: id.text, language, line: node.startPosition.row + 1, kind: "external" };
}

function extractScala(node: Node, language: string): ImportSpec | null {
  if (node.type !== "import_declaration") return null;
  const p = node.childForFieldName("path");
  const base = p ?? node.namedChildren.find((c) => c.type === "stable_identifier" || c.type === "identifier");
  if (!base) return null;
  return { raw: base.text, language, line: node.startPosition.row + 1, kind: "external" };
}

/** Callee text of a GDScript `call` node — it has no fields (rule: `_primary_expression arguments`). */
function gdscriptCallee(call: Node): string {
  const callee = call.namedChildren.find((ch) => ch.type !== "arguments");
  return callee?.text ?? "";
}

/** First `preload`/`load` string argument in a subtree (bounded depth). */
function findPreloadString(node: Node, depth = 0): string | null {
  if (depth > 8) return null;
  if (node.type === "call") {
    const callee = gdscriptCallee(node);
    if (callee === "preload" || callee === "load") {
      const args = node.namedChildren.find((ch) => ch.type === "arguments");
      const s = args ? firstStringIn(args) : null;
      if (s) return s;
    }
  }
  for (const ch of node.namedChildren) {
    const r = findPreloadString(ch, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

function extractGdscript(node: Node, language: string): ImportSpec[] | null {
  // GDScript has no import statements: script dependencies are `extends "res://…"`
  // and `const X = preload("res://…")` (plus dynamic `load`). Both res:// paths and
  // importing-file-relative paths resolve inside the project → "relative".
  const out: ImportSpec[] = [];
  const push = (raw: string | null): void => {
    // `uid://…` (Godot ≥4.4) is a stable ID, not a path — nothing to resolve.
    if (raw && !raw.startsWith("uid://")) {
      out.push({ raw, language, line: node.startPosition.row + 1, kind: "relative" });
    }
  };
  if (node.type === "extends_statement") {
    // `extends "res://foo.gd"` carries a string child (script dependency);
    // `extends Node2D` inherits an engine class — not a file, skip.
    const s = node.namedChildren.find((c) => c.type === "string");
    push(s ? innerStringText(s) : null);
  } else if (
    node.type === "const_statement" ||
    node.type === "variable_statement" ||
    node.type === "onready_variable_statement" ||
    node.type === "export_variable_statement" ||
    node.type === "expression_statement" ||
    node.type === "assignment"
  ) {
    push(findPreloadString(node));
  }
  return out.length ? out : null;
}

// ---- dispatcher ----

type Extractor = (node: Node, language: string) => ImportSpec | ImportSpec[] | null;

const EXTRACTORS: Record<string, Extractor> = {
  javascript: extractJs,
  typescript: extractJs,
  tsx: extractJs,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  java: extractJava,
  c: extractC,
  cpp: extractC,
  c_sharp: extractCSharp,
  php: extractPhp,
  ruby: extractRuby,
  kotlin: extractKotlin,
  swift: extractSwift,
  scala: extractScala,
  gdscript: extractGdscript,
};

function collectImports(root: Node, language: string): ImportSpec[] {
  const extractor = EXTRACTORS[language];
  if (!extractor) return [];
  const out: ImportSpec[] = [];
  for (const child of root.namedChildren) {
    const res = extractor(child, language);
    if (!res) continue;
    if (Array.isArray(res)) out.push(...res);
    else out.push(res);
  }
  return out;
}

/**
 * Extract import statements from a file's source.
 * Returns [] for languages without a grammar or empty/parse-failed input.
 */
export async function extractImports(filePath: string, content: string): Promise<ImportSpec[]> {
  if (content.trim().length === 0) return [];
  const ext = path.extname(filePath).toLowerCase();
  const language = EXT_TO_GRAMMAR[ext];
  if (!language) return [];

  let lang: Parser.Language | null = null;
  try {
    lang = await languageForExt(ext);
  } catch {
    lang = null;
  }
  if (!lang) return [];

  let tree: Parser.Tree | null = null;
  try {
    const parser = await getParser();
    // CRITICAL: shared-parser safety — no await between setLanguage and parse.
    parser.setLanguage(lang);
    tree = parser.parse(content);
  } catch {
    return [];
  }
  if (!tree) return [];

  return collectImports(tree.rootNode, language);
}
