import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHARS_PER_TOKEN, estimateTokens, effectiveChunkChars } from "../src/chunking/chunker";

const CAP_FIXTURE = join(import.meta.dir, "fixtures", "chunk-token-cap.ts");
const NO_YAML = join(tmpdir(), `mcp-no-such-config-${crypto.randomUUID()}.yml`);

/** Spawns the chunk-token-cap fixture (a single long function) and returns { count, contentLen }. */
async function runCap(env: Record<string, string>): Promise<{ count: number; contentLen: number }> {
  const proc = Bun.spawn(["bun", "run", CAP_FIXTURE], {
    env: { ...process.env, INDEXER_CONFIG: NO_YAML, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const line = out.trim().split("\n").pop()!;
  return JSON.parse(line);
}

describe("CHARS_PER_TOKEN", () => {
  test("default ratio is 4", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

describe("estimateTokens", () => {
  test("ceil of length / ratio", () => {
    expect(estimateTokens("abcd")).toBe(1); // exactly 4 chars → 1 token
    expect(estimateTokens("abc")).toBe(1); // 3 chars → ceil(0.75) = 1
    expect(estimateTokens("abcde")).toBe(2); // 5 chars → ceil(1.25) = 2
    expect(estimateTokens("")).toBe(0);
  });

  test("honors a custom ratio", () => {
    expect(estimateTokens("ab", 2)).toBe(1);
    expect(estimateTokens("abc", 2)).toBe(2); // ceil(1.5) = 2
  });
});

describe("effectiveChunkChars", () => {
  test("char limit binds when smaller than the token cap (default behavior)", () => {
    // Default config: maxChunkSize 1500, maxChunkTokens 512 → 512*4 = 2048 > 1500.
    expect(effectiveChunkChars(1500, 512, 4)).toBe(1500);
  });

  test("token cap binds when maxChunkSize would exceed it", () => {
    // maxChunkSize 6000 ≈ 1500 tokens, but cap is 512 → 2048 chars.
    expect(effectiveChunkChars(6000, 512, 4)).toBe(2048);
  });

  test("small maxChunkSize passes through", () => {
    expect(effectiveChunkChars(100, 512, 4)).toBe(100);
  });

  test("lowering the token cap shrinks the effective size", () => {
    expect(effectiveChunkChars(1500, 64, 4)).toBe(256); // 64 * 4
    expect(effectiveChunkChars(1500, 1, 4)).toBe(4); // floor at 1 token * 4
  });

  test("never returns <= 0 even with a zero/negative token cap", () => {
    expect(effectiveChunkChars(1500, 0, 4)).toBeGreaterThanOrEqual(1);
    expect(effectiveChunkChars(1500, -5, 4)).toBeGreaterThanOrEqual(1);
  });

  test("honors a custom chars-per-token", () => {
    // 512 tokens * 3 chars/token = 1536, smaller than 1500? no → 1500 binds.
    expect(effectiveChunkChars(1500, 512, 3)).toBe(1500);
    // 512 * 2 = 1024 < 1500 → token cap binds.
    expect(effectiveChunkChars(1500, 512, 2)).toBe(1024);
  });
});

describe("token cap integration (subprocess)", () => {
  test("a low MAX_CHUNK_TOKENS splits a long function into >1 chunk", async () => {
    // MAX_CHUNK_TOKENS=50 -> effective 200 chars; the ~870-char fixture function
    // can no longer fit in one chunk and is split by splitLarge.
    const { count, contentLen } = await runCap({ MAX_CHUNK_TOKENS: "50" });
    expect(contentLen).toBeGreaterThan(200);
    expect(count).toBeGreaterThan(1);
  });

  test("default config (char-limit-binding) keeps the sub-1500-char function as 1 chunk", async () => {
    // No env override: effective cap is min(1500, 512*4=2048) = 1500, so the
    // ~870-char function stays a single chunk. Proves no behavior change at defaults.
    const { count, contentLen } = await runCap({});
    expect(contentLen).toBeLessThan(1500);
    expect(count).toBe(1);
  });
});
