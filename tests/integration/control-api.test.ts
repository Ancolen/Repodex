/**
 * db + Control-API integration battery — COMMITTED and self-contained.
 *
 * Until now the Control API (and the db writing behind it) was exercised only
 * by per-version smoke runs against a manually started daemon; this suite
 * gives the same wire coverage with zero manual steps — the plain `bun test`
 * run carries it. Self-contained rules, each mechanically enforced below:
 *
 *   - the only faked piece is the embedding backend (an in-process fake Ollama
 *     on an ephemeral port, sha256-derived vectors — see ./helpers.ts); the
 *     daemon, sqlite registry, LanceDB table, watcher-less job queue, every
 *     route handler and the query log are all real;
 *   - the daemon runs as a subprocess with CIDX_HOME pointed at a temp dir and
 *     MCP_PORT/CONTROL_PORT at free ports picked per attempt (bind conflict →
 *     retry with fresh ports) — never the production 9371/9372, never ~/.cidx;
 *   - every wait is bounded (a hang fails one test, not the run);
 *   - one daemon lifetime, sequential scenarios in dependency order:
 *     boot → create → await job → serve (text/vector/find/outline/deps) →
 *     analytics (querylog/stats/doctor/events) → incremental sync (an edit
 *     and a file deletion, exercising deleted-file cleanup) → one report
 *     tool → graceful shutdown (exit code 0 — the SIGINT path).
 *
 * The `import type`s keep the asserted shapes structurally honest against the
 * real source types; they are erased at runtime, so the test process never
 * loads `src/` modules (the daemon subprocess does all of that under its own
 * env — `bunfig.toml`'s isolated CIDX_HOME preload stays untouched by it).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DependencyResult, ScopedSearchResult, SearchEnvelope } from "../../src/core/index-manager";
import type { DocCheckReport } from "../../src/core/doccheck";
import type { OutlineEntry } from "../../src/chunking/chunker";
import type { CouplingReport } from "../../src/core/coupling";
import type { DaemonEventPage } from "../../src/core/events";
import type { DoctorReport } from "../../src/core/doctor";
import type { QueryLogStats } from "../../src/core/registry";
import type { StatsReport } from "../../src/core/stats";
import type { IndexView } from "../../src/server/resource-defs";
import {
  callApi,
  rmDir,
  startDaemon,
  startFakeEmbedBackend,
  stopDaemon,
  waitFor,
  type DaemonHandle,
  type FakeEmbedBackend,
} from "./helpers";

const PROJECT_NAME = "int-fixture-battery";
/** deriveTableName("int-fixture-battery") — the table the daemon must serve. */
const PROJECT_TABLE = "idx_int_fixture_battery";

const FIXTURE_FILES: { rel: string; content: string }[] = [
  {
    rel: "src/greet.ts",
    content: `/** Greets one caller by name. */
export function greet(name: string): string {
  return "hello " + name;
}

/** Repeats the greeting for every caller. */
export class Greeter {
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  greetAll(names: string[]): string[] {
    return names.map((n) => greet(this.prefix + ":" + n));
  }
}
`,
  },
  {
    rel: "src/util.ts",
    content: `/** A tiny helper the app layer composes. */
export function helperValue(n: number): number {
  return n * 2;
}
`,
  },
  {
    rel: "src/app.ts",
    content: `import { Greeter, greet } from "./greet";
import { helperValue } from "./util";

/** Wires the greeting and helper pieces together. */
export function runApp(): string {
  const greeter = new Greeter("app");
  const lines = greeter.greetAll(["a", "b"]);
  const doubled = helperValue(lines.length);
  return greet("app") + ":" + String(doubled);
}
`,
  },
  {
    // The vector round-trip probe's file: a single symbol whose chunk content
    // can be re-embedded byte-for-byte as a query (see the vector scenario).
    rel: "src/solo.ts",
    content: `/** One-symbol file for the vector round-trip probe. */
export function soloMarker(): number {
  return 42;
}
`,
  },
  {
    // A second language so the fixture exercises two grammars end to end.
    rel: "src/tool.py",
    content: `"""Fixture tooling for the daemon battery."""


def py_probe(value: int) -> int:
    """Double the incoming value."""
    return value * 2
`,
  },
];

/** The doc created by the report-freshness scenario (indexed like any other .md). */
const WATCH_DOC_REL = "docs/watcher-freshness.md";
/** Every indexed file after the doccheck scenario: the fixture sources + that doc. */
const INDEXED_FILE_COUNT = FIXTURE_FILES.length + 1;

describe("db + control-api integration battery", () => {
  let backend: FakeEmbedBackend | undefined;
  let projectRoot: string | undefined;
  let daemon: DaemonHandle | undefined;

  const abs = (rel: string): string => {
    if (projectRoot === undefined) throw new Error("fixture not created");
    return path.join(projectRoot, rel);
  };

  beforeAll(async () => {
    backend = startFakeEmbedBackend();
    projectRoot = mkdtempSync(path.join(tmpdir(), "cidx-battery-project-"));
    for (const file of FIXTURE_FILES) {
      const filePath = abs(file.rel);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }
    daemon = await startDaemon({ embedUrl: backend.url });
  }, 120_000);

  afterAll(async () => {
    // Death asserted: a daemon that outlives the suite would keep its port,
    // and a leaked scratch home would re-grow with every run.
    if (daemon) {
      const code = await stopDaemon(daemon);
      expect(daemon.proc.exitCode).not.toBeNull();
      expect(code).toBeGreaterThanOrEqual(0);
      rmDir(daemon.home);
    }
    backend?.stop();
    if (projectRoot !== undefined) rmDir(projectRoot);
  }, 60_000);

  // --------------------------------------------------------------- boot

  test("GET /ping answers with the daemon identity", async () => {
    if (!daemon) throw new Error("daemon not started");
    const pong = await callApi<{ ok: boolean; version: string; pid: number }>(daemon.controlUrl, "/ping");
    expect(pong.ok).toBe(true);
    expect(pong.version.length).toBeGreaterThan(0);
    expect(pong.pid).toBeGreaterThan(0);
    expect(pong.pid).not.toBe(process.pid); // the daemon is really a subprocess
  });

  // ------------------------------------------------- create + await the job

  test("POST /index registers the project and reports the derived table", async () => {
    if (!daemon) throw new Error("daemon not started");
    const view = await callApi<IndexView>(daemon.controlUrl, "/index", {
      method: "POST",
      body: { path: abs("."), name: PROJECT_NAME },
    });
    expect(view.name).toBe(PROJECT_NAME);
    expect(view.path).toBe(projectRoot);
    expect(view.table).toBe(PROJECT_TABLE);
    expect(["indexing", "ready"]).toContain(view.status);
  });

  test("the index job completes: the table becomes ready with real chunks", async () => {
    if (!daemon) throw new Error("daemon not started");
    const view = await waitFor(
      "project 'int-fixture-battery' to become ready",
      async () => {
        const v = await callApi<IndexView>(daemon.controlUrl, `/indexes/${PROJECT_NAME}`);
        return v.status === "ready" && v.job === null ? v : null;
      },
      { timeoutMs: 45_000 },
    );
    expect(view.error).toBeNull();
    expect(view.lastIndexedAt).not.toBeNull();
    expect(view.files).toBe(FIXTURE_FILES.length);
    expect(view.chunks).toBeGreaterThan(0);
  }, 60_000);

  test("GET /indexes lists the served project", async () => {
    if (!daemon) throw new Error("daemon not started");
    const list = await callApi<IndexView[]>(daemon.controlUrl, "/indexes");
    const rec = list.find((r) => r.name === PROJECT_NAME);
    expect(rec).toBeDefined();
    expect(rec?.status).toBe("ready");
    expect(rec?.table).toBe(PROJECT_TABLE);
  });

  // ---------------------------------------------------------------- serving

  test("search (text mode) serves chunks from the finished table", async () => {
    if (!daemon || !backend) throw new Error("daemon not started");
    const env = await callApi<SearchEnvelope>(daemon.controlUrl, "/search", {
      method: "POST",
      body: { query: "greet", project: PROJECT_NAME, mode: "text", limit: 5, rerank: false },
    });
    // A plain search's envelope is exactly { results } — no expand/blame notes.
    expect(Object.keys(env).toSorted()).toEqual(["results"]);
    expect(env.results.length).toBeGreaterThan(0);
    expect(env.results.some((r) => r.symbolName === "greet")).toBe(true);
    for (const r of env.results) {
      expect(r.project).toBe(PROJECT_NAME);
      expect(r.filePath.startsWith(projectRoot!)).toBe(true);
      expect(r.content.length).toBeGreaterThan(0);
      // Public results never carry embedding columns.
      expect("vector" in r).toBe(false);
      expect("doc_vector" in r).toBe(false);
    }
  });

  test("a zero-hit query is served as an empty envelope (for the query log)", async () => {
    if (!daemon) throw new Error("daemon not started");
    // A token no fixture file mentions (none of the docstring words either —
    // the doc BM25 leg would otherwise rescue the search with a hit).
    const env = await callApi<SearchEnvelope>(daemon.controlUrl, "/search", {
      method: "POST",
      body: { query: "qqqzzz_absent_token_vv", project: PROJECT_NAME, mode: "text", limit: 5, rerank: false },
    });
    expect(Object.keys(env).toSorted()).toEqual(["results"]);
    expect(env.results).toEqual([]);
  });

  test("/find returns exact symbol hits without the fuzzy marker", async () => {
    if (!daemon) throw new Error("daemon not started");
    const results = await callApi<ScopedSearchResult[]>(daemon.controlUrl, "/find", {
      method: "POST",
      body: { name: "soloMarker", project: PROJECT_NAME, limit: 20 },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.symbolName === "soloMarker")).toBe(true);
    for (const r of results) {
      expect(r.fuzzy).not.toBe(true);
      expect(r.startLine).toBeGreaterThan(0);
    }
    // The solo file's chunk content is captured verbatim for the vector probe:
    // whatever the chunker stored IS what got embedded (framing is off for
    // this model), so re-embedding it as a query must reproduce its vector.
    const solo = results.find((r) => r.symbolName === "soloMarker" && r.filePath === abs("src/solo.ts"));
    expect(solo?.content).toContain("soloMarker");
    expect(solo?.content).toContain("return 42;");
  });

  test("/find falls back to the fuzzy tier and marks every hit", async () => {
    if (!daemon) throw new Error("daemon not started");
    // One typo off soloMarker — no exact hit, no prefix hit, several trigram hits.
    const results = await callApi<ScopedSearchResult[]>(daemon.controlUrl, "/find", {
      method: "POST",
      body: { name: "soloMarkes", project: PROJECT_NAME, limit: 20 },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.fuzzy === true)).toBe(true);
    expect(results.some((r) => r.symbolName === "soloMarker")).toBe(true);
  });

  test("search (vector mode) round-trips the fake backend at distance zero", async () => {
    if (!daemon || !backend) throw new Error("daemon not started");
    const found = await callApi<ScopedSearchResult[]>(daemon.controlUrl, "/find", {
      method: "POST",
      body: { name: "soloMarker", project: PROJECT_NAME, limit: 20 },
    });
    const solo = found.find((r) => r.filePath === abs("src/solo.ts"));
    if (!solo || !solo.content) throw new Error("soloMarker chunk not served by /find");
    const env = await callApi<SearchEnvelope>(daemon.controlUrl, "/search", {
      method: "POST",
      body: {
        query: solo.content,
        project: PROJECT_NAME,
        mode: "vector",
        // Single vector leg — no doc legs and no RRF, so the native cosine
        // distance is on every result and the exact match owns rank 1.
        doc: false,
        rerank: false,
        mmr: false,
        boost: false,
        limit: 5,
      },
    });
    expect(Object.keys(env).toSorted()).toEqual(["results"]);
    expect(env.results.length).toBeGreaterThan(0);
    const top = env.results[0]!;
    expect(top.filePath).toBe(abs("src/solo.ts"));
    expect(top.content).toBe(solo.content);
    expect(typeof top._distance).toBe("number");
    // Identical texts → identical sha256 vectors → cosine distance 0 (float32
    // noise tolerable); unrelated chunks sit around cos ≈ 1 — a 6-order gap.
    expect(top._distance!).toBeLessThan(1e-6);
    expect(Object.keys(top)).not.toContain("vector");
    expect(Object.keys(top)).not.toContain("doc_vector");

    // A second, NOT-cached query (the exact-content one above was already in
    // the embedding cache from indexing) proves the vector leg's single-embed
    // wire call: POST /api/embeddings on the fake backend.
    const unique = await callApi<SearchEnvelope>(daemon.controlUrl, "/search", {
      method: "POST",
      body: {
        query: `uncached vector probe ${Date.now()}`,
        project: PROJECT_NAME,
        mode: "vector",
        doc: false,
        rerank: false,
        mmr: false,
        boost: false,
        limit: 5,
      },
    });
    expect(Object.keys(unique).toSorted()).toEqual(["results"]);
    expect(unique.results.length).toBeGreaterThan(0);
    for (const r of unique.results) {
      expect(typeof r._distance).toBe("number");
    }
  });

  test("/outline maps the file's symbols", async () => {
    if (!daemon) throw new Error("daemon not started");
    const outline = await callApi<OutlineEntry[]>(daemon.controlUrl, "/outline", {
      method: "POST",
      body: { path: abs("src/greet.ts") },
    });
    const names = outline.map((o) => o.symbolName);
    expect(names).toContain("greet");
    expect(names).toContain("Greeter");
    for (const entry of outline) {
      expect(entry.startLine).toBeGreaterThan(0);
      expect(entry.endLine).toBeGreaterThanOrEqual(entry.startLine);
    }
  });

  test("/dependencies resolves forward and reverse edges through the dep graph", async () => {
    if (!daemon) throw new Error("daemon not started");
    const forward = await callApi<DependencyResult>(daemon.controlUrl, "/dependencies", {
      method: "POST",
      body: { path: abs("src/app.ts") },
    });
    expect(forward.project).toBe(PROJECT_NAME);
    expect(forward.truncated).toBe(false);
    expect(forward.scannedFiles).toBeGreaterThan(0);
    const resolved = forward.imports.filter((edge) => edge.status === "resolved");
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.some((edge) => edge.path === abs("src/greet.ts"))).toBe(true);

    // The reverse side comes from the manager's (rebuilt-on-change) graph.
    const reverse = await callApi<DependencyResult>(daemon.controlUrl, "/dependencies", {
      method: "POST",
      body: { path: abs("src/greet.ts") },
    });
    expect(reverse.importedBy.some((file) => file.endsWith("src/app.ts"))).toBe(true);
  });

  // -------------------------------------------------------------- analytics

  test("the query log recorded the searches (project-scoped too)", async () => {
    if (!daemon) throw new Error("daemon not started");
    // At least: greet-text, zero-hit-text, vector round-trip — one row each.
    const stats = await callApi<QueryLogStats>(daemon.controlUrl, "/querylog");
    expect(stats.total).toBeGreaterThanOrEqual(3);
    const greeted = stats.topQueries.find((q) => q.query === "greet");
    expect(greeted).toBeDefined();
    expect(greeted!.avgResultCount).toBeGreaterThan(0);
    expect(stats.zeroHit.map((z) => z.query)).toContain("qqqzzz_absent_token_vv");
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(stats.repeatRate).toBeGreaterThanOrEqual(0);
    expect(stats.repeatRate).toBeLessThanOrEqual(1);

    const scoped = await callApi<QueryLogStats>(daemon.controlUrl, `/querylog?project=${PROJECT_NAME}`);
    expect(scoped.total).toBeGreaterThanOrEqual(3);
  });

  test("GET /stats reports the project and the data root honestly", async () => {
    if (!daemon) throw new Error("daemon not started");
    const report = await callApi<StatsReport>(daemon.controlUrl, "/stats");
    expect(report.home).toBe(daemon.home);
    expect(report.global.rootExists).toBe(true);
    expect(report.global.totalBytes).toBeGreaterThan(0);
    expect(report.global.metaDbBytes).toBeGreaterThan(0);
    expect(report.global.embeddingCache.rows).toBeGreaterThan(0);
    expect(report.global.tables.map((t) => t.name)).toContain(PROJECT_TABLE);
    expect(report.projects.length).toBe(1);
    const project = report.projects[0]!;
    expect(project.name).toBe(PROJECT_NAME);
    expect(project.table).toBe(PROJECT_TABLE);
    expect(project.status).toBe("ready");
    expect(project.rows).toBeGreaterThan(0);
    expect(project.cachedFiles).toBe(FIXTURE_FILES.length);
    expect(project.lastIndexedAt).not.toBeNull();
    expect(project.tableBytes).toBeGreaterThan(0);
    expect(project.job).toBeNull();
  });

  test("GET /doctor runs every check and tolerates warn-level findings", async () => {
    if (!daemon) throw new Error("daemon not started");
    const report = await callApi<DoctorReport>(daemon.controlUrl, "/doctor");
    expect(report.home).toBe(daemon.home);
    expect(["ok", "warn"]).toContain(report.status);
    const ids = report.checks.map((c) => c.id);
    for (const id of ["backend", "reranker", "tables", "config", "disk", `project:${PROJECT_NAME}`]) {
      expect(ids).toContain(id);
    }
    // The fake backend serves the fake model → the backend check is fully green.
    const backendCheck = report.checks.find((c) => c.id === "backend");
    expect(backendCheck?.status).toBe("ok");
    // A reranker probe that 404s degrades to warn, never fail.
    const reranker = report.checks.find((c) => c.id === "reranker");
    expect(["ok", "warn"]).toContain(reranker?.status);
    const projectCheck = report.checks.find((c) => c.id === `project:${PROJECT_NAME}`);
    expect(["ok", "warn"]).toContain(projectCheck?.status);
  });

  test("GET /events pages the ring since a cursor", async () => {
    if (!daemon) throw new Error("daemon not started");
    const page = await callApi<DaemonEventPage>(daemon.controlUrl, "/events?since=0");
    expect(page.lastId).toBeGreaterThanOrEqual(2);
    expect(page.events.length).toBeGreaterThanOrEqual(2);
    const types = page.events.map((e) => e.type);
    expect(types).toContain("index-added");
    const completed = page.events.find((e) => e.type === "job-completed");
    expect(completed?.project).toBe(PROJECT_NAME);
    expect(completed?.jobType).toBe("index");
    expect(completed?.status).toBe("completed");
    for (const ev of page.events) {
      expect(ev.id).toBeGreaterThan(0);
      expect(ev.ts).toBeGreaterThan(0);
    }
    // Paging from the cursor: nothing new, same lastId.
    const next = await callApi<DaemonEventPage>(daemon.controlUrl, `/events?since=${page.lastId}`);
    expect(next.events).toEqual([]);
    expect(next.lastId).toBe(page.lastId);
  });

  // ------------------------------------------------------- incremental sync

  test("a sync picks up an edited file's new symbol", async () => {
    if (!daemon) throw new Error("daemon not started");
    appendFileSync(
      abs("src/util.ts"),
      `/** A marker the incremental-sync scenario can see. */
export function syncProbe(): string {
  return "probe";
}
`,
      "utf-8",
    );
    const view = await callApi<IndexView>(daemon.controlUrl, "/sync", {
      method: "POST",
      body: { name: PROJECT_NAME },
    });
    // 'indexing' here unless the whole incremental sync beat the response.
    expect(["indexing", "ready"]).toContain(view.status);
    await waitFor(
      "post-edit sync to finish",
      async () => {
        const v = await callApi<IndexView>(daemon.controlUrl, `/indexes/${PROJECT_NAME}`);
        return v.status === "ready" && v.job === null ? v : null;
      },
      { timeoutMs: 45_000 },
    );
    // Either the watcher or the sync wrote the file already — poll the strict
    // (fuzzy-off) lookup until the new symbol is genuinely served.
    await waitFor(
      "the synced symbol to be served",
      async () => {
        const results = await callApi<ScopedSearchResult[]>(daemon.controlUrl, "/find", {
          method: "POST",
          body: { name: "syncProbe", project: PROJECT_NAME, limit: 20, fuzzy: false },
        });
        return results.length > 0 ? results : null;
      },
      { timeoutMs: 15_000 },
    );
  });

  test("a watcher write reconciles the registry counters without a sync", async () => {
    if (!daemon) throw new Error("daemon not started");
    const before = await callApi<IndexView>(daemon.controlUrl, `/indexes/${PROJECT_NAME}`);
    appendFileSync(
      abs("src/app.ts"),
      `/** A marker the watcher-reconcile scenario can see. */
export function watchProbe(): string {
  return "watch";
}
`,
      "utf-8",
    );
    // The watcher (not a job) writes the table; prove the symbol is served…
    await waitFor(
      "the watcher to serve the edited symbol",
      async () => {
        const results = await callApi<ScopedSearchResult[]>(daemon.controlUrl, "/find", {
          method: "POST",
          body: { name: "watchProbe", project: PROJECT_NAME, limit: 20, fuzzy: false },
        });
        return results.length > 0 ? results : null;
      },
      { timeoutMs: 15_000 },
    );
    // …then that the debounced reconcile updated the registry counters (before
    // the fix, `chunks` stayed at the pre-edit value until a manual sync).
    await waitFor(
      "the registry chunk counter to reconcile after the watcher write",
      async () => {
        const v = await callApi<IndexView>(daemon.controlUrl, `/indexes/${PROJECT_NAME}`);
        return v.chunks > before.chunks ? v : null;
      },
      { timeoutMs: 15_000 },
    );
    const after = await callApi<IndexView>(daemon.controlUrl, `/indexes/${PROJECT_NAME}`);
    expect(after.files).toBe(before.files);
    expect(after.chunks).toBeGreaterThan(before.chunks);
  }, 45_000);

  test("a watcher write invalidates the doccheck snapshot without a sync", async () => {
    if (!daemon) throw new Error("daemon not started");
    mkdirSync(path.join(projectRoot!, "docs"), { recursive: true });
    writeFileSync(
      abs(WATCH_DOC_REL),
      "# Watch freshness\n\nThe `greet` symbol is documented here.\n",
      "utf-8",
    );
    // Populate the doccheck snapshot cache at the current data revision.
    const first = await callApi<DocCheckReport>(daemon.controlUrl, "/doccheck", {
      method: "POST",
      body: { project: PROJECT_NAME, noUndocumented: true },
    });
    expect(first.checked.indexFreshness).not.toBeNull();
    expect(first.findings.some((f) => f.message.includes("greet"))).toBe(false);

    appendFileSync(
      abs("src/app.ts"),
      `/** Added AFTER the doccheck snapshot was cached. */
export function watcherFreshProbe(): string {
  return "fresh";
}
`,
      "utf-8",
    );
    // The watcher (not a job) writes the new symbol into the table.
    await waitFor(
      "the watcher to serve watcherFreshProbe",
      async () => {
        const results = await callApi<ScopedSearchResult[]>(daemon.controlUrl, "/find", {
          method: "POST",
          body: { name: "watcherFreshProbe", project: PROJECT_NAME, limit: 20, fuzzy: false },
        });
        return results.length > 0 ? results : null;
      },
      { timeoutMs: 15_000 },
    );
    writeFileSync(
      abs(WATCH_DOC_REL),
      "# Watch freshness\n\nThe `greet` and `watcherFreshProbe` symbols are documented here.\n",
      "utf-8",
    );

    // Before the data-revision fix the snapshot stayed keyed to the first
    // call's index version: check_docs reported watcherFreshProbe as drift even
    // though /find served it, and the only way to refresh was a full reindex.
    const second = await waitFor(
      "the watcher write to refresh the doccheck snapshot",
      async () => {
        const report = await callApi<DocCheckReport>(daemon.controlUrl, "/doccheck", {
          method: "POST",
          body: { project: PROJECT_NAME, noUndocumented: true },
        });
        return report.checked.indexFreshness! > first.checked.indexFreshness! ? report : null;
      },
      { timeoutMs: 15_000 },
    );
    expect(second.findings.some((f) => f.message.includes("watcherFreshProbe"))).toBe(false);
  }, 45_000);

  test("a sync prunes a deleted file (deleted-file cleanup)", async () => {
    if (!daemon) throw new Error("daemon not started");
    rmSync(abs("src/util.ts"));
    expect(existsSync(abs("src/util.ts"))).toBe(false);
    await callApi<IndexView>(daemon.controlUrl, "/sync", {
      method: "POST",
      body: { name: PROJECT_NAME },
    });
    await waitFor(
      "post-delete sync to finish",
      async () => {
        const v = await callApi<IndexView>(daemon.controlUrl, `/indexes/${PROJECT_NAME}`);
        return v.status === "ready" && v.job === null ? v : null;
      },
      { timeoutMs: 45_000 },
    );
    expect((await callApi<IndexView>(daemon.controlUrl, `/indexes/${PROJECT_NAME}`)).files).toBe(
      INDEXED_FILE_COUNT - 1,
    );
    // Both of util.ts's symbols are gone from the table — strict, fuzzy-off.
    for (const gone of ["helperValue", "syncProbe"]) {
      await waitFor(
        `deleted symbol '${gone}' to leave the table`,
        async () => {
          const results = await callApi<ScopedSearchResult[]>(daemon.controlUrl, "/find", {
            method: "POST",
            body: { name: gone, project: PROJECT_NAME, limit: 20, fuzzy: false },
          });
          return results.length === 0 ? [] : null;
        },
        { timeoutMs: 15_000 },
      );
    }
  }, 90_000);

  // ------------------------------------------------------------ report tool

  test("POST /coupling (report smoke) returns the three-band coupling report", async () => {
    if (!daemon) throw new Error("daemon not started");
    const report = await callApi<CouplingReport>(daemon.controlUrl, "/coupling", {
      method: "POST",
      body: { project: PROJECT_NAME },
    });
    expect(report.project).toBe(PROJECT_NAME);
    expect(report.scannedFiles).toBe(INDEXED_FILE_COUNT - 1);
    for (const band of [report.topFanIn, report.changeMagnets, report.unstableLeaves]) {
      expect(Array.isArray(band.items)).toBe(true);
      expect(band.total).toBeGreaterThanOrEqual(0);
      expect(band.truncated).toBe(false);
    }
    // app.ts imports two indexed files but is imported by none → unstable leaf.
    expect(report.unstableLeaves.items.some((item) => item.file.endsWith("src/app.ts"))).toBe(true);
  });

  // --------------------------------------------------------------- shutdown

  test("POST /shutdown exits the daemon gracefully (exit code 0)", async () => {
    if (!daemon) throw new Error("daemon not started");
    // Wire-level proof of the backend round-trips: tags (probes/doctor), batch
    // embed (indexing), single embed (the vector query) — and the reranker
    // probe the fake answers 404 to (rerank stays off, byte-identically).
    for (const pathName of ["/api/tags", "/api/embed", "/api/embeddings", "/api/show"]) {
      expect(backend!.requests).toContain(pathName);
    }
    expect(backend!.requests).not.toContain("/v1/embeddings");

    const stopping = await callApi<{ stopping: boolean }>(daemon.controlUrl, "/shutdown", {
      method: "POST",
    });
    expect(stopping.stopping).toBe(true);
    const code = await waitFor("the daemon to exit", async () => {
      return daemon.proc.exitCode ?? null;
    }, { timeoutMs: 15_000, intervalMs: 100 });
    // The graceful path (SIGINT precedent) exits cleanly.
    expect(code).toBe(0);
  }, 20_000);
});