/**
 * Duplicate native-index cleanup plan (2.10.1) — the pure decision behind
 * `cidx doctor --fix` (`POST /doctor/fix`).
 *
 * A LanceDB table can carry several native indexes over one column set (legacy
 * data — modern LanceDB dedupes on create). Two indexes with the SAME column
 * set AND the same index type are functionally redundant and only one should
 * survive.
 *
 * How the redundant copies are repaired depends on their names, and this is
 * load-bearing: live legacy duplicates can share ONE native name (`vector_idx`
 * listed twice with identical coverage — one physical index referenced twice in
 * the manifest). `dropIndex(name)` on that shape removes the only physical
 * index, so a naive drop silently destroys the search leg. Therefore:
 *   - DISTINCT names → drop the extras, keep the best-covered one;
 *   - a SHARED name → rebuild that index once (`dropIndex` + `createIndex`),
 *     which collapses the manifest entries into a single clean index.
 *
 * Different index types on one column are NEVER redundant — an FTS and an ANN
 * index serve different search legs — so type is part of the grouping key and
 * is never mixed into one group. The I/O lives in
 * `services/db.ts → dropRedundantIndexes`; this module stays pure so the
 * decision is unit-testable without LanceDB.
 */

/** One native index of a table (structural subset of LanceDB's `IndexConfig`). */
export interface NativeIndexInfo {
  name: string;
  columns: string[];
  indexType: string;
}

/** How a redundant group is repaired. */
export type DuplicateIndexAction = "drop" | "rebuild";

/** One redundant-index group: which native index to keep/rebuild, what to drop. */
export interface DuplicateIndexDropPlan {
  /** The column set the group covers (sorted; normally one column). */
  columns: string[];
  /** The shared native index type (e.g. `IVF_PQ`, `FTS`). */
  indexType: string;
  /** `drop` = remove the extras; `rebuild` = recreate one clean index. */
  action: DuplicateIndexAction;
  /**
   * The native index kept as-is (`drop`) or the shared name rebuilt
   * (`rebuild`). Best coverage; earliest on a tie/unknown.
   */
  keep: string;
  /** Native indexes to drop (`drop` only; empty for `rebuild`). */
  drop: string[];
}

/** Grouping key: the sorted column set plus the index type. */
function groupKey(ix: NativeIndexInfo): string {
  return `${[...ix.columns].sort().join("+")}\u001f${ix.indexType}`;
}

/**
 * Plans the repair of redundant native indexes: group by (column set, index
 * type), keep the best-covered member, and either drop the rest (distinct
 * names) or rebuild once (a shared name — dropping it by name would remove the
 * only physical index). Unknown coverage (`null`) never beats a known one and
 * ties keep the earliest index in `listIndices()` order. A group of one — and
 * any group whose members differ in type — yields no plan.
 */
export function planDuplicateIndexDrops(
  indices: ReadonlyArray<NativeIndexInfo>,
  indexedRows: ReadonlyMap<string, number | null>,
): DuplicateIndexDropPlan[] {
  const groups = new Map<string, NativeIndexInfo[]>();
  for (const ix of indices) {
    const key = groupKey(ix);
    const group = groups.get(key);
    if (group) group.push(ix);
    else groups.set(key, [ix]);
  }

  const plans: DuplicateIndexDropPlan[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    if (!first) continue;
    let keep = first;
    let best: number | null = indexedRows.get(keep.name) ?? null;
    for (const ix of group.slice(1)) {
      const rows = indexedRows.get(ix.name) ?? null;
      if (rows !== null && (best === null || rows > best)) {
        keep = ix;
        best = rows;
      }
    }
    const sharedName = new Set(group.map((ix) => ix.name)).size < group.length;
    plans.push({
      columns: [...keep.columns].sort(),
      indexType: keep.indexType,
      action: sharedName ? "rebuild" : "drop",
      keep: keep.name,
      drop: sharedName ? [] : group.filter((ix) => ix !== keep).map((ix) => ix.name),
    });
  }
  return plans;
}
