import { CONFIG } from "../config";
import { mapWithConcurrency } from "../utils/concurrency";

/**
 * Second-stage reranker using a Qwen3-Reranker-style causal LM served by Ollama.
 *
 * Ollama has no `/api/rerank` endpoint, so each (query, doc) pair is scored via
 * `/api/generate` + logprobs: the model is prompted to answer "yes" or "no", and
 * the relevance score is the softmax of the "yes" vs "no" token logprobs.
 *
 * Per-doc calls are wrapped so a single failure degrades to a neutral score
 * rather than failing the whole search — reranking is a refinement, never a hard
 * dependency. If the configured model is absent/unusable, results simply come
 * back in their pre-rerank (RRF) order.
 */

/** Softmax over the yes/no logprobs. A missing token is treated as -Infinity. */
export function scoreFromLogprobs(
  topLogprobs: readonly { token: string; logprob: number }[],
): number {
  let yesLogp = -Infinity;
  let noLogp = -Infinity;
  for (const { token, logprob } of topLogprobs) {
    const t = token.trim().toLowerCase();
    if (t === "yes") yesLogp = Math.max(yesLogp, logprob);
    else if (t === "no") noLogp = Math.max(noLogp, logprob);
  }
  // Neither verdict token surfaced → genuinely unknown.
  if (!Number.isFinite(yesLogp) && !Number.isFinite(noLogp)) return 0.5;
  const hi = Math.max(yesLogp, noLogp);
  const expYes = Number.isFinite(yesLogp) ? Math.exp(yesLogp - hi) : 0;
  const expNo = Number.isFinite(noLogp) ? Math.exp(noLogp - hi) : 0;
  const denom = expYes + expNo;
  return denom === 0 ? 0.5 : expYes / denom;
}

/** The official Qwen3-Reranker judge prompt for one (query, doc) pair. */
function judgePrompt(query: string, doc: string): string {
  return (
    "<|im_start|>system\n" +
    'Judge whether the Document meets the requirements based on the Query and the Instruct provided. ' +
    'Note that the answer can only be "yes" or "no".' +
    "<|im_end|>\n" +
    "<|im_start|>user\n" +
    "<Instruct>: Given a code search query, retrieve the relevant code that answers the query.\n" +
    `<Query>: ${query}\n` +
    `<Document>: ${doc}` +
    "<|im_end|>\n" +
    "<|im_start|>assistant\n<think>\n\n</think>\n\n"
  );
}

interface OllamaLogprobEntry {
  token?: string;
  logprob?: number;
  top_logprobs?: Array<{ token: string; logprob: number }> | null;
}

async function scoreOne(query: string, doc: string): Promise<number> {
  const resp = await fetch(`${CONFIG.OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.RERANK_MODEL,
      prompt: judgePrompt(query, doc),
      raw: true,
      stream: false,
      options: { num_predict: 1, temperature: 0 },
      logprobs: true,
      top_logprobs: 20,
    }),
  });
  if (!resp.ok) throw new Error(`rerank generate HTTP ${resp.status}`);
  const data = (await resp.json()) as { logprobs?: OllamaLogprobEntry[] | null };
  // num_predict:1 → the first generated token is the model's yes/no verdict.
  return scoreFromLogprobs(data.logprobs?.[0]?.top_logprobs ?? []);
}

/**
 * Scores each document against the query in [0,1] (higher = more relevant), in
 * the same order as `docs`. Individual failures degrade to a neutral 0.5.
 *
 * Caller is responsible for guarding on `CONFIG.RERANK_MODEL` being non-empty.
 */
export async function rerankScores(query: string, docs: string[]): Promise<number[]> {
  if (docs.length === 0) return [];
  return mapWithConcurrency(docs, CONFIG.RERANK_CONCURRENCY, async (doc) => {
    try {
      return await scoreOne(query, doc);
    } catch (err) {
      console.error("[rerank] per-doc scoring failed; using neutral score:", err);
      return 0.5;
    }
  });
}
