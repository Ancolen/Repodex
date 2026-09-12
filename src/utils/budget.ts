/**
 * Token/character budget for search output.
 *
 * Applied server-side, after ranking + enrichment, so the budget is consistent
 * across every surface (HTTP JSON, MCP, stdio, CLI). Results are dropped whole,
 * in ranked order, until the cumulative size fits — code is never truncated
 * mid-chunk (a few complete results serve the agent better than sliced code).
 */

/** Approximate framing overhead per rendered result (header, meta, fences). */
const HEADER_CHARS = 120;

/** The fields applyCharBudget looks at to estimate a result's rendered size. */
interface BudgetedResult {
  content?: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

/** Rough rendered size of one result (content + surrounding context + framing). */
export function resultSize(r: BudgetedResult): number {
  const content = typeof r.content === "string" ? r.content.length : 0;
  const before = r.contextBefore?.join("\n").length ?? 0;
  const after = r.contextAfter?.join("\n").length ?? 0;
  return content + before + after + HEADER_CHARS;
}

/**
 * Returns the leading prefix of `rows` whose cumulative size fits `maxChars`.
 * Always keeps at least the top result (even if it alone exceeds the budget) so
 * a small budget never yields zero results. No-op when `maxChars` is unset/<=0.
 */
export function applyCharBudget<T extends BudgetedResult>(rows: T[], maxChars?: number): T[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) return rows;
  const out: T[] = [];
  let used = 0;
  for (const r of rows) {
    const size = resultSize(r);
    if (out.length > 0 && used + size > maxChars) break;
    out.push(r);
    used += size;
  }
  return out;
}

// ------------------------------------------------------------- context pack

/**
 * Approximate framing overhead for one pack entry beyond its hit text (the
 * "Outline:" / "Imports:" captions, separators and spacing). Purely a framing
 * estimate — the legs' real content is measured below.
 */
export const PACK_FRAME_CHARS = 80;

/** Approximate rendered size of one outline line ("L12-34  method Name"). */
export const OUTLINE_LINE_CHARS = 20;

/** Approximate rendered size of one import line ("→ src/a.ts  (from "./a")"). */
export const IMPORT_LINE_CHARS = 30;

/** The outline shape applyPackBudget measures (a structural subset is enough). */
export interface PackOutlineEntry {
  symbolName?: string;
  symbolType?: string;
}

/** The import-edge shape applyPackBudget measures. */
export interface PackImportEdge {
  raw?: string;
  relativePath?: string;
  path?: string;
}

/** One assembled pack entry: the search hit plus its per-hit enrichment legs. */
export interface PackEntry {
  /** The search hit itself (content + surrounding context). */
  hit: BudgetedResult;
  /** The hit file's outline lines (optional leg). */
  outline?: PackOutlineEntry[];
  /** The hit file's forward imports (optional leg). */
  imports?: PackImportEdge[];
}

/** Approximate rendered size of a pack entry's outline (one line per symbol). */
export function outlineSize(outline?: PackOutlineEntry[]): number {
  if (!outline) return 0;
  let n = 0;
  for (const o of outline) {
    n += (o.symbolName?.length ?? 0) + (o.symbolType?.length ?? 0) + OUTLINE_LINE_CHARS;
  }
  return n;
}

/** Approximate rendered size of a pack entry's import list (one line per edge). */
export function importsSize(imports?: PackImportEdge[]): number {
  if (!imports) return 0;
  let n = 0;
  for (const e of imports) {
    n += (e.raw?.length ?? 0) + (e.relativePath ?? e.path ?? "").length + IMPORT_LINE_CHARS;
  }
  return n;
}

/** Rough rendered size of one pack entry: the hit (content + context + framing) plus its legs. */
export function packEntrySize(entry: PackEntry): number {
  return resultSize(entry.hit) + outlineSize(entry.outline) + importsSize(entry.imports) + PACK_FRAME_CHARS;
}

/** What the pack-level budget reports back. */
export interface PackBudgetResult<T> {
  /** The kept entries, in ranked order (the top entry is always present). */
  hits: T[];
  /** Running total of the kept entries' approximate rendered size. */
  totalChars: number;
  /** Entries dropped whole to fit the budget (they are NOT truncated). */
  omitted: number;
}

/**
 * THE ONE BUDGET OF A CONTEXT PACK, applied once over the assembled entries.
 * Entries are added whole, in ranked order, while the running total fits; the top
 * entry is always kept (even if it alone exceeds the budget) so a small budget never
 * yields an empty pack; everything after the first non-fitting entry is reported as
 * `omitted` — never truncated, never silently dropped. The rank prefix is kept whole
 * on purpose (same discipline as `applyCharBudget`): a later, smaller entry is not
 * admitted past a higher-ranked one that didn't fit.
 *
 * No-op when `maxChars` is unset/non-finite/<=0 — the entries pass through untouched
 * and `totalChars` still reports their combined size (so callers can show it).
 */
export function applyPackBudget<T extends PackEntry>(entries: T[], maxChars?: number): PackBudgetResult<T> {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { hits: entries, totalChars: 0, omitted: 0 };
  }
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) {
    let total = 0;
    for (const e of entries) total += packEntrySize(e);
    return { hits: entries, totalChars: total, omitted: 0 };
  }
  const hits: T[] = [];
  let used = 0;
  for (const e of entries) {
    const size = packEntrySize(e);
    if (hits.length > 0 && used + size > maxChars) break;
    hits.push(e);
    used += size;
  }
  return { hits, totalChars: used, omitted: entries.length - hits.length };
}

// ------------------------------------------------------- size-keyed budget

/** What applyBudgetBySize reports back. */
export interface SizedBudgetResult<T> {
  /** The kept rows, in original order (the first row is always present). */
  kept: T[];
  /** Rows dropped whole to fit the budget (they are NOT truncated). */
  omitted: number;
}

/**
 * Generic sibling of `applyCharBudget` for rows whose rendered size is not
 * derivable from their own fields (the caller supplies `sizeOf`). Rows are kept
 * whole, in order, while the running total fits; the first row is always kept
 * (even if it alone exceeds the budget) and a later, smaller row is not admitted
 * past a higher-ranked one that didn't fit. No-op when `maxChars` is
 * unset/non-finite/<=0 — every row passes through and `omitted` is 0.
 */
export function applyBudgetBySize<T>(
  rows: readonly T[],
  maxChars: number | undefined,
  sizeOf: (item: T) => number,
): SizedBudgetResult<T> {
  if (rows.length === 0) return { kept: [], omitted: 0 };
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) {
    return { kept: [...rows], omitted: 0 };
  }
  const kept: T[] = [];
  let used = 0;
  for (const r of rows) {
    const size = sizeOf(r);
    if (kept.length > 0 && used + size > maxChars) break;
    kept.push(r);
    used += size;
  }
  return { kept, omitted: rows.length - kept.length };
}
