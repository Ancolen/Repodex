/**
 * Reciprocal Rank Fusion (RRF) — combines multiple ranked result lists into a
 * single merged ranking.
 *
 * For each list, an item's contribution is `1 / (k + rank)` (rank is 1-based).
 * `k` (default 60) is a small constant; it softens the influence of items at
 * lower ranks (large rank). It is a standard, score-scale-independent method
 * for merging vector (semantic) and BM25 (exact-term) lists.
 *
 * @param lists   Ranked result lists (each from best to worst).
 * @param keyOf   Deduplication key for an item (e.g. record id).
 * @param k       RRF constant.
 * @returns       `{ item, score }` pairs, in descending order of RRF score.
 */
export function rrfMerge<T>(
  lists: T[][],
  keyOf: (item: T) => string,
  k = 60,
): { item: T; score: number }[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, T>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!;
      const key = keyOf(item);
      const contribution = 1 / (k + rank + 1);
      scores.set(key, (scores.get(key) ?? 0) + contribution);
      if (!firstSeen.has(key)) firstSeen.set(key, item);
    }
  }

  return [...scores.entries()]
    .map(([key, score]) => ({ item: firstSeen.get(key)!, score }))
    .sort((a, b) => b.score - a.score);
}
