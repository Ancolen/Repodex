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
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 5).",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "vector", "text"],
          description:
            "Search mode: 'hybrid' (default; vector+BM25), 'vector' (pure semantic), 'text' (pure BM25/exact term). " +
            "'text' needs no embedding model and no query vector — use it as the fallback when embedding is unavailable.",
        },
        language: {
          type: "string",
          description:
            "Only results in this language (e.g. 'python', 'typescript'). Valid labels are listed by get_repo_overview (languageDistribution).",
        },
        symbolType: {
          type: "string",
          description:
            "Only results of this symbol type (e.g. 'function', 'class', 'method'). Valid labels are listed by get_repo_overview (symbolTypeBreakdown).",
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
        boost: {
          type: "boolean",
          description:
            "Path/surface boost is ON by default: RRF-merged results get small multiplicative nudges — " +
            "short project-relative paths and conventional source roots (src/lib/app) score a little " +
            "higher, test and generated/artifact paths (build/dist/gen/vendor, .pb.go, .min.*) a little " +
            "lower. Applies to RRF-merged lists only; single-leg results are untouched. Pass false for " +
            "a pure-RRF relevance order.",
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
        blame: {
          type: "boolean",
          description:
            "Ownership/blame enrichment (opt-in, default false). Pass true to stamp each result with " +
            "lastAuthor / lastCommitDate (UTC date) / churnCommits — the most recent commit touching the " +
            "chunk's line range, read fresh from git per search (one 'git blame --porcelain' per hit file, " +
            "≤ 8 files; extras are reported as the blameSkipped envelope note). Off by default — it costs one " +
            "git call per hit file.",
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
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results PER query (default: 5).",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "vector", "text"],
          description:
            "Search mode: 'hybrid' (default), 'vector' (pure semantic), 'text' (pure BM25 — needs no embedding model).",
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
        boost: {
          type: "boolean",
          description:
            "Path/surface boost ON by default (short paths / source roots up, test & generated paths down, " +
            "small multiplicative factors on RRF-merged results); pass false for a pure-RRF order.",
        },
        maxChars: {
          type: "number",
          description: "Optional character budget applied PER QUERY; results kept whole while they fit.",
        },
        doc: {
          type: "boolean",
          description: "Docstring retrieval legs ON by default (same semantics as search_codebase's 'doc'); pass false to skip.",
        },
        blame: {
          type: "boolean",
          description:
            "Ownership/blame enrichment (opt-in, default false; same semantics as search_codebase's 'blame'), " +
            "applied per query. Each result is stamped with lastAuthor / lastCommitDate / churnCommits from one " +
            "'git blame --porcelain' per hit file (≤ 8; extras reported as a per-group blameSkipped note).",
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
      "When exact AND prefix both find nothing and 'fuzzy' is not false, a FUZZY tier (n-gram BM25 over symbolName, " +
      "model-independent) recovers near misses like typos — every such hit carries fuzzy: true and is capped by 'limit'. " +
      "Tables indexed before the fuzzy tier existed never fuzzy-match (their next index job / a reindex enables it). " +
      "FRESHNESS: The index is updated with a ~1-2 sec delay; a symbol you just added/renamed " +
      "may not show up immediately. To confirm a change you just made yourself, read the file directly.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name to search for (e.g. 'loginUser', 'IndexManager')." },
        project: { type: "string", description: "Search only in this project (optional)." },
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
        limit: { type: "number", description: "Maximum results (default: 20)." },
        fuzzy: {
          type: "boolean",
          description:
            "Fuzzy fallback when exact + prefix find nothing (default true — an opt-out of the new tier). " +
            "Pass false to keep the strict exact/prefix-only behavior. Fuzzy hits are approximate, ranked by " +
            "n-gram overlap, and marked fuzzy: true.",
        },
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
      "Returns the indexing status and live progress (% / file) of a project (or all of them). " +
      "An unknown project name is reported with the list of available projects.",
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
      "Returns the symbol map (function/class/method + line ranges) of a source file. " +
      "The file is read live from disk, so it reflects your JUST-SAVED edits instantly — use it " +
      "(or a direct file read) when the ~1-2s index lag would otherwise show stale content.",
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
      "so it may include same-named symbols from different scopes. If 'project' is not given, searches all projects. " +
      "The result is honest about its cap: 'total' counts every distinct occurrence found and " +
      "'truncated' says when 'limit' bit (the rendered text says 'N of M reference(s)'). " +
      "Doc artifacts (.md/.mdx/.xml/.rst) count as evidence by default — pass includeDocs:false " +
      "for a code-only 'who calls X' answer.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name whose usages to find (e.g. 'loginUser')." },
        project: { type: "string", description: "Search only in this project (optional)." },
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
        limit: { type: "number", description: "Maximum number of occurrences kept (default: 50); 'total' is never capped." },
        includeDocs: {
          type: "boolean",
          description:
            "Doc artifacts (.md/.mdx/.xml/.rst) count as evidence by default (they are indexed chunks too). " +
            "Pass false to keep only code-file occurrences.",
        },
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
      "Aggregated from the index (no LLM); pair it with your own reasoning for a prose summary. " +
      "When both 'project' and 'path' are omitted and exactly one project is indexed, that project is summarized.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project name to summarize (optional)." },
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
      },
      required: [],
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
        project: { type: "string", description: "The project to analyze (optional when 'path' is given, or when exactly one project is indexed)." },
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
        language: { type: "string", description: "Restrict to this language (optional)." },
        symbolType: { type: "string", description: "Restrict to this symbol type, e.g. 'function' or 'method' (optional)." },
        minConfidence: { type: "number", description: "Minimum confidence (0-100) to report (default: 0)." },
        limit: { type: "number", description: "Maximum number of candidates (default: 200)." },
      },
      required: [],
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
      "files ('withFiles'). The project must be a git repo (reported as 'notARepo' otherwise). When " +
      "'project' is omitted and exactly one project is indexed, that project's history is searched. " +
      "NOTE: 'path' here is the FILE-HISTORY filter — there is deliberately no project anchor by path.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "The indexed project to search the git history of (optional when exactly one project is indexed).",
        },
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
  {
    name: "get_context_pack",
    description:
      "ONE call that assembles what you'd otherwise burn 4-6 round-trips on: the hybrid search " +
      "core of search_codebase (same reranker/MMR/doc-leg/query-cache pipeline) PLUS, for every hit, " +
      "its file's symbol outline capped to the hit's neighborhood, the hit file's forward imports " +
      "(resolved to indexed files only), and the optional surrounding context lines — all under a " +
      "SINGLE pack-level character budget. Hits are added whole in ranked order while the pack fits; " +
      "the top hit is always included; hits that didn't fit are reported as 'omitted' (never truncated). " +
      "Use it to get up to speed on a topic ('how does X work here?') in one turn. The same FRESHNESS " +
      "caveat as search_codebase applies: the index lags edits by ~1-2s.",
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
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
        limit: {
          type: "number",
          description: "Maximum number of hits considered for the pack (default: 5).",
        },
        maxChars: {
          type: "number",
          description:
            "Character budget for the WHOLE pack (default: 6000). Applied once over the assembled pack: " +
            "hits are kept whole in ranked order while the running total fits (the top hit is always kept) " +
            "and the rest are counted in 'omitted'. Internal legs never truncate on top of this.",
        },
        contextLines: {
          type: "number",
          description:
            "If > 0, include up to this many surrounding lines (read live from the file on disk) " +
            "before/after each hit chunk. Default 0.",
        },
        language: {
          type: "string",
          description: "Filter the underlying search by language (labels via get_repo_overview).",
        },
        symbolType: {
          type: "string",
          description: "Filter the underlying search by symbol type (e.g. 'function', 'class').",
        },
        pathGlob: {
          type: "string",
          description: "Filter the underlying search by file path glob (e.g. 'src/*').",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_api_diff",
    description:
      "PUBLIC API DIFF between two git refs of an indexed project — the 'did this release break " +
      "anything public?' / pre-merge-review question. Both sides are compared as exported-symbol " +
      "surfaces: the base ref is re-parsed from git (git ls-tree + git show + the same tree-sitter " +
      "recipe as indexing), the head defaults to the WORKING TREE as currently indexed (or pass " +
      "another ref). Every symbol is classified 'removed' / 'signature-changed' / 'visibility-narrowed' " +
      "(all BREAKING), 'added' or 'unchanged', with the before/after signatures side by side on the " +
      "breaking ones. No indexing, no embedding, no reindex; the project must be a git repo " +
      "('(notARepo)' otherwise) and 'base' must resolve ('unknownRef' otherwise). Parameter comparison " +
      "is per-language and approximate (arity + parameter names, string-normalized) — treat it as a " +
      "review list, not proof; files that fail to parse at the old ref are listed as 'unparsed'.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The indexed project to diff (optional when 'path' is given, or when exactly one project is indexed).",
        },
        path: {
          type: "string",
          description:
            "Alternative to 'project': a file/dir inside the project (the owning project is inferred). Ignored when 'project' is also given.",
        },
        base: {
          type: "string",
          description: "The 'before' git ref: a tag, a SHA, or a branch name (e.g. 'v1.2.0', 'main~3').",
        },
        head: {
          type: "string",
          description:
            "The 'after' git ref (optional). Defaults to the working tree as currently indexed — pass a " +
            "ref to compare two historical points instead.",
        },
        limit: { type: "number", description: "Maximum number of diff entries returned (default: 200)." },
        maxFiles: {
          type: "number",
          description:
            "Cap on how many files are parsed per historical side (default: 1000). Exceeding it sets " +
            "'truncated' — the diff is then partial.",
        },
        exportedOnly: {
          type: "boolean",
          description:
            "Keep only symbols that look exported on at least one side (default: false — every symbol is " +
            "reported). Useful in languages where exportedness is recoverable (JS/TS, Rust, Go, Java, C#).",
        },
        includeUnchanged: {
          type: "boolean",
          description:
            "Also list the 'unchanged' symbols (default: false — they are always included in the counts, " +
            "so you never miss them).",
        },
      },
      required: ["base"],
    },
  },
  {
    name: "get_change_impact",
    description:
      "ONE ranked answer to 'if I change X, what breaks?'. Joins three views that already exist — " +
      "the direct callers (call graph), the files that import the symbol's module (dependency graph), " +
      "and the whole-identifier references (with a few representative file:line hits and a total count) — " +
      "and ranks them by severity: a consumer that CALLS the symbol outranks a file that merely IMPORTS " +
      "its module, which outranks a loose textual mention. Each section is capped by 'limit' and reports " +
      "'total' + 'truncated'. Test files are split out into 'coveredBy' (exercised by a test) instead of " +
      "counting as production consumers, and 'fanOut' shows how entangled the change site itself is " +
      "(what its file imports, what the symbol calls). Anchor resolution mirrors get_call_graph: provide " +
      "a 'symbol' (function/method name, exact/prefix/dotted), a 'path' (its file), or both (disambiguate); " +
      "at least one is required. LIMITATION: matching is whole-identifier over indexed content, not full " +
      "LSP resolution, so same-named symbols in different scopes are indistinguishable — treat the report " +
      "as a review aid, not proof. No schema change, no reindex.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "A callable symbol name to center the report on (exact, then prefix, then dotted).",
        },
        path: {
          type: "string",
          description: "Absolute path of the changed file; disambiguates 'symbol', or resolves the file's single callable.",
        },
        project: {
          type: "string",
          description: "Restrict to this project (optional; inferred from the path, or the single indexed project).",
        },
        depth: { type: "number", description: "How many caller levels to follow, 1 = direct callers only (default: 3)." },
        limit: { type: "number", description: "Cap per section (default: 25); exceeding it sets 'truncated'." },
      },
      required: [],
    },
  },
  {
    name: "check_docs",
    description:
      "DETERMINISTIC doc–code conformance check (no LLM, no Ollama, byte-for-byte reproducible): " +
      "extracts backtick claims from the project's markdown docs and resolves every one against the " +
      "index — identifiers (symbols + whole-identifier occurrences + constant literals), paths (the " +
      "indexed file set), npm dependencies, HTTP endpoints, CLI commands/flags, environment variables, " +
      "config keys, model tags and `file → symbol` composite claims. A reference a TOTAL-resolution " +
      "class fails to resolve with confidence ≥ 90 is reported as a hard `drift` finding; every " +
      "residual doubt is demoted into `needsReview` instead — the checker never guesses. Historical " +
      "files (changelog), planned regions (proposals/roadmap headings) and fenced examples are counted, " +
      "never accused. Also reports `undocumented`: exported symbols no doc mentions (advisory, capped, " +
      "disable with noUndocumented). Optional drift window: `since` (a git ref) or `window: true` " +
      "(changes since the docs' last commit) keeps only findings whose doc or code side actually " +
      "changed — with a degradation note instead of a silent full scan when the anchor does not " +
      "resolve. FRESHNESS: evidence comes from the index, which lags edits by ~1-2s — a symbol " +
      "renamed moments ago may read as drift until the watcher syncs; `checked.indexFreshness` shows " +
      "what the report was built from. No schema change, no reindex.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The project to check (optional; inferred from 'path', or the single indexed project)." },
        path: { type: "string", description: "A file/dir inside the project to check (alternative to 'project')." },
        files: { type: "array", items: { type: "string" }, description: "Restrict the doc set (project-relative, root-anchored globs, e.g. ['docs/**/*.md']). Default: root *.md + docs/**." },
        ignore: { type: "array", items: { type: "string" }, description: "Doc files/globs to skip (also picked up from .cidx.json 'doccheck.ignore')." },
        limit: { type: "number", description: "Max findings/review items kept (default 100)." },
        maxChars: { type: "number", description: "Char budget over the rendered findings (kept whole; default from config, 12000)." },
        undocumentedLimit: { type: "number", description: "Max undocumented-symbol entries (default 25)." },
        noUndocumented: { type: "boolean", description: "Skip reverse coverage (exported symbols no doc mentions) entirely." },
        since: { type: "string", description: "A git ref; keep only findings whose doc or code side changed since that commit." },
        window: { type: "boolean", description: "Anchor the drift window at the docs' own last commit instead of 'since'." },
      },
      required: [],
    },
  },
];
