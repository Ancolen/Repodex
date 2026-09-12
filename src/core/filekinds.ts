/**
 * Pure file-kind heuristics shared by the analyses that reason over the indexed
 * file set (dead code, reverse doc coverage, …). No I/O — path string in,
 * boolean/set out. Works on absolute and project-relative paths alike (only
 * basenames and slash-normalized segments are inspected).
 */

/** Symbol types worth checking for dead code / doc coverage (skip `code`/`impl`/anonymous). */
export const DEAD_CANDIDATE_TYPES = new Set([
  "function", "method", "class", "interface", "enum", "struct", "trait", "record",
]);

/** Basenames (without extension) that mark an entry-point file. */
export const ENTRY_POINT_NAMES = new Set([
  "main", "index", "app", "cli", "server", "program", "__main__",
  "mod", "lib", "entry", "bootstrap", "start",
]);

/** Test-file patterns: symbols here are exercised indirectly, so never dead. */
export function isTestFile(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  const norm = filePath.replace(/\\/g, "/");
  if (/^test_/.test(base)) return true; // test_*.py / test_*.go
  if (/_test\.[a-z0-9]+$/.test(base)) return true; // foo_test.go
  if (/\.(test|spec)\.[a-z0-9]+$/.test(base)) return true; // foo.test.ts / bar.spec.js
  if (/(^|\/)(tests?|__tests?__|spec)\//.test(norm)) return true; // tests/, __tests__/, spec/
  return false;
}

/** Entry-point files (main/index/app/…): their symbols are called by the runtime. */
export function isEntryPointFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return ENTRY_POINT_NAMES.has(stem.toLowerCase());
}