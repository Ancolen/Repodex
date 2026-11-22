/**
 * Unexpected-shrink detection for an index job (2.10.0).
 *
 * A project directory that was moved, unmounted or emptied made the next sync
 * prune almost every file and still report `ready` — the counters silently
 * collapsed with no hint of why. This pure predicate decides when that drop is
 * worth a registry note; the wording lives in `runIndexJob`.
 *
 * Nested-root removals are excluded from the comparison: a first umbrella sync
 * legitimately prunes its child project's rows (`nestedRemoved`) and must not
 * look like data loss.
 */
export interface ShrinkInput {
  /** The registry's file count before this job. */
  beforeFiles: number;
  /** The true cache count after this job. */
  afterFiles: number;
  /** Files removed because a nested registered project now owns them. */
  nestedRemoved?: number | undefined;
  /** Fractional drop above which the note fires (0..1; <=0 = never). */
  ratio: number;
  /** Minimum adjusted before-count for the note (small projects churn; <=0 = never). */
  minFiles: number;
}

export interface ShrinkVerdict {
  /** Should the job attach a shrink note? */
  shrunk: boolean;
  /** The count compared: before minus nested removals, floored at 0. */
  adjustedBefore: number;
  /** Files that disappeared for reasons other than nested exclusion. */
  lost: number;
  /** `lost / adjustedBefore` (0 when adjustedBefore is 0). */
  ratio: number;
}

/** Pure shrink decision (no I/O; thresholds injected from `CONFIG`). */
export function detectShrink(input: ShrinkInput): ShrinkVerdict {
  const nested = Math.max(0, Math.floor(input.nestedRemoved ?? 0));
  const adjustedBefore = Math.max(0, input.beforeFiles - nested);
  const lost = Math.max(0, adjustedBefore - input.afterFiles);
  const ratio = adjustedBefore > 0 ? lost / adjustedBefore : 0;
  const shrunk =
    input.ratio > 0 && input.minFiles > 0 && adjustedBefore >= input.minFiles && lost > 0 && ratio > input.ratio;
  return { shrunk, adjustedBefore, lost, ratio };
}
