import { Ollama } from "ollama";
import { CONFIG } from "../config";
import { hashContent } from "../utils/hash";

const ollama = new Ollama({ host: CONFIG.OLLAMA_URL });

/** Generates an embedding for a single text. */
export async function getEmbedding(text: string): Promise<number[]> {
  const res = await ollama.embeddings({
    model: CONFIG.OLLAMA_MODEL,
    prompt: text,
  });
  return res.embedding;
}

/**
 * Embeds multiple texts in a single call (batch indexing).
 * The Ollama `embed` API accepts an array as input.
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await ollama.embed({
    model: CONFIG.OLLAMA_MODEL,
    input: texts,
  });
  return res.embeddings;
}

/**
 * The content-hash embedding cache surface `cachedEmbed` needs. Structurally
 * compatible with `Registry` so the param is decoupled from the class and
 * trivially fakeable in tests.
 */
export interface EmbedCache {
  getCachedEmbedding(model: string, hash: string): number[] | null;
  putCachedEmbeddings(model: string, entries: { hash: string; vector: number[] }[]): void;
}

/**
 * Embeds a single text through the content-hash cache (shared with indexing).
 * Repeated searches for the same query skip the Ollama round-trip entirely; a
 * query whose text matches an already-indexed chunk reuses that row (same model
 * + same content hash). Keyed by (model, sha256(text)) via `hashContent`.
 */
export async function cachedEmbed(
  text: string,
  model: string,
  cache: EmbedCache,
  embed: (text: string) => Promise<number[]> = getEmbedding,
): Promise<number[]> {
  const hash = hashContent(text);
  const hit = cache.getCachedEmbedding(model, hash);
  if (hit) return hit;
  const vector = await embed(text);
  try {
    cache.putCachedEmbeddings(model, [{ hash, vector }]);
  } catch (err) {
    // Cache write is best-effort — a failed write must not fail the search.
    console.error("[ollama] embedding cache write failed:", err);
  }
  return vector;
}
