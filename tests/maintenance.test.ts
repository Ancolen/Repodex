/** Pure post-job auto-maintenance decision (thresholds, no-op safety). */
import { describe, test, expect } from "bun:test";
import { shouldAutoMaintain, type AutoMaintainThresholds } from "../src/core/maintenance";
import type { IndexCoverageReport } from "../src/services/db";

function coverage(gapRatio: number, smallFragments: number | null): IndexCoverageReport {
  return {
    rows: 100,
    smallFragments,
    columns: [],
    gapRatio,
    unknownColumns: [],
    duplicates: [],
  };
}

const ON: AutoMaintainThresholds = { enabled: true, unindexedRatio: 0.05, minSmallFragments: 20 };

describe("shouldAutoMaintain", () => {
  test("disabled or unknown coverage never triggers", () => {
    expect(shouldAutoMaintain(coverage(0.9, 100), { ...ON, enabled: false })).toBe(false);
    expect(shouldAutoMaintain(null, ON)).toBe(false);
  });

  test("an uncovered-row share above the ratio triggers", () => {
    expect(shouldAutoMaintain(coverage(0.06, 0), ON)).toBe(true);
    expect(shouldAutoMaintain(coverage(1, null), ON)).toBe(true);
  });

  test("the ratio is strict: exactly at the threshold is still covered", () => {
    expect(shouldAutoMaintain(coverage(0.05, 0), ON)).toBe(false);
  });

  test("fragmentation triggers even when coverage is complete", () => {
    expect(shouldAutoMaintain(coverage(0, 20), ON)).toBe(true);
    expect(shouldAutoMaintain(coverage(0, 19), ON)).toBe(false);
    expect(shouldAutoMaintain(coverage(0, null), ON)).toBe(false);
  });

  test("thresholds are injectable (config overrides)", () => {
    expect(shouldAutoMaintain(coverage(0.2, 5), { enabled: true, unindexedRatio: 0.5, minSmallFragments: 50 })).toBe(false);
    expect(shouldAutoMaintain(coverage(0.2, 50), { enabled: true, unindexedRatio: 0.5, minSmallFragments: 50 })).toBe(true);
  });
});
