import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHARS_PER_TOKEN,
  chunkCode,
  estimateTokens,
  effectiveChunkChars,
} from "../src/chunking/chunker";
import { CONFIG } from "../src/config";

const CAP_FIXTURE = join(import.meta.dir, "fixtures", "chunk-token-cap.ts");
const NO_YAML = join(tmpdir(), `cidx-no-such-config-${crypto.randomUUID()}.yml`);

/** Spawns the chunk-token-cap fixture (a single long function) and returns { count, contentLen }. */
async function runCap(env: Record<string, string>): Promise<{ count: number; contentLen: number }> {
  const proc = Bun.spawn(["bun", "run", CAP_FIXTURE], {
    env: { ...process.env, CIDX_CONFIG: NO_YAML, ...env },
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

describe("splitLarge — astral-character safety at window cuts", () => {
  // Mirror the module's own MAX/STEP derivation so the placement arithmetic
  // below stays exact under any config.
  const MAX = effectiveChunkChars(CONFIG.MAX_CHUNK_SIZE, CONFIG.MAX_CHUNK_TOKENS, CHARS_PER_TOKEN);
  const STEP = Math.max(1, MAX - CONFIG.OVERLAP_SIZE);

  /** Pair-aware lone-surrogate count — 0 means the text cuts cleanly. */
  function loneSurrogates(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) n++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        const prev = s.charCodeAt(i - 1);
        if (!(prev >= 0xd800 && prev <= 0xdbff)) n++;
      }
    }
    return n;
  }

  test("a window END never cuts an astral character in half (production: luffy_proxy.py)", async () => {
    // The function text starts at unit 0 (`def`); the first window ends at MAX.
    // Put the emoji's HIGH half at MAX-1 — exactly what the 1500-char window
    // did to an emoji inside a Turkish print string: the chunk ended on a lone
    // high surrogate, JSON.stringify escaped it to \ud83d, and llama.cpp's
    // strict parser rejected the embed request (the file failed every sync).
    const head = `def f():\n    s = "`;
    const emoji = "🔄";
    const fill = "x".repeat(MAX - head.length - 1);
    const src = head + fill + emoji + "y".repeat(STEP * 2) + `"\n`;
    const chunks = await chunkCode("window-end.py", src);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(loneSurrogates(c.content)).toBe(0);
    expect(chunks.some((c) => c.content.includes(emoji))).toBe(true);
  });

  test("a window START never cuts an astral character in half (production: STREAM_ERROR.json)", async () => {
    // Window 2 starts at STEP — put the emoji's LOW half exactly there (its
    // high half at STEP-1 stays inside the previous window's overlap): the
    // continuation chunk used to START with a lone low surrogate.
    const head = `def f():\n    s = "`;
    const emoji = "📡";
    const fill = "x".repeat(STEP - head.length - 1);
    const src = head + fill + emoji + "y".repeat(MAX) + `"\n`;
    const chunks = await chunkCode("window-start.py", src);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(loneSurrogates(c.content)).toBe(0);
    expect(chunks.some((c) => c.content.includes(emoji))).toBe(true);
  });
});
