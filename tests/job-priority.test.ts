/**
 * Job priority (queue claim order) + the boot-time restore() background policy:
 *
 * - `JobQueue.enqueue(type, payload, priority = 0)` — HIGHER priority is
 *   claimed first, enqueue (FIFO) order holds within the same priority. No
 *   scheduler/preemption: the ONLY change is the ordering rule of `claimNext`.
 * - restore() re-enqueues boot catch-up at `JOB_PRIORITY_BACKGROUND` (-5) so
 *   it never starves a job the user just clicked (default 0).
 * - The registry `jobs` table persists the priority (with the lazy ALTER
 *   migration, covered in tests/registry.test.ts).
 * - The corrected `reindex` help text describes real behavior: a fresh reindex
 *   clears the table + FILE cache but KEEPS the content-hash embedding cache,
 *   so an unchanged reindex re-embeds nothing.
 *
 * Real Registry/JobQueue/IndexManager over temp sqlite/LanceDB with a STUBBED
 * embedding wire — never a live backend (the migrate/events-suite harness).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JOB_PRIORITY_BACKGROUND, type Job } from "../src/core/types";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const Registry = (await import("../src/core/registry")).Registry;
const JobQueue = (await import("../src/core/job-queue")).JobQueue;
const IndexManager = (await import("../src/core/index-manager")).IndexManager;
const setEmbedBackend = (await import("../src/services/embed")).setEmbedBackend;
const resetEmbedBackend = (await import("../src/services/embed")).resetEmbedBackend;
const isolatedHome = (await import("./helpers/isolated-cidx-home")).isolatedHome;

// ------------------------------------------------------------------ queue-only

/** Helper that waits for a job to be 'finished'. */
function waitFinished(q: InstanceType<typeof JobQueue>, id: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    q.on("finished", (job: Job) => {
      if (job.id === id) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

describe("JobQueue priority claim order", () => {
  /**
   * Boots a concurrency-1 queue whose first job ("blocker") parks a worker
   * until `release()`, so every job enqueued afterwards is still CLAIMABLE
   * (in the queue, not running) when the ordering decision matters.
   */
  async function bootQueue(): Promise<{
    q: InstanceType<typeof JobQueue>;
    done: string[];
    release: () => void;
  }> {
    const q = new JobQueue();
    const done: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    q.registerHandler("blocker", async () => {
      await gate;
      return null;
    });
    q.registerHandler("track", async (ctx) => {
      done.push((ctx.payload as { tag: string }).tag);
      return null;
    });
    return { q, done, release };
  }

  test("a higher-priority job is claimed before an older lower-priority one", async () => {
    const { q, done, release } = await bootQueue();

    const blockerId = q.enqueue("blocker", {}); // occupies the only worker slot
    const lowId = q.enqueue("track", { tag: "low" }); // default priority 0, first in line
    const highId = q.enqueue("track", { tag: "high" }, 5); // enqueued LATER, higher priority

    // Both are still queued behind the blocker — the claim order is open.
    expect(q.getJob(lowId)?.status).toBe("queued");
    expect(q.getJob(highId)?.status).toBe("queued");

    release(); // free the slot → the pool refills by claim order
    await Promise.all([waitFinished(q, blockerId), waitFinished(q, lowId), waitFinished(q, highId)]);
    expect(done).toEqual(["high", "low"]);
  });

  test("strict FIFO within equal priority", async () => {
    const { q, done, release } = await bootQueue();

    const blockerId = q.enqueue("blocker", {});
    const aId = q.enqueue("track", { tag: "a" });
    const bId = q.enqueue("track", { tag: "b" });

    expect(q.getJob(aId)?.status).toBe("queued");
    expect(q.getJob(bId)?.status).toBe("queued");

    release();
    await Promise.all([waitFinished(q, blockerId), waitFinished(q, aId), waitFinished(q, bId)]);
    expect(done).toEqual(["a", "b"]); // same priority → enqueue order, never reordered
  });

  test("boot-time background catch-up (negative priority) does not starve an interactive job", async () => {
    const { q, done, release } = await bootQueue();

    const blockerId = q.enqueue("blocker", {});
    const bgId = q.enqueue("track", { tag: "background" }, JOB_PRIORITY_BACKGROUND);
    const fgId = q.enqueue("track", { tag: "interactive" }); // clicked later, default priority

    expect(q.getJob(bgId)?.status).toBe("queued");
    expect(q.getJob(fgId)?.status).toBe("queued");

    release();
    await Promise.all([waitFinished(q, blockerId), waitFinished(q, bgId), waitFinished(q, fgId)]);
    expect(done).toEqual(["interactive", "background"]);
  });

  test("priority defaults to 0 and persists with the job row", async () => {
    const dbPath = path.join(isolatedHome, `prio-persist-${randomUUID()}.db`);
    const registry = new Registry(dbPath);
    try {
      const q = new JobQueue({ registry });
      q.registerHandler("noop", async () => null);

      const def = q.enqueue("noop", {});
      const bg = q.enqueue("noop", {}, JOB_PRIORITY_BACKGROUND);
      const boosted = q.enqueue("noop", {}, 7);

      await Promise.all([def, bg, boosted].map((id) => waitFinished(q, id)));

      // In-memory job AND persisted row carry the enqueue-time priority.
      expect(q.getJob(def)?.priority).toBe(0);
      expect(registry.getJob(def)?.priority).toBe(0);
      expect(registry.getJob(bg)?.priority).toBe(JOB_PRIORITY_BACKGROUND);
      expect(registry.getJob(boosted)?.priority).toBe(7);
    } finally {
      registry.close();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});

// ----------------------------------------------------- IndexManager harness

/** One-file project: chunking + a stubbed embed is all it needs. */
const PROJECT_ROOT = mkdtempSync(path.join(os.tmpdir(), "cidx-prio-proj-"));
const SRC_DIR = path.join(PROJECT_ROOT, "src");
mkdirSync(SRC_DIR, { recursive: true });
writeFileSync(path.join(SRC_DIR, "tiny.ts"), "export function prioritySmoke() { return 1; }\n");

/** Deterministic stub embedding + a wire-call counter (for the cache assertion). */
let wireCalls = 0;
const vecFor = (text: string, model: string): number[] => [
  ((text.length % 5) + 1) * (model === "model-b" ? 2 : 1),
  text.length,
];

let realFetch: typeof globalThis.fetch | null = null;
beforeAll(async () => {
  await (await import("../src/services/db")).initDB();
  const real = globalThis.fetch;
  realFetch = real;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // Count EMBED calls only: the indexer's readiness probe (/api/tags) is
    // deliberately not an embed and must not affect the cache-hit assertion.
    if (url.endsWith("/api/embed") || url.endsWith("/api/embeddings")) wireCalls++;
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const model = typeof body.model === "string" ? body.model : "";
    const texts = Array.isArray(body.input)
      ? (body.input as unknown[]).map((t) => String(t))
      : typeof body.prompt === "string"
        ? [String(body.prompt)]
        : [];
    // /api/embed is the batch endpoint (embeddings: [[...]]).
    if (url.endsWith("/api/embeddings")) {
      return new Response(JSON.stringify({ embedding: vecFor(texts[0] ?? "", model) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ embeddings: texts.map((t) => vecFor(t, model)) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});
afterAll(() => {
  if (realFetch) globalThis.fetch = realFetch;
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

describe("JobQueue priority — the daemon-level policy", () => {
  type Harness = {
    registry: InstanceType<typeof Registry>;
    queue: InstanceType<typeof JobQueue>;
    manager: InstanceType<typeof IndexManager>;
  };

  const dbPaths: string[] = [];
  let harness: Harness | null = null;

  const boot = (): Harness => {
    const dbPath = path.join(isolatedHome, `prio-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const registry = new Registry(dbPath);
    const queue = new JobQueue({ registry });
    const manager = new IndexManager(registry, queue);
    harness = { registry, queue, manager };
    return harness;
  };

  beforeEach(() => {
    setEmbedBackend({ provider: "ollama", url: "http://127.0.0.1:9", reason: "explicit" });
  });

  afterEach(async () => {
    resetEmbedBackend();
    if (harness) {
      await harness.manager.shutdown();
      // Drain any still-running job BEFORE closing the registry: an async
      // persist after close() would crash into whichever test happens to be
      // running next in this shared bun process.
      while (harness.queue.activeJobCount() > 0) {
        await Bun.sleep(5);
      }
      harness.registry.close();
      harness = null;
    }
    for (const p of dbPaths) {
      try {
        rmSync(p, { force: true });
        rmSync(`${p}-wal`, { force: true });
        rmSync(`${p}-shm`, { force: true });
      } catch {
        /* ignore */
      }
    }
    dbPaths.length = 0;
  });

  const waitForNoJob = (h: Harness, name: string): Promise<void> =>
    new Promise((resolve) => {
      const tick = (): void => {
        if (h.manager.activeJob(name) === null) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });

  test("restore() re-enqueues boot catch-up at the BACKGROUND priority; a user click stays at 0", async () => {
    const h = boot();
    expect(JOB_PRIORITY_BACKGROUND).toBeLessThan(0); // background lane is BELOW the default

    h.manager.createIndex(PROJECT_ROOT, "prio");
    await waitForNoJob(h, "prio");
    expect(h.registry.getIndex("prio")?.status).toBe("ready");

    // Boot-time catch-up: restore() re-syncs the 'ready' project (offline
    // changes) — claimed only before OTHER background work, never a user click.
    h.manager.restore();
    expect(h.manager.activeJob("prio")?.priority).toBe(JOB_PRIORITY_BACKGROUND);
    await waitForNoJob(h, "prio");

    // The enqueue-time priorities reached the persisted rows: the create job
    // (a user click, default 0) and the restore job (the background lane).
    const rows = h.registry
      .listJobs(100)
      .filter((r) => r.type === "index" && (r.payload ?? "").includes('"indexName":"prio"'));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.priority))).toEqual(new Set([0, JOB_PRIORITY_BACKGROUND]));
  });

  test("the corrected reindex help text is true: a fresh reindex KEEPS the embedding cache", async () => {
    const h = boot();

    h.manager.createIndex(PROJECT_ROOT, "cachekeep");
    await waitForNoJob(h, "cachekeep");
    const rowsAfterCreate = h.registry.countEmbeddingCache();
    expect(rowsAfterCreate).toBeGreaterThan(0);
    const callsAfterCreate = wireCalls;
    expect(callsAfterCreate).toBeGreaterThan(0);

    // Same path → createIndex routes to reindex (fresh=true): the table AND the
    // file (mtime) cache are rebuilt, the embedding cache is not.
    h.manager.createIndex(PROJECT_ROOT, "cachekeep");
    await waitForNoJob(h, "cachekeep");

    // No new embed wire call: every chunk hash hit the (content+model)-keyed
    // cache → the reindex legitimately finished on 100% cache hits.
    expect(wireCalls).toBe(callsAfterCreate);
    expect(h.registry.countEmbeddingCache()).toBe(rowsAfterCreate);
  });
});