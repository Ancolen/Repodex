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
