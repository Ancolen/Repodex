import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { PROJECT_CONFIG_FILE, parseProjectConfig } from "./project-config";
import { tableNameFor, type IndexRecord } from "./registry";
import type { EmbedProvider } from "../services/embed";
import { modelTagPresent } from "../utils/model-tag";

/**
 * `cidx doctor` — the check registry behind the `GET /doctor` Control-API route
 * and the `cidx doctor` CLI command (proposal O1).
 *
 * One read-only diagnostic pass. Every check reports `ok` / `warn` / `fail` plus
 * a one-line fix hint; the CLI exits 0 unless some check is `fail`. Nothing here
 * ever mutates state — it only reads the registry, the LanceDB tables, the
 * config files and the data directory.
 *
 * LAYERING (kept deliberately strict so the checks are unit-testable without a
 * daemon, without an embedding backend and without LanceDB):
 *   - The check functions below are PURE: they take injected, already-measured
 *     state (plain data) and return a verdict. They never touch a live handle.
 *   - `runDoctor` is the only place that *gathers* live state, and it does so
 *     exclusively through the injected `DoctorPorts`. The daemon (control-api)
 *     supplies the ports; tests supply fakes.
 *
 * Reuse over forks: schema freshness goes through the same `tableColumns` the
 * docstring legs are gated on, the config files are validated by the same
 * `parseProjectConfig` the indexer uses, and the reranker verdict comes from
 * `IndexManager.ensureRerankAvailable`'s cached probe (passed in as a port) —
 * doctor never probes Ollama a second time for it.
 */

// ------------------------------------------------------------------- types

export type DoctorStatus = "ok" | "warn" | "fail";

/** One diagnostic check result (`ok`/`warn`/`fail` + a one-line fix hint). */
export interface DoctorCheck {
  /** Stable id, e.g. `ollama`, `reranker`, `project:api`, `tables`, `config`, `disk`. */
  id: string;
  /** Human label rendered by the CLI (`project api`, `disk usage`, ...). */
  title: string;
  status: DoctorStatus;
  /** What was actually observed (pre-formatted, human-readable). */
  detail?: string;
  /** One-line fix hint. Always present for warn/fail. */
  hint?: string;
}

/** The full `/doctor` payload. */
export interface DoctorReport {
  /** Worst status across all checks (`ok` when there are no checks). */
  status: DoctorStatus;
  checks: DoctorCheck[];
  /** The daemon's data root (`~/.cidx`, or `$CIDX_HOME`). */
  home: string;
}

/** Index metadata of a table (structural subset of LanceDB's `IndexConfig`). */
export interface TableIndexInfo {
  columns: string[];
  indexType: string;
}

interface Finding {
  status: DoctorStatus;
  message: string;
  hint?: string;
}

/** Builds a check without tripping over `exactOptionalPropertyTypes`. */
function check(
  id: string,
  title: string,
  status: DoctorStatus,
  detail?: string,
  hint?: string,
): DoctorCheck {
  const c: DoctorCheck = { id, title, status };
  if (detail !== undefined) c.detail = detail;
  if (hint !== undefined) c.hint = hint;
  return c;
}

function finding(status: DoctorStatus, message: string, hint?: string): Finding {
  const f: Finding = { status, message };
  if (hint !== undefined) f.hint = hint;
  return f;
}

const STATUS_RANK: Record<DoctorStatus, number> = { ok: 0, warn: 1, fail: 2 };

/** The worst status of a set (a single `fail` makes the whole run red). */
export function aggregateStatus(items: { status: DoctorStatus }[]): DoctorStatus {
  let worst: DoctorStatus = "ok";
  for (const i of items) {
    if (STATUS_RANK[i.status] > STATUS_RANK[worst]) worst = i.status;
  }
  return worst;
}

/** First hint of the worst finding (the single line the CLI prints as `fix:`). */
function worstHint(findings: { status: DoctorStatus; hint?: string }[]): string | undefined {
  const sorted = [...findings]
    .filter((f) => f.hint !== undefined)
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
  return sorted[0]?.hint;
}

/** Byte count → short human string (`812 B`, `12.5 KB`, `380.2 MB`, `1.4 GB`). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const s = u === 0 ? String(Math.round(v)) : v.toFixed(1);
  return `${s} ${units[u]}`;
}

// ------------------------------------------------------------------- checks

export interface DaemonCheckState {
  reachable: boolean;
  cliVersion: string;
  daemonVersion?: string;
  pid?: number;
}

/**
 * Check 1 — daemon reachable + CLI ↔ daemon version match. Evaluated CLI-side
 * (an unreachable daemon is the one thing the daemon cannot report itself).
 */
export function daemonCheck(s: DaemonCheckState): DoctorCheck {
  if (!s.reachable) {
    return check(
      "daemon",
      "daemon",
      "fail",
      "not running (no answer on the control port)",
      "start it: cidx start   (cidx mcp also starts it on demand)",
    );
  }
  if (s.daemonVersion !== undefined && s.daemonVersion !== s.cliVersion) {
    return check(
      "daemon",
      "daemon",
      "warn",
      `daemon v${s.daemonVersion} but CLI v${s.cliVersion} — a mismatch can hide or break newer endpoints`,
      "restart the daemon: cidx stop && cidx start",
    );
  }
  return check("daemon", "daemon", "ok", `v${s.cliVersion}${s.pid !== undefined ? ` · pid ${s.pid}` : ""}`);
}

export interface BackendProbeState {
  /** Which backend answered; `null` = no backend reachable at all. */
  provider: EmbedProvider | null;
  url: string;
  up: boolean;
  /** Model tags/id served by the backend (`/api/tags` or `/v1/models`); [] when unreachable. */
  models: string[];
}

/** Check 2a — the embedding backend is reachable and serves the configured model. */
export function backendCheck(s: BackendProbeState, model: string): DoctorCheck {
  if (s.provider === null) {
    return check(
      "backend",
      "embedding backend",
      "fail",
      "no embedding backend reachable",
      `start Ollama (ollama serve) or llama-server (-m <model.gguf> --embedding), or set embedding.provider — mode=text search keeps working without one`,
    );
  }
  const label = s.provider === "ollama" ? "Ollama" : "llama-server";
  if (!s.up) {
    return check(
      "backend",
      "embedding backend",
      "fail",
      `no answer from ${label} at ${s.url}`,
      `start ${label} (ollama serve, or llama-server -m <model.gguf> --embedding) — mode=text search keeps working without it`,
    );
  }
  if (!modelTagPresent(s.models, model)) {
    const hint =
      s.provider === "ollama"
        ? `ollama pull ${model} — or point ollama.model at an installed tag`
        : `restart llama-server with that model (-m <model.gguf> -a ${model})`;
    return check(
      "backend",
      "embedding backend",
      "fail",
      `model '${model}' is not served by ${label} (${s.models.length} model(s) present)`,
      hint,
    );
  }
  return check(
    "backend",
    "embedding backend",
    "ok",
    `${label} at ${s.url} · model '${model}' present · ${s.models.length} model(s)`,
  );
}

export interface RerankerCheckState {
  enabled: boolean;
  model: string;
  /** Result of `IndexManager.ensureRerankAvailable`'s cached probe (null = not probed). */
  available: boolean | null;
}

/** Check 2b — reranker model availability (advisory: search falls back to RRF order). */
export function rerankerCheck(s: RerankerCheckState): DoctorCheck {
  if (!s.enabled || s.model.length === 0) {
    return check("reranker", "reranker", "ok", "disabled by config (search.rerank) — results stay in RRF order");
  }
  if (s.available === true) {
    return check("reranker", "reranker", "ok", `model '${s.model}' available — second-stage reranking active`);
  }
  if (s.available === null) {
    return check(
      "reranker",
      "reranker",
      "warn",
      `model '${s.model}' not probed yet`,
      "run a search once, then re-run doctor",
    );
  }
  return check(
    "reranker",
    "reranker",
    "warn",
    `model '${s.model}' is not available — reranking is off for this session`,
    `install it on the embedding backend (ollama pull ${s.model}, or start that llama-server with it) — or set search.rerank.enabled=false (search falls back to RRF order)`,
  );
}

export interface ProjectDoctorState {
  name: string;
  path: string;
  tableName: string;
  /** "indexing" | "ready" | "error" */
  status: string;
  error?: string | null;
  /** file_cache size as of the last job (registry `fileCount`). */
  fileCount: number;
  /** Chunk count the registry recorded at the last job. */
  chunkCount: number;
  /** The model the table's vectors were built with (null = legacy record). */
  embedModel: string | null;
  /** Is the project's model served by the embedding backend? (null = could not probe) */
  modelOnBackend: boolean | null;
  tableExists: boolean;
  /** Live row count (null when the table is absent). */
  tableRows: number | null;
  /** Live schema columns (empty when the table is absent). */
  columns: string[];
  /** Live index metadata (empty when the table is absent). */
  indices: TableIndexInfo[];
  /** ANN is only built at/above this row count (config `vectorIndexThreshold`). */
  vectorIndexThreshold: number;
  /** Config `indexing.docstrings` — whether missing doc columns is a problem. */
  docstringsEnabled: boolean;
}

/** The `doc` + `doc_vector` columns the 2.4.0 docstring legs are gated on. */
function hasDocColumns(columns: string[]): boolean {
  return columns.includes("doc") && columns.includes("doc_vector");
}

function hasIndexOn(indices: TableIndexInfo[], column: string, typeRe?: RegExp): boolean {
  return indices.some((ix) => ix.columns.includes(column) && (typeRe === undefined || typeRe.test(ix.indexType)));
}

/**
 * Findings for one registered project. Table-derived findings stop at a missing
 * table (there is nothing left to inspect); count-sanity findings are skipped
 * while a job is running because both sides are mid-write.
 */
export function projectFindings(s: ProjectDoctorState): Finding[] {
  const f: Finding[] = [];
  const reindex = `cidx reindex ${s.name}`;

  if (s.status === "error") {
    f.push(
      finding(
        "fail",
        `last index job failed${s.error ? `: ${s.error}` : ""}`,
        `${reindex} — and check that the embedding backend is running and serves the model`,
      ),
    );
  }

  if (!s.tableExists) {
    f.push(
      finding(
        "fail",
        `LanceDB table '${s.tableName}' is missing (registry reports ${s.chunkCount} chunks)`,
        `${reindex} — rebuilds the table`,
      ),
    );
    return f;
  }

  if (s.embedModel && s.modelOnBackend === false) {
    f.push(
      finding(
        "fail",
        `embedding model '${s.embedModel}' (pinned by this project) is not served by the embedding backend — search in this project fails`,
        `serve it (ollama pull ${s.embedModel}, or point llama-server at it) — or change .cidx.json embedModel and reindex`,
      ),
    );
  }

  // Schema freshness — the same gate the docstring search legs use.
  const docCols = hasDocColumns(s.columns);
  if (s.docstringsEnabled && !docCols) {
    f.push(
      finding(
        "warn",
        "table schema is pre-2.4.0 (no doc/doc_vector columns) — the docstring search legs are inactive",
        `${reindex} — enables the docstring search legs`,
      ),
    );
  }

  const rows = s.tableRows ?? 0;
  const ftsContent = hasIndexOn(s.indices, "content", /fts|inverted/i);
  if (rows > 0 && !ftsContent) {
    f.push(
      finding(
        "warn",
        "no BM25 (FTS) index on 'content' — text/hybrid search finds nothing in this table",
        `${reindex} — rebuilds the BM25 index`,
      ),
    );
  }
  if (docCols && rows > 0 && !hasIndexOn(s.indices, "doc", /fts|inverted/i)) {
    f.push(finding("ok", "doc column has no BM25 index — the doc text leg is inert (optional)"));
  }

  const ann = hasIndexOn(s.indices, "vector");
  if (rows >= s.vectorIndexThreshold && !ann) {
    f.push(
      finding(
        "warn",
        `${rows} rows but no ANN vector index — semantic search scans the whole table`,
        `${reindex} — builds the ANN index`,
      ),
    );
  } else if (rows > 0 && !ann) {
    f.push(
      finding(
        "ok",
        `no ANN index (below the ${s.vectorIndexThreshold} row threshold) — brute-force scan, by design`,
      ),
    );
  }

  if (s.status === "indexing") {
    f.push(finding("ok", "indexing in progress — table/cache counts are transient"));
  } else {
    if (rows !== s.chunkCount) {
      f.push(
        finding(
          "warn",
          `registry reports ${s.chunkCount} chunks but the table holds ${rows}`,
          `cidx sync ${s.name} — or ${reindex} for a full rebuild`,
        ),
      );
    }
    if (s.fileCount === 0 && rows > 0) {
      f.push(
        finding(
          "warn",
          `file cache is empty while the table holds ${rows} chunks — the next sync re-embeds everything`,
          `${reindex} — rebuilds the cache and the table together`,
        ),
      );
    }
  }

  if (f.length === 0) {
    f.push(
      finding(
        "ok",
        `${rows} chunks · ${s.fileCount} files · schema current${s.embedModel ? ` · model '${s.embedModel}'` : ""}`,
      ),
    );
  }
  return f;
}

/** Check 3 — one check per registered project (table, schema, indexes, cache sanity). */
export function projectCheck(s: ProjectDoctorState): DoctorCheck {
  const findings = projectFindings(s);
  const detail = findings.map((x) => x.message).join("; ");
  return check(`project:${s.name}`, `project ${s.name}`, aggregateStatus(findings), detail, worstHint(findings));
}

export interface OrphanTablesState {
  /** Table names on disk (`~/.cidx/db`). */
  tables: string[];
  /** Table names referenced by the registry (via `tableNameFor`). */
  registeredTables: string[];
  dbDir: string;
}

/** The `_mig` suffix naming an O2 model-migration shadow table. */
const MIG_TABLE_RE = /_mig$/;

/**
 * Check 4 — disk tables the registry does not know about. A `*_mig` orphan is
 * the interrupted-O2-migration leftover (the registry commit never flipped to
 * it): same warn, but the message and hint are migration-specific — the owning
 * project's live table is unaffected and `cidx sync` re-escalates (and
 * pre-cleans) when the model change is still pending. (The mirror case, a
 * registry row without a table, is the per-project check's `fail` — one finding
 * per problem, not two.)
 */
export function orphanTablesCheck(s: OrphanTablesState): DoctorCheck {
  const registered = new Set(s.registeredTables);
  const orphans = s.tables.filter((t) => !registered.has(t));
  if (orphans.length === 0) {
    return check(
      "tables",
      "tables",
      "ok",
      s.tables.length === 0
        ? `no tables in ${s.dbDir} (nothing indexed yet)`
        : `${s.tables.length} table(s), all registered`,
    );
  }
  const shadows = orphans.filter((t) => MIG_TABLE_RE.test(t));
  const others = orphans.filter((t) => !MIG_TABLE_RE.test(t));
  const parts: string[] = [];
  const hints: string[] = [];
  if (shadows.length > 0) {
    parts.push(
      `stale migration shadows: ${shadows.join(", ")} — an interrupted (or still in-progress) model migration left them behind; the projects' live tables are unaffected`,
    );
    hints.push(
      `delete the *_mig directory under ${s.dbDir} (or re-run cidx sync on the project to redo its migration)`,
    );
  }
  if (others.length > 0) {
    parts.push(`not in the registry: ${others.join(", ")} — never searched, only taking disk space`);
    hints.push(`remove the stale directory under ${s.dbDir} (or re-add the project with cidx index and cidx remove it)`);
  }
  return check("tables", "tables", "warn", parts.join(" · "), hints.join("; "));
}

/** One config file's verdict, computed by the collector. */
export interface ConfigFileFinding {
  path: string;
  status: DoctorStatus;
  message: string;
  hint?: string;
}

export interface ConfigCheckState {
  /** Resolved global YAML path (null = running on defaults). */
  configPath: string | null;
  files: ConfigFileFinding[];
}

/**
 * Check 5 — config files: the global YAML parses, every project's
 * `.cidx.json` parses and its fields validate (via `parseProjectConfig`, the
 * exact validator the indexer uses — shared, not duplicated).
 */
export function configCheck(s: ConfigCheckState): DoctorCheck {
  const status = aggregateStatus(s.files);
  // The YAML path prefixes the line, so it is not repeated per finding; project
  // files are shown by full path (which project owns the broken file matters).
  const detail = s.files.map((f) => (f.path === s.configPath ? f.message : `${f.path}: ${f.message}`)).join("; ");
  const hint = worstHint(s.files);
  const where = s.configPath ?? "(no configuration file — defaults)";
  return check("config", "config", status, s.files.length > 0 ? `${where} · ${detail}` : where, hint);
}

/**
 * Pure verdict for ONE configuration file, given its raw text.
 * `text === null` means the file is absent/unreadable: that is normal for a
 * project's `.cidx.json` (returns null — nothing to report) and reported as
 * "defaults" for the global YAML.
 */
export function inspectConfigFile(
  filePath: string,
  kind: "yaml" | "project",
  text: string | null,
): ConfigFileFinding | null {
  if (text === null) {
    return kind === "yaml"
      ? { path: filePath, status: "ok", message: "absent — running on defaults" }
      : null;
  }

  if (kind === "yaml") {
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (err) {
      return {
        path: filePath,
        status: "warn",
        message: `YAML does not parse (${err instanceof Error ? err.message : err}) — cidx is running on defaults`,
        hint: `fix the syntax error in ${filePath}, then restart the daemon`,
      };
    }
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      return {
        path: filePath,
        status: "warn",
        message: "does not contain a mapping — cidx is running on defaults",
        hint: `make ${filePath} a key: value mapping (see cidx config)`,
      };
    }
    return { path: filePath, status: "ok", message: "parses" };
  }

  // Per-project .cidx.json — validated by the shared validator.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      path: filePath,
      status: "warn",
      message: "invalid JSON — cidx ignores this file",
      hint: `fix the JSON syntax in ${PROJECT_CONFIG_FILE} (fields: languages, ignore, embedModel, doccheck)`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      path: filePath,
      status: "warn",
      message: "not a JSON object — cidx ignores this file",
      hint: `${PROJECT_CONFIG_FILE} must be an object (fields: languages, ignore, embedModel, doccheck)`,
    };
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (parseProjectConfig(raw, filePath) !== undefined) {
    return { path: filePath, status: "ok", message: `valid (${keys.length} field(s))` };
  }
  if (keys.length === 0) {
    return { path: filePath, status: "ok", message: "empty object — no overrides" };
  }
  return {
    path: filePath,
    status: "warn",
    message: "no valid fields — cidx ignores this file",
    hint: `${PROJECT_CONFIG_FILE} fields are: languages (string[]), ignore (string[]), embedModel (string), doccheck (object: files, ignore)`,
  };
}

export interface DiskEntry {
  name: string;
  bytes: number;
}

export interface DiskUsageState {
  root: string;
  rootExists: boolean;
  totalBytes: number;
  /** Top-level entries of the data root (`db`, `meta.db`, `daemon.log`, ...). */
  entries: DiskEntry[];
  /** Per-table sizes (the children of `<root>/db`). */
  tables: DiskEntry[];
  /** Entries that could not be read (permission, vanished mid-walk). */
  errors: number;
}

/** Check 6 — disk usage of the data root, with per-table sizes (informational). */
export function diskCheck(s: DiskUsageState): DoctorCheck {
  if (!s.rootExists) {
    return check(
      "disk",
      "disk usage",
      "warn",
      `${s.root} does not exist yet`,
      "index a project (cidx index <dir>) — the data root is created on first use",
    );
  }
  const top = (list: DiskEntry[], n: number) =>
    list
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, n)
      .map((e) => `${e.name} ${formatBytes(e.bytes)}`)
      .join(", ");
  const parts = [`total ${formatBytes(s.totalBytes)}`];
  const tables = top(s.tables, 5);
  if (tables) parts.push(`tables: ${tables}`);
  else {
    const entries = top(s.entries, 5);
    if (entries) parts.push(entries);
  }
  if (s.errors > 0) parts.push(`${s.errors} unreadable entr${s.errors === 1 ? "y" : "ies"}`);
  return check("disk", "disk usage", "ok", parts.join(" · "));
}

// ------------------------------------------------------- disk size walk (fs)

/**
 * Recursive byte size of one path (file or directory). A simple, bounded
 * read-only walk — no stats proposal (O3) is being built, so this is computed
 * inline and kept private to the doctor.
 */
function sizeOf(target: string, state: { errors: number }): number {
  let st;
  try {
    st = statSync(target);
  } catch {
    state.errors++;
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    state.errors++;
    return 0;
  }
  for (const name of names) {
    total += sizeOf(path.join(target, name), state);
  }
  return total;
}

/**
 * Measures the data root for `diskCheck`: total, top-level entries, and the
 * per-table children of `<root>/db` (`.lance` suffixes stripped for display).
 */
export function measureDiskUsage(root: string): DiskUsageState {
  const state = { errors: 0 };
  let rootExists = false;
  try {
    rootExists = statSync(root).isDirectory();
  } catch {
    rootExists = false;
  }
  if (!rootExists) {
    return { root, rootExists: false, totalBytes: 0, entries: [], tables: [], errors: 0 };
  }

  const entryNames = (() => {
    try {
      return readdirSync(root);
    } catch {
      state.errors++;
      return [] as string[];
    }
  })();

  const entries: DiskEntry[] = [];
  let total = 0;
  for (const name of entryNames) {
    const p = path.join(root, name);
    const bytes = sizeOf(p, state);
    total += bytes;
    entries.push({ name, bytes });
  }

  const dbDir = path.join(root, "db");
  const tables: DiskEntry[] = [];
  try {
    for (const name of readdirSync(dbDir)) {
      // `__manifest` is LanceDB's own bookkeeping directory, not a table (its
      // bytes are already part of the total) — only real tables are listed.
      if (name === "__manifest") continue;
      tables.push({ name: name.replace(/\.lance$/i, ""), bytes: sizeOf(path.join(dbDir, name), state) });
    }
  } catch {
    // No db/ directory (nothing indexed yet) — not an error.
  }

  return { root, rootExists: true, totalBytes: total, entries, tables, errors: state.errors };
}

// ---------------------------------------------------------------- collector

/**
 * The live state doctor needs, all injected. Every port must resolve (return a
 * degraded empty value) instead of throwing — a diagnostic must never turn its
 * own read failure into a crash; the daemon wires them from `IndexManager` +
 * `services/db` + `CONFIG`, tests pass fakes.
 */
export interface DoctorPorts {
  /** Registered projects (the daemon's registry). */
  indexes(): IndexRecord[];
  /** LanceDB table names. */
  tableNames(): Promise<string[]>;
  /** Schema columns of a table ([] when absent). */
  tableColumns(table: string): Promise<string[]>;
  /** Row count of a table (0 when absent). */
  rowCount(table: string): Promise<number>;
  /** Index metadata of a table ([] when absent). */
  tableIndices(table: string): Promise<TableIndexInfo[]>;
  /** Embedding-backend probe (provider + reachability + served model tags). */
  backend(): Promise<BackendProbeState>;
  /** The manager's cached reranker probe (`IndexManager.ensureRerankAvailable`). */
  rerankerAvailable(): Promise<boolean>;
  /** Resolved path of the global YAML config (null = defaults). */
  configPath(): string | null;
  /** Reads a file's text; null when absent/unreadable. */
  readText(filePath: string): Promise<string | null>;
  /** Measured sizes of the data root. */
  diskUsage(): DiskUsageState;
  /** The config values the verdicts depend on (already resolved by the daemon). */
  settings: {
    home: string;
    dbDir: string;
    embedModel: string;
    docstrings: boolean;
    vectorIndexThreshold: number;
    rerankEnabled: boolean;
    rerankModel: string;
  };
}

/**
 * Runs one read-only diagnostic pass: gathers state through `ports`, feeds the
 * pure checks, and returns the aggregated report.
 */
export async function runDoctor(ports: DoctorPorts): Promise<DoctorReport> {
  const { settings } = ports;
  const checks: DoctorCheck[] = [];

  // 2a/2b — the embedding backend + the reranker probe (network; the only awaited probes).
  const [backendState, rerankAvailable] = await Promise.all([ports.backend(), ports.rerankerAvailable()]);
  checks.push(backendCheck(backendState, settings.embedModel));
  checks.push(
    rerankerCheck({
      enabled: settings.rerankEnabled,
      model: settings.rerankModel,
      available: rerankAvailable,
    }),
  );

  const indexes = ports.indexes();
  const tables = await ports.tableNames();
  // The per-project model verdict needs the served-tags list; unknown (null)
  // when the backend is unreachable — the backend check already reports that.
  const modelProbe = backendState.up ? backendState.models : null;

  // 3 — one check per registered project.
  for (const rec of indexes) {
    const model = rec.embedModel ?? settings.embedModel;
    let exists = false;
    let columns: string[] = [];
    let rows = 0;
    let indices: TableIndexInfo[] = [];
    try {
      [columns, rows, indices] = await Promise.all([
        ports.tableColumns(rec.tableName),
        ports.rowCount(rec.tableName),
        ports.tableIndices(rec.tableName),
      ]);
      exists = columns.length > 0;
    } catch (err) {
      console.error(`[doctor] failed to inspect table '${rec.tableName}':`, err);
    }
    checks.push(
      projectCheck({
        name: rec.name,
        path: rec.path,
        tableName: rec.tableName,
        status: rec.status,
        error: rec.error,
        fileCount: rec.fileCount,
        chunkCount: rec.chunkCount,
        embedModel: rec.embedModel,
        tableExists: exists,
        tableRows: exists ? rows : null,
        columns,
        indices,
        modelOnBackend: modelProbe === null ? null : modelTagPresent(modelProbe, model),
        vectorIndexThreshold: settings.vectorIndexThreshold,
        docstringsEnabled: settings.docstrings,
      }),
    );
  }

  // 4 — orphan tables (registered rows without tables are the project check's fail).
  // `tableNameFor` is the authority on the served table (the O2 migration moves
  // the stored name); it falls back to the derived name for a bare record.
  checks.push(
    orphanTablesCheck({
      tables,
      registeredTables: indexes.map((r) => tableNameFor(r)),
      dbDir: settings.dbDir,
    }),
  );

  // 5 — config files (global YAML + one .cidx.json per project).
  const files: ConfigFileFinding[] = [];
  const cfgPath = ports.configPath();
  if (cfgPath !== null) {
    const yamlFinding = inspectConfigFile(cfgPath, "yaml", await ports.readText(cfgPath));
    if (yamlFinding) files.push(yamlFinding);
  }
  for (const rec of indexes) {
    const p = path.join(rec.path, PROJECT_CONFIG_FILE);
    const f = inspectConfigFile(p, "project", await ports.readText(p));
    if (f) files.push(f);
  }
  checks.push(configCheck({ configPath: cfgPath, files }));

  // 6 — disk usage.
  checks.push(diskCheck(ports.diskUsage()));

  return { status: aggregateStatus(checks), checks, home: settings.home };
}
