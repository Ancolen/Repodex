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
      "Results are refined by a second-stage reranker by default (higher precision; auto-disables if no reranker model is configured). " +
      "They are also diversified with MMR by default so the top results aren't near-duplicates (e.g. copies of the same function). " +
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
        rerank: {
          type: "boolean",
          description:
            "Second-stage reranker is ON by default. Pass false to skip it for faster lookups. " +
            "It re-scores the top candidates with a cross-encoder-style model for higher-precision " +
            "ordering; auto-disables if no reranker model is configured.",
        },
        mmr: {
          type: "boolean",
          description:
            "MMR diversification is ON by default. It re-orders the top results to avoid near-duplicate " +
            "chunks (e.g. copies of the same function) so you see distinct relevant code. Pass false to " +
            "keep a pure relevance order.",
        },
        maxChars: {
          type: "number",
          description:
            "Optional character budget for the returned results. When set, results are kept whole in " +
            "ranked order while they fit (never truncated mid-chunk) — use a higher 'limit' for recall " +
            "and 'maxChars' to cap how much text comes back. The top result is always returned. Default: no cap.",
        },
        doc: {
          type: "boolean",
          description:
            "Docstring retrieval legs are ON by default (tables indexed with the docstring feature carry a " +
            "separate doc_vector/doc column per symbol). Their vectors embed a symbol's docstring/comment, so " +
            "intent-style queries ('how do we retry with backoff?') surface the code chunk that has that doc. " +
            "Doc-matching results are marked with '[doc hit]'. Pass false to skip the doc legs.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_codebase_batch",
    description:
      "HYBRID search for SEVERAL queries in a single round-trip; returns results grouped per query " +
      "(one '## Query: \"...\"' section each). Use it when you have multiple related questions or want to explore " +
      "several angles at once instead of calling search_codebase repeatedly. Each query gets the same reranker/" +
      "MMR/maxChars behavior as search_codebase; duplicate query strings are de-duped. The same FRESHNESS caveat " +
      "applies: the index lags edits by ~1-2s.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "The queries to run (natural language or technical terms).",
        },
        project: {
          type: "string",
          description: "Search only in this project (optional). If not given, all projects are searched.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results PER query (default: 5).",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "vector", "text"],
          description: "Search mode: 'hybrid' (default), 'vector' (pure semantic), 'text' (pure BM25).",
        },
        language: { type: "string", description: "Only results in this language." },
        symbolType: { type: "string", description: "Only results of this symbol type." },
        pathGlob: { type: "string", description: "File path pattern (e.g. 'src/*' or 'auth')." },
        contextLines: {
          type: "number",
          description: "If > 0, include up to this many surrounding lines before/after each result chunk. Default 0.",
        },
        rerank: { type: "boolean", description: "Second-stage reranker ON by default; pass false to skip." },
        mmr: { type: "boolean", description: "MMR diversification ON by default; pass false to keep pure relevance." },
        maxChars: {
          type: "number",
          description: "Optional character budget applied PER QUERY; results kept whole while they fit.",
        },
        doc: {
          type: "boolean",
          description: "Docstring retrieval legs ON by default (same semantics as search_codebase's 'doc'); pass false to skip.",
        },
      },
      required: ["queries"],
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
  {
    name: "get_dependencies",
    description:
      "Returns the import graph of one source file: what it imports (resolved to indexed files, " +
      "plus external/unresolved specifiers) AND which indexed files import it (reverse deps). " +
      "Use it for impact/refactor analysis ('what depends on X', 'if I change this, what breaks'). " +
      "Imports are parsed from the file's AST (16 languages); reverse deps come from an on-demand " +
      "graph cached by file mtime — the first call per project scans all imports, later calls are " +
      "instant until a file changes. If 'project' is not given, it is inferred from the file's path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file to analyze." },
        project: {
          type: "string",
          description: "Restrict the analysis to this project (optional; inferred from the path if not given).",
        },
        limit: { type: "number", description: "Cap on the number of 'imported-by' files returned (default: 200)." },
      },
      required: ["path"],
    },
  },
  {
    name: "get_call_graph",
    description:
      "Returns the call graph around a symbol and/or file: who calls it (callers) and what it calls " +
      "(callees), as bounded, cycle-safe trees. Use it to trace impact ('if I change X, what is affected', " +
      "'how does execution reach X') and to navigate a function's call stack. Edges are derived from " +
      "whole-identifier matches over indexed chunk content (same pragmatic approach as find_references — " +
      "not full LSP, so treat it as a navigation aid). Provide a 'symbol' (function/method name), a 'path' " +
      "(all callables in that file), or both (disambiguate a name within one file). At least one of " +
      "'symbol'/'path' is required. The per-project adjacency is cached and rebuilt only when the project " +
      "is reindexed. No schema change, no reindex.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "A callable symbol name (function/method/constructor) to center the graph on (exact, then prefix).",
        },
        path: {
          type: "string",
          description: "Absolute path of a file; centers the graph on every callable symbol defined in it.",
        },
        project: {
          type: "string",
          description: "Restrict to this project (optional; inferred from the path, or the single indexed project).",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees", "both"],
          description: "Which trees to build (default: 'both').",
        },
        depth: { type: "number", description: "Maximum traversal depth, 0 = anchor only (default: 3)." },
        limit: { type: "number", description: "Cap on nodes per direction (default: 100); exceeding it sets 'truncated'." },
      },
      required: [],
    },
  },
  {
    name: "find_dead_code",
    description:
      "Finds POTENTIAL dead code in a project: symbols (functions/methods/classes/etc.) with zero " +
      "whole-identifier references anywhere in the indexed code, scored by a conservative multi-signal " +
      "model that demotes exported, polymorphic, dynamic-hook and common names. Results are labeled " +
      "'likely dead' / 'uncertain' / 'review' with a confidence score and the signals that drove it — " +
      "treat them as candidates to verify, not authoritative findings. Test files and entry points are " +
      "excluded. No reindex needed; coverage is partial if the project exceeds the row cap (reported as 'truncated').",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project to analyze (required)." },
        language: { type: "string", description: "Restrict to this language (optional)." },
        symbolType: { type: "string", description: "Restrict to this symbol type, e.g. 'function' or 'method' (optional)." },
        minConfidence: { type: "number", description: "Minimum confidence (0-100) to report (default: 0)." },
        limit: { type: "number", description: "Maximum number of candidates (default: 200)." },
      },
      required: ["project"],
    },
  },
  {
    name: "search_commits",
    description:
      "Searches the GIT HISTORY of an indexed project for commits — the 'when / why was feature X " +
      "added' and 'who changed this file, and when' questions that code search can't answer. Runs " +
      "`git log` live in the project directory: no indexing, no embedding, no reindex. Filter by commit " +
      "message ('query', case-insensitive regex), by file/path history, by author, and/or by date range " +
      "('since'/'until', git date syntax like '2 weeks ago' or '2024-01-01'). With no filters it returns " +
      "the most recent commits. Returns hash, author, date, subject (+ body), and optionally the changed " +
      "files ('withFiles'). The project must be a git repo (reported as 'notARepo' otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The indexed project to search the git history of (required)." },
        query: {
          type: "string",
          description: "Case-insensitive regex matched against the commit message (subject + body).",
        },
        path: {
          type: "string",
          description: "Restrict to commits that touched this file/path/glob (repo-relative or absolute).",
        },
        author: { type: "string", description: "Case-insensitive regex matched against the author name/email." },
        since: { type: "string", description: "git --since date, e.g. '2 weeks ago' or '2024-01-01'." },
        until: { type: "string", description: "git --until date." },
        withFiles: { type: "boolean", description: "Include the changed files per commit (default: false)." },
        limit: { type: "number", description: "Maximum commits to return (default: 50)." },
      },
      required: ["project"],
    },
  },
];
