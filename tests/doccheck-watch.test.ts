/**
 * D1c — check_docs watch/loop mode: the `doccheck` job type.
 *
 * The job handler re-runs the deterministic check for one project, UPSERTs the
 * latest report into the registry (`doccheck_reports`) and completes with a
 * verdict summary. With `doccheck.watch` (default OFF) a successful
 * index/sync/migrate job completion auto-enqueues one doccheck job per project
 * — never a second while the first is queued/running. `lastDocCheckReport`
 * answers `cidx doccheck --last` from the STORED snapshot.
 *
 * A real Registry + JobQueue + IndexManager over temp sqlite/LanceDB with a
 * STUBBED embedding wire — never a live backend (the event-suite harness).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Job } from "../src/core/types";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const db = await import("../src/services/db");
const Registry = (await import("../src/core/registry")).Registry;
const JobQueue = (await import("../src/core/job-queue")).JobQueue;
const IndexManager = (await import("../src/core/index-manager")).IndexManager;
const CONFIG = (await import("../src/config")).CONFIG;
const DOC_CHECK_JOB_TYPE = (await import("../src/core/types")).DOC_CHECK_JOB_TYPE;
const setEmbedBackend = (await import("../src/services/embed")).setEmbedBackend;
const resetEmbedBackend = (await import("../src/services/embed")).resetEmbedBackend;
const isolatedHome = (await import("./helpers/isolated-cidx-home")).isolatedHome;

// ------------------------------------------------------------------ fixtures

/** One-file project + a README whose backticked claims all resolve. */
const PROJECT_ROOT = mkdtempSync(path.join(os.tmpdir(), "cidx-d1c-proj-"));
mkdirSync(path.join(PROJECT_ROOT, "src"), { recursive: true });
writeFileSync(path.join(PROJECT_ROOT, "src", "tiny.ts"), "export function watchSmoke(): number { return 1; }\n");
writeFileSync(
  path.join(PROJECT_ROOT, "README.md"),
  "# Watch fixture\n\nThe deterministic check resolves `watchSmoke` against the index.\n",
);

/** The in-code CONFIG is `as const` (readonly at compile time only). */
const configWatch = CONFIG as unknown as { DOC_CHECK_WATCH: boolean };

/** Deterministic stub embedding (the migrate/event-suite recipe). */
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
  configWatch.DOC_CHECK_WATCH = false;
});

// -------------------------------------------------------------------- harness

type Harness = {
  registry: InstanceType<typeof Registry>;
  queue: InstanceType<typeof JobQueue>;
  manager: InstanceType<typeof IndexManager>;
};

const doccheckJobs = (h: Harness): Job[] =>
  h.queue.listJobs().filter((j) => j.type === DOC_CHECK_JOB_TYPE);

describe("doccheck job type + watch mode (D1c)", () => {
  const dbPaths: string[] = [];
  let harness: Harness | null = null;

  const boot = (): Harness => {
    const dbPath = path.join(isolatedHome, `d1c-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    const registry = new Registry(dbPath);
    const queue = new JobQueue({ registry });
    const manager = new IndexManager(registry, queue);
    return { registry, queue, manager };
  };

  beforeEach(() => {
    setEmbedBackend({ provider: "ollama", url: "http://127.0.0.1:9", reason: "explicit" });
  });

  afterEach(async () => {
    configWatch.DOC_CHECK_WATCH = false;
    resetEmbedBackend();
    if (harness) {
      harness.queue.abortAll();
      await harness.manager.shutdown();
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

  /** Resolved once no doccheck job is queued/running any more. */
  const waitForNoActiveDoccheck = (h: Harness): Promise<void> =>
    new Promise((resolve) => {
      const tick = (): void => {
        const active = doccheckJobs(h).some((j) => j.status === "queued" || j.status === "running");
        if (!active) resolve();
        else setTimeout(tick, 5);
      };
      tick();
    });

  test("the doccheck job runs the check and STORES the latest report", async () => {
    harness = boot();
    const { manager, queue, registry } = harness;

    manager.createIndex(PROJECT_ROOT, "d1cw");
    await waitForNoJob(harness, "d1cw");
    // No stored report before the first doccheck job ran.
    expect(registry.getDocCheckReport("d1cw")).toBeNull();

    queue.enqueue(DOC_CHECK_JOB_TYPE, { project: "d1cw" });
    await waitForNoActiveDoccheck(harness);

    const jobs = doccheckJobs(harness);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("completed");
    const result = jobs[0]!.result as { project: string; stored: boolean; consistent: boolean; findings: number };
    expect(result.project).toBe("d1cw");
    expect(result.stored).toBe(true);
    expect(result.consistent).toBe(true); // the fixture README resolves cleanly
    expect(result.findings).toBe(0);

    const row = registry.getDocCheckReport("d1cw");
    expect(row).not.toBeNull();
    expect(row!.project).toBe("d1cw");
    expect(row!.consistent).toBe(true);
    expect(row!.findings).toBe(0);
    expect(row!.ts).toBeGreaterThan(0);
    const report = JSON.parse(row!.reportJson) as {
      project: string;
      verdict: { consistent: boolean; findings: number; needsReview: number };
      findings: unknown[];
    };
    expect(report.project).toBe("d1cw");
    expect(report.verdict.consistent).toBe(true);
    expect(report.findings).toHaveLength(0);
    // Row counters agree with the stored report body.
    expect(row!.needsReview).toBe(report.verdict.needsReview);
  });

  test("--last reads the STORED snapshot (parsed report, honest ts); unknown project throws", async () => {
    harness = boot();
    const { manager, queue, registry } = harness;

    manager.createIndex(PROJECT_ROOT, "d1cw");
    await waitForNoJob(harness, "d1cw");

    // Before any doccheck job ran: no stored report (an honest null, not a fake).
    expect(await manager.lastDocCheckReport({ project: "d1cw" })).toBeNull();

    queue.enqueue(DOC_CHECK_JOB_TYPE, { project: "d1cw" });
    await waitForNoActiveDoccheck(harness);

    const found = await manager.lastDocCheckReport({ project: "d1cw" });
    expect(found).not.toBeNull();
    expect(found!.project).toBe("d1cw");
    // The STORED ts — the moment the job stored it, never "now".
    expect(found!.ts).toBe(registry.getDocCheckReport("d1cw")!.ts);
    expect(found!.consistent).toBe(true);
    expect(found!.report.project).toBe("d1cw");

    // Unknown project → the self-healing error naming the projects.
    await expect(manager.lastDocCheckReport({ project: "ghost" })).rejects.toThrow("Index not found");
  });

  test("watch mode OFF by default: completed index jobs enqueue nothing", async () => {
    harness = boot();
    const { manager, registry } = harness;

    configWatch.DOC_CHECK_WATCH = false;
    manager.createIndex(PROJECT_ROOT, "d1cw");
    await waitForNoJob(harness, "d1cw");

    expect(doccheckJobs(harness)).toHaveLength(0);
    expect(registry.getDocCheckReport("d1cw")).toBeNull();
  });

  test("the watch flag auto-runs a doccheck after an index job AND after a sync job", async () => {
    harness = boot();
    const { manager, registry } = harness;

    configWatch.DOC_CHECK_WATCH = true;
    manager.createIndex(PROJECT_ROOT, "d1cw");
    await waitForNoJob(harness, "d1cw");
    await waitForNoActiveDoccheck(harness);

    let jobs = doccheckJobs(harness).filter((j) => j.status === "completed");
    expect(jobs).toHaveLength(1);
    expect(registry.getDocCheckReport("d1cw")!.consistent).toBe(true);

    // A later SYNC job re-triggers the loop (the report is refreshed).
    manager.syncIndex("d1cw");
    await waitForNoJob(harness, "d1cw");
    await waitForNoActiveDoccheck(harness);
    jobs = doccheckJobs(harness).filter((j) => j.status === "completed");
    expect(jobs).toHaveLength(2);
    // Only the LATEST run is kept: the stored ts is the newest job's store time.
    expect(registry.getDocCheckReport("d1cw")!.ts).toBe((jobs[0]!.result as { ts: number }).ts);
  });

  test("no double-enqueue while a doccheck job is queued/running; cancelled clears the guard", async () => {
    harness = boot();
    const { manager, queue, registry } = harness;

    configWatch.DOC_CHECK_WATCH = true;
    manager.createIndex(PROJECT_ROOT, "d1cw");
    await waitForNoJob(harness, "d1cw");
    await waitForNoActiveDoccheck(harness);

    // Occupy the single worker so the next doccheck job stays QUEUED.
    queue.registerHandler("d1c-block", () => new Promise((resolve) => setTimeout(resolve, 250)));
    queue.enqueue("d1c-block", null);

    const before = new Set(queue.listJobs().map((j) => j.id));
    const id1 = manager.maybeEnqueueDocCheckJob("d1cw");
    expect(id1).not.toBeNull();
    expect(before.has(id1!)).toBe(false); // a NEW job was created
    expect(queue.getJob(id1!)!.status).toBe("queued");
    // The double-enqueue guard: a second trigger while queued/running adds nothing.
    expect(manager.maybeEnqueueDocCheckJob("d1cw")).toBeNull();
    expect(
      queue.listJobs().filter((j) => j.type === DOC_CHECK_JOB_TYPE && !before.has(j.id)),
    ).toHaveLength(1);

    // The guard only counts queued/running — a CANCELLED run stores nothing
    // (the snapshot from the auto-run above stays) and does not block the next
    // legitimate trigger.
    const storedTs = registry.getDocCheckReport("d1cw")!.ts;
    queue.cancel(id1!);
    await queue.waitForJob(id1!);
    expect(queue.getJob(id1!)!.status).toBe("cancelled");
    expect(registry.getDocCheckReport("d1cw")!.ts).toBe(storedTs); // untouched
    const id2 = manager.maybeEnqueueDocCheckJob("d1cw");
    expect(id2).not.toBeNull();
    expect(id2).not.toBe(id1);
    await waitForNoActiveDoccheck(harness);
    // The fresh (non-cancelled) run replaced the snapshot.
    expect(registry.getDocCheckReport("d1cw")!.ts).toBeGreaterThanOrEqual(storedTs);
  });

  test("maybeEnqueueDocCheckJob guard rails: unknown project and flag-off are null", async () => {
    harness = boot();
    const { manager } = harness;

    manager.createIndex(PROJECT_ROOT, "d1cw");
    await waitForNoJob(harness, "d1cw");

    // Watch off → no enqueue even for a valid project.
    configWatch.DOC_CHECK_WATCH = false;
    expect(manager.maybeEnqueueDocCheckJob("d1cw")).toBeNull();
    // Watch on + unknown/absent project → nothing to check.
    configWatch.DOC_CHECK_WATCH = true;
    expect(manager.maybeEnqueueDocCheckJob("ghost")).toBeNull();
    expect(manager.maybeEnqueueDocCheckJob(undefined)).toBeNull();
  });

  test("the doccheck job completion surfaces as a job-completed event (A2)", async () => {
    harness = boot();
    const { manager } = harness;

    configWatch.DOC_CHECK_WATCH = true;
    const events: { type: string; jobType?: string; status?: string }[] = [];
    const off = manager.onIndexEvent((ev) => events.push(ev as { type: string; jobType?: string; status?: string }));

    manager.createIndex(PROJECT_ROOT, "d1cw");
    await waitForNoJob(harness, "d1cw");
    await waitForNoActiveDoccheck(harness);
    off();

    expect(
      events.some((e) => e.type === "job-completed" && e.jobType === "doccheck" && e.status === "completed"),
    ).toBe(true);
    // The index job that triggered it produced its own event earlier.
    expect(
      events.some((e) => e.type === "job-completed" && e.jobType === "index" && e.status === "completed"),
    ).toBe(true);
  });
});

describe("doccheck_reports registry rows", () => {
  const dbPaths: string[] = [];

  const mkRegistry = (): InstanceType<typeof Registry> => {
    const dbPath = path.join(isolatedHome, `d1c-reg-${randomUUID()}.db`);
    dbPaths.push(dbPath);
    return new Registry(dbPath);
  };

  afterEach(() => {
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

  test("the UPSERT keeps only the latest snapshot per project", () => {
    const reg = mkRegistry();
    reg.saveDocCheckReport({
      project: "x",
      ts: 1_000,
      consistent: false,
      findings: 3,
      needsReview: 5,
      reportJson: '{"older":true}',
    });
    reg.saveDocCheckReport({
      project: "x",
      ts: 2_000,
      consistent: true,
      findings: 0,
      needsReview: 1,
      reportJson: '{"newer":true}',
    });
    const row = reg.getDocCheckReport("x");
    expect(row).toEqual({
      project: "x",
      ts: 2_000,
      consistent: true,
      findings: 0,
      needsReview: 1,
      reportJson: '{"newer":true}',
    });
    expect(reg.getDocCheckReport("y")).toBeNull();
    reg.close();
  });

  test("removeIndexDeep deletes the stored snapshot with the project", () => {
    const reg = mkRegistry();
    reg.saveDocCheckReport({
      project: "gone",
      ts: 10,
      consistent: true,
      findings: 0,
      needsReview: 0,
      reportJson: "{}",
    });
    reg.removeIndexDeep("gone");
    expect(reg.getDocCheckReport("gone")).toBeNull();
    reg.close();
  });
});