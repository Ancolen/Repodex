/**
 * Path/surface boost (proposal S3) — a pure post-merge re-scoring pass over
 * RRF-merged search results.
 *
 * RRF is rank-only: it cannot see that one hit is a 300-line generated file in
 * `build/` while another is the same function in `src/`. Small structural
 * signals — multiplicative factors, each independently testable — nudge the
 * merged ranking toward source-y surfaces. They adjust *relevance input only*
 * (rerank/MMR run afterwards and see the adjusted order); they never decide on
 * their own, and they never touch single-leg results.
 *
 * Applied by `IndexManager.searchIndex`/`searchAll` right after the RRF merge
 * and BEFORE `refineAndSlice` (so the reranker and MMR re-score/diversify an
 * already-boosted ordering). No index change, no reindex, no backend call.
 *
 * Invariants (load-bearing):
 * - Only lists of RRF results are re-scored, and the caller establishes that:
 *   `IndexManager.searchOnTable` reports whether its rows came out of an RRF
 *   merge. The distinction cannot be recovered from the rows alone — a
 *   single-leg list passes its RAW metric straight through, and the LanceDB
 *   text leg surfaces native BM25 under the same `_score` field the RRF merge
 *   writes (a vector-only leg uses `_distance`). Re-scaling a native metric
 *   would silently change its meaning, so the manager gates on `rrfMerged`
 *   and passes RRF lists only. Defensively, any list containing a row WITHOUT
 *   a numeric `_score` is returned untouched here (same array, same row
 *   references, same order) — a mixed list is treated as unboostable, not
 *   half-adjusted.
 * - `enabled: false` (config off or a per-call opt-out) returns the input
 *   byte-identical: same array reference, same order, same values.
 */

import { isTestFile } from "../core/filekinds";

/**
 * Boost parameters, mirroring the `search.boost` config block. `enabled`
 * echoes the CALL-LEVEL decision (config `search.boost.enabled` OR a forced
 * per-call flag, resolved by the caller), so the pure pass stays side-effect
 * free and config-ignorant.
 */
export interface PathBoostConfig {
  enabled: boolean;
  /** Max bonus for a short project-relative path (fades in below, on a log scale). */
  shortPath: number;
  /** Bonus when the project-relative path starts with a conventional source root. */
  sourceRoot: number;
  /** Multiplicative demotion for test files (`isTestFile`). */
  testDemotion: number;
  /** Multiplicative demotion for generated/artifact paths. */
  generatedDemotion: number;
  /** Directories that count as conventional source roots (project-relative). */
  sourceRoots: string[];
}

/**
 * Reference length (project-relative chars, after backslash normalization) at
 * which the shortPath bonus has fully faded: paths this long or longer get no
 * shortPath factor at all, shorter ones keep a fraction of it. Fixed (not
 * per-call-set-dependent) so the factor is a pure function of the path alone
 * and results stay comparable across projects.
 */
export const BOOST_PATH_NORM_CHARS = 160;

/** Generated/artifact directories — matched as a whole path segment. */
const GENERATED_SEGMENT_RE = /(^|\/)(gen|dist|build|vendor|node_modules)(\/|$)/;

/** Generated file suffixes: protobuf Go stubs and minified bundles. */
const GENERATED_SUFFIX_RE = /\.pb\.go$|\.min\.[a-z0-9]+$/;

/** Normalizes separators for segment matching (Windows-style paths included). */
function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** The project-relative path of a result: `filePath` with the project root stripped. */
export function relativeToProject(filePath: string, projectRoot?: string): string {
  const fp = posix(filePath);
  if (!projectRoot) return fp;
  const root = posix(projectRoot).replace(/\/+$/, "");
  if (root.length > 0 && fp.startsWith(root + "/")) return fp.slice(root.length + 1);
  return fp;
}

/**
 * Does the project-relative path start with one of the conventional source
 * roots? Segment-wise: `src` matches `src/a.ts` but neither `src-a.ts` nor
 * `nested/src/a.ts` nor `scripts/src.ts`.
 */
export function underSourceRoot(relativePath: string, roots: readonly string[]): boolean {
  const p = posix(relativePath).replace(/^\.\//, "");
  for (const raw of roots) {
    const root = posix(raw).replace(/^\.?\//, "").replace(/\/+$/, "");
    if (root.length > 0 && (p === root || p.startsWith(root + "/"))) return true;
  }
  return false;
}

/** Does the path live under a generated/artifact directory or carry a generated suffix? */
export function isGeneratedPath(relativePath: string): boolean {
  const p = posix(relativePath);
  return GENERATED_SEGMENT_RE.test(p) || GENERATED_SUFFIX_RE.test(p);
}

/**
 * The exact boost factor of one result, from its project-relative path alone.
 * Multiplicative and order-independent — `applyPathBoost` scales `_score` by
 * this. Exported so each signal is testable in isolation.
 */
export function pathBoostFactor(relativePath: string, cfg: PathBoostConfig): number {
  let factor = 1;
  // 1) shortPath: the bonus is largest for the shortest paths and fades in
  //    with the log of the length, reaching 0 at BOOST_PATH_NORM_CHARS.
  const len = posix(relativePath).length;
  const norm = Math.min(1, Math.log1p(len) / Math.log1p(BOOST_PATH_NORM_CHARS));
  factor *= 1 + cfg.shortPath * (1 - norm);
  // 2) sourceRoot: a hit under a conventional source root is more likely the
  //    real implementation than the same code elsewhere.
  if (underSourceRoot(relativePath, cfg.sourceRoots)) factor *= 1 + cfg.sourceRoot;
  // 3) test demotion: test files match their own subject's names, which would
  //    otherwise outrank the production code they exist to exercise.
  if (isTestFile(relativePath)) factor *= cfg.testDemotion;
  // 4) generated/artifact demotion: build output and vendored/generated code
  //    match queries well but are the wrong reading surface.
  if (isGeneratedPath(relativePath)) factor *= cfg.generatedDemotion;
  return factor;
}

/**
 * Re-scores RRF-merged results (the caller establishes RRF-ness — see the
 * invariants above). Lists whose rows all carry a numeric `_score` get each
 * score multiplied by the row's path factor and the list re-sorted by the
 * adjusted score (ties keep their relative order — stable sort, matching
 * `rrfMerge`'s own sort). Anything else — an empty list, a mixed one — is
 * returned untouched, and `cfg.enabled === false` always returns the input
 * reference itself.
 *
 * Rows are never mutated in place: adjusted rows are shallow copies, because
 * raw LanceDB rows arrive as non-extensible Proxy objects (the same reason
 * `refineAndSlice` copies before assigning `_rerankScore`).
 *
 * `projectRoot` (the indexed project's root path) makes the signals project-
 * relative; without it, the absolute `filePath` is used as-is (segment-based
 * signals still match; `sourceRoot` and the length normalization lose their
 * project-relative meaning, so callers should always pass it).
 */
export function applyPathBoost<T extends { filePath?: string; _score?: number }>(
  results: readonly T[],
  cfg: PathBoostConfig,
  projectRoot?: string,
): T[] {
  if (!cfg.enabled || results.length === 0) return results as T[];
  // Re-score only fully-RRF lists: a row without `_score` means this list is
  // not an RRF merge at all (or is mixed) — leave it exactly as it arrived.
  for (const r of results) {
    if (typeof r._score !== "number") return results as T[];
  }
  const adjusted = results.map((r) => {
    const factor =
      typeof r.filePath === "string"
        ? pathBoostFactor(relativeToProject(r.filePath, projectRoot), cfg)
        : 1; // no path → no signal
    return { ...r, _score: r._score! * factor } as T;
  });
  return adjusted.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
}