/**
 * Coupling metrics — pure helpers, no I/O and no LanceDB.
 *
 * Sibling of `impact.ts` / `deadcode.ts`. `get_dependencies` answers per-file;
 * agents and humans also need the aggregate: which files are entangled with
 * everything (change-magnets), which are orphans. This module only reduces the
 * dependency graph the `IndexManager.buildImportGraph` cache already builds into
 * per-file numbers and three ranked bands:
 *
 *   topFanIn        — most imported (fanIn desc)
 *   changeMagnets   — fanIn >= 2 AND fanOut >= 2, ranked by fanIn + fanOut desc
 *                     (the entangled files where one change ripples)
 *   unstableLeaves  — fanIn === 0 AND fanOut > 0, fanOut desc
 *                     (imported by nothing, importing others — pure dependents)
 *
 * Per file: `fanIn` (internal importers), `fanOut` (internal imports),
 * `instability = fanOut / (fanIn + fanOut)` (0 = stable/attracting, 1 = unstable/
 * depending; null for a file with no internal edges at all) and `externalImports`
 * — import specifiers that resolved OUTSIDE the index (external/unresolved).
 * External edges are deliberately excluded from the fan metrics (they are not
 * indexed files, so counting them would smear the internal picture) and are
 * reported separately instead.
 *
 * Every band is capped by `limit` with an honest `total` + `truncated`; files
 * that fall in no band (zero internal fan-in AND fan-out) are counted in
 * `unclassified`, never silently dropped.
 *
 * CAVEAT (also carried by the tool description): in a package-indexed, flat
 * project every file is one module, so the metrics are trivially shallow — they
 * are meaningful only for real module structures.
 */
import path from "node:path";

// --------------------------------------------------------------------- defaults

/** Default cap per band (`get_coupling` / `cidx coupling`). */
export const COUPLING_DEFAULT_LIMIT = 50;

/** Change-magnet threshold on fan-in (and, symmetrically, fan-out). */
const MAGNET_FAN = 2;

// ----------------------------------------------------------------------- types

/** Per-file coupling numbers (one record per indexed file). */
export interface FileCoupling {
  /** Absolute path. */
  file: string;
  /** Project-relative path (absolute when outside the root — never truncated to nothing). */
  relativeFile: string;
  /** Distinct indexed files that import this one. */
  fanIn: number;
  /** Distinct indexed files this one imports. */
  fanOut: number;
  /**
   * fanOut / (fanIn + fanOut), rounded to 3 decimals — 0 = stable/attracting,
   * 1 = unstable/depending. null when the file has no internal edges at all.
   */
  instability: number | null;
  /** Import specifiers that resolved outside the index (external/unresolved). */
  externalImports: number;
}

/** One capped band of the report. */
export interface CouplingBand {
  /** The ranked, capped band members. */
  items: FileCoupling[];
  /** The true band size before the cap. */
  total: number;
  /** The cap was hit — pass a higher `limit` for more. */
  truncated: boolean;
}

/** The `get_coupling` report: three bands over the dependency graph, plus the files they exclude. */
export interface CouplingReport {
  project: string;
  /** Most imported files (fanIn > 0), fanIn descending. */
  topFanIn: CouplingBand;
  /** Change magnets (fanIn >= 2 AND fanOut >= 2), fanIn + fanOut descending. */
  changeMagnets: CouplingBand;
  /** Unstable leaves (fanIn === 0 AND fanOut > 0), fanOut descending. */
  unstableLeaves: CouplingBand;
  /** Indexed files scanned (the node set). */
  scannedFiles: number;
  /**
   * Files that fall in no band — zero internal fan-in AND fan-out (imported by
   * nothing indexed, importing nothing indexed) — counted, not listed.
   */
  unclassified: number;
  /** Project-wide count of external/unresolved import specifiers (never in the fan metrics). */
  externalImports: number;
  /** Any band hit its cap. */
  truncated: boolean;
}

/** Everything the reduction needs — the engine gathers it from the dep-graph cache. */
export interface CouplingInput {
  project: string;
  projectRoot: string;
  /**
   * Absolute paths of the indexed files — the node set. Every file gets a record,
   * even one with zero internal edges (the `unclassified` count needs them).
   */
  files: string[];
  /** Importer abs path → imported abs paths (specifiers resolved against the index). */
  forward: Map<string, string[]>;
  /** Importer abs path → count of external/unresolved import specifiers. */
  externalImports?: Map<string, number>;
  /** Cap per band (default `COUPLING_DEFAULT_LIMIT`). */
  limit?: number | undefined;
}

// ------------------------------------------------------------------- helpers

/** Project-relative path when the file is inside the root, else the absolute path. */
function relTo(root: string, file: string): string {
  const rel = path.relative(root, file);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

/** Rounds instability to 3 decimals — deterministic JSON, readable bands. */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Distinct fan count for one file over a raw edge list: duplicate targets
 * collapse and a self-edge is ignored — the same discipline `computeCoupling`
 * applies to `forward` (which may repeat a target when two specifiers import
 * the same module). `get_hotspots` shares the dependency-graph cache with
 * `get_coupling`, so it must use the same definition or the two reports
 * disagree on fan-out (observed: 47 raw edges vs 40 distinct files).
 */
export function distinctNeighborCount(edges: readonly string[] | undefined, self: string): number {
  if (!edges || edges.length === 0) return 0;
  const seen = new Set<string>();
  for (const e of edges) {
    if (e === self) continue;
    seen.add(e);
  }
  return seen.size;
}

/** Deterministic tiebreak: project-relative path ascending. */
function byRelativePath(a: FileCoupling, b: FileCoupling): number {
  return a.relativeFile < b.relativeFile ? -1 : a.relativeFile > b.relativeFile ? 1 : 0;
}

// ------------------------------------------------------------------ the join

/**
 * Reduces the dependency graph to per-file coupling numbers and the three ranked
 * bands. Pure: every input is already in memory, so this is the only "new work"
 * `get_coupling` does beyond the cache lookup.
 *
 * Edge discipline: `forward` may repeat a target (two specifiers importing the
 * same file) and may self-reference — both are normalized here, so fans count
 * DISTINCT files and never count a file against itself. A reverse view is not
 * accepted because it could disagree with `forward`; fan-in is derived from the
 * same edge list fan-out is, so the two can never contradict each other.
 */
export function computeCoupling(input: CouplingInput): CouplingReport {
  const limit = input.limit ?? COUPLING_DEFAULT_LIMIT;
  const root = input.projectRoot;

  // The node set: every indexed file reports — even with zero internal edges.
  // Extend the set (never drop) if an edge points outside the declared set; the
  // engine guarantees coverage, the pure function refuses to lie instead.
  const known = new Set<string>(input.files);
  for (const [importer, targets] of input.forward) {
    known.add(importer);
    for (const t of targets) known.add(t);
  }

  // Per-file DISTINCT neighbor sets (same-file duplicates collapse; self-edges ignored).
  const outSets = new Map<string, Set<string>>();
  const inSets = new Map<string, Set<string>>();
  for (const f of known) {
    outSets.set(f, new Set());
    inSets.set(f, new Set());
  }
  for (const [importer, targets] of input.forward) {
    const out = outSets.get(importer);
    if (!out) continue; // unreachable (the pass above guaranteed it)
    for (const t of targets) {
      if (t === importer) continue;
      out.add(t);
      const inSet = inSets.get(t);
      if (inSet) inSet.add(importer);
    }
  }

  const records: FileCoupling[] = [];
  let externalTotal = 0;
  for (const f of known) {
    const fanIn = inSets.get(f)!.size;
    const fanOut = outSets.get(f)!.size;
    const ext = input.externalImports?.get(f) ?? 0;
    externalTotal += ext;
    const rec: FileCoupling = {
      file: f,
      relativeFile: relTo(root, f),
      fanIn,
      fanOut,
      instability: fanIn === 0 && fanOut === 0 ? null : round3(fanOut / (fanIn + fanOut)),
      externalImports: ext,
    };
    records.push(rec);
  }

  // The three bands: membership rules + ranking. A file may appear in two bands
  // (a change magnet is also a fan-in leader) — bands are views, not partitions.
  const topFanIn = records.filter((r) => r.fanIn > 0);
  topFanIn.sort((a, b) => (a.fanIn !== b.fanIn ? b.fanIn - a.fanIn : byRelativePath(a, b)));

  const changeMagnets = records.filter((r) => r.fanIn >= MAGNET_FAN && r.fanOut >= MAGNET_FAN);
  changeMagnets.sort((a, b) => {
    const sumA = a.fanIn + a.fanOut;
    const sumB = b.fanIn + b.fanOut;
    if (sumA !== sumB) return sumB - sumA;
    if (a.fanIn !== b.fanIn) return b.fanIn - a.fanIn;
    return byRelativePath(a, b);
  });

  const unstableLeaves = records.filter((r) => r.fanIn === 0 && r.fanOut > 0);
  unstableLeaves.sort((a, b) => (a.fanOut !== b.fanOut ? b.fanOut - a.fanOut : byRelativePath(a, b)));

  const band = (items: FileCoupling[]): CouplingBand => ({
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  });
  const topFanInBand = band(topFanIn);
  const magnetsBand = band(changeMagnets);
  const leavesBand = band(unstableLeaves);

  const unclassified = records.filter((r) => r.fanIn === 0 && r.fanOut === 0).length;

  return {
    project: input.project,
    topFanIn: topFanInBand,
    changeMagnets: magnetsBand,
    unstableLeaves: leavesBand,
    scannedFiles: records.length,
    unclassified,
    externalImports: externalTotal,
    truncated: topFanInBand.truncated || magnetsBand.truncated || leavesBand.truncated,
  };
}