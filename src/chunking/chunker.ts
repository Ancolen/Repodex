import path from "node:path";
import type Parser from "web-tree-sitter";
import { CONFIG } from "../config";
import { EXT_TO_GRAMMAR, languageForExt, getParser } from "./tree-sitter";
import { extractDoc } from "./docstring";

type Node = Parser.SyntaxNode;

/**
 * Language labels for allowed extensions that have no tree-sitter grammar
 * (character-fallback chunking). Grammar extensions take their label from
 * `EXT_TO_GRAMMAR`; these get one so the `language` column stays meaningful
 * and `language` filters work for doc corpora (engine class reference dumps,
 * .rst documentation trees). Extensions not listed here (e.g. Godot's
 * .tscn/.tres/.gdshader) stay unlabeled like before.
 */
export const TEXT_LANG_BY_EXT: Record<string, string> = {
  ".xml": "xml",
  ".rst": "rst",
  ".json": "json",
  ".md": "markdown",
};

/** An AST-based code chunk. */
export interface Chunk {
  content: string;
  startLine: number; // 1-based
  endLine: number;
  symbolName?: string;
  symbolType?: string;
  language?: string;
  /**
   * The symbol's docstring / doc comment (see `docstring.ts`). Present only on
   * the FIRST chunk of a symbol (split chunks share the code body but not the
   * doc), so each symbol contributes exactly one doc leg. Purely additive —
   * the doc text is never removed from `content`.
   */
  doc?: string;
}

// --- Node type classification (cross-language common sets) ---
//
// Class-like (type definitions that can contain their own methods).
const CLASS_LIKE = new Set([
  // JS/TS
  "class_declaration", "class_definition", "abstract_class_declaration",
  "interface_declaration", "enum_declaration",
  // Rust
  "struct_item", "trait_item", "impl_item", "enum_item",
  // C / C++
  "class_specifier", "struct_specifier", "enum_specifier", "union_specifier",
  // Kotlin / Scala etc.
  "object_declaration",
  // C#
  "record_declaration", "record_struct_declaration", "struct_declaration",
  // Ruby
  "class",
  // Swift
  "protocol_declaration",
  // Scala
  "object_definition", "trait_definition",
  // GDScript (inner class, `class_name X` header, enum)
  "class_name_statement", "enum_definition",
]);

// Function-like (callable definitions).
const FUNCTION_LIKE = new Set([
  "function_declaration", "function_definition", "function_item",
  "method_definition", "method_declaration", "constructor_declaration",
  "destructor_declaration", "operator_declaration", "local_function_statement",
  "function_signature", "fn_item",
  // Ruby
  "method", "singleton_method",
  // GDScript (`func _init` constructor, `signal x(...)` declaration)
  "constructor_definition", "signal_statement",
]);

// Not symbols themselves, but containers that must be DESCENDED INTO (namespace/module).
// The actual types/functions in their bodies are treated as if top-level.
const CONTAINER = new Set([
  "namespace_declaration", "file_scoped_namespace_declaration", // C#
  "namespace_definition", "linkage_specification",              // C++
  "module",                                                     // Ruby module / TS ambient module
  "internal_module",                                            // TS `namespace X {}`
  "mod_item",                                                   // Rust `mod x {}`
]);

// Wrappers to be "stripped" to find the actual definition inside.
const WRAPPERS = new Set([
  "export_statement", "decorated_definition", "ambient_declaration",
  "template_declaration", // C++ `template<...> <decl>`
]);

/** Approximate chars-per-token for the chunk-size guard (no tokenizer bundled). */
export const CHARS_PER_TOKEN = 4;

/** Rough token count of `text` (chars / charsPerToken, rounded up). */
export function estimateTokens(text: string, charsPerToken = CHARS_PER_TOKEN): number {
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Effective per-chunk char limit: the smaller of the configured char limit and
 * the approximate token cap (so a large maxChunkSize can't silently exceed the
 * embedding model's token window). Char-limit-binding by default
 * (512 tokens * 4 chars/token = 2048 > default maxChunkSize 1500).
 */
export function effectiveChunkChars(
  maxChunkSize: number,
  maxChunkTokens: number,
  charsPerToken = CHARS_PER_TOKEN,
): number {
  return Math.min(maxChunkSize, Math.max(1, maxChunkTokens * charsPerToken));
}

const MAX = effectiveChunkChars(CONFIG.MAX_CHUNK_SIZE, CONFIG.MAX_CHUNK_TOKENS, CHARS_PER_TOKEN);
const STEP = Math.max(1, MAX - CONFIG.OVERLAP_SIZE);

function countLines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function symbolTypeOf(nodeType: string): string {
  if (CLASS_LIKE.has(nodeType)) {
    if (nodeType.includes("interface") || nodeType.includes("protocol")) return "interface";
    if (nodeType.includes("enum")) return "enum";
    if (nodeType.includes("struct")) return "struct";
    if (nodeType.includes("union")) return "struct";
    if (nodeType.includes("trait")) return "trait";
    if (nodeType.includes("impl")) return "impl";
    return "class"; // includes class/record/object
  }
  if (FUNCTION_LIKE.has(nodeType)) {
    if (nodeType.includes("signal")) return "signal"; // GDScript signal declaration
    if (nodeType.includes("constructor") || nodeType.includes("destructor")) return "method";
    if (nodeType.includes("method")) return "method"; // method/singleton_method/method_declaration
    return "function";
  }
  return "code";
}

/** Strips wrappers like export/decorated/template and returns the actual inner definition. */
function unwrap(node: Node): Node {
  let n = node;
  let guard = 0;
  while (WRAPPERS.has(n.type) && guard++ < 8) {
    const inner =
      n.namedChildren.find(
        (c) => CLASS_LIKE.has(c.type) || FUNCTION_LIKE.has(c.type) || CONTAINER.has(c.type),
      ) ?? n.lastNamedChild;
    if (!inner || inner === n) break;
    n = inner;
  }
  return n;
}

/**
 * Extracts the name of a definition node.
 * In order: (1) the `name` field, (2) the C/C++ `declarator` chain (the name is
 * embedded in nested declarators), (3) the first identifier-like child.
 */
function nameOf(node: Node): string | undefined {
  // GDScript `func _init` is a literal token (the constructor node carries no
  // name field and no name child).
  if (node.type === "constructor_definition") return "_init";

  const byField = node.childForFieldName("name");
  if (byField?.text) return byField.text;

  // C / C++: function_definition → declarator(function_declarator) → ... → identifier
  let decl: Node | null = node.childForFieldName("declarator");
  let guard = 0;
  while (decl && guard++ < 8) {
    if (/identifier/.test(decl.type)) return decl.text;
    const next: Node | null =
      decl.childForFieldName("declarator") ??
      decl.namedChildren.find((c) => /identifier/.test(c.type) || c.type.endsWith("declarator")) ??
      null;
    if (!next || next === decl) break;
    decl = next;
  }

  // GDScript `class_name X` / `signal x(...)` carry the name as a bare `name`-typed
  // child (not a field). No other bundled grammar exposes such a child on a
  // definition node without a `name` field, so this fallback is inert elsewhere.
  const bareName = node.namedChildren.find((c) => c.type === "name");
  if (bareName?.text) return bareName.text;

  const id = node.namedChildren.find((c) => /identifier/.test(c.type));
  return id?.text;
}

/** Returns a node's body (body field); if none, the node itself. */
function bodyOf(node: Node): Node {
  return node.childForFieldName("body") ?? node;
}

type Meta = { language?: string; symbolName?: string; symbolType?: string };

function buildMeta(language?: string, symbolName?: string, symbolType?: string): Meta {
  const m: Meta = {};
  if (language !== undefined) m.language = language;
  if (symbolName !== undefined) m.symbolName = symbolName;
  if (symbolType !== undefined) m.symbolType = symbolType;
  return m;
}

/** Splits a large text into overlapping chunks; approximates line numbers. */
function splitLarge(text: string, baseLine: number, meta: Meta): Chunk[] {
  const out: Chunk[] = [];
  for (let offset = 0; offset < text.length; offset += STEP) {
    const slice = text.slice(offset, offset + MAX);
    if (slice.trim().length === 0) continue;
    const startLine = baseLine + countLines(text.slice(0, offset));
    out.push({ content: slice, startLine, endLine: startLine + countLines(slice), ...meta });
  }
  return out;
}

/** Converts a whole node (with correct line range) into a chunk; splits it if large. */
function emitNode(out: Chunk[], code: string, outer: Node, innerType: string, meta: Meta, doc?: string): void {
  const text = code.slice(outer.startIndex, outer.endIndex);
  if (text.trim().length === 0) return;
  const startLine = outer.startPosition.row + 1;
  if (text.length <= MAX) {
    const chunk: Chunk = { content: text, startLine, endLine: outer.endPosition.row + 1, ...meta };
    if (doc !== undefined) chunk.doc = doc;
    out.push(chunk);
  } else {
    // Split symbol: only the FIRST chunk carries the doc (one doc leg per symbol).
    const parts = splitLarge(text, startLine, meta);
    if (doc !== undefined && parts[0]) parts[0].doc = doc;
    out.push(...parts);
  }
  void innerType;
}

/** Emits a class as a single chunk; if large, emits header + each method as a separate chunk. */
function emitClass(out: Chunk[], code: string, outer: Node, cls: Node, language?: string): void {
  const className = nameOf(cls);
  const meta = buildMeta(language, className, symbolTypeOf(cls.type));
  const doc = extractDoc(outer, cls, language);
  const whole = code.slice(outer.startIndex, outer.endIndex);

  if (whole.length <= MAX) {
    emitNode(out, code, outer, cls.type, meta, doc);
    return;
  }

  const body = cls.childForFieldName("body");
  if (!body) {
    const parts = splitLarge(whole, outer.startPosition.row + 1, meta);
    if (doc !== undefined && parts[0]) parts[0].doc = doc;
    out.push(...parts);
    return;
  }

  const methods = body.namedChildren.filter((c) => FUNCTION_LIKE.has(unwrap(c).type));
  const first = methods[0];
  const headerEnd = first ? first.startIndex : body.endIndex;
  const headerText = code.slice(outer.startIndex, headerEnd);
  if (headerText.trim().length > 0) {
    const baseLine = outer.startPosition.row + 1;
    if (headerText.length <= MAX) {
      const endLine = baseLine + countLines(headerText);
      const header: Chunk = { content: headerText, startLine: baseLine, endLine, ...meta };
      if (doc !== undefined) header.doc = doc;
      out.push(header);
    } else {
      const parts = splitLarge(headerText, baseLine, meta);
      if (doc !== undefined && parts[0]) parts[0].doc = doc;
      out.push(...parts);
    }
  }

  for (const m of methods) {
    const mi = unwrap(m);
    const mname = className ? `${className}.${nameOf(mi) ?? "anonymous"}` : nameOf(mi);
    emitNode(
      out,
      code,
      m,
      mi.type,
      buildMeta(language, mname, symbolTypeOf(mi.type)),
      extractDoc(m, mi, language),
    );
  }
}

/**
 * Emits each `type_spec` inside a Go `type_declaration` (e.g. `type Server struct {...}`
 * or `type ( A ...; B ... )`) as a separate symbol (struct/interface/type).
 */
function emitGoTypeDecl(out: Chunk[], code: string, outer: Node, decl: Node, language?: string): void {
  const specs = decl.namedChildren.filter(
    (c) => c.type === "type_spec" || c.type === "type_alias",
  );
  if (specs.length === 0) {
    emitNode(out, code, outer, decl.type, buildMeta(language));
    return;
  }
  const single = specs.length === 1;
  // A doc comment above the declaration is unambiguous only for a single spec;
  // a `type ( A ...; B ... )` group has no per-spec attribution, so no doc.
  const doc = single ? extractDoc(outer, decl, language) : undefined;
  for (const spec of specs) {
    const name = spec.childForFieldName("name")?.text ?? nameOf(spec);
    const typeNode = spec.childForFieldName("type");
    const st =
      typeNode?.type === "interface_type"
        ? "interface"
        : typeNode?.type === "struct_type"
          ? "struct"
          : "type";
    emitNode(out, code, single ? outer : spec, spec.type, buildMeta(language, name, st), doc);
  }
}

/**
 * Processes the children at one AST level. Descends recursively into containers
 * (namespace/module); this way, in languages like C#/C++/Ruby/TS, types and
 * functions inside a namespace/module are also extracted as symbols.
 */
function walk(parent: Node, code: string, language: string | undefined, out: Chunk[], depth: number): void {
  let loose: Node[] = [];

  const flushLoose = () => {
    if (loose.length === 0) return;
    const first = loose[0]!;
    const last = loose[loose.length - 1]!;
    const text = code.slice(first.startIndex, last.endIndex);
    if (text.trim().length > 0) {
      const baseLine = first.startPosition.row + 1;
      const meta = buildMeta(language);
      if (text.length <= MAX) {
        out.push({ content: text, startLine: baseLine, endLine: last.endPosition.row + 1, ...meta });
      } else {
        out.push(...splitLarge(text, baseLine, meta));
      }
    }
    loose = [];
  };

  for (const top of parent.namedChildren) {
    const inner = unwrap(top);
    const t = inner.type;

    if (CONTAINER.has(t)) {
      flushLoose();
      if (depth < 12) {
        walk(bodyOf(inner), code, language, out, depth + 1);
      } else {
        emitNode(out, code, top, t, buildMeta(language));
      }
    } else if (t === "type_declaration") {
      // Go type group (struct/interface/alias)
      flushLoose();
      emitGoTypeDecl(out, code, top, inner, language);
    } else if (CLASS_LIKE.has(t)) {
      flushLoose();
      emitClass(out, code, top, inner, language);
    } else if (FUNCTION_LIKE.has(t)) {
      flushLoose();
      emitNode(
        out,
        code,
        top,
        inner.type,
        buildMeta(language, nameOf(inner), symbolTypeOf(inner.type)),
        extractDoc(top, inner, language),
      );
    } else {
      loose.push(top);
    }
  }
  flushLoose();
}

/** Produces chunks from the AST root. */
function astChunks(root: Node, code: string, language?: string): Chunk[] {
  const out: Chunk[] = [];
  walk(root, code, language, out, 0);
  return out;
}

/** Character-based fallback for languages without a grammar / parse errors. */
function fallbackChunks(content: string, language?: string): Chunk[] {
  const chunks = splitLarge(content, 1, buildMeta(language));
  return chunks.length > 0
    ? chunks
    : [{ content, startLine: 1, endLine: 1 + countLines(content), ...buildMeta(language) }];
}

/**
 * Chunks a file's content at AST boundaries (function/class/method).
 * Falls back to character-based chunking if there is no grammar or parsing fails.
 */
export async function chunkCode(filePath: string, content: string): Promise<Chunk[]> {
  if (content.trim().length === 0) return [];
  const ext = path.extname(filePath).toLowerCase();
  const language = EXT_TO_GRAMMAR[ext] ?? TEXT_LANG_BY_EXT[ext];

  let lang: Parser.Language | null = null;
  try {
    lang = await languageForExt(ext);
  } catch {
    lang = null;
  }
  if (!lang) return fallbackChunks(content, language);

  try {
    const parser = await getParser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    if (!tree) return fallbackChunks(content, language);
    const chunks = astChunks(tree.rootNode, content, language);
    return chunks.length > 0 ? chunks : fallbackChunks(content, language);
  } catch {
    return fallbackChunks(content, language);
  }
}

/** A single entry in a file's symbol map. */
export interface OutlineEntry {
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
}

/**
 * Extracts a file's symbol map (function/class/method).
 * Derived from chunkCode; parts of the same symbol split due to oversize are
 * merged into a single entry (by expanding the line range).
 */
export async function fileOutline(filePath: string, content: string): Promise<OutlineEntry[]> {
  const chunks = await chunkCode(filePath, content);
  const map = new Map<string, OutlineEntry>();
  for (const c of chunks) {
    if (!c.symbolName) continue;
    const key = `${c.symbolType ?? "symbol"}:${c.symbolName}`;
    const existing = map.get(key);
    if (existing) {
      existing.startLine = Math.min(existing.startLine, c.startLine);
      existing.endLine = Math.max(existing.endLine, c.endLine);
    } else {
      map.set(key, {
        symbolName: c.symbolName,
        symbolType: c.symbolType ?? "symbol",
        startLine: c.startLine,
        endLine: c.endLine,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.startLine - b.startLine);
}
