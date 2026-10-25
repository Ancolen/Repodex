import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import express from "express";
import * as lancedb from "@lancedb/lancedb";
import { CONFIG, CONFIG_SOURCE } from "../config";
import { hostGuard } from "./host-guard";
import { fileOutline } from "../chunking/chunker";
import { measureDiskUsage, runDoctor, type DoctorPorts } from "../core/doctor";
import { collectStats, compactBusyMessage, jobIsActive, type StatsPorts } from "../core/stats";
import { countTableRows, listTables, tableColumns, tableStats } from "../services/db";
import { probeOllama, resolveEmbedBackend } from "../services/embed";
import { probeLlamaServer } from "../services/llamacpp";
import type { JobQueue } from "../core/job-queue";
import { indexNotFoundMessage } from "../core/index-manager";
import type { IndexManager } from "../core/index-manager";
import type { BridgeSessionRegistry } from "../core/bridgesessions";
// A2 — the GET /events backing store and the shared index-serializer.
import type { DaemonEventRing } from "../core/events";
import { viewIndex } from "./resource-defs";
import { overviewPickOneNote, type OverviewPickOne } from "./format";
import type { IndexRecord, QueryLogStatsOpts } from "../core/registry";

export interface ControlDeps {
  manager: IndexManager;
  jobQueue: JobQueue;
  /** Shuts down the daemon gracefully (same path as SIGINT). */
  onShutdown: () => Promise<void> | void;
  /**
   * Bumps the idle-shutdown activity marker (proposal O4). Every request this
   * server handles counts as activity; undefined when the daemon has no idle
   * timeout armed (no behavior change).
   */
  onActivity?: () => void;
  /** Tracks live stdio-bridge MCP sessions (the idle guardrail). */
  bridgeSessions: BridgeSessionRegistry;
  /** A2 — the in-memory daemon event ring behind `GET /events`. */
  events: DaemonEventRing;
}

// -------------------------------------------------------------------- doctor

/**
 * Second, read-only LanceDB connection, used only for index metadata
 * (`Table.listIndices` — ANN/FTS presence). `services/db.ts` owns the daemon's
 * connection and exposes no index-metadata helper, and LanceDB is an embedded
 * store designed for concurrent readers, so a dedicated read-only handle is
 * safe. Cached: one extra connection per daemon process.
 */
let doctorDb: lancedb.Connection | null = null;
async function doctorConnection(): Promise<lancedb.Connection> {
  if (!doctorDb) doctorDb = await lancedb.connect(CONFIG.DB_DIR);
  return doctorDb;
}

/** Gathers the live state `runDoctor` reads — every port injectable, none throwing. */
function doctorPorts(deps: ControlDeps): DoctorPorts {
  return {
    indexes: () => deps.manager.listIndexes(),
    tableNames: () => listTables(),
    tableColumns: async (table) => [...(await tableColumns(table))],
    rowCount: (table) => countTableRows(table),
    tableIndices: async (table) => {
      const conn = await doctorConnection();
      const names = await conn.tableNames();
      if (!names.includes(table)) return [];
      const t = await conn.openTable(table);
      return (await t.listIndices()).map((ix) => ({ columns: ix.columns, indexType: ix.indexType }));
    },
    backend: async () => {
      try {
        const backend = await resolveEmbedBackend();
        const probe =
          backend.provider === "ollama"
            ? await probeOllama(backend.url)
            : await probeLlamaServer(backend.url);
        return {
          provider: backend.provider,
          url: backend.url,
          up: probe.up,
          models: probe.models,
        };
      } catch {
        // No backend resolved at all (nothing reachable under `auto`) — doctor
        // turns this into the actionable fail.
        return { provider: null, url: "", up: false, models: [] };
      }
    },
    // No probe happens when search.rerank.enabled=false (config-off = hard
    // off) — doctor then reports "disabled by config" without a backend call.
    rerankerAvailable: () => deps.manager.ensureRerankAvailable(),
    configPath: () => CONFIG_SOURCE,
    readText: async (filePath) => {
      try {
        return await readFile(filePath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[doctor] cannot read '${filePath}':`, err);
        }
        return null;
      }
    },
    diskUsage: () => measureDiskUsage(CONFIG.ROOT_DIR),
    settings: {
      home: CONFIG.ROOT_DIR,
      dbDir: CONFIG.DB_DIR,
      embedModel: CONFIG.OLLAMA_MODEL,
      docstrings: CONFIG.DOCSTRINGS,
      vectorIndexThreshold: CONFIG.VECTOR_INDEX_THRESHOLD,
      rerankEnabled: CONFIG.RERANK_ENABLED,
      rerankModel: CONFIG.RERANK_MODEL,
    },
  };
}

/**
 * Gathers the live state `collectStats` reads (proposal O3, the doctor's ports
 * pattern): registry rows + job state through the manager, the file/embedding
 * cache counts through its read-only pass-throughs, the data-root disk walk
 * reused 1:1 from the doctor, and the native per-table statistics.
 */
function statsPorts(deps: ControlDeps): StatsPorts {
  return {
    indexes: () => deps.manager.listIndexes(),
    activeJob: (name) => deps.manager.activeJob(name),
    fileCacheCount: (indexName) => deps.manager.fileCacheCount(indexName),
    embeddingCacheStats: () => deps.manager.embeddingCacheStats(),
    diskUsage: () => measureDiskUsage(CONFIG.ROOT_DIR),
    tableStats: (table) => tableStats(table),
  };
}

/**
 * The HTTP API the CLI client talks to. Bound ONLY to 127.0.0.1; not accessible
 * from outside (a local control channel for the user's own machine). The API is
 * unauthenticated, so it also validates the Host header (DNS-rebinding
 * protection) — a rebound hostname would otherwise reach it from the browser.
 */
export function startControlApi(
  deps: ControlDeps,
  port: number = CONFIG.CONTROL_PORT,
  host: string = CONFIG.HOST,
): Promise<void> {
  const app = express();
  app.use(hostGuard(host, port));
  app.use(express.json());
  // Idle shutdown (proposal O4): ANY request handled here counts as activity,
  // including /ping and /bridge-session traffic (the bridge's heartbeat keeps
  // an open MCP session alive — that is the guardrail, not noise).
  app.use((_req, _res, next) => {
    deps.onActivity?.();
    next();
  });

  app.get("/ping", (_req, res) => {
    res.json({ ok: true, version: "2.7.4", pid: process.pid });
  });

  app.get("/indexes", (_req, res) => {
    res.json(deps.manager.listIndexes().map((r) => viewIndex(deps.manager, r)));
  });

  app.get("/indexes/:name", (req, res) => {
    const rec = deps.manager.getIndex(req.params.name);
    if (!rec) {
      res
        .status(404)
        .json({ error: indexNotFoundMessage(req.params.name, deps.manager.listIndexes().map((r) => r.name)) });
      return;
    }
    res.json(viewIndex(deps.manager, rec));
  });

  app.post("/index", async (req, res) => {
    const { path: dir, name, wait } = (req.body ?? {}) as { path?: string; name?: string; wait?: boolean };
    if (!dir) {
      res.status(400).json({ error: "'path' is required" });
      return;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      res.status(400).json({ error: `Not a valid directory: ${dir}` });
      return;
    }
    try {
      const rec = deps.manager.createIndex(dir, name);
      // Duplicate-scope catch BEFORE the disk work happens: an overlapping
      // note is computed at start time and rides the response.
      const warningNote = deps.manager.pathOverlapWarning(rec.path);
      const settled = await deps.manager.waitForIndexSettle(rec.name, wait);
      const view = viewIndex(deps.manager, settled.rec);
      res.json({ ...view, ...(warningNote ? { warning: warningNote } : {}), ...(settled.timedOut ? { timedOut: true } : {}) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/reindex", async (req, res) => {
    const { name, wait } = (req.body ?? {}) as { name?: string; wait?: boolean };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const rec = deps.manager.reindex(name);
      const settled = await deps.manager.waitForIndexSettle(rec.name, wait);
      const view = viewIndex(deps.manager, settled.rec);
      res.json({ ...view, ...(settled.timedOut ? { timedOut: true } : {}) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/sync", async (req, res) => {
    const { name, project, path: projectPath, wait } = (req.body ?? {}) as {
      name?: string;
      project?: string;
      path?: string;
      wait?: boolean;
    };
    try {
      // `name` is the pre-existing CLI shape; `project`/`path` are the MCP tool's
      // anchor. Neither given → the single indexed project (or a self-healing
      // ambiguity error naming the projects).
      const scope = deps.manager.resolveProjectScope(project ?? name, projectPath, false)!;
      const rec = deps.manager.syncIndex(scope);
      const settled = await deps.manager.waitForIndexSettle(rec.name, wait);
      const view = viewIndex(deps.manager, settled.rec);
      res.json({ ...view, ...(settled.timedOut ? { timedOut: true } : {}) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/indexes/:name", async (req, res) => {
    const removed = await deps.manager.removeIndex(req.params.name);
    if (!removed) {
      res.status(404).json({ error: `Index not found: ${req.params.name}` });
      return;
    }
    res.json({ removed: true, name: req.params.name });
  });

  app.post("/search", async (req, res) => {
    const {
      query,
      project,
      path: projectPath,
      limit,
      mode,
      language,
      symbolType,
      pathGlob,
      contextLines,
      rerank,
      mmr,
      boost,
      maxChars,
      doc,
      blame,
      expand,
    } = (req.body ?? {}) as {
      query?: string;
      project?: string;
      path?: string;
      limit?: number;
      mode?: "hybrid" | "vector" | "text";
      language?: string;
      symbolType?: string;
      pathGlob?: string;
      contextLines?: number;
      rerank?: boolean;
      mmr?: boolean;
      boost?: boolean;
      maxChars?: number;
      doc?: boolean;
      blame?: boolean;
      expand?: boolean;
    };
    if (!query) {
      res.status(400).json({ error: "'query' is required" });
      return;
    }
    const opts = { mode, language, symbolType, pathGlob, contextLines, rerank, mmr, boost, maxChars, doc, blame, expand };
    try {
      // 'path' anchors the search to the project containing it; neither → all projects.
      const scope = deps.manager.resolveProjectScope(project, projectPath);
      const env = scope
        ? await deps.manager.searchIndex(scope, query, limit ?? 5, opts)
        : await deps.manager.searchAll(query, limit ?? 5, opts);
      res.json(env);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/search/batch", async (req, res) => {
    const {
      queries,
      project,
      path: projectPath,
      limit,
      mode,
      language,
      symbolType,
      pathGlob,
      contextLines,
      rerank,
      mmr,
      boost,
      maxChars,
      doc,
      blame,
      expand,
    } = (req.body ?? {}) as {
      queries?: unknown;
      project?: string;
      path?: string;
      limit?: number;
      mode?: "hybrid" | "vector" | "text";
      language?: string;
      symbolType?: string;
      pathGlob?: string;
      contextLines?: number;
      rerank?: boolean;
      mmr?: boolean;
      boost?: boolean;
      maxChars?: number;
      doc?: boolean;
      blame?: boolean;
      expand?: boolean;
    };
    if (!Array.isArray(queries) || queries.length === 0 || !queries.every((q) => typeof q === "string")) {
      res.status(400).json({ error: "'queries' must be a non-empty array of strings" });
      return;
    }
    const opts = { mode, language, symbolType, pathGlob, contextLines, rerank, mmr, boost, maxChars, doc, blame, expand };
    try {
      const scope = deps.manager.resolveProjectScope(project, projectPath);
      const groups = await deps.manager.searchBatch(queries as string[], scope, limit ?? 5, opts);
      res.json(groups);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/pack", async (req, res) => {
    const { query, project, path: projectPath, limit, maxChars, contextLines, language, symbolType, pathGlob } = (req.body ?? {}) as {
      query?: string;
      project?: string;
      path?: string;
      limit?: number;
      maxChars?: number;
      contextLines?: number;
      language?: string;
      symbolType?: string;
      pathGlob?: string;
    };
    if (!query) {
      res.status(400).json({ error: "'query' is required" });
      return;
    }
    const opts: {
      limit?: number;
      maxChars?: number;
      contextLines?: number;
      language?: string;
      symbolType?: string;
      pathGlob?: string;
    } = {};
    if (typeof limit === "number") opts.limit = limit;
    if (typeof maxChars === "number") opts.maxChars = maxChars;
    if (typeof contextLines === "number") opts.contextLines = contextLines;
    if (typeof language === "string") opts.language = language;
    if (typeof symbolType === "string") opts.symbolType = symbolType;
    if (typeof pathGlob === "string") opts.pathGlob = pathGlob;
    try {
      const scope = deps.manager.resolveProjectScope(project, projectPath);
      const pack = await deps.manager.getContextPack(query, scope, opts);
      res.json(pack);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/find", async (req, res) => {
    const { name, project, path: projectPath, limit, fuzzy, language, symbolType } = (req.body ?? {}) as {
      name?: string;
      project?: string;
      path?: string;
      limit?: number;
      fuzzy?: boolean;
      language?: string;
      symbolType?: string;
    };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const scope = deps.manager.resolveProjectScope(project, projectPath);
      const results = await deps.manager.findSymbol(name, scope, limit ?? 20, {
        language,
        symbolType,
      }, { fuzzy });
      res.json(results);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/outline", async (req, res) => {
    const { path: filePath } = (req.body ?? {}) as { path?: string };
    if (!filePath) {
      res.status(400).json({ error: "'path' is required" });
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.status(400).json({ error: `File not found: ${filePath}` });
      return;
    }
    try {
      const content = await readFile(filePath, "utf-8");
      const outline = await fileOutline(filePath, content);
      res.json(outline);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/references", async (req, res) => {
    const { name, project, path: projectPath, limit, language, symbolType, includeDocs } = (req.body ?? {}) as {
      name?: string;
      project?: string;
      path?: string;
      limit?: number;
      language?: string;
      symbolType?: string;
      includeDocs?: boolean;
    };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const scope = deps.manager.resolveProjectScope(project, projectPath);
      const results = await deps.manager.findReferences(name, scope, limit ?? 50, {
        language,
        symbolType,
        includeDocs: typeof includeDocs === "boolean" ? includeDocs : undefined,
      });
      res.json(results);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/overview", async (req, res) => {
    const { name, project, path: projectPath } = (req.body ?? {}) as {
      name?: string;
      project?: string;
      path?: string;
    };
    // 'name' (legacy CLI shape) and 'project' (the MCP tool's arg) are synonyms;
    // with neither, the single indexed project is summarized — but when several
    // are indexed, answer with the graceful pick-one payload (a 200 describing
    // the choices) instead of a self-healing 404: agents lose a round-trip on
    // the error and re-issue the identical call.
    const wanted = project ?? name;
    if (!wanted && !projectPath && deps.manager.listIndexes().length > 1) {
      const views = deps.manager.listIndexes().map((r) => viewIndex(deps.manager, r));
      res.json({ pickOne: true, note: overviewPickOneNote(views) } satisfies OverviewPickOne);
      return;
    }
    try {
      const scope = deps.manager.resolveProjectScope(wanted, projectPath, false)!;
      const overview = await deps.manager.repoOverview(scope);
      res.json(overview);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/dependencies", async (req, res) => {
    const { path: filePath, project, limit } = (req.body ?? {}) as {
      path?: string;
      project?: string;
      limit?: number;
    };
    if (!filePath) {
      res.status(400).json({ error: "'path' is required" });
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.status(400).json({ error: `File not found: ${filePath}` });
      return;
    }
    const opts = typeof limit === "number" ? { limit } : undefined;
    try {
      const result = await deps.manager.getDependencies(filePath, project, opts);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/callgraph", async (req, res) => {
    const { symbol, path: filePath, project, direction, depth, limit } = (req.body ?? {}) as {
      symbol?: string;
      path?: string;
      project?: string;
      direction?: "callers" | "callees" | "both";
      depth?: number;
      limit?: number;
    };
    if (!symbol && !filePath) {
      res.status(400).json({ error: "Provide a 'symbol' name and/or a 'path' (at least one is required)." });
      return;
    }
    if (filePath && (!existsSync(filePath) || !statSync(filePath).isFile())) {
      res.status(400).json({ error: `File not found: ${filePath}` });
      return;
    }
    const opts: {
      symbol?: string;
      path?: string;
      project?: string;
      direction?: "callers" | "callees" | "both";
      depth?: number;
      limit?: number;
    } = {};
    if (typeof symbol === "string") opts.symbol = symbol;
    if (typeof filePath === "string") opts.path = filePath;
    if (typeof project === "string") opts.project = project;
    if (direction === "callers" || direction === "callees" || direction === "both") opts.direction = direction;
    if (typeof depth === "number") opts.depth = depth;
    if (typeof limit === "number") opts.limit = limit;
    try {
      const result = await deps.manager.getCallGraph(opts);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/commits", async (req, res) => {
    const { project, query, path: filePath, author, since, until, withFiles, limit } = (req.body ?? {}) as {
      project?: string;
      query?: string;
      path?: string;
      author?: string;
      since?: string;
      until?: string;
      withFiles?: boolean;
      limit?: number;
    };
    const opts: {
      query?: string;
      path?: string;
      author?: string;
      since?: string;
      until?: string;
      withFiles?: boolean;
      limit?: number;
    } = {};
    if (typeof query === "string") opts.query = query;
    if (typeof filePath === "string") opts.path = filePath;
    if (typeof author === "string") opts.author = author;
    if (typeof since === "string") opts.since = since;
    if (typeof until === "string") opts.until = until;
    if (typeof withFiles === "boolean") opts.withFiles = withFiles;
    if (typeof limit === "number") opts.limit = limit;
    try {
      // NOTE: 'path' is the file-history filter — no project anchor by path here.
      // Omitted project → the single indexed project, or an error naming them all.
      const scope = deps.manager.resolveProjectScope(project, undefined, false)!;
      const result = await deps.manager.searchCommits(scope, opts);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/deadcode", async (req, res) => {
    const { project, path: projectPath, language, symbolType, minConfidence, limit } = (req.body ?? {}) as {
      project?: string;
      path?: string;
      language?: string;
      symbolType?: string;
      minConfidence?: number;
      limit?: number;
    };
    const opts: {
      language?: string;
      symbolType?: string;
      minConfidence?: number;
      limit?: number;
    } = {};
    if (typeof language === "string") opts.language = language;
    if (typeof symbolType === "string") opts.symbolType = symbolType;
    if (typeof minConfidence === "number") opts.minConfidence = minConfidence;
    if (typeof limit === "number") opts.limit = limit;
    try {
      // Neither given → the single indexed project, or an error naming them all.
      const scope = deps.manager.resolveProjectScope(project, projectPath, false)!;
      const report = await deps.manager.findDeadCode(scope, opts);
      res.json(report);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---------------------------------------------------- API diff (proposal C2)

  /** Public-API diff between two git refs of an indexed project (`cidx apidiff`). */
  app.post("/apidiff", async (req, res) => {
    const { project, path: projectPath, base, head, limit, maxFiles, exportedOnly, includeUnchanged } = (req.body ?? {}) as {
      project?: string;
      path?: string;
      base?: string;
      head?: string;
      limit?: number;
      maxFiles?: number;
      exportedOnly?: boolean;
      includeUnchanged?: boolean;
    };
    if (!base) {
      res.status(400).json({ error: "'base' is required (the 'before' git ref)." });
      return;
    }
    const opts: {
      head?: string;
      limit?: number;
      maxFiles?: number;
      exportedOnly?: boolean;
      includeUnchanged?: boolean;
    } = {};
    if (typeof head === "string") opts.head = head;
    if (typeof limit === "number") opts.limit = limit;
    if (typeof maxFiles === "number") opts.maxFiles = maxFiles;
    if (typeof exportedOnly === "boolean") opts.exportedOnly = exportedOnly;
    if (typeof includeUnchanged === "boolean") opts.includeUnchanged = includeUnchanged;
    try {
      // Neither given → the single indexed project, or an error naming them all.
      const scope = deps.manager.resolveProjectScope(project, projectPath, false)!;
      res.json(await deps.manager.getApiDiff(scope, base, opts));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/impact", async (req, res) => {
    const { symbol, path: filePath, project, depth, limit } = (req.body ?? {}) as {
      symbol?: string;
      path?: string;
      project?: string;
      depth?: number;
      limit?: number;
    };
    if (!symbol && !filePath) {
      res.status(400).json({ error: "Provide a 'symbol' name and/or a 'path' (at least one is required)." });
      return;
    }
    if (filePath && (!existsSync(filePath) || !statSync(filePath).isFile())) {
      res.status(400).json({ error: `File not found: ${filePath}` });
      return;
    }
    const opts: { symbol?: string; path?: string; project?: string; depth?: number; limit?: number } = {};
    if (typeof symbol === "string") opts.symbol = symbol;
    if (typeof filePath === "string") opts.path = filePath;
    if (typeof project === "string") opts.project = project;
    if (typeof depth === "number") opts.depth = depth;
    if (typeof limit === "number") opts.limit = limit;
    try {
      const result = await deps.manager.getChangeImpact(opts);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Doc–code conformance check — deterministic, no Ollama (`cidx doccheck`). */
  app.post("/doccheck", async (req, res) => {
    const {
      project,
      path: filePath,
      files,
      ignore,
      limit,
      maxChars,
      undocumentedLimit,
      noUndocumented,
      since,
      window,
      judge,
    } = (req.body ?? {}) as {
      project?: string;
      path?: string;
      files?: string[];
      ignore?: string[];
      limit?: number;
      maxChars?: number;
      undocumentedLimit?: number;
      noUndocumented?: boolean;
      since?: string;
      window?: boolean;
      judge?: boolean;
    };
    if (!project && !filePath) {
      res.status(400).json({ error: "Provide a 'project' name and/or a 'path' (at least one is required)." });
      return;
    }
    const opts: {
      project?: string;
      path?: string;
      files?: string[];
      ignore?: string[];
      limit?: number;
      maxChars?: number;
      undocumentedLimit?: number;
      noUndocumented?: boolean;
      since?: string;
      window?: boolean;
      judge?: boolean;
    } = {};
    if (typeof project === "string") opts.project = project;
    if (typeof filePath === "string") opts.path = filePath;
    if (Array.isArray(files)) opts.files = files.filter((f): f is string => typeof f === "string");
    if (Array.isArray(ignore)) opts.ignore = ignore.filter((f): f is string => typeof f === "string");
    if (typeof limit === "number") opts.limit = limit;
    if (typeof maxChars === "number") opts.maxChars = maxChars;
    if (typeof undocumentedLimit === "number") opts.undocumentedLimit = undocumentedLimit;
    if (typeof noUndocumented === "boolean") opts.noUndocumented = noUndocumented;
    if (typeof since === "string") opts.since = since;
    if (typeof window === "boolean") opts.window = window;
    if (typeof judge === "boolean") opts.judge = judge;
    try {
      res.json(await deps.manager.checkDocs(opts));
    } catch (err) {
      // An unknown project name is a 404 (like /deadcode); anything else is a bad request.
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.startsWith("Index not found") || msg.startsWith("No indexed project") ? 404 : 400).json({ error: msg });
    }
  });

  /**
   * The STORED latest doc-check report per project (D1c watch mode, `cidx
   * doccheck --last`): the snapshot the `doccheck` job last wrote after a
   * successful index/sync/migrate run. A SNAPSHOT — its `ts` says when it was
   * stored, and the caller must surface that; this route never runs a fresh
   * check (that is POST /doccheck). Query params: `project` or `path` (at
   * least one — the same anchor rule as POST /doccheck). Unknown project →
   * self-healing 404; a known project without a stored report → 404 with the
   * "enable doccheck.watch / run doccheck first" hint.
   */
  app.get("/doccheck/last", async (req, res) => {
    const project = typeof req.query.project === "string" ? req.query.project : undefined;
    const filePath = typeof req.query.path === "string" ? req.query.path : undefined;
    if (!project && !filePath) {
      res.status(400).json({ error: "Provide a 'project' name and/or a 'path' (at least one is required)." });
      return;
    }
    const opts: { project?: string; path?: string } = {};
    if (project) opts.project = project;
    if (filePath) opts.path = filePath;
    try {
      const found = await deps.manager.lastDocCheckReport(opts);
      if (!found) {
        res.status(404).json({
          error: `No stored doccheck report for '${opts.project ?? opts.path}' — enable doccheck.watch or run a doccheck job first (fresh check: POST /doccheck).`,
        });
        return;
      }
      res.json(found);
    } catch (err) {
      // An unknown project name is a 404 (like POST /doccheck); anything else is a bad request.
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.startsWith("Index not found") || msg.startsWith("No indexed project") ? 404 : 400).json({ error: msg });
    }
  });

  /** Project-level coupling metrics over the dependency graph (`cidx coupling`). */
  app.post("/coupling", async (req, res) => {
    const { project, path: projectPath, limit } = (req.body ?? {}) as {
      project?: string;
      path?: string;
      limit?: number;
    };
    try {
      // Resolution happens in the engine: explicit project → path anchor → the
      // single indexed project, or an error naming the available ones.
      const limitArg = typeof limit === "number" ? limit : undefined;
      res.json(await deps.manager.getCoupling(project, projectPath, limitArg));
    } catch (err) {
      // An unknown project / ambiguous anchor is a 404 (like /deadcode); anything else is a bad request.
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.startsWith("Index not found") || msg.startsWith("No indexed project") ? 404 : 400).json({ error: msg });
    }
  });

  /** Hotspot / technical-debt report (`cidx hotspots`, proposal C3). */
  app.post("/hotspots", async (req, res) => {
    const { project, path: projectPath, since, limit } = (req.body ?? {}) as {
      project?: string;
      path?: string;
      since?: string;
      limit?: number;
    };
    try {
      // Resolution happens in the engine (same anchor chain as /coupling).
      const opts: { since?: string; limit?: number } = {};
      if (typeof since === "string") opts.since = since;
      if (typeof limit === "number") opts.limit = limit;
      res.json(await deps.manager.getHotspots(project, projectPath, opts));
    } catch (err) {
      // An unknown project / ambiguous anchor is a 404 (like /deadcode); anything else is a bad request.
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.startsWith("Index not found") || msg.startsWith("No indexed project") ? 404 : 400).json({ error: msg });
    }
  });

  // ------------------------------------------------- bridge sessions (O4)

  /**
   * The stdio bridge (`cidx mcp`) registers itself here so an OPEN MCP session
   * counts as activity for the idle shutdown: registrations, heartbeats and
   * unregisters keep `openBridgeSessions` above zero. The wire shape built by
   * `src/core/bridgesessions.ts → *SessionRequest` must stay in sync.
   */
  app.post("/bridge-session", (_req, res) => {
    const sessionId = deps.bridgeSessions.register(Date.now());
    res.json({ sessionId });
  });

  /** Heartbeat/touch: 404 sends the bridge back to /bridge-session (re-register). */
  app.post("/bridge-session/:id", (req, res) => {
    if (!deps.bridgeSessions.touch(req.params.id, Date.now())) {
      res.status(404).json({ error: "Unknown or expired bridge session" });
      return;
    }
    res.json({ ok: true });
  });

  // Idempotent: an unregister for a session that is already gone (daemon
  // restart, TTL expiry) is not an error — the bridge is just cleaning up.
  app.delete("/bridge-session/:id", (req, res) => {
    const removed = deps.bridgeSessions.remove(req.params.id);
    res.json({ removed });
  });

  // ------------------------------------------------- event stream (A2)

  /**
   * The daemon's in-memory event ring, paged by the stdio bridge (proposal A2):
   * `GET /events?since=<id>` → `{ events: [{ id, type, project?, jobType?,
   * status?, ts }], lastId }`. Ids are monotonic (a process-local counter) and
   * the ring only replays what it still holds — in-memory only, so a daemon
   * restart resets the sequence and a poller re-syncs from 0
   * (`src/core/events.ts → nextEventCursor`). A malformed/negative `since`
   * degrades to 0 (the full retained tail), never a 400: this is polled every
   * few seconds and must not fail noisily.
   */
  app.get("/events", (req, res) => {
    const raw = typeof req.query.since === "string" ? Number(req.query.since) : NaN;
    const since = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    res.json(deps.events.since(since));
  });

  app.post("/shutdown", (_req, res) => {
    res.json({ stopping: true });
    setTimeout(() => void deps.onShutdown(), 50);
  });

  // ------------------------------------------------------------------ doctor

  /**
   * Read-only diagnostic pass for `cidx doctor` (proposal O1): Ollama + the
   * reranker probe, per-project table/schema/index/cache checks, orphan tables,
   * config-file validity, and data-root disk usage. Never mutates anything.
   */
  app.get("/doctor", async (_req, res) => {
    try {
      res.json(await runDoctor(doctorPorts(deps)));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ------------------------------------------------- query log (proposal A3)

  /**
   * Search-analytics stats (proposal A3) over the daemon's local query log —
   * what `cidx stats` renders. Query params: `project` (optional; an unknown
   * name is a self-healing 404, an absent one aggregates all projects),
   * `topQueries` and `zeroHitTop` (section caps). Cross-project searches are
   * logged with a null project and count toward the global stats only.
   */
  app.get("/querylog", (req, res) => {
    const opts: QueryLogStatsOpts = {};
    const project = req.query.project;
    if (typeof project === "string" && project.length > 0) {
      if (!deps.manager.listIndexes().some((r) => r.name === project)) {
        res
          .status(404)
          .json({ error: indexNotFoundMessage(project, deps.manager.listIndexes().map((r) => r.name)) });
        return;
      }
      opts.project = project;
    }
    const top = typeof req.query.topQueries === "string" ? Number(req.query.topQueries) : NaN;
    if (Number.isFinite(top) && top > 0) opts.topQueries = Math.floor(top);
    const zero = typeof req.query.zeroHitTop === "string" ? Number(req.query.zeroHitTop) : NaN;
    if (Number.isFinite(zero) && zero > 0) opts.zeroHitTop = Math.floor(zero);
    try {
      res.json(Object.keys(opts).length > 0 ? deps.manager.queryLogStats(opts) : deps.manager.queryLogStats());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ----------------------------------------- table stats / compact (O3)

  /**
   * Table/disk stats for `cidx stats` (proposal O3): per-project registry row
   * count, file-cache count, measured table size, ANN/FTS index presence +
   * native coverage, lastIndexedAt and the pending job — plus the global data
   * root (total, per-table sizes, meta.db, embedding cache). Pure read; every
   * unknown stays null with a note, never an invented zero. Query param
   * `project` (optional; an unknown name is a self-healing 404) narrows the
   * per-project list — the global picture is always included.
   */
  app.get("/stats", async (req, res) => {
    const opts: { project?: string } = {};
    const project = req.query.project;
    if (typeof project === "string" && project.length > 0) {
      if (!deps.manager.listIndexes().some((r) => r.name === project)) {
        res
          .status(404)
          .json({ error: indexNotFoundMessage(project, deps.manager.listIndexes().map((r) => r.name)) });
        return;
      }
      opts.project = project;
    }
    try {
      res.json(await collectStats(statsPorts(deps), opts));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Table maintenance (O3): compact + optimize a project's table with the
   * NATIVE LanceDB `optimize` inside the per-table write lock. Refused with a
   * 409 while a queued/running index/sync/migrate job holds the table (the
   * rule `IndexManager.compactIndex` re-checks — the status code is the
   * handler's job); refused with a 404 for unknown projects.
   */
  app.post("/compact", async (req, res) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    if (!deps.manager.getIndex(name)) {
      res
        .status(404)
        .json({ error: indexNotFoundMessage(name, deps.manager.listIndexes().map((r) => r.name)) });
      return;
    }
    const job = deps.manager.activeJob(name);
    if (jobIsActive(job)) {
      res.status(409).json({ error: compactBusyMessage(name, { type: job.type, status: job.status }) });
      return;
    }
    try {
      res.json(await deps.manager.compactIndex(name));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.error(`[control] Control API listening: http://${host}:${port}`);
      resolve();
    });
    // Fail loudly (the daemon exits with a clear message) instead of silently
    // logging "ready" while another daemon instance owns the port.
    server.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        err.message = `port ${port} is already in use — is another daemon running? (cidx stop first, or change controlPort)`;
      }
      reject(err);
    });
  });
}
