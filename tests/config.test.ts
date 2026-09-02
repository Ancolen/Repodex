/**
 * Configuration layer tests (config.ts).
 *
 * CONFIG is resolved once based on process.env when the module is imported. Therefore,
 * each scenario is run in an isolated subprocess. CIDX_CONFIG is set to a non-existent
 * path so that the user's real config.yml and indexer.yml in cwd are disabled
 * -> only in-code defaults + environment variables take effect.
 */
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";

const FIXTURE = join(import.meta.dir, "fixtures", "print-config.ts");
const NO_YAML = join(tmpdir(), `cidx-no-such-config-${crypto.randomUUID()}.yml`);

async function runConfig(env: Record<string, string>): Promise<{ CONFIG: any; CONFIG_SOURCE: string | null }> {
  const proc = Bun.spawn(["bun", "run", FIXTURE], {
    env: { ...process.env, CIDX_CONFIG: NO_YAML, ...env },
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
    expect(CONFIG.MAX_CHUNK_TOKENS).toBe(512);
    expect(CONFIG.MCP_PORT).toBe(9371);
    expect(CONFIG.CONTROL_PORT).toBe(9372);
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

  test("CIDX_HOME expands '~' and derived paths are located under home", async () => {
    const { CONFIG } = await runConfig({ CIDX_HOME: "~/cidx-test-home" });
    const home = process.env.HOME!;
    expect(CONFIG.ROOT_DIR).toBe(join(home, "cidx-test-home"));
    expect(CONFIG.DB_DIR).toBe(join(home, "cidx-test-home", "db"));
    expect(CONFIG.META_DB_PATH).toBe(join(home, "cidx-test-home", "meta.db"));
  });

  test("allowedExtensions default covers all grammar extensions", async () => {
    const { CONFIG } = await runConfig({});
    for (const e of [".ts", ".js", ".py", ".go", ".rs", ".cs", ".java", ".cpp", ".c", ".php", ".rb", ".kt", ".swift", ".scala"]) {
      expect(CONFIG.ALLOWED_EXTENSIONS).toContain(e);
    }
    // Godot: .gd (AST grammar) + text-fallback formats; .godot cache dir is ignored.
    for (const e of [".gd", ".gdshader", ".tscn", ".tres", ".godot"]) {
      expect(CONFIG.ALLOWED_EXTENSIONS).toContain(e);
    }
    // Doc formats without a grammar (character fallback + language label).
    for (const e of [".xml", ".rst"]) {
      expect(CONFIG.ALLOWED_EXTENSIONS).toContain(e);
    }
    expect(CONFIG.GLOBAL_IGNORED_DIRS).toContain(".godot");
  });

  test("jobConcurrency defaults to 2; overridden with JOB_CONCURRENCY", async () => {
    const def = await runConfig({});
    expect(def.CONFIG.JOB_CONCURRENCY).toBe(2);
    const ovr = await runConfig({ JOB_CONCURRENCY: "5" });
    expect(ovr.CONFIG.JOB_CONCURRENCY).toBe(5);
  });

  test("maxChunkTokens defaults to 512; overridden with MAX_CHUNK_TOKENS", async () => {
    const def = await runConfig({});
    expect(def.CONFIG.MAX_CHUNK_TOKENS).toBe(512);
    const ovr = await runConfig({ MAX_CHUNK_TOKENS: "128" });
    expect(ovr.CONFIG.MAX_CHUNK_TOKENS).toBe(128);
  });
});

describe("config — legacy ~/.mcp-indexer → ~/.cidx migration", () => {
  /** Spawns the fixture with a sandboxed HOME and without CIDX_CONFIG. */
  async function runApp(env: Record<string, string>): Promise<{ CONFIG: any; CONFIG_SOURCE: string | null; stderr: string }> {
    const full: Record<string, string> = { ...process.env } as Record<string, string>;
    delete full.CIDX_CONFIG; // migration must not be gated for this scenario
    for (const [k, v] of Object.entries(env)) full[k] = v;
    const proc = Bun.spawn(["bun", "run", FIXTURE], {
      env: full,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const line = out.trim().split("\n").pop()!;
    return { ...JSON.parse(line), stderr };
  }

  function sandbox(): { home: string; legacy: string; fresh: string } {
    const home = join(tmpdir(), `cidx-migrate-${crypto.randomUUID()}`);
    const legacy = join(home, ".mcp-indexer");
    const fresh = join(home, ".cidx");
    mkdirSync(legacy, { recursive: true });
    return { home, legacy, fresh };
  }

  test("moves the legacy home and rewrites config.yml's pinned home path", async () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.legacy, "config.yml"), `home: ${s.legacy}\n`);
      writeFileSync(join(s.legacy, "meta.db"), "data");
      const { CONFIG, stderr } = await runApp({ HOME: s.home, NODE_ENV: "production" });
      expect(existsSync(s.fresh)).toBe(true);
      expect(existsSync(s.legacy)).toBe(false);
      expect(readFileSync(join(s.fresh, "meta.db"), "utf-8")).toBe("data");
      expect(readFileSync(join(s.fresh, "config.yml"), "utf-8")).not.toContain(s.legacy);
      expect(CONFIG.ROOT_DIR).toBe(s.fresh);
      expect(stderr).toContain("migrated data home");
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  test("no-op when the fresh home already exists (legacy left untouched)", async () => {
    const s = sandbox();
    try {
      mkdirSync(s.fresh, { recursive: true });
      writeFileSync(join(s.legacy, "meta.db"), "old");
      const { stderr } = await runApp({ HOME: s.home, NODE_ENV: "production" });
      expect(existsSync(s.legacy)).toBe(true);
      expect(readFileSync(join(s.legacy, "meta.db"), "utf-8")).toBe("old");
      expect(stderr).not.toContain("migrated data home");
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  test("skipped when CIDX_CONFIG is set (caller manages their own setup)", async () => {
    const s = sandbox();
    try {
      writeFileSync(join(s.legacy, "meta.db"), "old");
      const { stderr } = await runApp({
        HOME: s.home,
        NODE_ENV: "production",
        CIDX_CONFIG: join(tmpdir(), `cidx-no-such-${crypto.randomUUID()}.yml`),
      });
      expect(existsSync(s.legacy)).toBe(true);
      expect(existsSync(s.fresh)).toBe(false);
      expect(stderr).not.toContain("migrated data home");
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });
});
