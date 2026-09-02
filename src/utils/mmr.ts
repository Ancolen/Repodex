/**
 * Maximal Marginal Relevance (MMR) — diversity-aware selection.
 *
 * Where RRF/rerank optimize *relevance*, MMR optimizes the *composition* of the
 * top-K: it greedily picks items that are both relevant to the query and unlike
 * the items already chosen, so the results aren't copies of the same function.
 *
 * Formula (Carbonell & Goldstein, 1998), picked greedily:
 *   MMR(d) = λ · rel(d) − (1 − λ) · max_{d' ∈ selected} cos(d, d')
 * λ = 1 → pure relevance (the usual top-K); λ = 0 → pure diversity.
 */

/** Cosine similarity; returns 0 if either vector is zero-length. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Min-max normalizes `values` to [0,1]. A constant series maps to all-1
 * (everything equally "best"), which makes MMR fall back to pure diversity.
 */
function minMax(values: readonly number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return values.map(() => 1);
  const span = max - min;
  return values.map((v) => (v - min) / span);
}

/**
 * Greedily selects `limit` items balancing relevance and diversity.
 *
 * `relevances` may use ANY scale (rerank score, RRF score, −distance …) — it is
 * min-max normalized to [0,1] so it combines cleanly with cosine similarity.
 * Returns the selected indices, length `min(limit, n)`.
 */
export function selectMMR(
  vectors: readonly (readonly number[])[],
  relevances: readonly number[],
  limit: number,
  lambda: number,
): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  const k = Math.min(limit, n);
  if (k <= 0) return [];

  const rel = minMax(relevances);
  const selected: number[] = [];
  const remaining = new Set<number>();
  for (let i = 0; i < n; i++) remaining.add(i);

  while (selected.length < k && remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const j of selected) {
        const s = cosine(vectors[i]!, vectors[j]!);
        if (s > maxSim) maxSim = s;
      }
      const score = lambda * rel[i]! - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    selected.push(bestIdx);
    remaining.delete(bestIdx);
  }
  return selected;
}
