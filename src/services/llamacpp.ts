import { sanitizeLoneSurrogates } from "../utils/text";

/**
 * Raw wire client for a `llama-server` process (llama.cpp's OpenAI-compatible
 * HTTP server). One server serves ONE model (started with `-m … --embedding`),
 * so there is no model management on this side — the `model` request field is
 * matched against the server's alias (`-a`, defaulting to the file basename)
 * and `cidx doctor` reports a mismatch.
 */

/** A successful `GET /v1/models` listing (ids are aliases for llama-server). */
export interface LlamaServerModels {
  up: boolean;
  models: string[];
}

/** Probes the OpenAI-compatible `/v1/models` endpoint (never throws). */
export async function probeLlamaServer(
  url: string,
  timeoutMs = 5000,
  fetchFn: typeof fetch = fetch,
): Promise<LlamaServerModels> {
  try {
    const resp = await fetchFn(`${url}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return { up: true, models: [] };
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    return {
      up: true,
      models: (data.data ?? [])
        .map((m) => m.id ?? "")
        .filter((n) => n.length > 0),
    };
  } catch {
    return { up: false, models: [] };
  }
}

interface OpenAIEmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] } | null>;
}

/**
 * Hard ceiling for one wire request (embeds, rerank and the doccheck judge
 * alike). A wedged llama-server (observed once on llama.cpp master in Oct 2026:
 * a task launched and never released its slot, stalling every concurrent job)
 * must surface as an error — and a skipped file / neutral score — instead of a
 * hung daemon.
 */
export const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Embeds a batch of texts through `POST /v1/embeddings` (an array `input` is
 * part of the OpenAI embeddings API). Results are re-sorted by the `index`
 * field, which the API contract leaves unordered.
 */
export async function llamaEmbeddings(texts: string[], url: string, model: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  const resp = await fetch(`${url}/v1/embeddings`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts.map(sanitizeLoneSurrogates) }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`llama-server /v1/embeddings HTTP ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const data = (await resp.json()) as OpenAIEmbeddingsResponse;
  const rows = data.data ?? [];
  const embeddings: number[][] = new Array(texts.length);
  for (const row of rows) {
    if (row?.embedding) embeddings[row.index ?? 0] = row.embedding;
  }
  if (embeddings.some((e) => !e)) throw new Error("llama-server /v1/embeddings response missing entries");
  return embeddings;
}

/** Embeds a single text (the batch endpoint with one entry — same code path). */
export async function llamaEmbedding(text: string, url: string, model: string): Promise<number[]> {
  const vectors = await llamaEmbeddings([text], url, model);
  const vector = vectors[0];
  if (!vector) throw new Error("llama-server /v1/embeddings returned no embedding for the input");
  return vector;
}

// ------------------------------------------------------------------ rerank

/**
 * The llama.cpp variant of the Qwen3-Reranker yes/no scoring
 * (`POST /v1/completions` with `logprobs`). llama-server serves ONE model, so
 * a llama.cpp reranker runs on its own llama-server whose URL
 * (`search.rerank.url`) may differ from the embedding backend's.
 *
 * Response shape tolerance: llama.cpp has moved `logprobs` between a flat
 * array of `{top_logprobs}` entries and the OpenAI `{content: [...]}` wrapper
 * over time — both carry `{token|tok_str, logprob}`, so both are accepted.
 */
export interface LlamaLogprobEntry {
  token?: string;
  tok_str?: string;
  logprob?: number;
}

/**
 * Extracts the first token's top-logprobs table from either response shape.
 * Shared with the doccheck semantic judge (`services/docjudge.ts`), whose wire
 * client hits the very same completions endpoint.
 */
export function extractTopLogprobs(raw: unknown): LlamaLogprobEntry[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    // OpenAI wrapper: { content: [ { logprob, top_logprobs: [...] } ] }
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as { top_logprobs?: LlamaLogprobEntry[] } | undefined;
      return first?.top_logprobs ?? [];
    }
    return [];
  }
  // llama.cpp flat array: [ { logprob, top_logprobs: [ { tok_str, logprob } ] } ]
  const first = raw[0] as { top_logprobs?: LlamaLogprobEntry[] } | undefined;
  return first?.top_logprobs ?? [];
}

/** How many top-logprob entries to ask for (widest table the API allows). */
export const RERANK_TOP_LOGPROBS = 20;

/**
 * Scores one (query, doc) pair: the caller builds the judge prompt (the exact
 * template is rerank's concern), this only talks to the server. Returns the
 * first generated token's top-logprobs table for `scoreFromLogprobs`.
 */
export async function llamaRerankTopLogprobs(
  judgePrompt: string,
  url: string,
  model: string,
): Promise<LlamaLogprobEntry[]> {
  const resp = await fetch(`${url}/v1/completions`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: sanitizeLoneSurrogates(judgePrompt),
      max_tokens: 1,
      temperature: 0,
      logprobs: RERANK_TOP_LOGPROBS,
    }),
  });
  if (!resp.ok) throw new Error(`llama-server /v1/completions HTTP ${resp.status}`);
  const data = (await resp.json()) as { choices?: Array<{ logprobs?: unknown }> };
  return extractTopLogprobs(data.choices?.[0]?.logprobs);
}