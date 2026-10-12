/**
 * Hotspot / technical-debt report (proposal C3) — pure aggregator, no I/O and
 * no LanceDB. Sibling of `coupling.ts` / `impact.ts` / `deadcode.ts`.
 *
 * A hotspot is the churn × size intersection: a file that changes often AND is
 * large to begin with is where refactoring effort pays off most — bugs cluster
 * there, changes ripple there. The three feeds are gathered by the engine
 * (`IndexManager.getHotspots`) and injected here, so this module stays pure and
 * unit-testable over synthetic fixtures:
 *
 *   1. churn    — per-file change counts inside the `--since` window (git log
 *                 --name-only; live per call, git is consulted fresh).
 *   2. size     — chunk count + DISTINCT symbol count per file, straight from
 *                 the table metadata (the `get_repo_overview` recipe).
 *   3. debt     — dead-code density per file (the `find_dead_code` reference
 *                 pass at "uncertain or better" confidence) and coupling
 *                 (fan-in + fan-out from the dependency-graph cache).
 *
 * SCORING — and this is a PROXY, deliberately: "size" here is chunk+symbol
 * volume, NOT cyclomatic complexity. The report never claims otherwise.
 *
 *   churnNorm = log1p(churn) / log1p(CHURN_SATURATE)      (0..1)
 *   sizeNorm  = log1p(size) / log1p(SIZE_SATURATE)        (0..1)
 *   base      = 100 · churnNorm · sizeNorm                (log-scaled product)
 *   debt      = deadBoost + couplingBoost                 (each capped ≤ its weight)
 *   score     = clamp(0, 100, base + debt)
 *
 * Debt signals PROMOTE (a hot file with dead code is more actionable, and a
 * change magnet's risk is higher than its churn alone); test files and entry
 * points are DEMOTED — a hot, well-exercised test file is not a hotspot (the
 * same conservative philosophy as `scoreDeadCode`: prefer to under-flag).
 *
 * Bands: `critical` (score ≥ 50) → `warm` (≥ 25) → `review` (everything else
 * that earned a place: any score > 0 — churn, volume with a debt signal, or a
 * coupling edge). Indexed files that score 0 with no signal at all are counted
 * in `notListed` — never silently dropped. Each band is capped by `limit` with
 * an honest `total` + `truncated`, exactly like the coupling bands.
 */
import path from "node:path";
// Reuse, do not fork: the same file-kind recipe dead code / reverse coverage use.
import { isTestFile, isEntryPointFile } from "./filekinds";

/** A file-kind classifier signature (injected so tests can vary it). */
export type HotspotClassifier = (filePath: string) => boolean;

// --------------------------------------------------------------------- defaults

/** Default churn window (`get_hotspots` / `cidx hotspots`) — git date syntax. */
export const HOTSPOTS_DEFAULT_SINCE = "90 days ago";

/** Default cap per band. */
export const HOTSPOTS_DEFAULT_LIMIT = 20;

// Log-scaled normalization anchors: a file at exactly CHURN_SATURATE edits (or
// SIZE_SATURATE chunk+symbol volume) maps to dimension 1.0. Both grow slowly
// past the anchor (log) and every score clamps at 100.
const CHURN_SATURATE = 20;
const SIZE_SATURATE = 40;
const DEAD_WEIGHT = 15; // max score added by the dead-code signal
const DEAD_DENSITY_SATURATE = 0.5; // density at which the boost is full
/**
 * The dead-code confidence a symbol needs to count toward a file's dead-code
 * density: "uncertain" (40) or better — the conservative middle of
 * `scoreDeadCode`'s categories (likely-dead ≥ 70, uncertain ≥ 40). The engine
 * applies it when building the per-file dead feed, so the policy lives next to
 * the score it feeds.
 */
export const DEAD_DENSITY_CONFIDENCE = 40;
const COUPLING_WEIGHT = 15; // max score added by the coupling signal
const COUPLING_SATURATE = 8; // fanIn+fanOut at which the boost is full
const DEMOTED_CAP = 20; // test/entry-point files can never cross into `warm`

/** Score at which a file enters `critical`; ≥ 25 (but below 50) is `warm`. */
export const HOTSPOT_BAND_SCORES = { critical: 50, warm: 25 } as const;

// ----------------------------------------------------------------------- types

/** Per-file size feed, produced by the cached table-metadata snapshot. */
export interface HotspotSizeFeed {
  /** Absolute path (the join key with churn/dead/coupling feeds). */
  file: string;
  chunks: number;
  symbols: number;
}

/** Per-file dead-code feed (absolute path keyed), from the same snapshot. */
export interface HotspotDeadFeed {
  /** Zero-reference symbols scored at `DEAD_DENSITY_CONFIDENCE` or better. */
  dead: number;
  /** All dead-code candidates scanned in the file (the density denominator). */
  candidates: number;
}

/** Per-file coupling feed (absolute path keyed), from the dependency graph. */
export interface HotspotCouplingFeed {
  fanIn: number;
  fanOut: number;
}

/** One ranked file of the hotspot report. */
export interface HotspotFile {
  /** Absolute path. */
  file: string;
  /** Project-relative path (absolute when outside the root). */
  relativeFile: string;
  /** Distinct commits that touched the file inside the `since` window. */
  churn: number;
  /** Chunks the index holds for the file. */
  chunks: number;
  /** DISTINCT symbols the index holds for the file. */
  symbols: number;
  /** Zero-reference symbols at "uncertain or better" confidence. */
  deadSymbols: number;
  /** `deadSymbols / candidates` — present only when the file has candidates. */
  deadDensity?: number;
  fanIn: number;
  fanOut: number;
  testFile: boolean;
  entryPoint: boolean;
  /** 0–100, one decimal. A PROXY score (churn × size volume + debt), not complexity. */
  score: number;
  band: "critical" | "warm" | "review";
  /** One line: churn/size/debt facts and any demotion, no interpretation. */
  rationale: string;
}

/** One capped band of the report. */
export interface HotspotBand {
  items: HotspotFile[];
  /** The true band size before the cap. */
  total: number;
  /** The cap was hit — pass a higher `limit` for more. */
  truncated: boolean;
}

/** The `get_hotspots` report: three ranked bands over the joined feeds. */
export interface HotspotReport {
  project: string;
  /** The churn window actually used (git date syntax; reflects a caller override). */
  since: string;
  critical: HotspotBand;
  warm: HotspotBand;
  review: HotspotBand;
  /** Indexed files examined (the size feed). */
  scannedFiles: number;
  /** Indexed files that scored 0 with no debt signal — counted, not listed. */
  notListed: number;
  /** Indexed files changed inside the window. */
  filesWithChurn: number;
  /** Churn paths that join to no indexed file (deleted/unindexed docs…). */
  unindexedChurnFiles: number;
  /** Commits walked for churn (≤ CHURN_DEFAULT_MAX_COMMITS). */
  commitsScanned: number;
  /** The churn walk hit its cap — churn may undercount (surfaced, never silent). */
  commitsTruncated: boolean;
  /** The project directory is not a git repo — churn is empty. */
  notARepo: boolean;
  /** The table snapshot hit its row cap — the size/dead feeds are partial. */
  snapshotTruncated: boolean;
  /** Any band hit its cap. */
  truncated: boolean;
}

/** Everything the aggregator needs — the engine gathers it from the caches. */
export interface HotspotInput {
  project: string;
  projectRoot: string;
  /** Git `--since` window (already defaulted by the engine). */
  since: string;
  /** Cap per band (default `HOTSPOTS_DEFAULT_LIMIT`). */
  limit?: number | undefined;
  /** The size feed: every indexed file. */
  sizes: HotspotSizeFeed[];
  /** The dead-code feed (absent/empty → no debt signal). */
  dead?: Map<string, HotspotDeadFeed> | undefined;
  /** Churn counts, absolute-path keyed (absent → notARepo or git unavailable). */
  churn?: Map<string, number> | undefined;
  /** Coupling fans, absolute-path keyed (absent → all zero). */
  coupling?: Map<string, HotspotCouplingFeed> | undefined;
  /** File-kind classifiers — injected so tests can vary them (default: filekinds). */
  isTestFile?: HotspotClassifier | undefined;
  isEntryPointFile?: HotspotClassifier | undefined;
  notARepo?: boolean | undefined;
  commitsScanned?: number | undefined;
  commitsTruncated?: boolean | undefined;
  /** The table snapshot hit its row cap (sizes/dead partial). */
  snapshotTruncated?: boolean | undefined;
}

// ------------------------------------------------------------------- helpers

/** Rounds to one decimal — deterministic JSON, readable band lines. */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Project-relative path when the file is inside the root, else the absolute path. */
function relTo(root: string, file: string): string {
  const rel = path.relative(root, file);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

/** Deterministic tiebreak: project-relative path ascending (as in coupling.ts). */
function byRelativePath(a: HotspotFile, b: HotspotFile): number {
  return a.relativeFile < b.relativeFile ? -1 : a.relativeFile > b.relativeFile ? 1 : 0;
}

/** The default classifier set (the engine passes nothing; tests may override). */
const DEFAULT_TEST: HotspotClassifier = isTestFile;
const DEFAULT_ENTRY: HotspotClassifier = isEntryPointFile;

// ------------------------------------------------------------------ the join

/**
 * Joins the three feeds into the ranked hotspot report. Pure: every input is in
 * memory; the only arithmetic is the log-scaled score above.
 */
export function computeHotspots(input: HotspotInput): HotspotReport {
  const limit = input.limit ?? HOTSPOTS_DEFAULT_LIMIT;
  const isTest = input.isTestFile ?? DEFAULT_TEST;
  const isEntry = input.isEntryPointFile ?? DEFAULT_ENTRY;

  const files: HotspotFile[] = [];
  let notListed = 0;
  let filesWithChurn = 0;

  for (const size of input.sizes) {
    const churn = input.churn?.get(size.file) ?? 0;
    if (churn > 0) filesWithChurn++;
    const coupling = input.coupling?.get(size.file);
    const fanIn = coupling?.fanIn ?? 0;
    const fanOut = coupling?.fanOut ?? 0;
    const dead = input.dead?.get(size.file);

    // Size and the two score dimensions (log-scaled, see the module header).
    const sizeRaw = size.chunks + size.symbols;
    const churnNorm = Math.log1p(churn) / Math.log1p(CHURN_SATURATE);
    const sizeNorm = Math.log1p(sizeRaw) / Math.log1p(SIZE_SATURATE);
    const base = 100 * churnNorm * sizeNorm;

    // Debt signals promote: capped per signal so no single signal dominates.
    const density =
      dead && dead.candidates > 0 ? dead.dead / dead.candidates : 0;
    const deadBoost =
      dead && dead.dead > 0 ? DEAD_WEIGHT * Math.min(1, density / DEAD_DENSITY_SATURATE) : 0;
    const couplingBoost =
      fanIn + fanOut > 0 ? COUPLING_WEIGHT * Math.min(1, (fanIn + fanOut) / COUPLING_SATURATE) : 0;

    let score = Math.max(0, Math.min(100, base + deadBoost + couplingBoost));

    // Demotion: a hot test file / entry point is reported, never as a hotspot priority.
    const test = isTest(size.file);
    const entry = isEntry(size.file);
    const demoted = test || entry;
    if (demoted) score = Math.min(score, DEMOTED_CAP);

    score = round1(score);

    // Inclusion: anything that scored, or carries a debt signal. A file that
    // never changes, holds (almost) no code and has no signal is not a hotspot
    // — counted in `notListed` so nothing disappears silently.
    if (score === 0 && !(dead && dead.dead > 0)) {
      notListed++;
      continue;
    }

    const band: HotspotFile["band"] =
      demoted || score < HOTSPOT_BAND_SCORES.warm
        ? "review"
        : score >= HOTSPOT_BAND_SCORES.critical
          ? "critical"
          : "warm";

    // One-line rationale: the facts that produced the score, in score order.
    const parts: string[] = [];
    parts.push(`changed ${churn}×`);
    if (size.symbols > 0 || size.chunks > 0) {
      parts.push(`${size.symbols} symbols, ${size.chunks} chunks`);
    }
    if (dead && dead.dead > 0) {
      parts.push(`${dead.dead} dead of ${dead.candidates} candidates`);
    }
    if (fanIn > 0 || fanOut > 0) parts.push(`fan-in ${fanIn}, fan-out ${fanOut}`);
    if (test) parts.push("test file — demoted");
    if (entry) parts.push("entry point — demoted");

    const rec: HotspotFile = {
      file: size.file,
      relativeFile: relTo(input.projectRoot, size.file),
      churn,
      chunks: size.chunks,
      symbols: size.symbols,
      deadSymbols: dead?.dead ?? 0,
      fanIn,
      fanOut,
      testFile: test,
      entryPoint: entry,
      score,
      band,
      rationale: parts.join("; "),
    };
    if (density > 0) rec.deadDensity = round1(density * 1000) / 1000;
    files.push(rec);
  }

  // Ranked: score desc → churn desc → path asc (stable, like the other reports).
  files.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.churn !== b.churn) return b.churn - a.churn;
    return byRelativePath(a, b);
  });

  const band = (name: HotspotFile["band"]): HotspotBand => {
    const members = files.filter((f) => f.band === name);
    return {
      items: members.slice(0, limit),
      total: members.length,
      truncated: members.length > limit,
    };
  };
  const critical = band("critical");
  const warm = band("warm");
  const review = band("review");

  // Churn paths that join to no indexed file: counted honestly, never listed.
  let unindexedChurnFiles = 0;
  if (input.churn) {
    const indexed = new Set(input.sizes.map((s) => s.file));
    for (const f of input.churn.keys()) {
      if (!indexed.has(f)) unindexedChurnFiles++;
    }
  }

  return {
    project: input.project,
    since: input.since,
    critical,
    warm,
    review,
    scannedFiles: input.sizes.length,
    notListed,
    filesWithChurn,
    unindexedChurnFiles,
    commitsScanned: input.commitsScanned ?? 0,
    commitsTruncated: input.commitsTruncated ?? false,
    notARepo: input.notARepo ?? false,
    snapshotTruncated: input.snapshotTruncated ?? false,
    truncated: critical.truncated || warm.truncated || review.truncated,
  };
}