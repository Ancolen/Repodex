/**
 * Wait budgets for status/index starts (2.10.0).
 *
 * `INDEX_WAIT_MS` dropped to 90 s and a caller-supplied `waitMs` is clamped to
 * `INDEX_WAIT_MAX_MS` (110 s) so a server-side wait finishes under the ~120 s
 * client timeout. `waitForAllSettle` awaits every active job against ONE shared
 * deadline (the anchorless `get_index_status { wait: true }`), never per project.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = await import("../src/services/db");
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager, clampIndexWaitMs } = await import("../src/core/index-manager");
const { setEmbedBackend, resetEmbedBackend } = await import("../src/services/embed");
const { CONFIG } = await import("../src/config");
const { INDEX_WAIT_MS, INDEX_WAIT_MAX_MS } = await import("../src/core/types");

const ROOT = mkdtempSync(join(tmpdir(), "cidx-index-wait-"));
let registry: InstanceType<typeof Registry>;
let queue: InstanceType<typeof JobQueue>;
let manager: InstanceType<typeof IndexManager>;
let realFetch: typeof globalThis.fetch | null = null;
/** Per-test fake-backend latency (0 = instant). */
let embedDelayMs = 0;

function projectDir(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lib.ts"), `export function ${name.replace(/[^a-z0-9]/gi, "_")}() { return 1; }\n`);
  return dir;
}

beforeAll(async () => {
  await db.initDB();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: CONFIG.OLLAMA_MODEL }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/api/embed")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const inputs = Array.isArray(body.input) ? body.input : [];
      if (embedDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, embedDelayMs));
      return new Response(JSON.stringify({ embeddings: inputs.map(() => [0.1, 0.2, 0.3, 0.4]) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
  registry = new Registry(join(ROOT, "meta.db"));
  queue = new JobQueue({ registry });
  manager = new IndexManager(registry, queue);
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  resetEmbedBackend();
  await manager?.shutdown();
  registry?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  embedDelayMs = 0;
});

describe("clampIndexWaitMs", () => {
  test("default and bounds", () => {
    expect(INDEX_WAIT_MS).toBe(90_000);
    expect(INDEX_WAIT_MAX_MS).toBe(110_000);
    expect(clampIndexWaitMs()).toBe(90_000);
    expect(clampIndexWaitMs(1500)).toBe(1500);
    expect(clampIndexWaitMs(0)).toBe(90_000);
    expect(clampIndexWaitMs(-5)).toBe(90_000);
    expect(clampIndexWaitMs(Number.NaN)).toBe(90_000);
    expect(clampIndexWaitMs(999_999)).toBe(110_000);
    expect(clampIndexWaitMs(1500.9)).toBe(1500);
  });
});

describe("waitForIndexSettle", () => {
  test("an unknown project is the self-healing error", async () => {
    await expect(manager.waitForIndexSettle("ghost", true, 50)).rejects.toThrow("Index not found");
  });

  test("wait:false returns the live record immediately", async () => {
    embedDelayMs = 400;
    const rec = manager.createIndex(projectDir("nowait"), "w-nowait");
    const s = await manager.waitForIndexSettle(rec.name, false, 10_000);
    expect(s.timedOut).toBe(false);
    expect(s.rec.status).toBe("indexing");
    await manager.waitForIndexSettle(rec.name, true, 10_000); // drain
  });

  test("a fast job settles within the budget", async () => {
    const rec = manager.createIndex(projectDir("fast"), "w-fast");
    const s = await manager.waitForIndexSettle(rec.name, true, 10_000);
    expect(s.timedOut).toBe(false);
    expect(s.rec.status).toBe("ready");
    expect(s.rec.chunkCount).toBeGreaterThan(0);
  }, 30_000);

  test("a slow job returns timedOut at the caller's budget", async () => {
    embedDelayMs = 1500;
    const rec = manager.createIndex(projectDir("slow"), "w-slow");
    const started = Date.now();
    const s = await manager.waitForIndexSettle(rec.name, true, 50);
    expect(s.timedOut).toBe(true);
    expect(s.rec.status).toBe("indexing");
    expect(Date.now() - started).toBeLessThan(1500);
    await manager.waitForIndexSettle(rec.name, true, 10_000); // drain
  }, 30_000);
});

describe("waitForAllSettle", () => {
  test("awaits every active job against one shared deadline", async () => {
    embedDelayMs = 250;
    const a = manager.createIndex(projectDir("all-a"), "w-all-a");
    const b = manager.createIndex(projectDir("all-b"), "w-all-b");
    const started = Date.now();
    const { timedOut } = await manager.waitForAllSettle(10_000);
    expect(timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(registry.getIndex(a.name)!.status).toBe("ready");
    expect(registry.getIndex(b.name)!.status).toBe("ready");
  }, 30_000);

  test("times out once, not per project", async () => {
    embedDelayMs = 1500;
    const a = manager.createIndex(projectDir("multi-a"), "w-multi-a");
    const b = manager.createIndex(projectDir("multi-b"), "w-multi-b");
    const started = Date.now();
    const { timedOut } = await manager.waitForAllSettle(50);
    expect(timedOut).toBe(true);
    // One shared 50 ms deadline — NOT 2 × 50 ms.
    expect(Date.now() - started).toBeLessThan(1000);
    await manager.waitForAllSettle(10_000); // drain
    expect(registry.getIndex(a.name)!.status).toBe("ready");
    expect(registry.getIndex(b.name)!.status).toBe("ready");
  }, 30_000);
});
