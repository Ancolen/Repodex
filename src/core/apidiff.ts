/**
 * Public API diff / breaking-change detection (proposal C2).
 *
 * Two halves live here:
 *
 *  1. The PURE comparator: `compareSurfaces` joins two symbol surfaces (base vs
 *     head) and classifies every symbol as `removed` / `added` /
 *     `signature-changed` / `visibility-narrowed` / `unchanged`, flagging the
 *     breaking ones. No I/O — unit-testable like `deadcode.ts` / `commits.ts`.
 *
 *  2. The surface extraction from a file's TEXT: `fileSurface` runs the SAME
 *     `chunkCode` recipe the indexer uses, so a symbol at an old git ref is
 *     extracted exactly as it would be today (same names, types, line ranges),
 *     plus `parseHasError` so a file that fails to parse at the old ref is
 *     reported as `unparsed` instead of silently contributing nothing.
 *
 * `extractRefSurface` walks a ref (`git ls-tree` → `git show` → `fileSurface`)
 * in bounded concurrency — the embedding pipeline's shape, minus embeddings.
 * The engine (`IndexManager.getApiDiff`) supplies the *current* surface from the
 * index (no re-parse) and calls `compareSurfaces`.
 *
 * No embedding, no LanceDB, no schema change, no reindex, nothing persisted.
 */
import path from "node:path";
import type { Chunk } from "../chunking/chunker";
import { chunkCode } from "../chunking/chunker";
import { EXT_TO_GRAMMAR, languageForExt, getParser } from "../chunking/tree-sitter";
import { detectExported } from "./exported";
import { deriveSignature } from "../utils/text";
import { gitLsTreeFiles, gitShowFile } from "../services/git";
import { mapWithConcurrency } from "../utils/concurrency";
import { CONFIG } from "../config";

// ------------------------------------------------------------------ surface

/**
 * One symbol's public surface on one side of the diff. `exported` is recovered
 * from the chunk text per language (`src/core/exported.ts` — the same recipe the
 * dead-code scorer uses); `signature` is the derived declaration head
 * (`deriveSignature`), "" when the chunk yields none.
 */
export interface ApiSymbol {
  symbolName: string;
  symbolType: string;
  /** Repo-relative path (the join key on both sides). */
  relativePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  signature: string;
  exported: boolean;
}

/** One classified symbol of the diff. */
export interface ApiDiffEntry {
  kind: ApiChangeKind;
  breaking: boolean;
  symbolName: string;
  symbolType: string;
  relativePath: string;
  language: string;
  /** The symbol as it was at `base` (absent for `added`). */
  base?: ApiDiffSide;
  /** The symbol as it is at `head` (absent for `removed`). */
  head?: ApiDiffSide;
}

export type ApiChangeKind =
  | "removed"
  | "signature-changed"
  | "visibility-narrowed"
  | "added"
  | "unchanged";

/** One side of a diff entry — location + derived signature (no chunk text). */
export interface ApiDiffSide {
  startLine: number;
  endLine: number;
  signature: string;
  exported: boolean;
}

/** Per-kind totals of a diff (always complete, even when `entries` is capped). */
export interface ApiDiffCounts {
  removed: number;
  signatureChanged: number;
  visibilityNarrowed: number;
  added: number;
  unchanged: number;
}

/** Breaking kinds first, in the order they should be read. */
const KIND_RANK: Record<ApiChangeKind, number> = {
  removed: 0,
  "signature-changed": 1,
  "visibility-narrowed": 2,
  added: 3,
  unchanged: 4,
};

/** The join key: same file, same name, same kind of symbol. */
function surfaceKey(s: ApiSymbol): string {
  return `${s.relativePath}\0${s.symbolType}\0${s.symbolName}`;
}

function sideOf(s: ApiSymbol): ApiDiffSide {
  return { startLine: s.startLine, endLine: s.endLine, signature: s.signature, exported: s.exported };
}

/**
 * Joins the two surfaces and classifies every symbol.
 *
 * A symbol that moved to a different name or type (a rename) surfaces as one
 * `removed` (breaking) entry plus one `added` entry — there is no rename
 * inference, so nothing is silently paired up. Both inputs should be
 * deterministic-ordered (the extractors sort); the output is sorted breaking
 * kinds first, then by path and name.
 */
export function compareSurfaces(base: ApiSymbol[], head: ApiSymbol[]): ApiDiffEntry[] {
  const baseByKey = new Map<string, ApiSymbol>();
  for (const s of base) baseByKey.set(surfaceKey(s), s);
  const headByKey = new Map<string, ApiSymbol>();
  for (const s of head) headByKey.set(surfaceKey(s), s);

  const entries: ApiDiffEntry[] = [];
  const push = (e: ApiDiffEntry): void => {
    entries.push(e);
  };

  for (const s of base) {
    const h = headByKey.get(surfaceKey(s));
    if (!h) {
      push({ kind: "removed", breaking: true, base: sideOf(s), ...named(s) });
      continue;
    }
    if (s.exported && !h.exported) {
      push({ kind: "visibility-narrowed", breaking: true, base: sideOf(s), head: sideOf(h), ...named(s) });
      continue;
    }
    if (s.signature !== h.signature && paramsDiffer(s.signature, h.signature, s.language)) {
      push({ kind: "signature-changed", breaking: true, base: sideOf(s), head: sideOf(h), ...named(s) });
      continue;
    }
    push({ kind: "unchanged", breaking: false, base: sideOf(s), head: sideOf(h), ...named(s) });
  }
  for (const s of head) {
    if (!baseByKey.has(surfaceKey(s))) {
      push({ kind: "added", breaking: false, head: sideOf(s), ...named(s) });
    }
  }

  return entries.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) ||
      (a.symbolName < b.symbolName ? -1 : a.symbolName > b.symbolName ? 1 : 0),
  );
}

/** The fields every entry carries (spread into the object literal above). */
function named(s: ApiSymbol): {
  symbolName: string;
  symbolType: string;
  relativePath: string;
  language: string;
} {
  return {
    symbolName: s.symbolName,
    symbolType: s.symbolType,
    relativePath: s.relativePath,
    language: s.language,
  };
}

/** Counts a full entry list per kind (plus the always-complete `breaking` total). */
export function countDiff(entries: ApiDiffEntry[]): ApiDiffCounts & { breaking: number } {
  const c: ApiDiffCounts & { breaking: number } = {
    removed: 0,
    signatureChanged: 0,
    visibilityNarrowed: 0,
    added: 0,
    unchanged: 0,
    breaking: 0,
  };
  for (const e of entries) {
    if (e.kind === "removed") c.removed++;
    else if (e.kind === "signature-changed") c.signatureChanged++;
    else if (e.kind === "visibility-narrowed") c.visibilityNarrowed++;
    else if (e.kind === "added") c.added++;
    else c.unchanged++;
    if (e.breaking) c.breaking++;
  }
  return c;
}

// ------------------------------------------------------- signature comparison

/** Languages whose parameter list is `name Type` (name FIRST, type last). */
const NAME_FIRST_LANGS = new Set(["go"]);

/**
 * Extracts a symbol's parameter list from its derived signature, normalized so
 * that cosmetic differences don't read as breaking changes:
 *   - default values / initializers are cut (`age = 30` → `age`);
 *   - type annotations after `:` are cut (`res: Response` → `res`);
 *   - decoration is stripped (`&`, `*`, `...`, `?`, `!`, `_`);
 *   - `name Type` languages (Go) keep the FIRST token as the name, everything
 *     else keeps the LAST (Java `String name`, C++ `const std::string& name`).
 * Python's leading `self`/`cls` is dropped on both sides, so moving a function
 * into a method doesn't read as a breaking change.
 *
 * Returns null when the signature has no parameter list (a class with no
 * constructor head, a derived signature that lost its parens) — the comparator
 * treats "cannot compare" as "not changed" (conservative: no breaking claim
 * without evidence).
 */
export function paramList(signature: string, language: string): string[] | null {
  const open = signature.indexOf("(");
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return null;
  const inner = signature.slice(open + 1, close);
  if (inner.trim().length === 0) return [];

  const parts = splitTopLevel(inner, ",");
  const out: string[] = [];
  for (const raw of parts) {
    const bare = raw.trim();
    // A bare separator marker (Python's keyword-only `*` / positional-only `/`)
    // is not a parameter — drop it instead of counting it as an arity change.
    if (/^[*/&.]+$/.test(bare)) continue;
    let p = normalizeParam(raw, language);
    if (p.length === 0) p = bare;
    out.push(p);
  }
  // Python's implicit receiver is not part of the callable's public arity.
  if ((language === "python" || language === "gdscript") && out.length > 0) {
    const first = out[0]!;
    if (first === "self" || first === "cls") out.shift();
  }
  return out;
}

/** Splits on `sep` at paren/bracket/brace/angle depth 0 only. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if ("([{<".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Cuts `s` at the first top-level occurrence of `ch` (depth-aware). A DOUBLED
 * `ch` is not a separator: C++'s `std::string` must not read as a type
 * annotation, so `const std::string& name` survives the `:` cut intact.
 */
function cutTopLevel(s: string, ch: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if ("([{<".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === ch && s[i - 1] !== ch && s[i + 1] !== ch) return s.slice(0, i);
  }
  return s;
}

function normalizeParam(raw: string, language: string): string {
  let p = raw.trim();
  if (p.length === 0) return "";
  // Variadic / optional / reference decoration.
  p = p.replace(/^\.{3}/, "").replace(/^[*&]+/, "").replace(/[?!,]+$/, "").trim();
  // Default value, then type annotation (`x: Type = def` → `x`).
  p = cutTopLevel(p, "=").trim();
  p = cutTopLevel(p, ":").trim();
  // Rust/TS pattern remnants (`mut x`, `ref x`).
  p = p.replace(/^(mut|ref|inout|const)\s+/i, "").trim();
  if (p.includes(" ")) {
    const toks = p.split(/\s+/).filter((t) => t.length > 0 && t !== "_");
    p = (NAME_FIRST_LANGS.has(language) ? toks[0] : toks[toks.length - 1]) ?? "";
  }
  return p.replace(/^[*&]+/, "").replace(/[?!,]+$/, "").trim();
}

/**
 * Do the two signatures' parameter lists differ? Approximate BY DESIGN:
 * arity, parameter order and (normalized) parameter names are compared —
 * structural differences (type-only changes, overloads, default-value moves
 * that keep the names) may need human review. A side with no comparable
 * parameter list never counts as changed.
 */
export function paramsDiffer(baseSig: string, headSig: string, language: string): boolean {
  const a = paramList(baseSig, language);
  const b = paramList(headSig, language);
  if (!a || !b) return false;
  if (a.length !== b.length) return true;
  return a.some((p, i) => p !== b[i]);
}

// --------------------------------------------------- surface from file text

/** A file's surface: its symbols, plus whether it failed to parse. */
export interface FileSurface {
  symbols: ApiSymbol[];
  /** The file has an AST grammar but failed to parse — reported, never skipped silently. */
  parseFailed: boolean;
}

/**
 * Extracts a file's symbol surface from its text with the SAME tree-sitter
 * recipe the indexer uses (`chunkCode`), so a symbol is named/typed/ranged
 * identically on both sides of the diff. `relPath` only needs the right
 * extension (it picks the grammar and is the join key).
 */
export async function fileSurface(relPath: string, content: string): Promise<FileSurface> {
  const ext = path.extname(relPath).toLowerCase();
  const language = EXT_TO_GRAMMAR[ext];
  // Scope guard: only AST languages (the 16 bundled grammars) have a surface —
  // character-fallback corpora (json/md/xml/rst) carry no symbols at all.
  if (!language) return { symbols: [], parseFailed: false };
  const chunks = await chunkCode(relPath, content);
  const symbols = surfaceFromChunks(chunks, language, relPath);
  // A file that yields no symbols is only a parse failure if the parse actually
  // errored; a legitimately symbol-less file (`const x = 1`) is just empty.
  const parseFailed = symbols.length === 0 && (await parseHasError(ext, content));
  return { symbols, parseFailed };
}

/** Chunks → surface symbols (split symbols merged, longest chunk wins). */
function surfaceFromChunks(chunks: Chunk[], language: string, relPath: string): ApiSymbol[] {
  const byKey = new Map<string, ApiSymbol>();
  for (const c of chunks) {
    if (!c.symbolName || !c.symbolType) continue;
    const key = `${c.symbolType}\0${c.symbolName}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        symbolName: c.symbolName,
        symbolType: c.symbolType,
        relativePath: relPath,
        language,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        signature: deriveSignature(c.content, language),
        exported: detectExported(c.symbolName, c.symbolType, language, c.content),
      });
    } else {
      prev.startLine = Math.min(prev.startLine, c.startLine);
      prev.endLine = Math.max(prev.endLine, c.endLine);
      if (c.content.length > prev.content.length) {
        prev.content = c.content;
        prev.signature = deriveSignature(c.content, language);
        prev.exported = detectExported(c.symbolName, c.symbolType, language, c.content);
      }
    }
  }
  return sortSurface([...byKey.values()]);
}

/** Deterministic surface order (path, name, type) — the join is order-insensitive. */
function sortSurface(symbols: ApiSymbol[]): ApiSymbol[] {
  return symbols.sort(
    (a, b) =>
      (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) ||
      (a.symbolName < b.symbolName ? -1 : a.symbolName > b.symbolName ? 1 : 0) ||
      (a.symbolType < b.symbolType ? -1 : a.symbolType > b.symbolType ? 1 : 0),
  );
}

/**
 * Does this content fail to parse with its grammar? (`rootNode.hasError`.)
 * Same shared-parser discipline as everywhere else: NO `await` between
 * `setLanguage` and `parse`. Any failure to load/parse returns false — this is
 * a confirmation step, never a source of false "unparsed" claims.
 */
async function parseHasError(ext: string, content: string): Promise<boolean> {
  try {
    const lang = await languageForExt(ext);
    if (!lang) return false;
    const parser = await getParser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    return tree ? tree.rootNode.hasError : false;
  } catch {
    return false;
  }
}

// ------------------------------------------------- surface from index rows

/** Only the fields the surface needs, exactly as `tableSymbolsWithContent` returns them. */
export interface IndexedSymbolRow {
  filePath: string;
  language?: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
}

/**
 * Projects the INDEX's symbol rows (the working-tree side of the diff) into a
 * surface: one `ApiSymbol` per (path, type, name), split symbols merged with the
 * longest chunk winning, exportedness recovered from the chunk text. Only AST
 * symbols are present in the index (character-fallback chunks carry no name), so
 * this is the same scope the historical side extracts.
 */
export function surfaceFromIndexRows(projectRoot: string, rows: IndexedSymbolRow[]): ApiSymbol[] {
  const byKey = new Map<string, ApiSymbol>();
  for (const r of rows) {
    const name = r.symbolName;
    const st = r.symbolType;
    if (!name || !st) continue;
    if (typeof r.startLine !== "number" || typeof r.endLine !== "number") continue;
    const content = typeof r.content === "string" ? r.content : "";
    const rel = path.relative(projectRoot, r.filePath);
    const language = r.language ?? "";
    const key = `${rel}\0${st}\0${name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        symbolName: name,
        symbolType: st,
        relativePath: rel,
        language,
        startLine: r.startLine,
        endLine: r.endLine,
        content,
        signature: deriveSignature(content, language),
        exported: detectExported(name, st, language, content),
      });
    } else {
      prev.startLine = Math.min(prev.startLine, r.startLine);
      prev.endLine = Math.max(prev.endLine, r.endLine);
      if (content.length > prev.content.length) {
        prev.content = content;
        prev.signature = deriveSignature(content, language);
        prev.exported = detectExported(name, st, language, content);
      }
    }
  }
  return sortSurface([...byKey.values()]);
}

// ------------------------------------------------------- surface from a ref

/** Default cap on how many historical files are parsed per side. */
export const API_DIFF_MAX_FILES = 1000;

/** A ref's extracted surface, with the honest-coverage fields the engine surfaces. */
export interface RefSurface {
  symbols: ApiSymbol[];
  /** Files at the ref that could not be read or parsed (`unparsed` in the report). */
  unparsed: { path: string; reason: "read-failed" | "parse-error" }[];
  /** AST-language files actually scanned (after the cap). */
  scannedFiles: number;
  /** The AST file list exceeded the cap — the surface (and diff) is partial. */
  truncated: boolean;
}

/**
 * Extracts the exported-symbol surface of a whole tree at `ref`:
 * `git ls-tree -r` intersected with the AST extensions, then a bounded-
 * concurrent `git show` + parse pass over the contents (the embedding
 * pipeline's shape, minus embeddings). Reads only — no index mutation, nothing
 * persisted. Returns null when the ref can't be listed at all (unknown ref /
 * not a repo / git failure); per-FILE failures go to `unparsed` instead.
 */
export async function extractRefSurface(
  baseDir: string,
  ref: string,
  opts?: { maxFiles?: number; concurrency?: number },
): Promise<RefSurface | null> {
  const all = await gitLsTreeFiles(baseDir, ref);
  if (!all) return null;
  const maxFiles = opts?.maxFiles ?? API_DIFF_MAX_FILES;
  const astFiles = all.filter((f) => EXT_TO_GRAMMAR[path.extname(f).toLowerCase()] !== undefined);
  const truncated = astFiles.length > maxFiles;
  const picked = astFiles.slice(0, maxFiles);

  const symbols: ApiSymbol[] = [];
  const unparsed: RefSurface["unparsed"] = [];
  await mapWithConcurrency(picked, opts?.concurrency ?? CONFIG.EMBED_CONCURRENCY, async (rel) => {
    const content = await gitShowFile(baseDir, ref, rel);
    if (content === null) {
      unparsed.push({ path: rel, reason: "read-failed" });
      return;
    }
    if (content.trim().length === 0) return; // an empty file has no surface — not a failure
    const s = await fileSurface(rel, content);
    if (s.parseFailed) unparsed.push({ path: rel, reason: "parse-error" });
    symbols.push(...s.symbols);
  });

  unparsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { symbols: sortSurface(symbols), unparsed, scannedFiles: picked.length, truncated };
}
