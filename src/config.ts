import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { FramingSetting } from "./core/framing";

/**
 * Configuration layer.
 *
 * Priority (low to high): in-code defaults < YAML file < environment variables.
 *
 * The YAML file is searched in this order:
 *   1) $CIDX_CONFIG (full path)
 *   2) ./cidx.yml or ./.cidx.yml or ./cidx.yaml (working directory)
 *   3) <home>/config.yml  (home = $CIDX_HOME or ~/.cidx)
 * If none exist, a default file with comments is CREATED at location (3).
 *
 * Migration: installs from before the cidx rename stored everything under
 * ~/.mcp-indexer. If the new default home (~/.cidx) does not exist yet and the
 * old one does, it is moved once at startup (see migrateLegacyHome).
 */

/**
 * The embedding backend. `auto` probes both (an Ollama that has the configured
 * model wins; a live llama-server next); `ollama`/`llamacpp` pin one.
 */
export type EmbedProviderSetting = "auto" | "ollama" | "llamacpp";
const EMBED_PROVIDER_VALUES: readonly string[] = ["auto", "ollama", "llamacpp"];

export interface IndexerConfig {
  home: string;
  server: { host: string; mcpPort: number; controlPort: number };
  ollama: {
    url: string;
    model: string;
    batchSize: number;
    concurrency: number;
    /**
     * Ollama `num_ctx` sent with every embed request. Ollama allocates 4096
     * when it is not given, which is ~8x oversized for chunks capped at
     * ~512 tokens — the context buffer is allocated up front per loaded
     * model, so the overshoot is paid in VRAM/RAM, not in accuracy.
     */
    numCtx: number;
  };
  embedding: {
    cacheMax: number;
    /** Which embedding backend to talk to (see services/embed.ts for the auto rules). */
    provider: EmbedProviderSetting;
    /** Base URL of a `llama-server` process (OpenAI-compatible endpoints). */
    llamacppUrl: string;
    /**
     * Default embedding task-framing setting (per-model framing layer): "none"
     * sends every text exactly as before; "auto" applies the per-model preset
     * for the record's embedding model (unknown models stay unframed). A
     * per-project `.cidx.json` `framing` overrides it; the resolved identity is
     * pinned per record and a framing change escalates like a model change.
     */
    framing: FramingSetting;
  };
  indexing: {
    maxChunkSize: number;
    overlapSize: number;
    /**
     * Approximate per-chunk token cap. The effective chunk size is
     * min(maxChunkSize, maxChunkTokens * CHARS_PER_TOKEN), so a large
     * maxChunkSize can't silently exceed the embedding model's token window.
     */
    maxChunkTokens: number;
    allowedExtensions: string[];
    ignoredDirs: string[];
    /**
     * Files strictly larger than this many bytes are skipped (proposal:
     * `maxFileSizeBytes` guard) — a persistent guard so oversized data files
     * don't depend solely on `.cidxignore`. 0 (the default) disables the
     * filter; any value <= 0 reads as off. A per-project `.cidx.json`
     * `maxFileSizeBytes` (positive integer) overrides this globally. Filtered
     * files are absent from `collectFiles` output, so the deleted-file cleanup
     * prunes them on the next sync/reindex (the `.cidx.json` `languages`
     * semantics).
     */
    maxFileSizeBytes: number;
    /** An ANN vector index is built when a table reaches this row count. */
    vectorIndexThreshold: number;
    /** If true, .gitignore rules are also added to the ignore matcher. */
    respectGitignore: boolean;
    /** If true, only git-tracked files are indexed (in git repos). */
    gitTrackedOnly: boolean;
    /**
     * If true, each symbol's docstring/doc comment (`chunk.doc`) is embedded
     * into a separate `doc_vector` column (the docstring retrieval leg).
     * Turning it off skips the extra embeddings; existing `doc_vector` data is
     * untouched until a reindex recreates the table.
     */
    docstrings: boolean;
    /** Number of indexing jobs that can run at the same time (worker pool). */
    jobConcurrency: number;
  };
  watcher: { debounceMs: number };
  search: {
    /**
     * Max rows kept in the local query log (search analytics, proposal A3):
     * one row per completed `searchIndex`/`searchAll` call, pruned to the most
     * recent `queryLogSize` rows at write time. 0 = off (nothing is logged).
     */
    queryLogSize: number;
    /**
     * Local-LLM query expansion (proposal S4): one completion call produces
     * 2-3 variant queries per `expand: true` search and their rankings merge
     * into the base ranking (RRF, the original query first — rank dominance).
     * Opt-in per call; the model must name an instruct model the backend
     * serves. Empty model = the feature is unavailable and an expanded search
     * degrades to the base search with an envelope note.
     */
    expand: {
      /** Ollama tag / llama-server alias of the expansion model. Empty = unavailable. */
      model: string;
      /** Base URL for the expansion request. Empty = follow the embedding backend's resolved URL (same rule as `search.rerank.url`). */
      url: string;
      /** Max variant queries one expanded search may add (empties, duplicates and the original are always dropped). */
      maxVariants: number;
      /** The single completion call is aborted at this deadline; the search then degrades to the base search. */
      timeoutMs: number;
    };
    rerank: {
      /** If true, a second-stage reranker refines results by default (per-call override via the search API). */
      enabled: boolean;
      /** Ollama tag of the causal-LM reranker model (scored via yes/no logprobs). Empty string disables. */
      model: string;
      /** How many of the top candidates to rerank before slicing to the requested `limit`. */
      topK: number;
      /** Max concurrent reranker calls to Ollama. */
      concurrency: number;
      /**
       * Ollama `num_ctx` for the rerank `/api/generate` calls. The judge prompt
       * is the query + one chunk + the Qwen3-Reranker template (~500 tokens at
       * the default chunk size), so 1024 fits it with headroom while avoiding
       * Ollama's 4096 default allocation.
       */
      numCtx: number;
      /**
       * Base URL for reranker requests. Empty = follow the embedding backend's
       * resolved URL. Set it when the reranker model lives on a different
       * server from the embedding model (a llama.cpp reranker must: one
       * llama-server serves one model).
       */
      url: string;
    };
    mmr: {
      /** If true, MMR diversifies the top results by default (per-call override via the search API). */
      enabled: boolean;
      /** Relevance vs diversity tradeoff: 1 = pure relevance, 0 = pure diversity. */
      lambda: number;
      /** How many of the top candidates to diversify over before slicing to the requested `limit`. */
      topK: number;
    };
    boost: {
      /**
       * If true, path/surface signals nudge RRF-merged search results by default
       * (per-call override via the search API). Pure re-scoring — no index change,
       * no reindex, no backend call; single-leg results are never touched.
       */
      enabled: boolean;
      /** Max multiplicative bonus for a short project-relative path (fades in on a log scale). */
      shortPath: number;
      /** Multiplicative bonus when a path starts with a conventional source root. */
      sourceRoot: number;
      /** Multiplicative demotion for test files (`isTestFile` patterns). */
      testDemotion: number;
      /** Multiplicative demotion for generated/artifact paths (gen|dist|build|vendor|node_modules segments, .pb.go, .min.*). */
      generatedDemotion: number;
      /** Directories that count as conventional source roots (project-relative). */
      sourceRoots: string[];
    };
  };
  /** Doc–code conformance checker (proposal D1) — deterministic, no LLM. */
  doccheck: {
    /** Per-call char budget over the rendered findings (kept whole, in ranked order). */
    maxChars: number;
    /** Max `undocumented` symbol entries reported per call. */
    undocumentedLimit: number;
    /**
     * Semantic judge model tag (D1b, default off): when set, a local instruct
     * model re-adjudicates the uncertain claims (yes/no completion logprobs,
     * reranker-style). Empty = the judge never runs, reports stay byte-identical.
     */
    judgeModel: string;
    /** The judge's base URL; empty = the resolved embedding backend (like `search.rerank.url`). */
    judgeUrl: string;
    /**
     * Watch/loop mode (proposal D1c, default off): when true, every successful
     * `index`/`migrate` job completion enqueues a `doccheck` job for that
     * project (never more than one queued/running per project), which re-runs
     * the deterministic check and stores the latest report in the registry —
     * `cidx doccheck <project> --last` reads that snapshot.
     */
    watch: boolean;
  };
  daemon: {
    /**
     * Shut the daemon down after this many minutes without activity
     * (proposal O4). Activity = any control-API/MCP HTTP request, a queued or
     * running index job, or an open MCP session (stdio-bridge heartbeat).
     * 0 disables idle shutdown (the default — behavior is unchanged).
     */
    idleTimeoutMinutes: number;
  };
}

const DEFAULTS: IndexerConfig = {
  home: path.join(os.homedir(), ".cidx"),
  server: { host: "127.0.0.1", mcpPort: 9371, controlPort: 9372 },
  // The bare `qwen3-embedding` tag resolves to the 8B variant in Ollama; the
  // default is pinned to :0.6b so a fresh install does not pull 4.6 GB for
  // chunks that are at most ~512 tokens. Override per project via `.cidx.json`
  // `embedModel` (or globally here / via OLLAMA_MODEL).
  ollama: {
    url: "http://127.0.0.1:11434",
    model: "qwen3-embedding:0.6b",
    batchSize: 8,
    concurrency: 4,
    numCtx: 1024,
  },
  // framing stays "none": existing installs embed byte-identically; "auto" is opt-in.
  embedding: { cacheMax: 50000, provider: "auto", llamacppUrl: "http://127.0.0.1:8080", framing: "none" },
  indexing: {
    maxChunkSize: 1500,
    overlapSize: 200,
    maxChunkTokens: 512,
    allowedExtensions: [
      ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs",
      ".java", ".cpp", ".cc", ".c", ".h", ".hpp",
      ".cs", ".php", ".rb",
      ".kt", ".kts", ".swift", ".scala", ".sc",
      ".gd",
      // Godot text formats without a grammar — character-fallback chunking
      // (like .json/.md): shaders, scenes, resources, project.godot.
      ".gdshader", ".tscn", ".tres", ".godot",
      ".json", ".md",
      // Doc formats without a grammar — character-fallback chunking with a
      // language label (see TEXT_LANG_BY_EXT): engine class reference (.xml,
      // e.g. `godot --doctool` dumps) and reStructuredText (.rst, e.g.
      // godotengine/godot-docs).
      ".xml", ".rst",
    ],
    ignoredDirs: [
      "node_modules", ".git", ".lancedb", "dist", "build",
      "out", ".cache", "target", ".claude", ".cidx",
      ".godot",
      // Python environments/caches and JS bundler caches: generated trees that
      // can dominate a project's file count (a `.venv` alone can hold 10^5
      // files, and the watcher opens a handle per watched file).
      ".venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
      ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".gradle", ".idea",
    ],
    maxFileSizeBytes: 0,
    vectorIndexThreshold: 50000,
    respectGitignore: true,
    gitTrackedOnly: false,
    docstrings: true,
    jobConcurrency: 2,
  },
  watcher: { debounceMs: 300 },
  search: {
    queryLogSize: 10000,
    expand: { model: "", url: "", maxVariants: 3, timeoutMs: 10000 },
    rerank: { enabled: true, model: "qwen3-reranker-q8", topK: 20, concurrency: 4, numCtx: 1024, url: "" },
    mmr: { enabled: true, lambda: 0.5, topK: 20 },
    boost: {
      enabled: true,
      shortPath: 0.1,
      sourceRoot: 0.05,
      testDemotion: 0.85,
      generatedDemotion: 0.8,
      sourceRoots: ["src", "lib", "app"],
    },
  },
  doccheck: { maxChars: 12000, undocumentedLimit: 25, judgeModel: "", judgeUrl: "", watch: false },
  daemon: { idleTimeoutMinutes: 0 },
};

/** Editable default YAML template (written if the file does not exist). */
export const DEFAULT_CONFIG_YAML = `# cidx configuration
# Restart the daemon after making changes.

# The root directory where all data (LanceDB + meta.db + log) is stored.
home: ${DEFAULTS.home}

server:
  host: ${DEFAULTS.server.host}        # localhost only is recommended
  mcpPort: ${DEFAULTS.server.mcpPort}        # AI agent (MCP/SSE)
  controlPort: ${DEFAULTS.server.controlPort}    # CLI control API

ollama:
  url: ${DEFAULTS.ollama.url}
  model: ${DEFAULTS.ollama.model}   # :0.6b is enough for ~512-token chunks; the bare tag is the 8B model
  numCtx: ${DEFAULTS.ollama.numCtx}              # Ollama num_ctx for embed calls (chunks are ≤512 tokens + headroom); Ollama defaults to 4096 and allocates that buffer per loaded model
  batchSize: ${DEFAULTS.ollama.batchSize}              # number of chunks per embed request
  concurrency: ${DEFAULTS.ollama.concurrency}

embedding:
  cacheMax: ${DEFAULTS.embedding.cacheMax}       # max records in the content-hash embedding cache
  provider: ${DEFAULTS.embedding.provider}       # auto | ollama | llamacpp; auto = an Ollama that has the model wins, else a live llama-server
  llamacppUrl: ${DEFAULTS.embedding.llamacppUrl}  # base URL of llama-server; start it: llama-server -m <model.gguf> -a <model> --ctx-size <numCtx> --embedding
  framing: ${DEFAULTS.embedding.framing}               # none | auto; auto = per-model task prefixes (EmbeddingGemma 2 docs/queries, qwen3 query instruction); unknown models stay unframed; a change re-embeds via migration

indexing:
  maxChunkSize: ${DEFAULTS.indexing.maxChunkSize}
  overlapSize: ${DEFAULTS.indexing.overlapSize}
  maxChunkTokens: ${DEFAULTS.indexing.maxChunkTokens}            # approximate per-chunk token cap (effective chunk size = min(maxChunkSize, maxChunkTokens*4)); raise/lower to tune, then reindex
  allowedExtensions:
${DEFAULTS.indexing.allowedExtensions.map((e) => `    - "${e}"`).join("\n")}
  ignoredDirs:
${DEFAULTS.indexing.ignoredDirs.map((d) => `    - "${d}"`).join("\n")}
  maxFileSizeBytes: ${DEFAULTS.indexing.maxFileSizeBytes}             # skip files larger than this many bytes (an oversized-data-file guard); 0 = off; a per-project .cidx.json maxFileSizeBytes overrides it
  vectorIndexThreshold: ${DEFAULTS.indexing.vectorIndexThreshold}   # an ANN vector index is built when a table exceeds this chunk count
  respectGitignore: ${DEFAULTS.indexing.respectGitignore}           # also obey .gitignore rules
  gitTrackedOnly: ${DEFAULTS.indexing.gitTrackedOnly}            # index only git-tracked files (in git repos)
  docstrings: ${DEFAULTS.indexing.docstrings}                # embed each symbol's docstring/comment into a separate doc_vector (docstring search leg)
  jobConcurrency: ${DEFAULTS.indexing.jobConcurrency}              # number of indexing jobs running at the same time (worker pool)

search:
  queryLogSize: ${DEFAULTS.search.queryLogSize}          # max rows kept in the local query log (search analytics via 'cidx stats'); 0 = off
  expand:
    model: ""                   # local-LLM query expander; empty = expansion unavailable (an expand:true search degrades to the base search with a note). Needs an INSTRUCT model the backend serves (e.g. qwen3:0.6b) — not the embedding model
    url: ""                     # expansion base URL; empty = same server as the embedding backend
    maxVariants: ${DEFAULTS.search.expand.maxVariants}             # max variant queries one expanded search may add (empties, duplicates and the original are dropped)
    timeoutMs: ${DEFAULTS.search.expand.timeoutMs}           # the single completion call aborts at this deadline; the search then returns the plain base results
  rerank:
    enabled: ${DEFAULTS.search.rerank.enabled}            # on by default; auto-disables if the reranker model is absent in Ollama
    model: ${DEFAULTS.search.rerank.model}    # causal-LM reranker; scored via yes/no token logprobs
    topK: ${DEFAULTS.search.rerank.topK}                  # how many candidates to rerank before slicing to limit
    concurrency: ${DEFAULTS.search.rerank.concurrency}              # concurrent reranker calls to the backend
    numCtx: ${DEFAULTS.search.rerank.numCtx}              # Ollama num_ctx for the rerank prompt (query + one chunk + template ≈ 500 tokens)
    url: ""                     # reranker base URL; empty = same server as the embedding backend (a llama.cpp reranker usually needs its own)
  mmr:
    enabled: true              # diversify the top results (Maximal Marginal Relevance)
    lambda: 0.5                # 1.0 = pure relevance, 0.0 = pure diversity
    topK: 20                   # how many candidates to diversify over before slicing to limit
  boost:
    enabled: ${DEFAULTS.search.boost.enabled}              # nudge RRF-merged results by path/surface signals (single-leg results untouched)
    shortPath: ${DEFAULTS.search.boost.shortPath}             # max bonus for short project-relative paths (fades in with the log of the path length)
    sourceRoot: ${DEFAULTS.search.boost.sourceRoot}           # bonus when a path starts with a conventional source root
    testDemotion: ${DEFAULTS.search.boost.testDemotion}         # demotion multiplier for test files
    generatedDemotion: ${DEFAULTS.search.boost.generatedDemotion}     # demotion multiplier for generated/artifact paths (gen/dist/build/vendor/node_modules, .pb.go, .min.*)
    sourceRoots:              # directories that count as conventional source roots
${DEFAULTS.search.boost.sourceRoots.map((d) => `      - "${d}"`).join("\n")}

doccheck:
  maxChars: ${DEFAULTS.doccheck.maxChars}          # per-call char budget over the rendered findings (kept whole)
  undocumentedLimit: ${DEFAULTS.doccheck.undocumentedLimit}   # max undocumented-symbol entries per report
  judgeModel: "${DEFAULTS.doccheck.judgeModel}"                # local instruct model that re-judges uncertain claims via yes/no logprobs; empty = off
  judgeUrl: "${DEFAULTS.doccheck.judgeUrl}"                    # judge base URL; empty = same server as the embedding backend
  watch: ${DEFAULTS.doccheck.watch}                    # after each successful index/migrate job, re-run the deterministic check and store the report (cidx doccheck <project> --last reads it)

watcher:
  debounceMs: ${DEFAULTS.watcher.debounceMs}        # reindexing delay after a file change

daemon:
  idleTimeoutMinutes: ${DEFAULTS.daemon.idleTimeoutMinutes}        # exit the daemon after N minutes without activity (requests, index jobs, open MCP sessions); 0 = off. Every cidx command / MCP entry point restarts it on demand.
`;

// ---- helpers ----
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
function num(v: string | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/** Env mirror for boolean flags: only the four canonical spellings resolve. */
function envBool(v: string | undefined): boolean | undefined {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function configHomeBase(): string {
  return expandHome(process.env.CIDX_HOME ?? DEFAULTS.home);
}

/**
 * One-time migration from the pre-rename data home: ~/.mcp-indexer → ~/.cidx.
 * Runs only when the new default home does not exist yet and the old one does,
 * and only for the *default* home (an explicit $CIDX_HOME is the user's own
 * choice and is never auto-populated). Also skipped when $CIDX_CONFIG is set
 * (an explicitly provided config file means the caller manages their own setup)
 * or under a test run (`bun test` sets NODE_ENV=test) so tests never touch real
 * user data. Idempotent: after the move the old dir is gone, so subsequent
 * boots are no-ops.
 */
const LEGACY_DEFAULT_HOME = path.join(os.homedir(), ".mcp-indexer");
function migrateLegacyHome(home: string): void {
  if (home !== DEFAULTS.home || process.env.CIDX_CONFIG || process.env.NODE_ENV === "test") return;
  if (existsSync(DEFAULTS.home) || !existsSync(LEGACY_DEFAULT_HOME)) return;
  try {
    renameSync(LEGACY_DEFAULT_HOME, DEFAULTS.home);
    // The default config template pins `home:` to an absolute path; a config
    // written by an older release points at the old home, which would make the
    // daemon recreate ~/.mcp-indexer on the next boot. Rewrite it in place.
    const cfgPath = path.join(DEFAULTS.home, "config.yml");
    if (existsSync(cfgPath)) {
      const text = readFileSync(cfgPath, "utf-8");
      // The old default template also listed the old home dir name under
      // indexing.ignoredDirs — swap that literal for the new one as well.
      const patched = text
        .split(LEGACY_DEFAULT_HOME)
        .join(DEFAULTS.home)
        .replace('    - ".mcp-indexer"', '    - ".cidx"');
      if (patched !== text) writeFileSync(cfgPath, patched);
    }
    console.error(`[config] migrated data home: ${LEGACY_DEFAULT_HOME} → ${DEFAULTS.home}`);
  } catch (err) {
    console.error(`[config] failed to migrate ${LEGACY_DEFAULT_HOME} → ${DEFAULTS.home}:`, err);
  }
}

/** Resolves the YAML file path; creates the default file if needed. */
export function resolveConfigPath(): string | null {
  migrateLegacyHome(configHomeBase());
  if (process.env.CIDX_CONFIG) return process.env.CIDX_CONFIG;
  for (const c of ["cidx.yml", ".cidx.yml", "cidx.yaml"]) {
    const p = path.resolve(process.cwd(), c);
    if (existsSync(p)) return p;
  }
  const homeConfig = path.join(configHomeBase(), "config.yml");
  if (existsSync(homeConfig)) return homeConfig;
  // If absent, create the default.
  try {
    mkdirSync(configHomeBase(), { recursive: true });
    writeFileSync(homeConfig, DEFAULT_CONFIG_YAML, { flag: "wx" });
    return homeConfig;
  } catch {
    return existsSync(homeConfig) ? homeConfig : null;
  }
}

function loadYaml(p: string | null): Record<string, any> {
  if (!p || !existsSync(p)) return {};
  try {
    return (parseYaml(readFileSync(p, "utf-8")) as Record<string, any>) ?? {};
  } catch (err) {
    console.error(`[config] failed to read '${p}', using defaults:`, err);
    return {};
  }
}

export const CONFIG_SOURCE = resolveConfigPath();
const y = loadYaml(CONFIG_SOURCE);

/** Resolved configuration (default < YAML < environment variable). */
export const RESOLVED: IndexerConfig = {
  home: expandHome(process.env.CIDX_HOME ?? y.home ?? DEFAULTS.home),
  server: {
    host: process.env.HOST ?? y.server?.host ?? DEFAULTS.server.host,
    mcpPort: num(process.env.MCP_PORT) ?? y.server?.mcpPort ?? DEFAULTS.server.mcpPort,
    controlPort: num(process.env.CONTROL_PORT) ?? y.server?.controlPort ?? DEFAULTS.server.controlPort,
  },
  ollama: {
    url: process.env.OLLAMA_URL ?? y.ollama?.url ?? DEFAULTS.ollama.url,
    model: process.env.OLLAMA_MODEL ?? y.ollama?.model ?? DEFAULTS.ollama.model,
    batchSize: num(process.env.EMBED_BATCH_SIZE) ?? y.ollama?.batchSize ?? DEFAULTS.ollama.batchSize,
    concurrency: num(process.env.EMBED_CONCURRENCY) ?? y.ollama?.concurrency ?? DEFAULTS.ollama.concurrency,
    numCtx: num(process.env.OLLAMA_NUM_CTX) ?? y.ollama?.numCtx ?? DEFAULTS.ollama.numCtx,
  },
  embedding: {
    cacheMax: num(process.env.EMBED_CACHE_MAX) ?? y.embedding?.cacheMax ?? DEFAULTS.embedding.cacheMax,
    provider: (() => {
      const raw = process.env.EMBED_PROVIDER ?? y.embedding?.provider ?? DEFAULTS.embedding.provider;
      if (EMBED_PROVIDER_VALUES.includes(raw)) return raw as EmbedProviderSetting;
      console.error(`[config] embedding.provider: '${raw}' is not one of auto/ollama/llamacpp — using 'auto'`);
      return "auto" as const;
    })(),
    llamacppUrl: process.env.LLAMACPP_URL ?? y.embedding?.llamacppUrl ?? DEFAULTS.embedding.llamacppUrl,
    framing: (() => {
      const raw = process.env.EMBEDDING_FRAMING ?? y.embedding?.framing ?? DEFAULTS.embedding.framing;
      if (raw === "none" || raw === "auto") return raw;
      console.error(`[config] embedding.framing: '${raw}' is not one of none/auto — using 'none'`);
      return "none" as const;
    })(),
  },
  indexing: {
    maxChunkSize: y.indexing?.maxChunkSize ?? DEFAULTS.indexing.maxChunkSize,
    overlapSize: y.indexing?.overlapSize ?? DEFAULTS.indexing.overlapSize,
    maxChunkTokens:
      num(process.env.MAX_CHUNK_TOKENS) ?? y.indexing?.maxChunkTokens ?? DEFAULTS.indexing.maxChunkTokens,
    allowedExtensions: strArray(y.indexing?.allowedExtensions) ?? DEFAULTS.indexing.allowedExtensions,
    ignoredDirs: strArray(y.indexing?.ignoredDirs) ?? DEFAULTS.indexing.ignoredDirs,
    // Passed through as given (like daemon.idleTimeoutMinutes): the consumers
    // (collectFiles / indexFile) treat anything <= 0 as "off", so `-1` reads as
    // the same opt-out as 0 and a fractional value simply acts as its byte cap.
    maxFileSizeBytes:
      num(process.env.MAX_FILE_SIZE_BYTES) ?? y.indexing?.maxFileSizeBytes ?? DEFAULTS.indexing.maxFileSizeBytes,
    vectorIndexThreshold:
      num(process.env.VECTOR_INDEX_THRESHOLD) ??
      y.indexing?.vectorIndexThreshold ??
      DEFAULTS.indexing.vectorIndexThreshold,
    respectGitignore:
      typeof y.indexing?.respectGitignore === "boolean"
        ? y.indexing.respectGitignore
        : DEFAULTS.indexing.respectGitignore,
    gitTrackedOnly:
      typeof y.indexing?.gitTrackedOnly === "boolean"
        ? y.indexing.gitTrackedOnly
        : DEFAULTS.indexing.gitTrackedOnly,
    docstrings:
      typeof y.indexing?.docstrings === "boolean"
        ? y.indexing.docstrings
        : DEFAULTS.indexing.docstrings,
    jobConcurrency:
      num(process.env.JOB_CONCURRENCY) ??
      y.indexing?.jobConcurrency ??
      DEFAULTS.indexing.jobConcurrency,
  },
  watcher: { debounceMs: y.watcher?.debounceMs ?? DEFAULTS.watcher.debounceMs },
  search: {
    queryLogSize:
      num(process.env.QUERY_LOG_SIZE) ?? y.search?.queryLogSize ?? DEFAULTS.search.queryLogSize,
    expand: {
      model: process.env.EXPAND_MODEL ?? y.search?.expand?.model ?? DEFAULTS.search.expand.model,
      url: process.env.EXPAND_URL ?? y.search?.expand?.url ?? DEFAULTS.search.expand.url,
      maxVariants:
        num(process.env.EXPAND_MAX_VARIANTS) ??
        y.search?.expand?.maxVariants ??
        DEFAULTS.search.expand.maxVariants,
      timeoutMs:
        num(process.env.EXPAND_TIMEOUT_MS) ??
        y.search?.expand?.timeoutMs ??
        DEFAULTS.search.expand.timeoutMs,
    },
    rerank: {
      enabled:
        typeof y.search?.rerank?.enabled === "boolean"
          ? y.search.rerank.enabled
          : DEFAULTS.search.rerank.enabled,
      model: process.env.RERANK_MODEL ?? y.search?.rerank?.model ?? DEFAULTS.search.rerank.model,
      topK: num(process.env.RERANK_TOP_K) ?? y.search?.rerank?.topK ?? DEFAULTS.search.rerank.topK,
      concurrency:
        num(process.env.RERANK_CONCURRENCY) ??
        y.search?.rerank?.concurrency ??
        DEFAULTS.search.rerank.concurrency,
      numCtx:
        num(process.env.RERANK_NUM_CTX) ?? y.search?.rerank?.numCtx ?? DEFAULTS.search.rerank.numCtx,
      url: process.env.RERANK_URL ?? y.search?.rerank?.url ?? DEFAULTS.search.rerank.url,
    },
    mmr: {
      enabled:
        typeof y.search?.mmr?.enabled === "boolean"
          ? y.search.mmr.enabled
          : DEFAULTS.search.mmr.enabled,
      lambda: num(process.env.MMR_LAMBDA) ?? y.search?.mmr?.lambda ?? DEFAULTS.search.mmr.lambda,
      topK: num(process.env.MMR_TOP_K) ?? y.search?.mmr?.topK ?? DEFAULTS.search.mmr.topK,
    },
    boost: {
      enabled:
        typeof y.search?.boost?.enabled === "boolean"
          ? y.search.boost.enabled
          : DEFAULTS.search.boost.enabled,
      shortPath:
        num(process.env.BOOST_SHORT_PATH) ?? y.search?.boost?.shortPath ?? DEFAULTS.search.boost.shortPath,
      sourceRoot:
        num(process.env.BOOST_SOURCE_ROOT) ?? y.search?.boost?.sourceRoot ?? DEFAULTS.search.boost.sourceRoot,
      testDemotion:
        num(process.env.BOOST_TEST_DEMOTION) ??
        y.search?.boost?.testDemotion ??
        DEFAULTS.search.boost.testDemotion,
      generatedDemotion:
        num(process.env.BOOST_GENERATED_DEMOTION) ??
        y.search?.boost?.generatedDemotion ??
        DEFAULTS.search.boost.generatedDemotion,
      sourceRoots: strArray(y.search?.boost?.sourceRoots) ?? DEFAULTS.search.boost.sourceRoots,
    },
  },
  doccheck: {
    maxChars: num(process.env.DOC_CHECK_MAX_CHARS) ?? y.doccheck?.maxChars ?? DEFAULTS.doccheck.maxChars,
    undocumentedLimit:
      num(process.env.DOC_CHECK_UNDOCUMENTED) ??
      y.doccheck?.undocumentedLimit ??
      DEFAULTS.doccheck.undocumentedLimit,
    judgeModel: process.env.DOC_CHECK_JUDGE_MODEL ?? y.doccheck?.judgeModel ?? DEFAULTS.doccheck.judgeModel,
    judgeUrl: process.env.DOC_CHECK_JUDGE_URL ?? y.doccheck?.judgeUrl ?? DEFAULTS.doccheck.judgeUrl,
    watch:
      envBool(process.env.DOC_CHECK_WATCH) ??
      (typeof y.doccheck?.watch === "boolean" ? y.doccheck.watch : DEFAULTS.doccheck.watch),
  },
  daemon: {
    // A negative value is deliberately passed through: shouldIdleShutdown
    // treats anything <= 0 as "off", so `-1` reads as the same opt-out as 0.
    idleTimeoutMinutes:
      num(process.env.DAEMON_IDLE_TIMEOUT_MINUTES) ??
      y.daemon?.idleTimeoutMinutes ??
      DEFAULTS.daemon.idleTimeoutMinutes,
  },
};

/**
 * Backward-compatible, flattened configuration.
 * The rest of the codebase uses this constant.
 */
export const CONFIG = {
  ROOT_DIR: RESOLVED.home,
  DB_DIR: path.join(RESOLVED.home, "db"),
  META_DB_PATH: path.join(RESOLVED.home, "meta.db"),

  OLLAMA_URL: RESOLVED.ollama.url,
  OLLAMA_MODEL: RESOLVED.ollama.model,
  OLLAMA_NUM_CTX: RESOLVED.ollama.numCtx,
  EMBED_BATCH_SIZE: RESOLVED.ollama.batchSize,
  EMBED_CONCURRENCY: RESOLVED.ollama.concurrency,
  EMBED_CACHE_MAX: RESOLVED.embedding.cacheMax,
  EMBED_PROVIDER: RESOLVED.embedding.provider,
  LLAMACPP_URL: RESOLVED.embedding.llamacppUrl,
  EMBEDDING_FRAMING: RESOLVED.embedding.framing,

  ALLOWED_EXTENSIONS: RESOLVED.indexing.allowedExtensions,
  GLOBAL_IGNORED_DIRS: RESOLVED.indexing.ignoredDirs,
  MAX_FILE_SIZE_BYTES: RESOLVED.indexing.maxFileSizeBytes,
  MAX_CHUNK_SIZE: RESOLVED.indexing.maxChunkSize,
  OVERLAP_SIZE: RESOLVED.indexing.overlapSize,
  MAX_CHUNK_TOKENS: RESOLVED.indexing.maxChunkTokens,
  VECTOR_INDEX_THRESHOLD: RESOLVED.indexing.vectorIndexThreshold,
  RESPECT_GITIGNORE: RESOLVED.indexing.respectGitignore,
  GIT_TRACKED_ONLY: RESOLVED.indexing.gitTrackedOnly,
  DOCSTRINGS: RESOLVED.indexing.docstrings,
  JOB_CONCURRENCY: RESOLVED.indexing.jobConcurrency,

  WATCH_DEBOUNCE_MS: RESOLVED.watcher.debounceMs,

  RERANK_ENABLED: RESOLVED.search.rerank.enabled,
  RERANK_MODEL: RESOLVED.search.rerank.model,
  RERANK_TOP_K: RESOLVED.search.rerank.topK,
  RERANK_CONCURRENCY: RESOLVED.search.rerank.concurrency,
  RERANK_NUM_CTX: RESOLVED.search.rerank.numCtx,
  RERANK_URL: RESOLVED.search.rerank.url,

  MMR_ENABLED: RESOLVED.search.mmr.enabled,
  MMR_LAMBDA: RESOLVED.search.mmr.lambda,
  MMR_TOP_K: RESOLVED.search.mmr.topK,

  BOOST_ENABLED: RESOLVED.search.boost.enabled,
  BOOST_SHORT_PATH: RESOLVED.search.boost.shortPath,
  BOOST_SOURCE_ROOT: RESOLVED.search.boost.sourceRoot,
  BOOST_TEST_DEMOTION: RESOLVED.search.boost.testDemotion,
  BOOST_GENERATED_DEMOTION: RESOLVED.search.boost.generatedDemotion,
  BOOST_SOURCE_ROOTS: RESOLVED.search.boost.sourceRoots,

  QUERY_LOG_SIZE: RESOLVED.search.queryLogSize,

  EXPAND_MODEL: RESOLVED.search.expand.model,
  EXPAND_URL: RESOLVED.search.expand.url,
  EXPAND_MAX_VARIANTS: RESOLVED.search.expand.maxVariants,
  EXPAND_TIMEOUT_MS: RESOLVED.search.expand.timeoutMs,

  DOC_CHECK_MAX_CHARS: RESOLVED.doccheck.maxChars,
  DOC_CHECK_UNDOCUMENTED: RESOLVED.doccheck.undocumentedLimit,
  DOC_CHECK_JUDGE_MODEL: RESOLVED.doccheck.judgeModel,
  DOC_CHECK_JUDGE_URL: RESOLVED.doccheck.judgeUrl,
  DOC_CHECK_WATCH: RESOLVED.doccheck.watch,

  HOST: RESOLVED.server.host,
  MCP_PORT: RESOLVED.server.mcpPort,
  CONTROL_PORT: RESOLVED.server.controlPort,

  IDLE_TIMEOUT_MINUTES: RESOLVED.daemon.idleTimeoutMinutes,
} as const;

export type Config = typeof CONFIG;
