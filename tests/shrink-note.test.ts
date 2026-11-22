/**
 * Unexpected-shrink notes (2.10.0).
 *
 * A moved/unmounted/emptied project used to prune almost every file on the next
 * sync and still report `ready` — the counters silently collapsed. `detectShrink`
 * is the pure predicate; `runIndexJob` turns it into a registry note, subtracts
 * nested-root removals, and clears the note on the next clean run.
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
const { detectShrink } = await import("../src/utils/shrink");
const { CONFIG } = await import("../src/config");

const ROOT = mkdtempSync(join(tmpdir(), "cidx-shrink-"));
const PROJECT = join(ROOT, "moved");
const PARENT = join(ROOT, "umbrella");
const CHILD = join(PARENT, "child");
let registry: InstanceType<typeof Registry>;
let queue: InstanceType<typeof JobQueue>;
let manager: InstanceType<typeof IndexManager>;
let realFetch: typeof globalThis.fetch | null = null;
let prevDebounce = 0;

function file(dir: string, name: string): string {
  const p = join(dir, name);
  writeFileSync(p, `export function ${name.replace(/[^a-z0-9]/gi, "_")}() { return 1; }\n`);
  return p;
}

async function settle(name: string): Promise<void> {
  await manager.waitForIndexSettle(name, true, 30_000);
}

beforeAll(async () => {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(CHILD, { recursive: true });
  for (let i = 0; i < 20; i++) file(PROJECT, `f${i}.ts`);
  for (let i = 0; i < 19; i++) file(PARENT, `p${i}.ts`);
  file(CHILD, "c0.ts");

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
  // Keep watcher events from racing the manual syncs (one long debounce).
  prevDebounce = CONFIG.WATCH_DEBOUNCE_MS;
  CONFIG.WATCH_DEBOUNCE_MS = 60_000;
  registry = new Registry(join(ROOT, "meta.db"));
  queue = new JobQueue({ registry });
  manager = new IndexManager(registry, queue);
});

afterAll(async () => {
  CONFIG.WATCH_DEBOUNCE_MS = prevDebounce;
  if (realFetch) globalThis.fetch = realFetch;
  resetEmbedBackend();
  await manager?.shutdown();
  registry?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("detectShrink", () => {
  test("a large drop over the minimum fires", () => {
    const v = detectShrink({ beforeFiles: 20, afterFiles: 5, ratio: 0.5, minFiles: 10 });
    expect(v).toEqual({ shrunk: true, adjustedBefore: 20, lost: 15, ratio: 0.75 });
  });

  test("nested removals are subtracted (an umbrella sync is not data loss)", () => {
    const v = detectShrink({ beforeFiles: 20, afterFiles: 19, nestedRemoved: 1, ratio: 0.5, minFiles: 10 });
    expect(v.shrunk).toBe(false);
    expect(v.adjustedBefore).toBe(19);
    expect(v.lost).toBe(0);
  });

  test("small projects, the exact threshold boundary, and disabled settings stay quiet", () => {
    expect(detectShrink({ beforeFiles: 6, afterFiles: 1, ratio: 0.5, minFiles: 10 }).shrunk).toBe(false);
    // 10/20 = exactly 50% — strictly greater is required.
    expect(detectShrink({ beforeFiles: 20, afterFiles: 10, ratio: 0.5, minFiles: 10 }).shrunk).toBe(false);
    expect(detectShrink({ beforeFiles: 20, afterFiles: 9, ratio: 0.5, minFiles: 10 }).shrunk).toBe(true);
    expect(detectShrink({ beforeFiles: 20, afterFiles: 1, ratio: 0, minFiles: 10 }).shrunk).toBe(false);
    expect(detectShrink({ beforeFiles: 20, afterFiles: 1, ratio: 0.5, minFiles: 0 }).shrunk).toBe(false);
  });
});

describe("runIndexJob shrink note", () => {
  test("a sync that lost most files writes a move hint; a clean run clears it", async () => {
    const rec = manager.createIndex(PROJECT, "moved");
    await settle(rec.name);
    expect(registry.getIndex("moved")!.note).toBeNull();
    expect(registry.getIndex("moved")!.fileCount).toBe(20);

    for (let i = 0; i < 15; i++) rmSync(join(PROJECT, `f${i}.ts`));
    manager.syncIndex("moved");
    await settle("moved");

    const shrunk = registry.getIndex("moved")!;
    expect(shrunk.fileCount).toBe(5);
    expect(shrunk.note).toContain("file count dropped 20 → 5");
    expect(shrunk.note).toContain("75% fewer");
    expect(shrunk.note).toContain("moved");

    // Restore the files and sync again → the note does not outlive the condition.
    for (let i = 0; i < 15; i++) file(PROJECT, `f${i}.ts`);
    manager.syncIndex("moved");
    await settle("moved");
    expect(registry.getIndex("moved")!.note).toBeNull();
    expect(registry.getIndex("moved")!.fileCount).toBe(20);
  }, 90_000);

  test("pruning a nested registered project alone never produces a shrink note", async () => {
    const parent = manager.createIndex(PARENT, "umbrella");
    await settle(parent.name);
    expect(registry.getIndex("umbrella")!.fileCount).toBe(20);

    const child = manager.createIndex(CHILD, "umbrella-child");
    await settle(child.name);

    manager.syncIndex("umbrella");
    await settle("umbrella");
    const ix = registry.getIndex("umbrella")!;
    expect(ix.fileCount).toBe(19); // child's file pruned
    expect(ix.note).toBeNull(); // …but counted as nestedRemoved, not a shrink
  }, 90_000);
});
