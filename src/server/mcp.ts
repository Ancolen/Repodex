import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "../config";
import { hostGuard } from "./host-guard";
import { fileOutline } from "../chunking/chunker";
import { TOOL_DEFINITIONS } from "./tool-defs";
import {
  formatResults,
  formatBatchResults,
  formatOutline,
  formatReferences,
  formatOverview,
  formatDependencies,
  formatDeadCode,
  formatCallGraph,
  formatCommits,
} from "./format";
import type { JobQueue } from "../core/job-queue";
import type { IndexManager } from "../core/index-manager";

/** The dependencies the MCP server needs (decoupled). */
export interface McpDeps {
  jobQueue: JobQueue;
  manager: IndexManager;
}

/** Builds a configured MCP Server instance for each connection. */
function buildServer(deps: McpDeps): Server {
  const server = new Server(
    { name: "cidx", version: "2.4.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;

    if (name === "search_codebase") {
      const args = rawArgs as {
        query: string;
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
      const limit = args.limit ?? 5;
      const opts = {
        mode: args.mode,
        language: args.language,
        symbolType: args.symbolType,
        pathGlob: args.pathGlob,
        contextLines: args.contextLines,
        rerank: args.rerank,
        mmr: args.mmr,
        maxChars: args.maxChars,
        doc: args.doc,
      };
      try {
        const results = args.project
          ? await deps.manager.searchIndex(args.project, args.query, limit, opts)
          : await deps.manager.searchAll(args.query, limit, opts);
        return { content: [{ type: "text", text: formatResults(results) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Search error: ${msg}` }], isError: true };
      }
    }

    if (name === "search_codebase_batch") {
      const args = rawArgs as {
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
      if (!Array.isArray(args.queries) || args.queries.length === 0) {
        return {
          content: [{ type: "text", text: "Search error: 'queries' must be a non-empty array of strings." }],
          isError: true,
        };
      }
      const limit = args.limit ?? 5;
      const opts = {
        mode: args.mode,
        language: args.language,
        symbolType: args.symbolType,
        pathGlob: args.pathGlob,
        contextLines: args.contextLines,
        rerank: args.rerank,
        mmr: args.mmr,
        maxChars: args.maxChars,
        doc: args.doc,
      };
      try {
        const groups = await deps.manager.searchBatch(
          args.queries as string[],
          args.project,
          limit,
          opts,
        );
        return { content: [{ type: "text", text: formatBatchResults(groups) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Search error: ${msg}` }], isError: true };
      }
    }

    if (name === "find_symbol") {
      const args = rawArgs as {
        name: string;
        project?: string;
        limit?: number;
        language?: string;
        symbolType?: string;
      };
      if (!args.name) {
        return { content: [{ type: "text", text: "'name' is required." }], isError: true };
      }
      try {
        const results = await deps.manager.findSymbol(args.name, args.project, args.limit ?? 20, {
          language: args.language,
          symbolType: args.symbolType,
        });
        return { content: [{ type: "text", text: formatResults(results) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Symbol search error: ${msg}` }], isError: true };
      }
    }

    if (name === "list_indexes") {
      const indexes = deps.manager.listIndexes();
      if (indexes.length === 0) {
        return { content: [{ type: "text", text: "No projects indexed yet." }] };
      }
      const text = indexes
        .map(
          (ix) =>
            `• ${ix.name} [${ix.status}] — ${ix.path}\n  ${ix.fileCount} files, ${ix.chunkCount} chunks${ix.error ? `\n  error: ${ix.error}` : ""}`,
        )
        .join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (name === "get_index_status") {
      const args = rawArgs as { project?: string };
      const fmt = (ixName: string): string | null => {
        const ix = deps.manager.getIndex(ixName);
        if (!ix) return null;
        const job = deps.manager.activeJob(ixName);
        const prog =
          job && job.progress.total > 0
            ? ` — %${Math.round((job.progress.processed / job.progress.total) * 100)} (${job.progress.processed}/${job.progress.total})`
            : "";
        return `${ix.name} [${ix.status}]${prog}\n  ${ix.fileCount} files, ${ix.chunkCount} chunks, model: ${ix.embedModel ?? "—"}${ix.error ? `\n  error: ${ix.error}` : ""}`;
      };
      if (args.project) {
        const text = fmt(args.project);
        return text
          ? { content: [{ type: "text", text }] }
          : { content: [{ type: "text", text: `Index not found: ${args.project}` }], isError: true };
      }
      const all = deps.manager.listIndexes();
      const text = all.length
        ? all.map((ix) => fmt(ix.name)).filter(Boolean).join("\n")
        : "No projects indexed yet.";
      return { content: [{ type: "text", text }] };
    }

    if (name === "index_project") {
      const args = rawArgs as { path: string; name?: string };
      if (!args.path) {
        return { content: [{ type: "text", text: "'path' is required." }], isError: true };
      }
      if (!existsSync(args.path) || !statSync(args.path).isDirectory()) {
        return {
          content: [{ type: "text", text: `Not a valid directory: ${args.path}` }],
          isError: true,
        };
      }
      try {
        const ix = deps.manager.createIndex(args.path, args.name);
        return {
          content: [
            {
              type: "text",
              text: `Indexing started (in the background): '${ix.name}' [${ix.status}] → ${ix.path}\nFor progress: get_index_status("${ix.name}").`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to start indexing: ${msg}` }], isError: true };
      }
    }

    if (name === "get_file_outline") {
      const args = rawArgs as { path: string };
      if (!args.path || !existsSync(args.path) || !statSync(args.path).isFile()) {
        return { content: [{ type: "text", text: `File not found: ${args.path}` }], isError: true };
      }
      try {
        const content = await readFile(args.path, "utf-8");
        const outline = await fileOutline(args.path, content);
        return { content: [{ type: "text", text: formatOutline(outline) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to read file: ${msg}` }], isError: true };
      }
    }

    if (name === "find_references") {
      const args = rawArgs as {
        name: string;
        project?: string;
        limit?: number;
        language?: string;
        symbolType?: string;
      };
      if (!args.name) {
        return { content: [{ type: "text", text: "'name' is required." }], isError: true };
      }
      try {
        const refs = await deps.manager.findReferences(args.name, args.project, args.limit ?? 50, {
          language: args.language,
          symbolType: args.symbolType,
        });
        return { content: [{ type: "text", text: formatReferences(refs) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Reference search error: ${msg}` }], isError: true };
      }
    }

    if (name === "get_repo_overview") {
      const args = rawArgs as { project: string };
      if (!args.project) {
        return { content: [{ type: "text", text: "'project' is required." }], isError: true };
      }
      try {
        const overview = await deps.manager.repoOverview(args.project);
        return { content: [{ type: "text", text: formatOverview(overview) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Overview error: ${msg}` }], isError: true };
      }
    }

    if (name === "get_dependencies") {
      const args = rawArgs as { path: string; project?: string; limit?: number };
      if (!args.path) {
        return { content: [{ type: "text", text: "'path' is required." }], isError: true };
      }
      try {
        const opts = typeof args.limit === "number" ? { limit: args.limit } : undefined;
        const dep = await deps.manager.getDependencies(args.path, args.project, opts);
        return { content: [{ type: "text", text: formatDependencies(dep) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Dependency error: ${msg}` }], isError: true };
      }
    }

    if (name === "get_call_graph") {
      const args = rawArgs as {
        symbol?: string;
        path?: string;
        project?: string;
        direction?: "callers" | "callees" | "both";
        depth?: number;
        limit?: number;
      };
      if (!args.symbol && !args.path) {
        return {
          content: [{ type: "text", text: "Provide a 'symbol' name and/or a 'path' (at least one is required)." }],
          isError: true,
        };
      }
      try {
        const opts: {
          symbol?: string;
          path?: string;
          project?: string;
          direction?: "callers" | "callees" | "both";
          depth?: number;
          limit?: number;
        } = {};
        if (typeof args.symbol === "string") opts.symbol = args.symbol;
        if (typeof args.path === "string") opts.path = args.path;
        if (typeof args.project === "string") opts.project = args.project;
        if (args.direction === "callers" || args.direction === "callees" || args.direction === "both") {
          opts.direction = args.direction;
        }
        if (typeof args.depth === "number") opts.depth = args.depth;
        if (typeof args.limit === "number") opts.limit = args.limit;
        const cg = await deps.manager.getCallGraph(opts);
        return { content: [{ type: "text", text: formatCallGraph(cg) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Call graph error: ${msg}` }], isError: true };
      }
    }

    if (name === "find_dead_code") {
      const args = rawArgs as {
        project: string;
        language?: string;
        symbolType?: string;
        minConfidence?: number;
        limit?: number;
      };
      if (!args.project) {
        return { content: [{ type: "text", text: "'project' is required." }], isError: true };
      }
      const opts: {
        language?: string;
        symbolType?: string;
        minConfidence?: number;
        limit?: number;
      } = {};
      if (typeof args.language === "string") opts.language = args.language;
      if (typeof args.symbolType === "string") opts.symbolType = args.symbolType;
      if (typeof args.minConfidence === "number") opts.minConfidence = args.minConfidence;
      if (typeof args.limit === "number") opts.limit = args.limit;
      try {
        const report = await deps.manager.findDeadCode(args.project, opts);
        return { content: [{ type: "text", text: formatDeadCode(report) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Dead-code error: ${msg}` }], isError: true };
      }
    }

    if (name === "search_commits") {
      const args = rawArgs as {
        project: string;
        query?: string;
        path?: string;
        author?: string;
        since?: string;
        until?: string;
        withFiles?: boolean;
        limit?: number;
      };
      if (!args.project) {
        return {
          content: [{ type: "text", text: "'project' is required." }],
          isError: true,
        };
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
      if (typeof args.query === "string") opts.query = args.query;
      if (typeof args.path === "string") opts.path = args.path;
      if (typeof args.author === "string") opts.author = args.author;
      if (typeof args.since === "string") opts.since = args.since;
      if (typeof args.until === "string") opts.until = args.until;
      if (typeof args.withFiles === "boolean") opts.withFiles = args.withFiles;
      if (typeof args.limit === "number") opts.limit = args.limit;
      try {
        const cs = await deps.manager.searchCommits(args.project, opts);
        return { content: [{ type: "text", text: formatCommits(cs) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Commit search error: ${msg}` }], isError: true };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

/**
 * Starts the MCP server. Does NOT wait for indexing; starts listening as soon as
 * it is called. It serves two transports (only on CONFIG.HOST = 127.0.0.1):
 *   - POST /mcp   → Streamable HTTP (the current MCP transport, recommended)
 *   - GET  /sse   → SSE (legacy; kept for backward compatibility)
 */
export function startMcpServer(
  deps: McpDeps,
  port: number = CONFIG.MCP_PORT,
  host: string = CONFIG.HOST,
): Promise<void> {
  const app = express();
  // SECURITY: Restrict CORS to localhost origins only. Even though the server is
  // bound to 127.0.0.1, a wide-open cors() would allow a malicious web page in the
  // user's browser (cross-origin) to access these endpoints.
  // Native MCP clients without an Origin header (curl, SDK) are allowed.
  const localhostOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || localhostOrigin.test(origin)) cb(null, true);
        else cb(null, false);
      },
    }),
  );
  // SECURITY: DNS-rebinding protection on EVERY endpoint (Host-header check).
  // The Streamable HTTP transport additionally validates the Host itself for
  // POST /mcp; this middleware covers /health, /sse and /message too.
  app.use(hostGuard(host, port));

  app.get("/health", (_req, res) => {
    const jobs = deps.jobQueue.listJobs();
    res.json({
      status: "ok",
      indexes: deps.manager.listIndexes().map((ix) => ({
        name: ix.name,
        status: ix.status,
        files: ix.fileCount,
        chunks: ix.chunkCount,
      })),
      activeJobs: jobs.filter((j) => j.status === "running" || j.status === "queued").length,
      jobs: jobs.slice(0, 10).map((j) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        progress: j.progress,
      })),
    });
  });

  // --- Current transport: Streamable HTTP (stateless) ---
  // A new Server+transport per request; no session state is kept (simple, robust).
  app.post("/mcp", express.json(), async (req, res) => {
    const server = buildServer(deps);
    // Not providing sessionIdGenerator = stateless mode (session management off).
    // DNS-rebinding protection: only accept expected Host headers
    // (prevents malicious sites from hitting localhost via the browser).
    const transport = new StreamableHTTPServerTransport({
      enableDnsRebindingProtection: true,
      allowedHosts: [
        `${host}:${port}`,
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
      ],
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      // Cast: works around the onclose friction between the SDK transport type
      // and strict exactOptionalPropertyTypes (the transport is already a Transport impl).
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp] /mcp request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET/DELETE are not supported in stateless mode.
  const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless mode)." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // --- Legacy transport: SSE ---
  const transports = new Map<string, SSEServerTransport>();
  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/message", res);
    transports.set(transport.sessionId, transport);
    res.on("close", () => transports.delete(transport.sessionId));
    const server = buildServer(deps);
    await server.connect(transport);
  });

  app.post("/message", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).send("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.error(
        `[mcp] MCP server listening: http://${host}:${port}/mcp (Streamable HTTP) · /sse (legacy)`,
      );
      resolve();
    });
    // Fail loudly (the daemon exits with a clear message) instead of silently
    // logging "ready" while another daemon instance owns the port.
    server.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        err.message = `port ${port} is already in use — is another daemon running? (cidx stop first, or change mcpPort)`;
      }
      reject(err);
    });
  });
}
