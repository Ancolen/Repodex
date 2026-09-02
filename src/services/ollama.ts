import { Ollama } from "ollama";
import { CONFIG } from "../config";

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
 * Embeds multiple texts in a single call (Phase 5: batch indexing).
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
