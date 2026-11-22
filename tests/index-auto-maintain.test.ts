/**
 * Post-job auto-maintenance against the real pipeline (2.10.0).
 *
 * A no-op sync must repair coverage that incremental rows created behind the
 * FTS index: `indexDirectory` runs `ensure*` (which leaves a partially covered
 * index alone), then `runIndexJob`'s `maybeAutoMaintain` runs ONE native
 * `optimize()` before the project flips back to `ready`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = await import("../src/services/db");
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { setEmbedBackend, resetEmbedBackend } = await import("../src/services/embed");
const { CONFIG } = await import("../src/config");

const PROJECT = mkdtempSync(join(tmpdir(), "cidx-auto-maint-"));
const INDEX = "auto-maint";
let registry: InstanceType<typeof Registry>;
let queue: InstanceType<typeof JobQueue>;
let manager: InstanceType<typeof IndexManager>;
let realFetch: typeof globalThis.fetch | null = null;

function ghostRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `/ghost/extra.ts#${i}`,
    filePath: "/ghost/extra.ts",
    content: `ghost row ${i}`,
    vector: [0.1, 0.2, 0.3, 0.4],
    language: "typescript",
    symbolName: `ghost_${i}`,
    symbolType: "function",
    startLine: i,
    endLine: i,
    doc: null,
    doc_vector: null,
    id_terms: null,
  }));
}

async function settle(name: string): Promise<void> {
  const job = manager.activeJob(name);
  expect(job).not.toBeNull();
  await queue.waitForJob(job!.id);
}

beforeAll(async () => {
  mkdirSync(join(PROJECT, "src"), { recursive: true });
  writeFileSync(
    join(PROJECT, "src", "lib.ts"),
    "export function add(a: number, b: number) { return a + b; }\n",
  );
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
  registry = new Registry(join(PROJECT, "meta.db"));
  queue = new JobQueue({ registry });
  manager = new IndexManager(registry, queue);
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  resetEmbedBackend();
  await manager?.shutdown();
  registry?.close();
  rmSync(PROJECT, { recursive: true, force: true });
});

describe("runIndexJob auto-maintenance", () => {
  test("a no-op sync repairs rows that landed behind the FTS index", async () => {
    const rec = manager.createIndex(PROJECT, INDEX);
    await settle(rec.name);
    const table = registry.getIndex(INDEX)!.tableName;

    const before = await db.indexCoverage(table);
    expect(before).not.toBeNull();
    expect(before!.gapRatio).toBe(0);

    // Rows written behind the index (the incremental-sync/watcher shape) with a
    // path that is neither on disk nor in file_cache, so the deleted-file
    // cleanup cannot remove them.
    await db.insertChunks(table, ghostRows(20));
    const gap = await db.indexCoverage(table);
    expect(gap!.gapRatio).toBeGreaterThan(CONFIG.AUTO_MAINTENANCE_UNINDEXED_RATIO);

    manager.syncIndex(INDEX);
    await settle(INDEX);

    expect(registry.getIndex(INDEX)!.status).toBe("ready");
    const repaired = await db.indexCoverage(table);
    expect(repaired!.gapRatio).toBe(0);
  }, 60_000);
});
