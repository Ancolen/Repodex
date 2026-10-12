/**
 * A2 — the IndexManager event hook (`onIndexEvent`): job completions, index
 * adds and removals land exactly once per lifecycle change, with the project
 * derived from the job payload, a throwing listener is contained, and a
 * refresh (createIndex over an existing project) does not re-announce "added".
 * A real Registry + JobQueue + IndexManager over temp sqlite/LanceDB with a
 * STUBBED embedding wire — never a live backend (the migrate-suite harness).
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DaemonEventInput } from "../src/core/events";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const db = await import("../src/services/db");
const Registry = (await import("../src/core/registry")).Registry;
const JobQueue = (await import("../src/core/job-queue")).JobQueue;
const IndexManager = (await import("../src/core/index-manager")).IndexManager;
const setEmbedBackend = (await import("../src/services/embed")).setEmbedBackend;
const resetEmbedBackend = (await import("../src/services/embed")).resetEmbedBackend;
const isolatedHome = (await import("./helpers/isolated-cidx-home")).isolatedHome;

// ------------------------------------------------------------------ fixtures

/** One-file project: chunking + a stubbed embed is all it needs. */
const PROJECT_ROOT = mkdtempSync(path.join(os.tmpdir(), "cidx-events-proj-"));
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const PROJECT_FILE = path.join(SRC_DIR, "tiny.ts");
mkdirSync(SRC_DIR, { recursive: true });
writeFileSync(PROJECT_FILE, "export function eventSmoke() { return 1; }\n");

/** Deterministic stub embedding. */
const vecFor = (text: string, model: string): number[] => [
  ((text.length % 5) + 1) * (model === "model-b" ? 2 : 1),
  text.length,
];

let realFetch: typeof globalThis.fetch | null = null;
beforeAll(async () => {
  await db.initDB();
  const real = globalThis.fetch;
  realFetch = real;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
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

// -------------------------------------------------------------------- harness

describe("IndexManager.onIndexEvent — the daemon's subscribable hook", () => {
  type Harness = {
    registry: InstanceType<typeof Registry>;
    queue: InstanceType<typeof JobQueue>;
    manager: InstanceType<typeof IndexManager>;
    events: DaemonEventInput[];
  };

  const dbPaths: string[] = [];
  let harness: Harness | null = null;

  const boot = (listeners: Array<(ev: DaemonEventInput) => void> = []): Harness => {
    const dbPath = path.join(isolatedHome, `events-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const registry = new Registry(dbPath);
    const queue = new JobQueue({ registry });
    const manager = new IndexManager(registry, queue);
    const events: DaemonEventInput[] = [];
    const unsubscribeAll = listeners.map((fn) => manager.onIndexEvent((ev) => fn(ev)));
    manager.onIndexEvent((ev) => events.push(ev));
    return { registry, queue, manager, events };
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

  test("createIndex → one index-added, then one completed job-completed event", async () => {
    harness = boot();
    const { manager, events } = harness;

    manager.createIndex(PROJECT_ROOT, "evtx");
    expect(events).toEqual([{ type: "index-added", project: "evtx" }]);

    await waitForNoJob(harness, "evtx");
    expect(events).toEqual([
      { type: "index-added", project: "evtx" },
      { type: "job-completed", project: "evtx", jobType: "index", status: "completed" },
    ]);
  });

  test("a refresh (createIndex over the same path) announces no new index-added", async () => {
    harness = boot();
    const { manager, events } = harness;

    manager.createIndex(PROJECT_ROOT, "evtx");
    await waitForNoJob(harness, "evtx");
    manager.createIndex(PROJECT_ROOT, "evtx"); // same path → routed to reindex
    await waitForNoJob(harness, "evtx");

    const added = events.filter((e) => e.type === "index-added");
    expect(added).toHaveLength(1);
    const completed = events.filter(
      (e) => e.type === "job-completed" && e.status === "completed",
    );
    expect(completed).toHaveLength(2);
  });

  test("removeIndex → one index-removed event, after the project is gone", async () => {
    harness = boot();
    const { manager, events } = harness;

    manager.createIndex(PROJECT_ROOT, "evtx");
    await waitForNoJob(harness, "evtx");
    const removed = await manager.removeIndex("evtx");
    expect(removed).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "index-removed", project: "evtx" });
    expect(manager.getIndex("evtx")).toBeNull();
    // In order: added → job-completed → removed.
    expect(events.map((e) => e.type)).toEqual(["index-added", "job-completed", "index-removed"]);
  });

  test("a throwing listener is contained — the job still completes", async () => {
    harness = boot([
      () => {
        throw new Error("listener exploded");
      },
    ]);
    const { manager, events } = harness;

    manager.createIndex(PROJECT_ROOT, "evtx");
    await waitForNoJob(harness, "evtx");

    expect(manager.getIndex("evtx")?.status).toBe("ready");
    expect(events).toEqual([
      { type: "index-added", project: "evtx" },
      { type: "job-completed", project: "evtx", jobType: "index", status: "completed" },
    ]);
  });

  test("the returned fn unsubscribes — late events stop flowing", () => {
    harness = boot();
    const { manager, events } = harness;
    const late: DaemonEventInput[] = [];
    const off = manager.onIndexEvent((ev) => late.push(ev));
    off();
    manager.createIndex(PROJECT_ROOT, "evtx");
    expect(late).toEqual([]);
    expect(events.length).toBeGreaterThan(0); // the real subscriber still sees them
  });
});