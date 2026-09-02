/**
 * Dependency resolution — turn raw import specifiers into real indexed files.
 *
 * Pure: no I/O. Takes the indexed-file set (as a `FileIndex`) and the importing
 * file's path, returns a `ResolvedDep` per spec. **Every resolved path is
 * validated against the index** — we never return a file that isn't indexed, so
 * there are no phantom edges.
 *
 * Resolution is language-aware but deliberately pragmatic: relative specifiers
 * (JS/TS, Python relative, Rust crate/super/self, C/C++ local includes, PHP/Ruby
 * local requires) are resolved against the filesystem layout; external specifiers
 * (node_modules, stdlib, external crates, go modules, namespaces) are returned as
 * `external` rather than scanned. Where the source root is unknown (Java/Kotlin
 * packages, etc.), a path-segment suffix match against the index is used.
 */
import path from "node:path";
import type { ImportSpec } from "../chunking/imports";

export interface ResolvedDep {
  /** Original specifier. */
  raw: string;
  language: string;
  line: number;
  /** Absolute path when matched against an indexed file; undefined otherwise. */
  resolvedPath?: string;
  /** Repo-relative path (relative to projectRoot) when resolved. */
  relativePath?: string;
  status: "resolved" | "external" | "unresolved";
  /** Why it's external/unresolved, or the match strategy used. */
  reason?: string;
}

// ---- index over indexed files ----

export interface FileIndex {
  /** All absolute indexed file paths. */
  exact: ReadonlySet<string>;
  /** Key = last two path segments joined (e.g. "b/c.py") → set of absolute paths ending that way. */
  bySuffix: Map<string, Set<string>>;
}

/** Build a lookup index from a set/list of absolute file paths. */
export function buildFileIndex(indexedFiles: Iterable<string>): FileIndex {
  const exact = new Set<string>();
  const bySuffix = new Map<string, Set<string>>();
  for (const f of indexedFiles) {
    exact.add(f);
    const key = lastSegments(f, 2);
    let bucket = bySuffix.get(key);
    if (!bucket) {
      bucket = new Set();
      bySuffix.set(key, bucket);
    }
    bucket.add(f);
  }
  return { exact, bySuffix };
}

function lastSegments(p: string, n: number): string {
  // Normalize to forward slashes for cross-platform suffix keys.
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts.slice(-n).join("/");
}

// ---- match primitives ----

function exactMatch(index: FileIndex, candidate: string): string | null {
  return index.exact.has(candidate) ? candidate : null;
}

/**
 * Find an indexed file whose path ends with the given relative segments
 * (path-segment aligned, not a raw substring). Used when the source root is
 * unknown (Java/Kotlin packages). `reason` labels the match strategy.
 */
function suffixMatch(index: FileIndex, relSegments: string, reason: string): { path: string; reason: string } | null {
  const norm = relSegments.replace(/\\/g, "/").replace(/^\/+/, "");
  const key = norm.split("/").slice(-2).join("/");
  const candidates = index.bySuffix.get(key);
  if (!candidates) return null;
  const needle = "/" + norm;
  for (const f of candidates) {
    const fnorm = f.replace(/\\/g, "/");
    if (fnorm === norm || fnorm.endsWith(needle)) {
      return { path: f, reason };
    }
  }
  return null;
}

// ---- per-language resolution ----

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"];
const JS_INDEX = ["index.js", "index.ts", "index.tsx", "index.mjs", "index.cjs"];

function resolveJs(spec: ImportSpec, index: FileIndex, importingFile: string): ResolvedDep {
  const raw = spec.raw;
  if (!raw.startsWith(".") && !raw.startsWith("/")) {
    return { ...spec, status: "external", reason: "node_modules" };
  }
  const dir = path.dirname(importingFile);
  const base = path.resolve(dir, raw);
  // Try the bare path, then extension variants, then index files.
  const candidates = [base, ...JS_EXTS.map((e) => base + e), ...JS_INDEX.map((i) => path.join(base, i))];
  for (const c of candidates) {
    const hit = exactMatch(index, c);
    if (hit) return resolved(spec, hit);
  }
  // Suffix fallback for the relative path (root may differ).
  const rel = raw.replace(/^\.\/?/, "").replace(/^\.\.\//g, "");
  const sm = rel ? suffixMatch(index, rel + (path.extname(rel) ? "" : ""), "suffix") : null;
  if (sm) return resolved(spec, sm.path, sm.reason);
  return { ...spec, status: "unresolved", reason: "no indexed match" };
}

function resolvePython(spec: ImportSpec, projectRoot: string, index: FileIndex, importingFile: string): ResolvedDep {
  const raw = spec.raw;
  const dots = raw.match(/^\.+/)?.[0]?.length ?? 0;
  const module = raw.slice(dots);
  // Relative import: ascend (dots-1) dirs from the importing file's directory.
  if (dots > 0) {
    let dir = path.dirname(importingFile);
    for (let i = 1; i < dots; i++) dir = path.dirname(dir);
    const hit = pyModuleResolve(dir, module, index, /*allowInit*/ true);
    if (hit) return resolved(spec, hit.path, hit.reason);
    return { ...spec, status: "unresolved", reason: "no indexed match" };
  }
  if (!module) {
    // `from . import x` with no module — leave unresolved (the name isn't a path).
    return { ...spec, status: "unresolved", reason: "relative name import" };
  }
  // Bare module: resolve from the project root (typical source root), with suffix fallback.
  const hit = pyModuleResolve(projectRoot, module, index, true);
  if (hit) return resolved(spec, hit.path, hit.reason);
  return { ...spec, status: "external", reason: "stdlib / site-packages" };
}

function pyModuleResolve(
  baseDir: string,
  module: string,
  index: FileIndex,
  allowInit: boolean,
): { path: string; reason: string } | null {
  if (!module) return null;
  const segs = module.split(".").filter(Boolean);
  const relPy = segs.join("/") + ".py";
  // Exact under baseDir.
  const pyExact = path.resolve(baseDir, relPy);
  const e1 = exactMatch(index, pyExact);
  if (e1) return { path: e1, reason: "exact" };
  if (allowInit) {
    const initExact = path.resolve(baseDir, ...segs, "__init__.py");
    const e2 = exactMatch(index, initExact);
    if (e2) return { path: e2, reason: "exact" };
  }
  // Suffix fallback (source root unknown).
  const sm = suffixMatch(index, relPy, "suffix");
  if (sm) return sm;
  if (allowInit) {
    const sm2 = suffixMatch(index, segs.join("/") + "/__init__.py", "suffix");
    if (sm2) return sm2;
  }
  return null;
}

function resolveRust(spec: ImportSpec, projectRoot: string, index: FileIndex, importingFile: string): ResolvedDep {
  const raw = spec.raw;
  const segs = raw.split("::").filter(Boolean);
  if (segs.length === 0) return { ...spec, status: "unresolved", reason: "empty" };
  const first = segs[0]!;
  let base: string;
  if (first === "crate") {
    base = projectRoot;
    segs.shift();
  } else if (first === "super") {
    base = path.dirname(path.dirname(importingFile));
    segs.shift();
  } else if (first === "self") {
    base = path.dirname(importingFile);
    segs.shift();
  } else {
    // External crate (we can't see its source) unless it suffix-matches a local file.
    return { ...spec, status: "external", reason: "external crate" };
  }
  if (segs.length === 0) return { ...spec, status: "unresolved", reason: "no path" };
  // `use crate::a::b::Type` — Type is an item, not a file. Resolve to the deepest
  // module that IS a file by trying the full segment path first, then peeling the
  // last segment, down to a single segment. Each tries `<path>.rs` and `<path>/mod.rs`,
  // both exact-at-base and via suffix match (source root may be src/, not the root).
  for (let depth = segs.length; depth >= 1; depth--) {
    const pathSegs = segs.slice(0, depth);
    const joined = pathSegs.join("/");
    const candidates = [
      path.join(base, ...pathSegs) + ".rs",
      path.join(base, ...pathSegs, "mod.rs"),
    ];
    for (const c of candidates) {
      const hit = exactMatch(index, c);
      if (hit) return resolved(spec, hit);
    }
    const sm = suffixMatch(index, joined + ".rs", "suffix");
    if (sm) return resolved(spec, sm.path, sm.reason);
    const sm2 = suffixMatch(index, joined + "/mod.rs", "suffix");
    if (sm2) return resolved(spec, sm2.path, sm2.reason);
  }
  return { ...spec, status: "unresolved", reason: "no indexed match" };
}

function resolveC(spec: ImportSpec, importingFile: string, projectRoot: string, index: FileIndex): ResolvedDep {
  const raw = spec.raw;
  if (spec.kind === "system") {
    return { ...spec, status: "external", reason: "system header" };
  }
  const dir = path.dirname(importingFile);
  // Relative to the importing file, then the project root, then a suffix match.
  const c1 = path.resolve(dir, raw);
  const e1 = exactMatch(index, c1);
  if (e1) return resolved(spec, e1);
  const c2 = path.resolve(projectRoot, raw);
  const e2 = exactMatch(index, c2);
  if (e2) return resolved(spec, e2);
  const sm = suffixMatch(index, raw, "suffix");
  if (sm) return resolved(spec, sm.path, sm.reason);
  return { ...spec, status: "unresolved", reason: "no indexed match" };
}

function resolveJavaKotlin(spec: ImportSpec, index: FileIndex, ext: string): ResolvedDep {
  // com.foo.Bar → look for Bar.<ext> anywhere (suffix match on the simple name).
  const simple = spec.raw.split(/[.]/).pop();
  if (!simple) return { ...spec, status: "external", reason: "namespace" };
  const sm = suffixMatch(index, simple + ext, "basename");
  if (sm) return resolved(spec, sm.path, sm.reason);
  return { ...spec, status: "external", reason: "namespace / external" };
}

function resolveLocalRequire(spec: ImportSpec, index: FileIndex, importingFile: string, ext: string): ResolvedDep {
  // PHP/Ruby local require relative to the importing file's dir.
  const dir = path.dirname(importingFile);
  let raw = spec.raw;
  const withExt = path.extname(raw) ? raw : raw + ext;
  const c1 = path.resolve(dir, withExt);
  const e1 = exactMatch(index, c1);
  if (e1) return resolved(spec, e1);
  const sm = suffixMatch(index, withExt, "suffix");
  if (sm) return resolved(spec, sm.path, sm.reason);
  return { ...spec, status: spec.kind === "external" ? "external" : "unresolved", reason: "load path / no match" };
}

function resolveGdscript(
  spec: ImportSpec,
  projectRoot: string,
  index: FileIndex,
  importingFile: string,
): ResolvedDep {
  // `res://x/y.gd` is Godot-project-root-relative; the indexed project root IS the
  // Godot project root in the common case, so try it first. Bare relative paths
  // are importing-file-relative. Extension may be omitted (`extends "res://a/b"`).
  const raw = spec.raw.replace(/^res:\/\//, "");
  const withExt = path.extname(raw) ? raw : raw + ".gd";
  const candidates = [path.resolve(projectRoot, withExt), path.resolve(path.dirname(importingFile), withExt)];
  for (const c of candidates) {
    const hit = exactMatch(index, c);
    if (hit) return resolved(spec, hit);
  }
  const sm = suffixMatch(index, withExt, "suffix");
  if (sm) return resolved(spec, sm.path, sm.reason);
  return { ...spec, status: "unresolved", reason: "no indexed match" };
}

// ---- public entry ----

function resolved(spec: ImportSpec, absPath: string, reason?: string): ResolvedDep {
  const out: ResolvedDep = {
    raw: spec.raw,
    language: spec.language,
    line: spec.line,
    resolvedPath: absPath,
    status: "resolved",
  };
  if (reason) out.reason = reason;
  return out;
}

/** Resolve a list of import specs against the indexed-file index. */
export function resolveImports(
  specs: ImportSpec[],
  projectRoot: string,
  index: FileIndex,
  importingFile: string,
): ResolvedDep[] {
  const out: ResolvedDep[] = [];
  for (const spec of specs) {
    out.push(resolveOne(spec, projectRoot, index, importingFile));
  }
  return out;
}

function resolveOne(
  spec: ImportSpec,
  projectRoot: string,
  index: FileIndex,
  importingFile: string,
): ResolvedDep {
  switch (spec.language) {
    case "javascript":
    case "typescript":
    case "tsx":
      return resolveJs(spec, index, importingFile);
    case "python":
      return resolvePython(spec, projectRoot, index, importingFile);
    case "rust":
      return resolveRust(spec, projectRoot, index, importingFile);
    case "c":
    case "cpp":
      return resolveC(spec, importingFile, projectRoot, index);
    case "java":
      return resolveJavaKotlin(spec, index, ".java");
    case "kotlin":
      return resolveJavaKotlin(spec, index, ".kt");
    case "php":
      return resolveLocalRequire(spec, index, importingFile, ".php");
    case "ruby":
      return resolveLocalRequire(spec, index, importingFile, ".rb");
    case "gdscript":
      return resolveGdscript(spec, projectRoot, index, importingFile);
    case "c_sharp":
    case "swift":
    case "scala":
    case "go":
      // Namespaces / modules — not file-level imports; only a suffix match if a source path coincides.
      return resolveNamespace(spec, index);
    default:
      return { ...spec, status: "external", reason: "unsupported" };
  }
}

function resolveNamespace(spec: ImportSpec, index: FileIndex): ResolvedDep {
  // Best-effort: try the simple name as a file suffix for the common extensions.
  const simple = spec.raw.split(/[./]/).pop();
  if (!simple) return { ...spec, status: "external", reason: "namespace" };
  for (const ext of [".cs", ".swift", ".scala", ".go"]) {
    const sm = suffixMatch(index, simple + ext, "basename");
    if (sm) return resolved(spec, sm.path, sm.reason);
  }
  return { ...spec, status: "external", reason: "namespace / external" };
}
