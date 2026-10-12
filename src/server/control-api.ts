import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import express from "express";
import * as lancedb from "@lancedb/lancedb";
import { CONFIG, CONFIG_SOURCE } from "../config";
import { hostGuard } from "./host-guard";
import { fileOutline } from "../chunking/chunker";
import { measureDiskUsage, runDoctor, type DoctorPorts } from "../core/doctor";
import { countTableRows, listTables, tableColumns } from "../services/db";
import { probeOllama, resolveEmbedBackend } from "../services/embed";
import { probeLlamaServer } from "../services/llamacpp";
import type { JobQueue } from "../core/job-queue";
import { indexNotFoundMessage } from "../core/index-manager";
import type { IndexManager } from "../core/index-manager";
import type { IndexRecord, QueryLogStatsOpts } from "../core/registry";

export interface ControlDeps {
  manager: IndexManager;
  jobQueue: JobQueue;
  /** Shuts down the daemon gracefully (same path as SIGINT). */
  onShutdown: () => Promise<void> | void;
}

/** Presents an index record along with live job progress. */
function viewIndex(deps: ControlDeps, rec: IndexRecord) {
  const job = deps.manager.activeJob(rec.name);
  return {
    name: rec.name,
    path: rec.path,
    table: rec.tableName,
    status: rec.status,
    files: rec.fileCount,
    chunks: rec.chunkCount,
    lastIndexedAt: rec.lastIndexedAt,
    error: rec.error,
    job: job
      ? {
          id: job.id,
          status: job.status,
          processed: job.progress.processed,
          total: job.progress.total,
          percent:
            job.progress.total > 0
              ? Math.round((job.progress.processed / job.progress.total) * 100)
              : 0,
        }
      : null,
  };
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

  app.get("/ping", (_req, res) => {
    res.json({ ok: true, version: "2.5.0", pid: process.pid });
  });

  app.get("/indexes", (_req, res) => {
    res.json(deps.manager.listIndexes().map((r) => viewIndex(deps, r)));
  });

  app.get("/indexes/:name", (req, res) => {
    const rec = deps.manager.getIndex(req.params.name);
    if (!rec) {
      res
        .status(404)
        .json({ error: indexNotFoundMessage(req.params.name, deps.manager.listIndexes().map((r) => r.name)) });
      return;
    }
    res.json(viewIndex(deps, rec));
  });

  app.post("/index", (req, res) => {
    const { path: dir, name } = (req.body ?? {}) as { path?: string; name?: string };
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
      res.json(viewIndex(deps, rec));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/reindex", (req, res) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const rec = deps.manager.reindex(name);
      res.json(viewIndex(deps, rec));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/sync", (req, res) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const rec = deps.manager.syncIndex(name);
      res.json(viewIndex(deps, rec));
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
    };
    if (!query) {
      res.status(400).json({ error: "'query' is required" });
      return;
    }
    const opts = { mode, language, symbolType, pathGlob, contextLines, rerank, mmr, boost, maxChars, doc, blame };
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
    };
    if (!Array.isArray(queries) || queries.length === 0 || !queries.every((q) => typeof q === "string")) {
      res.status(400).json({ error: "'queries' must be a non-empty array of strings" });
      return;
    }
    const opts = { mode, language, symbolType, pathGlob, contextLines, rerank, mmr, boost, maxChars, doc, blame };
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
    // with neither, the single indexed project is summarized (else an error).
    const wanted = project ?? name;
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
    try {
      res.json(await deps.manager.checkDocs(opts));
    } catch (err) {
      // An unknown project name is a 404 (like /deadcode); anything else is a bad request.
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.startsWith("Index not found") || msg.startsWith("No indexed project") ? 404 : 400).json({ error: msg });
    }
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
