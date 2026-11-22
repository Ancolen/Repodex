import type { IndexCoverageReport } from "../services/db";

/** Injectable thresholds for the post-job index-maintenance decision. */
export interface AutoMaintainThresholds {
  enabled: boolean;
  /** Uncovered-row share (0..1) that triggers optimize. */
  unindexedRatio: number;
  /** Small-fragment count that triggers optimize. */
  minSmallFragments: number;
}

/**
 * Pure decision for the post-job auto-maintenance pass (unit-tested with
 * fakes, like the doctor/stats ports). A fully covered, compact table never
 * triggers; unknown coverage (null report) never triggers either — the caller
 * skips rather than guessing.
 */
export function shouldAutoMaintain(
  coverage: IndexCoverageReport | null,
  thresholds: AutoMaintainThresholds,
): boolean {
  if (!thresholds.enabled || coverage === null) return false;
  const small = coverage.smallFragments ?? 0;
  return coverage.gapRatio > thresholds.unindexedRatio || small >= thresholds.minSmallFragments;
}
