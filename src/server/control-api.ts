import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import express from "express";
import * as lancedb from "@lancedb/lancedb";
import { CONFIG, CONFIG_SOURCE } from "../config";
import { hostGuard } from "./host-guard";
import { fileOutline } from "../chunking/chunker";
import { measureDiskUsage, runDoctor, type DoctorPorts } from "../core/doctor";
import { countTableRows, listTables, tableColumns } from "../services/db";
import type { JobQueue } from "../core/job-queue";
import type { IndexManager } from "../core/index-manager";
import type { IndexRecord } from "../core/registry";

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
    ollama: async () => {
      try {
        const r = await fetch(`${CONFIG.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return { reachable: true, models: [] };
        const data = (await r.json()) as { models?: { name?: string }[] };
        return {
          reachable: true,
          models: (data.models ?? [])
            .map((m) => m.name ?? "")
            .filter((n) => n.length > 0),
        };
      } catch {
        return { reachable: false, models: [] };
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
      ollamaUrl: CONFIG.OLLAMA_URL,
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
    res.json({ ok: true, version: "2.4.0", pid: process.pid });
  });

  app.get("/indexes", (_req, res) => {
    res.json(deps.manager.listIndexes().map((r) => viewIndex(deps, r)));
  });

  app.get("/indexes/:name", (req, res) => {
    const rec = deps.manager.getIndex(req.params.name);
    if (!rec) {
      res.status(404).json({ error: `Index not found: ${req.params.name}` });
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
      limit,
      mode,
      language,
      symbolType,
      pathGlob,
      contextLines,
      rerank,
      mmr,
      maxChars,
      doc,
    } = (req.body ?? {}) as {
      query?: string;
      project?: string;
      limit?: number;
      mode?: "hybrid" | "vector" | "text";
      language?: string;
      symbolType?: string;
      pathGlob?: string;
      contextLines?: number;
      rerank?: boolean;
      mmr?: boolean;
      maxChars?: number;
      doc?: boolean;
    };
    if (!query) {
      res.status(400).json({ error: "'query' is required" });
      return;
    }
    const opts = { mode, language, symbolType, pathGlob, contextLines, rerank, mmr, maxChars, doc };
    try {
      const results = project
        ? await deps.manager.searchIndex(project, query, limit ?? 5, opts)
        : await deps.manager.searchAll(query, limit ?? 5, opts);
      res.json(results);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/search/batch", async (req, res) => {
    const {
      queries,
      project,
      limit,
      mode,
      language,
      symbolType,
      pathGlob,
      contextLines,
      rerank,
      mmr,
      maxChars,
      doc,
    } = (req.body ?? {}) as {
      queries?: unknown;
      project?: string;
      limit?: number;
      mode?: "hybrid" | "vector" | "text";
      language?: string;
      symbolType?: string;
      pathGlob?: string;
      contextLines?: number;
      rerank?: boolean;
      mmr?: boolean;
      maxChars?: number;
      doc?: boolean;
    };
    if (!Array.isArray(queries) || queries.length === 0 || !queries.every((q) => typeof q === "string")) {
      res.status(400).json({ error: "'queries' must be a non-empty array of strings" });
      return;
    }
    const opts = { mode, language, symbolType, pathGlob, contextLines, rerank, mmr, maxChars, doc };
    try {
      const groups = await deps.manager.searchBatch(queries as string[], project, limit ?? 5, opts);
      res.json(groups);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/pack", async (req, res) => {
    const { query, project, limit, maxChars, contextLines } = (req.body ?? {}) as {
      query?: string;
      project?: string;
      limit?: number;
      maxChars?: number;
      contextLines?: number;
    };
    if (!query) {
      res.status(400).json({ error: "'query' is required" });
      return;
    }
    const opts: { limit?: number; maxChars?: number; contextLines?: number } = {};
    if (typeof limit === "number") opts.limit = limit;
    if (typeof maxChars === "number") opts.maxChars = maxChars;
    if (typeof contextLines === "number") opts.contextLines = contextLines;
    try {
      const pack = await deps.manager.getContextPack(query, project, opts);
      res.json(pack);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/find", async (req, res) => {
    const { name, project, limit, language, symbolType } = (req.body ?? {}) as {
      name?: string;
      project?: string;
      limit?: number;
      language?: string;
      symbolType?: string;
    };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const results = await deps.manager.findSymbol(name, project, limit ?? 20, {
        language,
        symbolType,
      });
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
    const { name, project, limit, language, symbolType } = (req.body ?? {}) as {
      name?: string;
      project?: string;
      limit?: number;
      language?: string;
      symbolType?: string;
    };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const results = await deps.manager.findReferences(name, project, limit ?? 50, {
        language,
        symbolType,
      });
      res.json(results);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/overview", async (req, res) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (!name) {
      res.status(400).json({ error: "'name' is required" });
      return;
    }
    try {
      const overview = await deps.manager.repoOverview(name);
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
    if (!project) {
      res.status(400).json({ error: "'project' is required." });
      return;
    }
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
      const result = await deps.manager.searchCommits(project, opts);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/deadcode", async (req, res) => {
    const { project, language, symbolType, minConfidence, limit } = (req.body ?? {}) as {
      project?: string;
      language?: string;
      symbolType?: string;
      minConfidence?: number;
      limit?: number;
    };
    if (!project) {
      res.status(400).json({ error: "'project' is required" });
      return;
    }
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
      const report = await deps.manager.findDeadCode(project, opts);
      res.json(report);
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
