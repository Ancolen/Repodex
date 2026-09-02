import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { parse as parseYaml } from "yaml";

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

export interface IndexerConfig {
  home: string;
  server: { host: string; mcpPort: number; controlPort: number };
  ollama: { url: string; model: string; batchSize: number; concurrency: number };
  embedding: { cacheMax: number };
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
    rerank: {
      /** If true, a second-stage reranker refines results by default (per-call override via the search API). */
      enabled: boolean;
      /** Ollama tag of the causal-LM reranker model (scored via yes/no logprobs). Empty string disables. */
      model: string;
      /** How many of the top candidates to rerank before slicing to the requested `limit`. */
      topK: number;
      /** Max concurrent reranker calls to Ollama. */
      concurrency: number;
    };
    mmr: {
      /** If true, MMR diversifies the top results by default (per-call override via the search API). */
      enabled: boolean;
      /** Relevance vs diversity tradeoff: 1 = pure relevance, 0 = pure diversity. */
      lambda: number;
      /** How many of the top candidates to diversify over before slicing to the requested `limit`. */
      topK: number;
    };
  };
}

const DEFAULTS: IndexerConfig = {
  home: path.join(os.homedir(), ".cidx"),
  server: { host: "127.0.0.1", mcpPort: 9371, controlPort: 9372 },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen3-embedding", batchSize: 8, concurrency: 4 },
  embedding: { cacheMax: 50000 },
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
    ],
    vectorIndexThreshold: 50000,
    respectGitignore: true,
    gitTrackedOnly: false,
    docstrings: true,
    jobConcurrency: 2,
  },
  watcher: { debounceMs: 300 },
  search: {
    rerank: { enabled: true, model: "qwen3-reranker-q8", topK: 20, concurrency: 4 },
    mmr: { enabled: true, lambda: 0.5, topK: 20 },
  },
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
  model: ${DEFAULTS.ollama.model}
  batchSize: ${DEFAULTS.ollama.batchSize}              # number of chunks per embed request
  concurrency: ${DEFAULTS.ollama.concurrency}

embedding:
  cacheMax: ${DEFAULTS.embedding.cacheMax}       # max records in the content-hash embedding cache

indexing:
  maxChunkSize: ${DEFAULTS.indexing.maxChunkSize}
  overlapSize: ${DEFAULTS.indexing.overlapSize}
  maxChunkTokens: ${DEFAULTS.indexing.maxChunkTokens}            # approximate per-chunk token cap (effective chunk size = min(maxChunkSize, maxChunkTokens*4)); raise/lower to tune, then reindex
  allowedExtensions:
${DEFAULTS.indexing.allowedExtensions.map((e) => `    - "${e}"`).join("\n")}
  ignoredDirs:
${DEFAULTS.indexing.ignoredDirs.map((d) => `    - "${d}"`).join("\n")}
  vectorIndexThreshold: ${DEFAULTS.indexing.vectorIndexThreshold}   # an ANN vector index is built when a table exceeds this chunk count
  respectGitignore: ${DEFAULTS.indexing.respectGitignore}           # also obey .gitignore rules
  gitTrackedOnly: ${DEFAULTS.indexing.gitTrackedOnly}            # index only git-tracked files (in git repos)
  docstrings: ${DEFAULTS.indexing.docstrings}                # embed each symbol's docstring/comment into a separate doc_vector (docstring search leg)
  jobConcurrency: ${DEFAULTS.indexing.jobConcurrency}              # number of indexing jobs running at the same time (worker pool)

search:
  rerank:
    enabled: ${DEFAULTS.search.rerank.enabled}            # on by default; auto-disables if the reranker model is absent in Ollama
    model: ${DEFAULTS.search.rerank.model}    # causal-LM reranker; scored via yes/no token logprobs
    topK: ${DEFAULTS.search.rerank.topK}                  # how many candidates to rerank before slicing to limit
    concurrency: ${DEFAULTS.search.rerank.concurrency}              # concurrent reranker calls to Ollama
  mmr:
    enabled: true              # diversify the top results (Maximal Marginal Relevance)
    lambda: 0.5                # 1.0 = pure relevance, 0.0 = pure diversity
    topK: 20                   # how many candidates to diversify over before slicing to limit

watcher:
  debounceMs: ${DEFAULTS.watcher.debounceMs}        # reindexing delay after a file change
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
  },
  embedding: {
    cacheMax: num(process.env.EMBED_CACHE_MAX) ?? y.embedding?.cacheMax ?? DEFAULTS.embedding.cacheMax,
  },
  indexing: {
    maxChunkSize: y.indexing?.maxChunkSize ?? DEFAULTS.indexing.maxChunkSize,
    overlapSize: y.indexing?.overlapSize ?? DEFAULTS.indexing.overlapSize,
    maxChunkTokens:
      num(process.env.MAX_CHUNK_TOKENS) ?? y.indexing?.maxChunkTokens ?? DEFAULTS.indexing.maxChunkTokens,
    allowedExtensions: strArray(y.indexing?.allowedExtensions) ?? DEFAULTS.indexing.allowedExtensions,
    ignoredDirs: strArray(y.indexing?.ignoredDirs) ?? DEFAULTS.indexing.ignoredDirs,
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
    },
    mmr: {
      enabled:
        typeof y.search?.mmr?.enabled === "boolean"
          ? y.search.mmr.enabled
          : DEFAULTS.search.mmr.enabled,
      lambda: num(process.env.MMR_LAMBDA) ?? y.search?.mmr?.lambda ?? DEFAULTS.search.mmr.lambda,
      topK: num(process.env.MMR_TOP_K) ?? y.search?.mmr?.topK ?? DEFAULTS.search.mmr.topK,
    },
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
  EMBED_BATCH_SIZE: RESOLVED.ollama.batchSize,
  EMBED_CONCURRENCY: RESOLVED.ollama.concurrency,
  EMBED_CACHE_MAX: RESOLVED.embedding.cacheMax,

  ALLOWED_EXTENSIONS: RESOLVED.indexing.allowedExtensions,
  GLOBAL_IGNORED_DIRS: RESOLVED.indexing.ignoredDirs,
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

  MMR_ENABLED: RESOLVED.search.mmr.enabled,
  MMR_LAMBDA: RESOLVED.search.mmr.lambda,
  MMR_TOP_K: RESOLVED.search.mmr.topK,

  HOST: RESOLVED.server.host,
  MCP_PORT: RESOLVED.server.mcpPort,
  CONTROL_PORT: RESOLVED.server.controlPort,
} as const;

export type Config = typeof CONFIG;
