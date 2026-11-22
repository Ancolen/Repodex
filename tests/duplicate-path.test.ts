/**
 * A path indexed under two names (2.10.0).
 *
 * `createIndex` used to register a SECOND project + table + watcher when the
 * caller asked for the same directory under a different name. It now reuses the
 * existing record (`getIndexByPath`, newest wins) and reindexes it; the start
 * response says the requested name was ignored.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = await import("../src/services/db");
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { setEmbedBackend, resetEmbedBackend } = await import("../src/services/embed");
const { CONFIG } = await import("../src/config");

const ROOT = mkdtempSync(join(tmpdir(), "cidx-dup-path-"));
const PROJECT = join(ROOT, "app");
let registry: InstanceType<typeof Registry>;
let queue: InstanceType<typeof JobQueue>;
let manager: InstanceType<typeof IndexManager>;
let realFetch: typeof globalThis.fetch | null = null;

async function settle(name: string): Promise<void> {
  await manager.waitForIndexSettle(name, true, 30_000);
}

beforeAll(async () => {
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, "lib.ts"), "export function shared() { return 1; }\n");
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

describe("createIndex — one path, one project", () => {
  test("a second name on the same path reuses the existing project", async () => {
    const first = manager.createIndex(PROJECT, "canonical");
    await settle(first.name);

    const second = manager.createIndex(PROJECT, "alias-name");
    expect(second.name).toBe("canonical");
    await settle(second.name);

    const sharing = registry.listIndexes().filter((r) => r.path === PROJECT);
    expect(sharing).toHaveLength(1);
    expect(registry.listDuplicatePaths()).toEqual([]);
  }, 60_000);

  test("the overlap note explains that the requested name is ignored", async () => {
    const note = manager.pathOverlapWarning(PROJECT, "another-alias");
    expect(note).toContain("already indexed as 'canonical'");
    expect(note).toContain("'another-alias' is ignored");
    // Without a requested name there is nothing to warn about.
    expect(manager.pathOverlapWarning(PROJECT)).toBeNull();
  });
});
