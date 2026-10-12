import { Ollama } from "ollama";
import { CONFIG } from "../config";
import { sanitizeLoneSurrogates } from "../utils/text";

// The Ollama library binds a fetch implementation at Ollama-construction time
// (`config.fetch ?? <module-scoped fetch>`); route it through the LIVE global
// instead so this service behaves exactly like services/llamacpp.ts — test
// stubs (and any future proxying) that install after this module loads are
// honored, not bypassed by a captured reference.
const liveFetch = (...args: Parameters<typeof globalThis.fetch>): Promise<Response> =>
  globalThis.fetch(...args);
const ollama = new Ollama({
  host: CONFIG.OLLAMA_URL,
  fetch: liveFetch as unknown as typeof globalThis.fetch,
});

/**
 * Ollama sizes its context buffer from `num_ctx` and allocates it up front for
 * every loaded model — 4096 (its default) is ~8x oversized for chunks capped at
 * ~512 tokens, and that overshoot is paid in VRAM/RAM for the lifetime of the
 * model. Embeddings are unaffected by the cap as long as the input fits, which
 * the default chunk window guarantees (`num_ctx` > `maxChunkTokens`).
 */
const EMBED_OPTIONS = { num_ctx: CONFIG.OLLAMA_NUM_CTX };

/** Generates an embedding for a single text through `POST /api/embeddings`. */
export async function ollamaEmbedding(text: string, model: string): Promise<number[]> {
  const res = await ollama.embeddings({
    model,
    prompt: sanitizeLoneSurrogates(text),
    options: EMBED_OPTIONS,
  });
  return res.embedding;
}

/**
 * Embeds multiple texts in a single call (batch indexing).
 * The Ollama `embed` API accepts an array as input; `num_ctx` applies to each
 * input item individually, not to the concatenated batch.
 */
export async function ollamaEmbeddings(texts: string[], model: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await ollama.embed({
    model,
    input: texts.map(sanitizeLoneSurrogates),
    options: EMBED_OPTIONS,
  });
  return res.embeddings;
}

/**
 * The content-hash embedding cache surface `cachedEmbed` needs. Structurally
 * compatible with `Registry` so the param is decoupled from the class and
 * trivially fakeable in tests. Lives with the dispatch layer (`embed.ts`).
 */
export interface EmbedCache {
  getCachedEmbedding(model: string, hash: string): number[] | null;
  putCachedEmbeddings(model: string, entries: { hash: string; vector: number[] }[]): void;
}