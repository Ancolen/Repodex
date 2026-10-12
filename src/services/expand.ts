import { CONFIG } from "../config";
import { rrfMerge } from "../utils/rrf";
import { sanitizeLoneSurrogates } from "../utils/text";
import { resolveEmbedBackend } from "./embed";

/**
 * Query expansion over the local LLM backend (proposal S4).
 *
 * An agent's first query is often intent-shaped and under-specified ("auth
 * check middleware"). One completion call turns it into 2-3 variant queries —
 * a symbol-identifier-shaped variant (snake_case / camelCase tokens only) plus
 * a rephrased natural variant — whose rankings merge into the base ranking via
 * weighted RRF (`mergeVariantRankings`: the ORIGINAL query is the merge's first
 * list at weight 1, every variant at 0.5, so the original's verdict alone
 * outranks any single variant's; corroborating variants still promote a hit).
 *
 * The wire follows rerank's dual-backend patterns (Ollama `/api/generate`,
 * llama.cpp `/v1/completions`); `search.expand.url` may point at its own
 * server, otherwise the resolved embedding backend's URL is used.
 *
 * Failure contract: retry-free and transparent. Any failure — no model
 * configured, backend unreachable, HTTP error, timeout, malformed response —
 * comes back as an EMPTY variant list plus a reason; the caller runs the plain
 * base search unchanged and surfaces the reason as an envelope note.
 */

/** The expansion client knobs (the `search.expand` config block). */
export interface ExpandClientConfig {
  /** Ollama tag / llama-server alias of the expansion model. Empty = the feature is unavailable. */
  model: string;
  /** Base URL of the expansion server. Empty = follow the resolved embedding backend. */
  url: string;
  /** Max variant queries one expanded search may add. */
  maxVariants: number;
  /** The single completion call aborts at this deadline. */
  timeoutMs: number;
}

/** The resolved config, with a test hook pinning it (tests never edit CONFIG). */
let configOverride: ExpandClientConfig | null = null;

/** The expansion client config (override-aware; the CONFIG block by default). */
export function expandConfig(): ExpandClientConfig {
  if (configOverride) return configOverride;
  return {
    model: CONFIG.EXPAND_MODEL,
    url: CONFIG.EXPAND_URL,
    maxVariants: CONFIG.EXPAND_MAX_VARIANTS,
    timeoutMs: CONFIG.EXPAND_TIMEOUT_MS,
  };
}

/** Test hook — pin the client config so tests never depend on live YAML/env. */
export function setExpandConfig(cfg: ExpandClientConfig | null): void {
  configOverride = cfg;
}

/** The expansion envelope's contribution: variants to merge, or a reason why not. */
export interface ExpandResult {
  variants: string[];
  /** Set when expansion could not contribute (the caller attaches it as a note). */
  error?: string;
}

/** Max completion tokens requested — 2-3 short query strings fit far below. */
const EXPAND_NUM_PREDICT = 200;

/**
 * The one-shot expansion prompt. Tight, instruct-style: strict JSON only, two
 * named variant kinds (the identifier form and a rephrasing) with a third
 * optional short-keyword form.
 */
export function expandPrompt(query: string): string {
  return (
    "You expand code-search queries. Rewrite the query below into 2-3 alternative search queries " +
    "with the SAME intent, ordered:\n" +
    "1. the likely identifier form of what the query asks for — snake_case or camelCase tokens ONLY, " +
    'no spaces (e.g. "auth_check_middleware", "parseUserConfig");\n' +
    "2. the same intent rephrased in different natural-language words;\n" +
    "3. optionally, a shorter keyword form.\n" +
    'Answer with STRICT JSON only: an object {"variants": ["...", "..."]} — no markdown fence, ' +
    "no explanation, no text before or after.\n\n" +
    `Query: ${query}\nJSON:`
  );
}

/**
 * Extracts the first balanced JSON object from a model response: the raw text,
 * a code-fenced block, or JSON surrounded by stray prose. Still pure-JSON
 * parsing — the span must brace-balance (string-aware); nothing else is
 * salvaged. `null` = nothing JSON-shaped to parse.
 */
function extractJsonObject(raw: string): string | null {
  let t = raw.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1] !== undefined) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The pure parser/sanitizer for one model response. Trims each variant, drops
 * empties, drops duplicates of each other and of the original query (a variant
 * identical to the query adds nothing; the identifier-SHAPE of the original is
 * kept — that is the point of variant 1) — case-insensitively, with runs of
 * whitespace folded — and caps at `maxVariants` (a cap ≤ 0 yields nothing).
 * ANY failure is reported in `error` instead of throwing.
 */
export function parseExpandVariants(
  raw: string,
  original: string,
  maxVariants: number,
): ExpandResult {
  const json = extractJsonObject(raw);
  if (json === null) {
    return { variants: [], error: "no JSON object in the expansion response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      variants: [],
      error: `invalid JSON in the expansion response (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const list =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { variants?: unknown }).variants)
      ? ((parsed as { variants: unknown[] }).variants)
      : null;
  if (!list) {
    return { variants: [], error: 'the expansion response is not {"variants": [...]}' };
  }
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const cap = Math.max(0, Math.floor(maxVariants));
  const seen = new Set<string>([norm(original)]);
  const variants: string[] = [];
  for (const entry of list) {
    if (variants.length >= cap) break;
    if (typeof entry !== "string") continue;
    const candidate = entry.trim();
    if (candidate.length === 0) continue;
    const key = norm(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(candidate);
  }
  if (variants.length === 0) {
    return { variants: [], error: "the expansion produced no usable variants" };
  }
  return { variants };
}

/**
 * One expansion call over an explicitly named backend. NEVER throws — a wire
 * or parse failure is `error`; the caller's search degrades to the base
 * results. (Test seam: the caller pins provider/URL/cfg, no live backend.)
 */
export async function expandVariantsVia(
  provider: "ollama" | "llamacpp",
  url: string,
  prompt: string,
  cfg: ExpandClientConfig,
  original: string,
): Promise<ExpandResult> {
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  try {
    let raw: string;
    if (provider === "llamacpp") {
      // One llama-server serves ONE model — same rule as rerank/llamacpp.ts.
      const resp = await fetch(`${url}/v1/completions`, {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.model,
          prompt: sanitizeLoneSurrogates(prompt),
          max_tokens: EXPAND_NUM_PREDICT,
          temperature: 0,
        }),
      });
      if (!resp.ok) throw new Error(`llama-server /v1/completions HTTP ${resp.status}`);
      const data = (await resp.json()) as { choices?: Array<{ text?: string }> };
      raw = data.choices?.[0]?.text ?? "";
    } else {
      // stream:false plain generate; the template applies (the prompt is plain
      // instruct text, unlike rerank's pre-rendered judge prompt). num_ctx is
      // sent explicitly — Ollama otherwise allocates 4096 per loaded model.
      const resp = await fetch(`${url}/api/generate`, {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.model,
          prompt: sanitizeLoneSurrogates(prompt),
          stream: false,
          options: {
            temperature: 0,
            num_ctx: CONFIG.OLLAMA_NUM_CTX,
            num_predict: EXPAND_NUM_PREDICT,
          },
        }),
      });
      if (!resp.ok) throw new Error(`expand /api/generate HTTP ${resp.status}`);
      const data = (await resp.json()) as { response?: string };
      raw = data.response ?? "";
    }
    return parseExpandVariants(raw, original, cfg.maxVariants);
  } catch (err) {
    return { variants: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The client `IndexManager` calls: config-resolved, backend-resolved, never
 * throws. An empty model short-circuits with the actionable reason (the
 * not-configured degrade the addenda names); an unreachable backend or a
 * failed/malformed call degrades the same way with its own reason.
 */
export async function expandQuery(query: string): Promise<ExpandResult> {
  const cfg = expandConfig();
  if (cfg.model.length === 0) {
    return { variants: [], error: "no expansion model is configured (search.expand.model)" };
  }
  try {
    // Empty `search.expand.url` = follow the embedding backend's resolved URL
    // (the same server serves the expander by default).
    const backend = await resolveEmbedBackend();
    const url = cfg.url || backend.url;
    return await expandVariantsVia(backend.provider, url, expandPrompt(query), cfg, query);
  } catch (err) {
    return { variants: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// ----------------------------------------------------------------- the merge

/**
 * A variant list's RRF weight relative to the original query's list. At 0.5 a
 * variant-only hit can NEVER outrank an original hit of the same-or-better
 * rank (0.5/(60+1) < 1/(60+1) for any rank), while corroboration — the same
 * doc found by the original AND a variant, or by 2+ variants — still promotes.
 * Three variants agreeing at rank 1 (1.5/61) beat an uncorroborated original
 * rank-1 (1/61): strong multi-rephrase agreement is the recall the feature is
 * for. The original is also always the merge's FIRST list, so its item object
 * wins dedup and stable ties.
 */
export const EXPAND_VARIANT_WEIGHT = 0.5;

/**
 * Weighted RRF across the base ranking (`lists[0]` — the ORIGINAL query) and
 * each variant ranking, in descending fused-score order. The caller dedups
 * via `keyOf` (the search results merge on `project` + row `id`).
 */
export function mergeVariantRankings<T>(
  lists: T[][],
  keyOf: (item: T) => string,
  k = 60,
): { item: T; score: number }[] {
  return rrfMerge(
    lists,
    keyOf,
    k,
    lists.map((_, i) => (i === 0 ? 1 : EXPAND_VARIANT_WEIGHT)),
  );
}