/**
 * Configuration layer tests (config.ts).
 *
 * CONFIG is resolved once based on process.env when the module is imported. Therefore,
 * each scenario is run in an isolated subprocess. INDEXER_CONFIG is set to a non-existent
 * path so that the user's real config.yml and indexer.yml in cwd are disabled
 * -> only in-code defaults + environment variables take effect.
 */
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const FIXTURE = join(import.meta.dir, "fixtures", "print-config.ts");
const NO_YAML = join(tmpdir(), `mcp-no-such-config-${crypto.randomUUID()}.yml`);

async function runConfig(env: Record<string, string>): Promise<{ CONFIG: any; CONFIG_SOURCE: string | null }> {
  const proc = Bun.spawn(["bun", "run", FIXTURE], {
    env: { ...process.env, INDEXER_CONFIG: NO_YAML, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const line = out.trim().split("\n").pop()!;
  return JSON.parse(line);
}

describe("config — defaults and environment variable overrides", () => {
  test("in-code defaults apply when YAML is missing", async () => {
    const { CONFIG } = await runConfig({});
    expect(CONFIG.OLLAMA_MODEL).toBe("qwen3-embedding");
    expect(CONFIG.EMBED_BATCH_SIZE).toBe(8);
    expect(CONFIG.EMBED_CONCURRENCY).toBe(4);
    expect(CONFIG.MAX_CHUNK_SIZE).toBe(1500);
    expect(CONFIG.OVERLAP_SIZE).toBe(200);
    expect(CONFIG.MCP_PORT).toBe(3001);
    expect(CONFIG.CONTROL_PORT).toBe(3002);
  });

  test("OLLAMA_MODEL / EMBED_* environment variables override defaults", async () => {
    const { CONFIG } = await runConfig({
      OLLAMA_MODEL: "qwen3-embedding:8b-q8_0",
      EMBED_BATCH_SIZE: "16",
      EMBED_CONCURRENCY: "2",
      EMBED_CACHE_MAX: "12345",
    });
    expect(CONFIG.OLLAMA_MODEL).toBe("qwen3-embedding:8b-q8_0");
    expect(CONFIG.EMBED_BATCH_SIZE).toBe(16);
    expect(CONFIG.EMBED_CONCURRENCY).toBe(2);
    expect(CONFIG.EMBED_CACHE_MAX).toBe(12345);
  });

  test("port and threshold environment variables are converted to numbers", async () => {
    const { CONFIG } = await runConfig({
      MCP_PORT: "4001",
      CONTROL_PORT: "4002",
      VECTOR_INDEX_THRESHOLD: "99999",
    });
    expect(CONFIG.MCP_PORT).toBe(4001);
    expect(CONFIG.CONTROL_PORT).toBe(4002);
    expect(CONFIG.VECTOR_INDEX_THRESHOLD).toBe(99999);
  });

  test("invalid numerical environment variables are ignored (fallback to default)", async () => {
    const { CONFIG } = await runConfig({ EMBED_BATCH_SIZE: "abc" });
    expect(CONFIG.EMBED_BATCH_SIZE).toBe(8);
  });

  test("MCP_INDEXER_HOME expands '~' and derived paths are located under home", async () => {
    const { CONFIG } = await runConfig({ MCP_INDEXER_HOME: "~/mcp-test-home" });
    const home = process.env.HOME!;
    expect(CONFIG.ROOT_DIR).toBe(join(home, "mcp-test-home"));
    expect(CONFIG.DB_DIR).toBe(join(home, "mcp-test-home", "db"));
    expect(CONFIG.META_DB_PATH).toBe(join(home, "mcp-test-home", "meta.db"));
  });

  test("allowedExtensions default covers extensions of the 12 grammars", async () => {
    const { CONFIG } = await runConfig({});
    for (const e of [".ts", ".js", ".py", ".go", ".rs", ".cs", ".java", ".cpp", ".c", ".php", ".rb"]) {
      expect(CONFIG.ALLOWED_EXTENSIONS).toContain(e);
    }
  });

  test("jobConcurrency defaults to 2; overridden with JOB_CONCURRENCY", async () => {
    const def = await runConfig({});
    expect(def.CONFIG.JOB_CONCURRENCY).toBe(2);
    const ovr = await runConfig({ JOB_CONCURRENCY: "5" });
    expect(ovr.CONFIG.JOB_CONCURRENCY).toBe(5);
  });
});
