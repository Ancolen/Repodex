import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Registry } from "../src/core/registry";
import { cachedEmbed } from "../src/services/ollama";

function tempDbPath(): string {
  return join(tmpdir(), `mcp-test-${crypto.randomUUID()}.db`);
}

describe("cachedEmbed (query embedding cache)", () => {
  let reg: Registry;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    reg = new Registry(dbPath);
  });

  afterEach(() => {
    reg.close();
    try {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      /* ignore */
    }
  });

  /** A fake embedder that counts calls and returns a deterministic vector. */
  function fakeEmbed() {
    let calls = 0;
    const embed = async (text: string): Promise<number[]> => {
      calls++;
      // Deterministic, distinct per input text so cache hits are detectable.
      return [text.length, calls];
    };
    return { embed, count: () => calls };
  }

  test("miss → embed called once, vector cached and returned", async () => {
    const f = fakeEmbed();
    const before = reg.countEmbeddingCache();
    const vec = await cachedEmbed("auth middleware", "qwen3-embedding", reg, f.embed);
    expect(f.count()).toBe(1);
    expect(vec).toEqual([15, 1]); // "auth middleware".length === 15
    expect(reg.countEmbeddingCache()).toBe(before + 1);
  });

  test("repeat same text + model → cache hit, embed NOT called again", async () => {
    const f = fakeEmbed();
    const a = await cachedEmbed("login handler", "qwen3-embedding", reg, f.embed);
    const b = await cachedEmbed("login handler", "qwen3-embedding", reg, f.embed);
    expect(f.count()).toBe(1);
    expect(b).toEqual(a);
  });

  test("different text → embed called again", async () => {
    const f = fakeEmbed();
    await cachedEmbed("login handler", "qwen3-embedding", reg, f.embed);
    await cachedEmbed("logout handler", "qwen3-embedding", reg, f.embed);
    expect(f.count()).toBe(2);
  });

  test("same text, different model → embed called again (model-scoped key)", async () => {
    const f = fakeEmbed();
    await cachedEmbed("login handler", "model-a", reg, f.embed);
    await cachedEmbed("login handler", "model-b", reg, f.embed);
    expect(f.count()).toBe(2);
  });

  test("cached vector round-trips through the Float32 BLOB encode/decode", async () => {
    const f = fakeEmbed();
    // Values chosen to be exactly representable in Float32 (the cache storage type),
    // so the round-trip is exact and exercises the BLOB encode/decode path.
    const embed = async (): Promise<number[]> => [0.5, -0.25, 0.125, 0.0, 1234.5];
    await cachedEmbed("x", "m", reg, embed);
    // Second call must hit the cache and return the same values.
    const hit = await cachedEmbed("x", "m", reg, f.embed);
    expect(f.count()).toBe(0); // cache hit, fake never invoked
    expect(hit).toEqual([0.5, -0.25, 0.125, 0.0, 1234.5]);
  });
});
