/**
 * End-to-end full-index batching (`indexDirectory` + `replaceFileRecords`).
 *
 * Exercises the real pipeline against a fake Ollama backend: a slice of files
 * is prepared concurrently and committed in one batch, the mtime cache is only
 * written after the commit, an unchanged re-run embeds nothing, and a changed
 * file's old rows are replaced (not duplicated) by a later batch.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexDirectory } from "../src/services/indexer";
import { countTableRows, initDB, scanTableBatches } from "../src/services/db";
import { resetEmbedBackend, setEmbedBackend } from "../src/services/embed";
import { Registry } from "../src/core/registry";
import { CONFIG } from "../src/config";

const root = mkdtempSync(join(tmpdir(), "cidx-index-batch-"));
const TABLE = "idx_index_batch_test";
const FILES = 40;

let registry: Registry;
let embedCalls = 0;
let realFetch: typeof globalThis.fetch | null = null;

function writeFile(i: number, functions: number): void {
  const body = Array.from(
    { length: functions },
    (_, k) => `export function f${i}_${k}(x: number) { return x + ${k}; }\n`,
  ).join("\n");
  writeFileSync(join(root, `mod_${i}.ts`), body);
}

async function rowsByFile(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await scanTableBatches(TABLE, 128, async (rows) => {
    for (const r of rows) counts[r.filePath] = (counts[r.filePath] ?? 0) + 1;
  });
  return counts;
}

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < FILES; i++) writeFile(i, 1);
  await initDB();
  registry = new Registry(join(root, "meta.db"));
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
      embedCalls++;
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
});

afterEach(() => {
  embedCalls = 0;
});

afterAll(() => {
  if (realFetch) globalThis.fetch = realFetch;
  resetEmbedBackend();
  registry.close();
  rmSync(root, { recursive: true, force: true });
});

const target = () => ({ indexName: "batch-fixture", tableName: TABLE, baseDir: root });

describe("indexDirectory — batched full index", () => {
  test("first run writes every file in batches, caches mtimes, and reports one dim", async () => {
    const result = await indexDirectory(target(), { registry, embedReadyTimeoutMs: 0 });
    expect(result.files).toBe(FILES);
    expect(result.failed).toBe(0);
    expect(result.chunks).toBe(FILES);
    expect(result.dim).toBe(4);
    expect(await countTableRows(TABLE)).toBe(FILES);
    expect(registry.listCachedFiles("batch-fixture").length).toBe(FILES);
    expect(embedCalls).toBeGreaterThan(0);
  });

  test("an unchanged re-run embeds nothing and writes nothing", async () => {
    const result = await indexDirectory(target(), { registry, embedReadyTimeoutMs: 0 });
    expect(result.files).toBe(FILES);
    expect(result.failed).toBe(0);
    expect(result.chunks).toBe(0);
    expect(embedCalls).toBe(0);
    expect(await countTableRows(TABLE)).toBe(FILES);
  });

  test("a changed file's old rows are replaced, not duplicated", async () => {
    // A later mtime so the per-file cache check sees a real change.
    const t = new Date(Date.now() + 2_000);
    writeFile(7, 2);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(root, "mod_7.ts"), t, t);

    const result = await indexDirectory(target(), { registry, embedReadyTimeoutMs: 0 });
    expect(result.failed).toBe(0);
    expect(result.chunks).toBe(2); // only the changed file's two functions
    const rows = await rowsByFile();
    expect(rows[join(root, "mod_7.ts")]).toBe(2);
    expect(Object.keys(rows).length).toBe(FILES);
    expect(await countTableRows(TABLE)).toBe(FILES + 1);
  });
});
