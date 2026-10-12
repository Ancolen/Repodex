/**
 * Per-model embedding task framing.
 *
 * Retrieval-tuned embedding models reach their best quality when each input
 * carries the task framing the model was trained with (measured on this repo's
 * corpus at +0.06–0.08 MRR for both qwen3-embedding and EmbeddingGemma 2).
 * The embedding backends cidx talks to (Ollama `/api/embed`, llama-server
 * `/v1/embeddings`) embed RAW text only, so cidx adds the prefixes itself:
 *
 * - documents — indexed chunk content AND its docstring `doc_vector` leg → the
 *   preset's `docPrefix`, applied at the indexer (and the migration's shadow
 *   re-embed), BEFORE the embed call. The cache is keyed on
 *   `(model, sha256(text))` hashing whatever is embedded, so framing first
 *   keeps cache keys correct ("hash what you embed");
 * - queries — the vector leg of `searchIndex`/`searchAll` → the preset's
 *   `queryPrefix`, applied per RECORD before its `cachedEmbed` call, exactly
 *   like the model pin.
 *
 * Resolution (`resolveFraming`): the effective setting — the global
 * `embedding.framing` default ("none") or the per-project `.cidx.json`
 * `framing` override — is "none" → null (no framing: byte-identical legacy
 * behavior, zero new wire bytes), or "auto" → the first preset whose
 * lowercased `modelPrefix` matches the record's embedding model, falling back
 * to null for any other model. The RESOLVED identity (null for none, else the
 * preset id) is pinned into `IndexRecord.framing` at createIndex and re-pinned
 * at the end of every index job — the embedModel precedent. A framing change
 * escalates through the same machinery as a model change (zero-downtime
 * `migrate` job; the watcher skips writes on a divergence), so two framings
 * never share a table.
 *
 * The prefix strings are data (the models' documented prompt formats), not code
 * paths: only the record's pin decides whether a text is framed, and a record
 * resolving to nothing behaves everywhere exactly as before framing existed.
 */

/** The configurable framing setting: "none" or "auto". */
export type FramingSetting = "none" | "auto";

/** One model family's prompt framing. */
export interface FramingPreset {
  /** Lowercased model-string prefix matched against the embedding model. */
  modelPrefix: string;
  /** Identity stored in `IndexRecord.framing` when this preset applies. */
  id: string;
  /** Prefix for DOCUMENT texts (indexed content + the docstring leg); "" = documents unframed. */
  docPrefix: string;
  /** Prefix for QUERY texts (the search vector leg); "" = queries unframed. */
  queryPrefix: string;
}

/**
 * The preset table, most specific first (no prefix overlaps today). The exact
 * strings are the models' documented retrieval prompt formats:
 *
 * - EmbeddingGemma 2: docs "title: none\n\ntext: {content}", queries
 *   "task: search result\n\nquery: {query}";
 * - qwen3-embedding: the official query-side task instruction — documents must
 *   NOT be instructed ("no need to add instruction for retrieval documents").
 */
export const FRAMING_PRESETS: readonly FramingPreset[] = [
  {
    modelPrefix: "embeddinggemma-2",
    id: "embeddinggemma-2",
    docPrefix: "title: none\n\ntext: ",
    queryPrefix: "task: search result\n\nquery: ",
  },
  {
    modelPrefix: "qwen3-embedding",
    id: "qwen3-embedding",
    docPrefix: "",
    queryPrefix:
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
  },
];

/** The preset whose model-string prefix matches, or null for any other model. */
export function framingPresetForModel(model: string | null | undefined): FramingPreset | null {
  const m = (model ?? "").toLowerCase();
  if (m.length === 0) return null;
  return FRAMING_PRESETS.find((p) => m.startsWith(p.modelPrefix)) ?? null;
}

/** The preset behind a stored (resolved) framing identity, or null for none/unknown. */
export function presetForFraming(framing: string | null | undefined): FramingPreset | null {
  if (!framing) return null;
  return FRAMING_PRESETS.find((p) => p.id === framing) ?? null;
}

/**
 * Resolves the effective framing identity to pin: "auto" looks up the preset by
 * the record's model (unknown models stay unframed), anything else — including
 * the "none" default — is no framing. The returned identity is what
 * `IndexRecord.framing` stores (null = unframed, exactly the legacy pin).
 */
export function resolveFraming(
  setting: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (setting !== "auto") return null;
  return framingPresetForModel(model)?.id ?? null;
}

/** The document prefix a stored framing identity contributes ("" = unframed). */
export function framingDocPrefix(framing: string | null | undefined): string {
  return presetForFraming(framing)?.docPrefix ?? "";
}

/** The query prefix a stored framing identity contributes ("" = unframed). */
export function framingQueryPrefix(framing: string | null | undefined): string {
  return presetForFraming(framing)?.queryPrefix ?? "";
}

/**
 * Frames a DOCUMENT text (indexed chunk content or a docstring) for the embed
 * call. Unframed records return the text byte-identical — the embed input, the
 * cache key and the wire payload are exactly what a pre-framing cidx sent.
 */
export function frameDoc(text: string, framing: string | null | undefined): string {
  return framingDocPrefix(framing) + text;
}

/**
 * Frames a QUERY text for the vector leg's embed call. Unframed records return
 * the text byte-identical; the raw query keeps its other roles (BM25 legs, the
 * query log, the reranker prompt) untouched.
 */
export function frameQuery(text: string, framing: string | null | undefined): string {
  return framingQueryPrefix(framing) + text;
}