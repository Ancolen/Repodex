import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/**
 * Configuration layer.
 *
 * Priority (low to high): in-code defaults < YAML file < environment variables.
 *
 * The YAML file is searched in this order:
 *   1) $INDEXER_CONFIG (full path)
 *   2) ./indexer.yml or ./.indexer.yml (working directory)
 *   3) <home>/config.yml  (home = $MCP_INDEXER_HOME or ~/.mcp-indexer)
 * If none exist, a default file with comments is CREATED at location (3).
 */

export interface IndexerConfig {
  home: string;
  server: { host: string; mcpPort: number; controlPort: number };
  ollama: { url: string; model: string; batchSize: number; concurrency: number };
  embedding: { cacheMax: number };
  indexing: {
    maxChunkSize: number;
    overlapSize: number;
    allowedExtensions: string[];
    ignoredDirs: string[];
    /** An ANN vector index is built when a table reaches this row count. */
    vectorIndexThreshold: number;
    /** If true, .gitignore rules are also added to the ignore matcher. */
    respectGitignore: boolean;
    /** If true, only git-tracked files are indexed (in git repos). */
    gitTrackedOnly: boolean;
    /** Number of indexing jobs that can run at the same time (worker pool). */
    jobConcurrency: number;
  };
  watcher: { debounceMs: number };
}

const DEFAULTS: IndexerConfig = {
  home: path.join(os.homedir(), ".mcp-indexer"),
  server: { host: "127.0.0.1", mcpPort: 3001, controlPort: 3002 },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen3-embedding", batchSize: 8, concurrency: 4 },
  embedding: { cacheMax: 50000 },
  indexing: {
    maxChunkSize: 1500,
    overlapSize: 200,
    allowedExtensions: [
      ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs",
      ".java", ".cpp", ".cc", ".c", ".h", ".hpp",
      ".cs", ".php", ".rb",
      ".kt", ".kts", ".swift", ".scala", ".sc",
      ".json", ".md",
    ],
    ignoredDirs: [
      "node_modules", ".git", ".lancedb", "dist", "build",
      "out", ".cache", "target", ".claude", ".mcp-indexer",
    ],
    vectorIndexThreshold: 50000,
    respectGitignore: true,
    gitTrackedOnly: false,
    jobConcurrency: 2,
  },
  watcher: { debounceMs: 300 },
};

/** Editable default YAML template (written if the file does not exist). */
export const DEFAULT_CONFIG_YAML = `# mcp-code-indexer configuration
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
  allowedExtensions:
${DEFAULTS.indexing.allowedExtensions.map((e) => `    - "${e}"`).join("\n")}
  ignoredDirs:
${DEFAULTS.indexing.ignoredDirs.map((d) => `    - "${d}"`).join("\n")}
  vectorIndexThreshold: ${DEFAULTS.indexing.vectorIndexThreshold}   # an ANN vector index is built when a table exceeds this chunk count
  respectGitignore: ${DEFAULTS.indexing.respectGitignore}           # also obey .gitignore rules
  gitTrackedOnly: ${DEFAULTS.indexing.gitTrackedOnly}            # index only git-tracked files (in git repos)
  jobConcurrency: ${DEFAULTS.indexing.jobConcurrency}              # number of indexing jobs running at the same time (worker pool)

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
  return expandHome(process.env.MCP_INDEXER_HOME ?? DEFAULTS.home);
}

/** Resolves the YAML file path; creates the default file if needed. */
export function resolveConfigPath(): string | null {
  if (process.env.INDEXER_CONFIG) return process.env.INDEXER_CONFIG;
  for (const c of ["indexer.yml", ".indexer.yml", "indexer.yaml"]) {
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
  home: expandHome(process.env.MCP_INDEXER_HOME ?? y.home ?? DEFAULTS.home),
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
    jobConcurrency:
      num(process.env.JOB_CONCURRENCY) ??
      y.indexing?.jobConcurrency ??
      DEFAULTS.indexing.jobConcurrency,
  },
  watcher: { debounceMs: y.watcher?.debounceMs ?? DEFAULTS.watcher.debounceMs },
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
  VECTOR_INDEX_THRESHOLD: RESOLVED.indexing.vectorIndexThreshold,
  RESPECT_GITIGNORE: RESOLVED.indexing.respectGitignore,
  GIT_TRACKED_ONLY: RESOLVED.indexing.gitTrackedOnly,
  JOB_CONCURRENCY: RESOLVED.indexing.jobConcurrency,

  WATCH_DEBOUNCE_MS: RESOLVED.watcher.debounceMs,

  HOST: RESOLVED.server.host,
  MCP_PORT: RESOLVED.server.mcpPort,
  CONTROL_PORT: RESOLVED.server.controlPort,
} as const;

export type Config = typeof CONFIG;
