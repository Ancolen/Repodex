/**
 * Table stats (proposal O3) — what `cidx stats` reports over `GET /stats`.
 *
 * THE COLLECTION LAYERING mirrors `src/core/doctor.ts` (kept deliberately
 * strict so the shape is unit-testable without a daemon, an embedding backend,
 * or LanceDB):
 *   - `collectStats` is the only function that *composes* state, exclusively
 *     through the injected `StatsPorts` — every unknown stays honest (a null
 *     field + a note, never an invented zero).
 *   - The daemon (control-api) wires the ports from `IndexManager` +
 *     `services/db` + the doctor's disk walk; tests pass fakes.
 *
 * Per project: the registry's row count, the file_cache count, lastIndexedAt,
 * the measured table-directory size (the doctor disk walk reused 1:1), the
 * ANN/FTS index presence + native coverage stats, and the pending job. Global:
 * data-root total, per-table sizes, meta.db size, embedding-cache row count +
 * estimated size. Read-only — nothing here mutates anything.
 *
 * Compact (the proposal's other half) lives with the mutation side of the
 * house: `services/db.ts → compactTable` (native `optimize` under the
 * per-table write lock) behind `IndexManager.compactIndex` (the busy rule).
 */

import { tableNameFor, type EmbedCacheStats, type IndexRecord } from "./registry";
import type { Job } from "./types";
import type { DiskEntry, DiskUsageState } from "./doctor";
import type { TableIndexStat, TableStatsReport } from "../services/db";

// ------------------------------------------------------------------- types

/** The queued/running job of a project, flattened for the stats payload. */
export interface ProjectJobView {
  id: string;
  type: string;
  status: string;
  processed: number;
  total: number;
}

/** One project's table/maintenance picture ("should I compact this?"). */
export interface ProjectStats {
  name: string;
  path: string;
  /** The LanceDB table the project is served from. */
  table: string;
  status: string;
  /** Chunks tracked by the registry (the row count the stats proposal names). */
  rows: number;
  /** file_cache rows for this project (registry). */
  cachedFiles: number;
  lastIndexedAt: number | null;
  /** Measured table-directory size — null when the table is not on disk. */
  tableBytes: number | null;
  /** Native fragment counts — null when the native stats are unavailable. */
  fragments: number | null;
  /** Uncompacted fragments — the `compact` signal. */
  smallFragments: number | null;
  /** ANN/FTS index presence + coverage — null when the table itself is absent. */
  indices: TableIndexStat[] | null;
  /** What could not be read (honest unknowns, one line each). */
  notes: string[];
  job: ProjectJobView | null;
}

/** The data-root-wide picture. */
export interface GlobalStats {
  rootExists: boolean;
  /** Total bytes of the data root (`~/.cidx`), as the doctor's walk measures it. */
  totalBytes: number;
  /** Per-table sizes (children of `<root>/db`, `.lance` suffix stripped). */
  tables: DiskEntry[];
  /** meta.db (registry + caches + query log) size — null when absent. */
  metaDbBytes: number | null;
  embeddingCache: EmbedCacheStats;
  /** Walk entries that could not be read (carried over from the disk walk). */
  unreadableEntries: number;
}

/** The full `/stats` payload — read-only, honest unknowns. */
export interface StatsReport {
  generatedAt: number;
  /** The daemon's data root (`~/.cidx`, or `$CIDX_HOME`). */
  home: string;
  global: GlobalStats;
  projects: ProjectStats[];
}

/** Options of `collectStats` (mirrors the `GET /stats?project=` query param). */
export interface StatsOpts {
  /** Only report this project (plus the usual global picture). */
  project?: string | undefined;
  /**
   * Uncovered-row share above which an index-coverage note is emitted
   * (default 0.05; the daemon passes `maintenance.unindexedRatio`).
   */
  coverageGapRatio?: number | undefined;
}

/** Default uncovered-row share for the coverage note (config default). */
export const DEFAULT_COVERAGE_GAP_RATIO = 0.05;

/**
 * The live state the stats need, all injected — every port resolves honestly
 * instead of throwing, exactly like `DoctorPorts`. The daemon wires them from
 * `IndexManager` + `services/db` + `CONFIG`; tests pass fakes.
 */
export interface StatsPorts {
  /** Registered projects (the daemon's registry). */
  indexes(): IndexRecord[];
  /** The queued/running job for a project, if any. */
  activeJob(name: string): Job | null;
  /** Rows of the file cache: one project (name given) or all of them. */
  fileCacheCount(indexName?: string | undefined): number;
  /** Embedding-cache rows + estimated bytes. */
  embeddingCacheStats(): EmbedCacheStats;
  /** Read-only disk walk of the data root (the doctor's helper, reused 1:1). */
  diskUsage(): DiskUsageState;
  /** Native table statistics; null when the table does not exist. */
  tableStats(table: string): Promise<TableStatsReport | null>;
}

// -------------------------------------------------------- busy-table refusal

/**
 * The ONE refusal wording shared by the enforcement (`IndexManager.compactIndex`)
 * and the `/compact` handler (which upgrades the refusal to a 409 status).
 * Compaction must not interleave with an active index/sync/migrate job — the
 * same busy rule the watcher's per-file deferral already enforces.
 */
export function compactBusyMessage(name: string, job: Pick<Job, "type" | "status">): string {
  return (
    `Project '${name}' is busy (${job.type} job ${job.status}) — compaction needs a ` +
    "quiescent table; retry after it finishes."
  );
}

/** Type predicate: true when a job still holds or waits for the table (queued or running). */
export function jobIsActive(job: Job | null): job is Job {
  return !!job && (job.status === "queued" || job.status === "running");
}

// ---------------------------------------------------------------- collector

const META_DB_ENTRIES = ["meta.db", "meta.db-wal", "meta.db-shm"] as const;

/** Sums the disk-walk bytes of the given top-level entries (absent → 0). */
function sumEntries(entries: DiskEntry[], names: readonly string[]): number {
  let total = 0;
  for (const name of names) {
    const e = entries.find((x) => x.name === name);
    if (e) total += e.bytes;
  }
  return total;
}

/**
 * Coverage + duplicate-index notes for one project's native indices (2.10.0).
 * Incremental writes land behind an existing ANN/FTS index until an `optimize`
 * folds them in, so an uncovered index is a silent search-quality regression.
 * Duplicates are never summed — the best-covered index is reported.
 */
function coverageNotes(native: TableStatsReport, project: string, threshold: number): string[] {
  const rows = native.numRows;
  if (rows === null || rows <= 0) return [];
  const best = new Map<string, { count: number; indexed: number | null; unindexed: number | null }>();
  const order: string[] = [];
  for (const ix of native.indices) {
    for (const column of ix.columns) {
      let c = best.get(column);
      if (!c) {
        c = { count: 0, indexed: null, unindexed: null };
        best.set(column, c);
        order.push(column);
      }
      c.count += 1;
      if (ix.indexedRows !== undefined) {
        const unindexed = ix.unindexedRows ?? Math.max(0, rows - ix.indexedRows);
        if (c.indexed === null || ix.indexedRows > c.indexed) {
          c.indexed = ix.indexedRows;
          c.unindexed = unindexed;
        }
      }
    }
  }
  const notes: string[] = [];
  for (const column of order) {
    const c = best.get(column)!;
    if (c.indexed !== null && c.unindexed !== null && c.unindexed > 0 && c.unindexed / rows > threshold) {
      const pct = Math.round((c.unindexed / rows) * 100);
      notes.push(
        `'${column}' index covers ${c.indexed}/${rows} rows (${pct}% unindexed) — ` +
          `cidx compact ${project} or the next sync auto-repairs it`,
      );
    }
    if (c.count > 1) notes.push(`${c.count} native indexes on '${column}' — one is redundant`);
  }
  return notes;
}

/** Composes one project's stats from the ports (all unknowns preserved). */
async function projectStats(
  ports: StatsPorts,
  disk: DiskUsageState,
  rec: IndexRecord,
  coverageGapRatio: number,
): Promise<ProjectStats> {
  const table = tableNameFor(rec);
  const size = disk.tables.find((e) => e.name === table);
  const native = await ports.tableStats(table);
  const job = ports.activeJob(rec.name);

  const project: ProjectStats = {
    name: rec.name,
    path: rec.path,
    table,
    status: rec.status,
    rows: rec.chunkCount,
    cachedFiles: ports.fileCacheCount(rec.name),
    lastIndexedAt: rec.lastIndexedAt,
    tableBytes: size ? size.bytes : null,
    fragments: native ? native.numFragments : null,
    smallFragments: native ? native.numSmallFragments : null,
    indices: native ? native.indices : null,
    notes: native
      ? [...native.unknowns, ...coverageNotes(native, rec.name, coverageGapRatio)]
      : [`table '${table}' not found on disk — reindex to rebuild it`],
    job: job
      ? {
          id: job.id,
          type: job.type,
          status: job.status,
          processed: job.progress.processed,
          total: job.progress.total,
        }
      : null,
  };
  return project;
}

/**
 * Composes the full stats report: one read-only disk walk of the data root,
 * one pass over the registry's projects, and one native table-stats read per
 * project. `opts.project` narrows the per-project list — the global picture
 * always stays intact. Unknown names yield zero projects (the caller 404s
 * against the registry first; this is the defensive backstop).
 */
export async function collectStats(ports: StatsPorts, opts: StatsOpts = {}): Promise<StatsReport> {
  const disk = ports.diskUsage();
  const all = ports.indexes();
  const scoped = opts.project ? all.filter((r) => r.name === opts.project) : all;
  const coverageGapRatio = opts.coverageGapRatio ?? DEFAULT_COVERAGE_GAP_RATIO;

  const projects: ProjectStats[] = [];
  for (const rec of scoped) {
    projects.push(await projectStats(ports, disk, rec, coverageGapRatio));
  }

  return {
    generatedAt: Date.now(),
    home: disk.root,
    global: {
      rootExists: disk.rootExists,
      totalBytes: disk.totalBytes,
      tables: disk.tables,
      metaDbBytes: sumEntries(disk.entries, META_DB_ENTRIES),
      embeddingCache: ports.embeddingCacheStats(),
      unreadableEntries: disk.errors,
    },
    projects,
  };
}