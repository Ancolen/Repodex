import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool definitions (the `tools` array in the ListTools response).
 *
 * Both the in-process MCP server (`server/mcp.ts`) and the stdio bridge
 * (`stdio-bridge.ts`) use this single source; this way the tool schemas never
 * diverge from each other.
 */
export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: "search_codebase",
    description:
      "HYBRID search (semantic vector + BM25 exact term) over indexed codebases. " +
      "If 'project' is not given, searches ALL projects. You can filter results by language/symbol type/file path. " +
      "FRESHNESS: The index watches file changes live, but the reflection has a ~1-2 sec delay " +
      "(save detection + embedding). Do not rely on this tool to search the NEW content of a file " +
      "you JUST edited yourself — the result may show the old version; get that content by reading the " +
      "file directly. This tool is for DISCOVERY (finding related/similar code, where something is). " +
      "If you need to see an edit reflected in the index, wait ~2 sec before searching.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language query or technical terms to search for.",
        },
        project: {
          type: "string",
          description: "Search only in this project (optional). If not given, all projects are searched.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 5).",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "vector", "text"],
          description:
            "Search mode: 'hybrid' (default; vector+BM25), 'vector' (pure semantic), 'text' (pure BM25/exact term).",
        },
        language: {
          type: "string",
          description: "Only results in this language (e.g. 'python', 'typescript').",
        },
        symbolType: {
          type: "string",
          description: "Only results of this symbol type (e.g. 'function', 'class', 'method').",
        },
        pathGlob: {
          type: "string",
          description: "File path pattern (e.g. 'src/*' or 'auth'). The '*' wildcard is supported.",
        },
        contextLines: {
          type: "number",
          description:
            "If > 0, include up to this many surrounding lines (read live from the file on disk) " +
            "before/after each result chunk, so you can read usages in context without opening the file. Default 0.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "find_symbol",
    description:
      "Finds a symbol (function/class/method) directly by NAME (exact + prefix). " +
      "More precise than semantic search; use it when you know the exact name. If 'project' is not given, searches all projects. " +
      "FRESHNESS: The index is updated with a ~1-2 sec delay; a symbol you just added/renamed " +
      "may not show up immediately. To confirm a change you just made yourself, read the file directly.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name to search for (e.g. 'loginUser', 'IndexManager')." },
        project: { type: "string", description: "Search only in this project (optional)." },
        limit: { type: "number", description: "Maximum results (default: 20)." },
        language: { type: "string", description: "Filter by language (optional)." },
        symbolType: { type: "string", description: "Filter by symbol type (optional)." },
      },
      required: ["name"],
    },
  },
  {
    name: "list_indexes",
    description: "Lists indexed projects and their statuses (ready/indexing/error).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_index_status",
    description:
      "Returns the indexing status and live progress (% / file) of a project (or all of them).",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The project name whose status is requested. If not given, a summary of all projects is returned.",
        },
      },
    },
  },
  {
    name: "index_project",
    description:
      "Starts indexing a local directory as a new project (in the background, returns immediately). If the same path already exists, it is reindexed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the directory to index." },
        name: { type: "string", description: "Project name (optional; if not given, the folder name)." },
      },
      required: ["path"],
    },
  },
  {
    name: "get_file_outline",
    description:
      "Returns the symbol map (function/class/method + line ranges) of a source file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." },
      },
      required: ["path"],
    },
  },
  {
    name: "find_references",
    description:
      "Finds where a symbol NAME is USED across the indexed code (call sites + definition), " +
      "returning file:line occurrences with the matching source line. Complements 'find_symbol' " +
      "(which finds only the definition); use this for impact/refactor analysis ('who calls X'). " +
      "Practical matcher: whole-identifier matches over indexed chunks (not full LSP resolution), " +
      "so it may include same-named symbols from different scopes. If 'project' is not given, searches all projects.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name whose usages to find (e.g. 'loginUser')." },
        project: { type: "string", description: "Search only in this project (optional)." },
        limit: { type: "number", description: "Maximum number of occurrences (default: 50)." },
        language: { type: "string", description: "Filter by language (optional)." },
        symbolType: { type: "string", description: "Filter by the containing symbol's type (optional)." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo_overview",
    description:
      "Returns a structural onboarding summary of a project: language distribution, symbol-type " +
      "breakdown, top-level directories, likely entry points, and the files with the most symbols. " +
      "Use this when you FIRST enter a project to learn 'what is this repo and where to start'. " +
      "Aggregated from the index (no LLM); pair it with your own reasoning for a prose summary.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project name to summarize." },
      },
      required: ["project"],
    },
  },
];
