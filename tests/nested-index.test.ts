/**
 * Nested registered project roots (2.10.0).
 *
 * An umbrella index must not scan a directory that is its own registered
 * project: the child's table/watcher already owns that code, so including it
 * duplicates every row and doubles embed work. The parent walk skips the child
 * subtree and its first sync prunes the stale duplicate rows (`nestedRemoved`).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = await import("../src/services/db");
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { indexDirectory } = await import("../src/services/indexer");
const { setEmbedBackend, resetEmbedBackend } = await import("../src/services/embed");
const { CONFIG } = await import("../src/config");

const ROOT = mkdtempSync(join(tmpdir(), "cidx-nested-index-"));
const PARENT = join(ROOT, "mono");
const CHILD = join(PARENT, "packages", "app");
let registry: InstanceType<typeof Registry>;
let queue: InstanceType<typeof JobQueue>;
let manager: InstanceType<typeof IndexManager>;
let realFetch: typeof globalThis.fetch | null = null;

beforeAll(async () => {
  mkdirSync(CHILD, { recursive: true });
  writeFileSync(join(PARENT, "top.ts"), "export function umbrellaTop() { return 1; }\n");
  writeFileSync(join(CHILD, "child.ts"), "export function childOnly() { return 2; }\n");
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

describe("umbrella index excludes a nested registered project", () => {
  test("a later sync prunes the child's stale rows and cache entries", async () => {
    // Index the parent FIRST (the child is not a project yet) → both files.
    const parent = manager.createIndex(PARENT, "mono");
    await manager.waitForIndexSettle(parent.name, true, 30_000);
    expect(registry.listCachedFiles("mono").sort()).toEqual(
      [join(PARENT, "top.ts"), join(CHILD, "child.ts")].sort(),
    );
    expect(registry.getIndex("mono")!.chunkCount).toBe(2);

    // Register the child as its own project.
    const child = manager.createIndex(CHILD, "mono-app");
    await manager.waitForIndexSettle(child.name, true, 30_000);
    expect(registry.getIndex("mono-app")!.chunkCount).toBe(1);

    // The umbrella sync now skips the child subtree and prunes its stale rows.
    manager.syncIndex("mono");
    await manager.waitForIndexSettle("mono", true, 30_000);
    expect(registry.listCachedFiles("mono")).toEqual([join(PARENT, "top.ts")]);
    expect(registry.getIndex("mono")!.chunkCount).toBe(1);
    // The child project itself is untouched.
    expect(registry.listCachedFiles("mono-app")).toEqual([join(CHILD, "child.ts")]);
    expect(registry.getIndex("mono-app")!.chunkCount).toBe(1);
  }, 60_000);

  test("indexDirectory reports nestedRemoved separately from deletions", async () => {
    const target = { indexName: "nested-direct", tableName: "idx_nested_direct", baseDir: PARENT };
    const first = await indexDirectory(target, { registry });
    expect(first.files).toBe(2);
    expect(first.nestedRemoved).toBe(0);

    const second = await indexDirectory(target, { registry, excludeRoots: [CHILD] });
    expect(second.excludedRoots).toEqual([CHILD]);
    expect(second.nestedRemoved).toBe(1);
    expect(second.deleted).toBe(0); // a nested prune is NOT a deletion
    expect(registry.listCachedFiles("nested-direct")).toEqual([join(PARENT, "top.ts")]);
    expect(second.filterStats.nestedExcluded).toBe(1);
  }, 60_000);
});
