import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import express from "express";
import { CONFIG } from "../config";
import { hostGuard } from "./host-guard";
import { fileOutline } from "../chunking/chunker";
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
    res.json({ ok: true, version: "2.3.0", pid: process.pid });
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

  app.post("/shutdown", (_req, res) => {
    res.json({ stopping: true });
    setTimeout(() => void deps.onShutdown(), 50);
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
