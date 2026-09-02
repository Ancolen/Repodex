#!/usr/bin/env bun
/**
 * Stdio bridge — for MCP clients that expect stdio (e.g. Claude Desktop).
 *
 * This process speaks an MCP server over stdin/stdout; it forwards tool calls to
 * the running daemon's Control API (HTTP, 127.0.0.1). If the daemon is not running,
 * it starts it automatically. This way a single long-lived daemon serves both
 * HTTP/SSE/Streamable and stdio clients.
 *
 * IMPORTANT: stdout is the JSON-RPC channel; this process must NEVER write logs to
 * stdout (all logs go to stderr). That's why console.log is not used here.
 *
 * Usage (Claude Desktop configuration):
 *   { "command": "cidx", "args": ["mcp"] }     // or directly: bun run src/stdio-bridge.ts
 */
import path from "node:path";
import { mkdirSync, openSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./config";
import { daemonCommand } from "./runtime";
import { TOOL_DEFINITIONS } from "./server/tool-defs";
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
} from "./server/format";

const BASE = `http://${CONFIG.HOST}:${CONFIG.CONTROL_PORT}`;

// ----------------------------------------------------------- daemon management
async function ping(timeoutMs = 1000): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Starts the daemon in the background if it's not running and waits until it's ready. */
async function ensureDaemon(): Promise<void> {
  if (await ping()) return;
  console.error("[bridge] Daemon not running, starting it...");
  mkdirSync(CONFIG.ROOT_DIR, { recursive: true });
  const logPath = path.join(CONFIG.ROOT_DIR, "daemon.log");
  const out = openSync(logPath, "a");
  const proc = Bun.spawn({
    cmd: daemonCommand(import.meta.dir),
    stdout: out,
    stderr: out,
    stdin: "ignore",
    env: process.env,
  });
  proc.unref();
  for (let i = 0; i < 60; i++) {
    if (await ping()) {
      console.error(`[bridge] Daemon ready (pid ${proc.pid}).`);
      return;
    }
    await Bun.sleep(500);
  }
  throw new Error(`Failed to start daemon. Logs: ${logPath}`);
}

async function api<T = unknown>(method: string, pathname: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as T;
}

// ----------------------------------------------------------------- formatting
interface IndexView {
  name: string;
  path: string;
  status: string;
  files: number;
  chunks: number;
  error?: string | null;
  job?: { percent: number; processed: number; total: number } | null;
}

function formatIndexList(indexes: IndexView[]): string {
  if (indexes.length === 0) return "No projects indexed yet.";
  return indexes
    .map(
      (ix) =>
        `• ${ix.name} [${ix.status}] — ${ix.path}\n  ${ix.files} files, ${ix.chunks} chunks${ix.error ? `\n  error: ${ix.error}` : ""}`,
    )
    .join("\n");
}

function formatIndexStatus(ix: IndexView): string {
  const prog =
    ix.job && ix.job.total > 0 ? ` — %${ix.job.percent} (${ix.job.processed}/${ix.job.total})` : "";
  return `${ix.name} [${ix.status}]${prog}\n  ${ix.files} files, ${ix.chunks} chunks${ix.error ? `\n  error: ${ix.error}` : ""}`;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// --------------------------------------------------------------------- main
async function main(): Promise<void> {
  await ensureDaemon();

  const server = new Server(
    { name: "cidx (stdio bridge)", version: "2.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "search_codebase": {
          const results = await api<Parameters<typeof formatResults>[0]>("POST", "/search", {
            query: args.query,
            project: args.project,
            limit: args.limit,
            mode: args.mode,
            language: args.language,
            symbolType: args.symbolType,
            pathGlob: args.pathGlob,
            contextLines: args.contextLines,
            rerank: args.rerank,
            mmr: args.mmr,
            maxChars: args.maxChars,
          });
          return ok(formatResults(results));
        }
        case "search_codebase_batch": {
          const groups = await api<Parameters<typeof formatBatchResults>[0]>("POST", "/search/batch", {
            queries: args.queries,
            project: args.project,
            limit: args.limit,
            mode: args.mode,
            language: args.language,
            symbolType: args.symbolType,
            pathGlob: args.pathGlob,
            contextLines: args.contextLines,
            rerank: args.rerank,
            mmr: args.mmr,
            maxChars: args.maxChars,
          });
          return ok(formatBatchResults(groups));
        }
        case "find_symbol": {
          const results = await api<Parameters<typeof formatResults>[0]>("POST", "/find", {
            name: args.name,
            project: args.project,
            limit: args.limit,
            language: args.language,
            symbolType: args.symbolType,
          });
          return ok(formatResults(results));
        }
        case "list_indexes": {
          const indexes = await api<IndexView[]>("GET", "/indexes");
          return ok(formatIndexList(indexes));
        }
        case "get_index_status": {
          if (args.project) {
            const ix = await api<IndexView>(
              "GET",
              `/indexes/${encodeURIComponent(String(args.project))}`,
            );
            return ok(formatIndexStatus(ix));
          }
          const indexes = await api<IndexView[]>("GET", "/indexes");
          return ok(indexes.length ? indexes.map(formatIndexStatus).join("\n") : "No projects indexed yet.");
        }
        case "index_project": {
          const ix = await api<IndexView>("POST", "/index", { path: args.path, name: args.name });
          return ok(
            `Indexing started (in the background): '${ix.name}' [${ix.status}] → ${ix.path}\nFor progress: get_index_status("${ix.name}").`,
          );
        }
        case "get_file_outline": {
          const outline = await api<Parameters<typeof formatOutline>[0]>("POST", "/outline", {
            path: args.path,
          });
          return ok(formatOutline(outline));
        }
        case "find_references": {
          const refs = await api<Parameters<typeof formatReferences>[0]>("POST", "/references", {
            name: args.name,
            project: args.project,
            limit: args.limit,
            language: args.language,
            symbolType: args.symbolType,
          });
          return ok(formatReferences(refs));
        }
        case "get_repo_overview": {
          const overview = await api<Parameters<typeof formatOverview>[0]>("POST", "/overview", {
            name: args.project,
          });
          return ok(formatOverview(overview));
        }
        case "get_dependencies": {
          const dep = await api<Parameters<typeof formatDependencies>[0]>("POST", "/dependencies", {
            path: args.path,
            project: args.project,
            limit: args.limit,
          });
          return ok(formatDependencies(dep));
        }
        case "get_call_graph": {
          const cg = await api<Parameters<typeof formatCallGraph>[0]>("POST", "/callgraph", {
            symbol: args.symbol,
            path: args.path,
            project: args.project,
            direction: args.direction,
            depth: args.depth,
            limit: args.limit,
          });
          return ok(formatCallGraph(cg));
        }
        case "find_dead_code": {
          const report = await api<Parameters<typeof formatDeadCode>[0]>("POST", "/deadcode", {
            project: args.project,
            language: args.language,
            symbolType: args.symbolType,
            minConfidence: args.minConfidence,
            limit: args.limit,
          });
          return ok(formatDeadCode(report));
        }
        case "search_commits": {
          const cs = await api<Parameters<typeof formatCommits>[0]>("POST", "/commits", {
            project: args.project,
            query: args.query,
            path: args.path,
            author: args.author,
            since: args.since,
            until: args.until,
            withFiles: args.withFiles,
            limit: args.limit,
          });
          return ok(formatCommits(cs));
        }
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Error: ${msg}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  console.error("[bridge] Stdio MCP bridge ready.");
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
