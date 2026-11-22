/**
 * Tool-usage analytics (2.10.0) — the honest, local-only half of "how much is
 * cidx saving me?".
 *
 * Every MCP / Control-API tool call records one bounded row (registry
 * `usage_log`): the tool, the project (when an anchor was given), success,
 * returned chars → estimated tokens, and an estimate of the tokens an agent
 * would have spent reading the files the answer points at. The estimates are
 * deliberately crude (chars/4, full file sizes) and labelled as estimates —
 * the point is the ratio, never a billing number.
 *
 * Pure functions only (the file `stat` is injected), so the math is unit-tested
 * without a daemon or a filesystem.
 */

/** Cap on the payload text measured per call (a huge pack must not blow memory). */
export const MAX_PAYLOAD_CHARS = 200_000;

/** Cap on the distinct files whose full size contributes to the avoided estimate. */
export const MAX_AVOIDED_FILES = 50;

/** Tools whose payload points at code the agent would otherwise read whole. */
export const AVOIDED_ESTIMATE_TOOLS: ReadonlySet<string> = new Set([
  "search_codebase",
  "search_codebase_batch",
  "get_context_pack",
  "find_symbol",
  "find_references",
  "get_file_outline",
  "get_dependencies",
  "get_call_graph",
  "get_change_impact",
  "find_dead_code",
  "search_commits",
  "get_coupling",
  "get_hotspots",
  "check_docs",
]);

/** Serialises a value for a rough size estimate (never throws). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Rendered chars of one tool reply: the text content plus the structured
 * payload, capped at `MAX_PAYLOAD_CHARS`. Both are usually present (MCP returns
 * text + `structuredContent`), so this counts what a client actually receives.
 */
export function estimatePayloadChars(text: string | undefined, structured: unknown): number {
  const textLen = typeof text === "string" ? text.length : 0;
  const structuredLen = structured === undefined ? 0 : safeJson(structured).length;
  return Math.min(MAX_PAYLOAD_CHARS, textLen + structuredLen);
}

/** Estimated tokens for a char count (ceil; at least 1 for a non-empty payload). */
export function estimateReturnedTokens(chars: number, charsPerToken = 4): number {
  const divisor = charsPerToken > 0 ? charsPerToken : 4;
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / divisor);
}

/**
 * Distinct `filePath` values anywhere in a payload (search hits, batch groups,
 * pack hits, dependency edges…), capped at `MAX_AVOIDED_FILES`. Bounded walk:
 * depth 6, 50k visited nodes — a malformed/huge payload cannot spin here.
 */
export function uniqueFilePaths(payload: unknown): string[] {
  const out = new Set<string>();
  let visited = 0;
  const walk = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 6) return;
    if (out.size >= MAX_AVOIDED_FILES || visited >= 50_000) return;
    visited++;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.filePath === "string" && obj.filePath.length > 0) out.add(obj.filePath);
    for (const v of Object.values(obj)) {
      if (typeof v === "object" && v !== null) walk(v, depth + 1);
    }
  };
  walk(payload, 0);
  return [...out];
}

/** One call's estimates, as stored in `usage_log`. */
export interface ToolUsageEstimate {
  returnedChars: number;
  estReturnedTokens: number;
  estAvoidedTokens: number;
}

/**
 * Estimates one tool call's cost/saving.
 *
 * - `returnedChars`/`estReturnedTokens` measure the reply.
 * - `estAvoidedTokens` (only for `AVOIDED_ESTIMATE_TOOLS`) sums the FULL file
 *   sizes of the distinct files in the payload (≤ 50, `stat` injected) divided
 *   by `charsPerToken`, minus the tokens actually returned, clamped at 0. A
 *   report that names a 200-line file instead of dumping it therefore reads as
 *   a saving; a payload that dumps most of the files reads as ~0.
 */
export function estimateToolUsage(input: {
  tool: string;
  text: string | undefined;
  structured: unknown;
  charsPerToken: number;
  /** Full byte size of a path (null = unreadable/absent). */
  sizeOfFile?: ((filePath: string) => number | null) | undefined;
}): ToolUsageEstimate {
  const charsPerToken = input.charsPerToken > 0 ? input.charsPerToken : 4;
  const returnedChars = estimatePayloadChars(input.text, input.structured);
  const estReturnedTokens = estimateReturnedTokens(returnedChars, charsPerToken);
  let estAvoidedTokens = 0;
  if (AVOIDED_ESTIMATE_TOOLS.has(input.tool) && input.sizeOfFile) {
    const paths = uniqueFilePaths(input.structured).slice(0, MAX_AVOIDED_FILES);
    let fullTokens = 0;
    for (const p of paths) {
      const size = input.sizeOfFile(p);
      if (size !== null && Number.isFinite(size) && size > 0) fullTokens += size / charsPerToken;
    }
    estAvoidedTokens = Math.max(0, Math.round(fullTokens - estReturnedTokens));
  }
  return { returnedChars, estReturnedTokens, estAvoidedTokens };
}
