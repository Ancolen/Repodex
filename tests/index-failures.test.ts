/**
 * An unreachable embedding provider must not look like a clean run.
 *
 * Production symptom (2026-10-20): `llamacpp-eg2.service` was down, every file
 * failed with ConnectionRefused, the table kept "0 chunks written" — and the
 * index still reported `ready` with no note. `IndexResult.failed` carries the
 * count so the ready line and the registry note can say it out loud.
 *
 * 2.10.0 adds `embedding.failFast` (default ON): a dead backend aborts the job
 * BEFORE the deleted-file cleanup and any write (the existing index is
 * preserved), and three consecutive connection failures mid-job stop new work,
 * commit the prepared slice, then throw. `EMBED_FAIL_FAST=false` restores the
 * legacy per-file counting.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { indexDirectory } from "../src/services/indexer";
import { setEmbedBackend, resetEmbedBackend } from "../src/services/embed";
import { CONFIG } from "../src/config";
import { countTableRows, initDB, listTables } from "../src/services/db";
import { Registry } from "../src/core/registry";

const root = mkdtempSync(join(tmpdir(), "cidx-index-failures-"));

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

let realFetch: typeof globalThis.fetch | null = null;

beforeAll(async () => {
  write("legacy/a.ts", "export function alpha() { return 1; }\n");
  write("legacy/b.ts", "export function beta() { return 2; }\n");
  for (let i = 0; i < 5; i++) {
    write(`circuit/f${i}.ts`, `export function circuit${i}() { return ${i}; }\n`);
  }
  write("recovery/r1.ts", "export function rec1() { return 1; }\n");
  write("recovery/r2.ts", "export function rec2() { return 2; }\n");
  await initDB();
  realFetch = globalThis.fetch;
  // Any HTTP attempt fails: the same shape as a dead llama-server (ECONNREFUSED).
  globalThis.fetch = (async () => {
    throw new Error("Unable to connect. Is the computer able to access the url?");
  }) as typeof fetch;
  setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
});

afterAll(() => {
  if (realFetch) globalThis.fetch = realFetch;
  resetEmbedBackend();
  rmSync(root, { recursive: true, force: true });
});

describe("indexDirectory — a dead backend fails fast (default)", () => {
  test("the job aborts before any write and the existing index is preserved", async () => {
    const registry = new Registry(join(root, "failfast.db"));
    try {
      await expect(
        indexDirectory(
          { indexName: "failure-fixture", tableName: "idx_failure_fixture", baseDir: join(root, "legacy") },
          // Probe once, never wait: the test's backend is unreachable on purpose.
          { embedReadyTimeoutMs: 0, registry },
        ),
      ).rejects.toThrow(/embedding backend unreachable/);
      // No table, no mtime cache — the abort happened before the cleanup/write.
      expect(await listTables()).not.toContain("idx_failure_fixture");
      expect(registry.listCachedFiles("failure-fixture")).toHaveLength(0);
    } finally {
      registry.close();
    }
  });

  test("EMBED_FAIL_FAST=false keeps the legacy per-file failure counting", async () => {
    const prev = CONFIG.EMBED_FAIL_FAST;
    CONFIG.EMBED_FAIL_FAST = false;
    try {
      const result = await indexDirectory(
        { indexName: "failure-fixture", tableName: "idx_failure_fixture", baseDir: join(root, "legacy") },
        { embedReadyTimeoutMs: 0 },
      );
      expect(result.files).toBe(2);
      expect(result.failed).toBe(2);
      expect(result.chunks).toBe(0);
      expect(result.dim).toBeNull();
    } finally {
      CONFIG.EMBED_FAIL_FAST = prev;
    }
  });
});

describe("indexDirectory — mid-job outage circuit breaker", () => {
  const okEmbed = (init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
    const inputs = Array.isArray(body.input) ? body.input : [];
    return new Response(JSON.stringify({ embeddings: inputs.map(() => [0.1, 0.2, 0.3]) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  test("three consecutive connection failures commit the prepared slice, then throw", async () => {
    let embedCalls = 0;
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
        // The first two files embed; the backend then dies. With concurrency 1
        // the failure order is deterministic.
        if (embedCalls > 2) {
          throw new Error("Unable to connect. Is the computer able to access the url?");
        }
        return okEmbed(init);
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const prevConcurrency = CONFIG.INDEX_FILE_CONCURRENCY;
    const prevBatch = CONFIG.INDEX_WRITE_BATCH_FILES;
    CONFIG.INDEX_FILE_CONCURRENCY = 1;
    CONFIG.INDEX_WRITE_BATCH_FILES = 64;
    try {
      await expect(
        indexDirectory(
          { indexName: "circuit-fixture", tableName: "idx_circuit_fixture", baseDir: join(root, "circuit") },
          { embedReadyTimeoutMs: 0 },
        ),
      ).rejects.toThrow(/unreachable mid-job/);
      // The two prepared files were committed before the abort.
      expect(await countTableRows("idx_circuit_fixture")).toBeGreaterThan(0);
      expect(embedCalls).toBe(5); // 2 successes + 3 consecutive failures
    } finally {
      CONFIG.INDEX_FILE_CONCURRENCY = prevConcurrency;
      CONFIG.INDEX_WRITE_BATCH_FILES = prevBatch;
    }
  }, 60_000);

  test("a backend that recovers mid-job is retried once and its files are recovered", async () => {
    let embedCalls = 0;
    const prev = globalThis.fetch;
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
        // The first pass fails for both files (backend went down mid-job); the
        // end-of-job retry pass sees a recovered backend.
        if (embedCalls <= 2) {
          throw new Error("Unable to connect. Is the computer able to access the url?");
        }
        return okEmbed(init);
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await indexDirectory(
        { indexName: "recovery-fixture", tableName: "idx_recovery_fixture", baseDir: join(root, "recovery") },
        { embedReadyTimeoutMs: 0 },
      );
      expect(result.failed).toBe(0);
      expect(result.chunks).toBeGreaterThan(0);
      expect(result.dim).toBe(3);
      expect(embedCalls).toBe(4); // 2 failures + 2 recovered on the retry pass
    } finally {
      globalThis.fetch = prev;
    }
  });
});
