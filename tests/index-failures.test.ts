/**
 * An unreachable embedding provider must not look like a clean run.
 *
 * Production symptom (2026-10-20): `llamacpp-eg2.service` was down, every file
 * failed with ConnectionRefused, the table kept "0 chunks written" — and the
 * index still reported `ready` with no note. `IndexResult.failed` carries the
 * count so the ready line and the registry note can say it out loud.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { indexDirectory } from "../src/services/indexer";
import { setEmbedBackend, resetEmbedBackend } from "../src/services/embed";
import { CONFIG } from "../src/config";
import { initDB } from "../src/services/db";

const root = mkdtempSync(join(tmpdir(), "cidx-index-failures-"));

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

let realFetch: typeof globalThis.fetch | null = null;

beforeAll(async () => {
  write("a.ts", "export function alpha() { return 1; }\n");
  write("b.ts", "export function beta() { return 2; }\n");
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

describe("indexDirectory — failed embeds are counted, not hidden", () => {
  test("a dead embedding provider makes every file fail and writes no chunks", async () => {
    const result = await indexDirectory({
      indexName: "failure-fixture",
      tableName: "idx_failure_fixture",
      baseDir: root,
    });
    expect(result.files).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.chunks).toBe(0);
    expect(result.dim).toBeNull();
  });
});
