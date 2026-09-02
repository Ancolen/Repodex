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
import { fileOutline } from "../chunking/chunker";
import { TOOL_DEFINITIONS } from "./tool-defs";
import { formatResults, formatOutline, formatReferences, formatOverview } from "./format";
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
    { name: "mcp-code-indexer", version: "2.1.0" },
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
      };
      const limit = args.limit ?? 5;
      const opts = {
        mode: args.mode,
        language: args.language,
        symbolType: args.symbolType,
        pathGlob: args.pathGlob,
        contextLines: args.contextLines,
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

  return new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.error(
        `[mcp] MCP server listening: http://${host}:${port}/mcp (Streamable HTTP) · /sse (legacy)`,
      );
      resolve();
    });
  });
}
