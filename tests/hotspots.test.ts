/**
 * Hotspot / technical-debt report tests (proposal C3) — three levels, no Ollama:
 *
 *  1. `computeHotspots` — the PURE aggregator over injected feeds: the
 *     churn × size log-scaled score (the proposal fixture: 20 edits × 15
 *     symbols outranks 20 edits × 2), bands, debt promotions (dead-code
 *     density, coupling), demotions (test files, entry points), the
 *     notListed bucket, unindexed churn paths, caps + honest truncation,
 *     determinism — no repo and no table.
 *  2. `churnCounts` — the git churn helper against a REAL scripted temp repo
 *     (same spawnSync recipe as tests/blame.test.ts): per-file counts, the
 *     `--since` window excluding old commits, the commit-walk cap surfacing
 *     `truncated`, NUL-safe paths with spaces, and a non-repo yielding zeros.
 *  3. `IndexManager.getHotspots` — the ENGINE over a hand-indexed LanceDB
 *     fixture with real git history: churn joined to indexed files, a dead
 *     symbol feeding the debt signal, a stable file landing in `notListed`,
 *     an unindexed churn path counted, and a non-repo project reported —
 *     plus the project-anchor contract (two projects → the engine refuses
 *     and says to pass 'project'/'path').
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { computeHotspots, HOTSPOTS_DEFAULT_SINCE, DEAD_DENSITY_CONFIDENCE } from "../src/core/hotspots";
import type { HotspotBand, HotspotInput, HotspotReport, HotspotFile } from "../src/core/hotspots";
import { churnCounts } from "../src/services/git";
import { Registry } from "../src/core/registry";
import { JobQueue } from "../src/core/job-queue";
import { IndexManager } from "../src/core/index-manager";
import { isolatedHome } from "./helpers/isolated-cidx-home";

// --------------------------------------------------------------- pure helpers

/** Sizes feed entry shorthand — an indexed file with chunk/symbol counts. */
const size = (file: string, chunks: number, symbols: number): HotspotInput["sizes"][number] => ({
  file,
  chunks,
  symbols,
});

/** Fetches one band member by project-relative path (throws when absent). */
function byRel(band: HotspotBand, rel: string): HotspotFile {
  const hit = band.items.find((f) => f.relativeFile === rel);
  if (!hit) throw new Error(`'${rel}' not in band: [${band.items.map((f) => f.relativeFile).join(", ")}]`);
  return hit;
}

/** The rels of a band, in ranked order. */
const rels = (band: HotspotBand): string[] => band.items.map((f) => f.relativeFile);

/** Base input for the pure tests: two churn-heavy files of different volume. */
const BASE: HotspotInput = {
  project: "pure",
  projectRoot: "/fx",
  since: HOTSPOTS_DEFAULT_SINCE,
  sizes: [size("/fx/src/big.ts", 6, 15), size("/fx/src/small.ts", 1, 1)],
  churn: new Map([
    ["/fx/src/big.ts", 20],
    ["/fx/src/small.ts", 20],
  ]),
};

const run = (over: Partial<HotspotInput> = {}): HotspotReport => computeHotspots({ ...BASE, ...over });

// ----------------------------------------- 1. computeHotspots — the pure join

describe("computeHotspots — the churn × size score", () => {
  test("acceptance: a file edited 20× with 15 symbols outranks one edited 20× with 2", () => {
    const r = run();
    expect(r.since).toBe(HOTSPOTS_DEFAULT_SINCE);
    expect(r.scannedFiles).toBe(2);
    expect(r.filesWithChurn).toBe(2);
    expect(r.notListed).toBe(0);
    const big = byRel(r.critical, "src/big.ts");
    const small = byRel(r.warm, "src/small.ts");
    expect(big.score).toBeGreaterThan(small.score);
    expect(big.band).toBe("critical");
    expect(small.band).toBe("warm");
    // The rationale carries the proposal's facts on one line.
    expect(big.rationale).toContain("changed 20×");
    expect(big.rationale).toContain("15 symbols, 6 chunks");
  });

  test("log-scaled churn: a rarely-touched tiny file stays small but positive", () => {
    const r = run({
      sizes: [size("/fx/src/tiny.ts", 1, 1)],
      churn: new Map([["/fx/src/tiny.ts", 1]]),
    });
    const tiny = byRel(r.review, "src/tiny.ts");
    expect(tiny.score).toBeGreaterThan(0);
    expect(tiny.score).toBeLessThan(15);
    expect(tiny.band).toBe("review");
  });

  test("the score clamps at 100; heavy churn over real volume lands in critical", () => {
    const r = run({
      sizes: [size("/fx/src/mega.ts", 40, 10)],
      churn: new Map([["/fx/src/mega.ts", 500]]),
    });
    expect(byRel(r.critical, "src/mega.ts").score).toBe(100);
  });

  test("deterministic ranking: score desc, then churn desc, then path asc", () => {
    // churn 9 × size 3 lands in warm; same churn ties break by project path.
    const r = run({
      sizes: [size("/fx/src/b.ts", 1, 2), size("/fx/src/c.ts", 1, 2), size("/fx/src/a.ts", 1, 2)],
      churn: new Map([
        ["/fx/src/b.ts", 9],
        ["/fx/src/c.ts", 9],
        ["/fx/src/a.ts", 1],
      ]),
    });
    expect(rels(r.warm)).toEqual(["src/b.ts", "src/c.ts"]);
    expect(rels(r.review)).toEqual(["src/a.ts"]);
    const b = byRel(r.warm, "src/b.ts");
    const c = byRel(r.warm, "src/c.ts");
    expect(b.score).toBe(c.score); // a full tie resolves only by path, deterministically
  });
});

describe("computeHotspots — debt signals promote, demotions stay", () => {
  test("dead-code density promotes and feeds the rationale + deadDensity", () => {
    const withDead = run({
      sizes: [size("/fx/src/dense.ts", 1, 4)],
      churn: new Map([["/fx/src/dense.ts", 1]]),
      dead: new Map([["/fx/src/dense.ts", { dead: 4, candidates: 10 }]]),
    });
    const without = run({
      sizes: [size("/fx/src/dense.ts", 1, 4)],
      churn: new Map([["/fx/src/dense.ts", 1]]),
    });
    const scored = withDead.review.items[0]!;
    const bare = without.review.items[0]!;
    expect(scored.score).toBeGreaterThan(bare.score);
    expect(scored.deadSymbols).toBe(4);
    expect(scored.deadDensity).toBe(0.4);
    expect(scored.rationale).toContain("4 dead of 10 candidates");
  });

  test("coupling promotes: fanIn+fanOut can push a warm file into critical", () => {
    const plain = run({ sizes: [size("/fx/src/magnet.ts", 1, 4)], churn: new Map([["/fx/src/magnet.ts", 20]]) });
    expect(byRel(plain.warm, "src/magnet.ts").band).toBe("warm");
    const coupled = run({
      sizes: [size("/fx/src/magnet.ts", 1, 4)],
      churn: new Map([["/fx/src/magnet.ts", 20]]),
      coupling: new Map([["/fx/src/magnet.ts", { fanIn: 4, fanOut: 4 }]]),
    });
    const magnet = byRel(coupled.critical, "src/magnet.ts");
    expect(magnet.score).toBeGreaterThan(byRel(plain.warm, "src/magnet.ts").score);
    expect(magnet.rationale).toContain("fan-in 4, fan-out 4");
  });

  test("dead-code alone is at most a review: churn 0 keeps the base at 0", () => {
    const r = run({
      sizes: [size("/fx/src/stale.ts", 10, 10)],
      churn: new Map(),
      dead: new Map([["/fx/src/stale.ts", { dead: 5, candidates: 10 }]]),
    });
    const stale = byRel(r.review, "src/stale.ts");
    expect(stale.churn).toBe(0);
    expect(stale.band).toBe("review");
    expect(stale.rationale).toContain("changed 0×");
  });

  test("test files and entry points are demoted into review, with the reason", () => {
    const files = [
      size("/fx/src/probe.test.ts", 6, 15),
      size("/fx/src/cli.ts", 6, 15),
      size("/fx/src/hub.ts", 6, 15),
    ];
    const churn = new Map(files.map((f) => [f.file, 20]));
    const r = run({ sizes: files, churn });
    // The plain file keeps its critical band; the demoted ones cannot cross in.
    expect(byRel(r.critical, "src/hub.ts").band).toBe("critical");
    for (const rel of ["src/probe.test.ts", "src/cli.ts"]) {
      const demoted = byRel(r.review, rel);
      expect(demoted.band).toBe("review");
      expect(demoted.score).toBeLessThanOrEqual(20);
      expect(demoted.rationale).toMatch(/demoted/);
    }
    expect(rels(r.critical)).toEqual(["src/hub.ts"]);
  });

  test("a zero-score file with no signal lands in notListed, and counts balance", () => {
    const r = run({
      sizes: [size("/fx/src/stable.ts", 3, 4)],
      churn: new Map(),
    });
    expect(r.notListed).toBe(1);
    for (const band of [r.critical, r.warm, r.review]) expect(band.total).toBe(0);
    // Every scanned file is accounted for: banded or notListed, never dropped.
    const banded = r.critical.total + r.warm.total + r.review.total;
    expect(banded + r.notListed).toBe(r.scannedFiles);
  });

  test("an empty project reports zeros honestly", () => {
    const r = computeHotspots({ project: "e", projectRoot: "/fx", since: HOTSPOTS_DEFAULT_SINCE, sizes: [] });
    expect(r.scannedFiles).toBe(0);
    expect(r.critical.total).toBe(0);
    expect(r.warm.total).toBe(0);
    expect(r.review.total).toBe(0);
    expect(r.notListed).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test("notARepo degrades to size/debt bands with empty churn", () => {
    const r = run({
      churn: undefined,
      notARepo: true,
      dead: new Map([["/fx/src/big.ts", { dead: 1, candidates: 1 }]]),
    });
    expect(r.notARepo).toBe(true);
    expect(r.filesWithChurn).toBe(0);
    expect(r.unindexedChurnFiles).toBe(0);
    // The dead-code signal still earns the file a review listing.
    expect(byRel(r.review, "src/big.ts").deadSymbols).toBe(1);
  });

  test("unindexed churn paths are counted, never listed", () => {
    const r = run({
      churn: new Map<string, number>([
        ...BASE.churn!,
        ["/fx/README.md", 7], // exists in git, never indexed
      ]),
    });
    expect(r.unindexedChurnFiles).toBe(1);
    expect(r.filesWithChurn).toBe(2); // README does not inflate the indexed count
    const all = [...r.critical.items, ...r.warm.items, ...r.review.items];
    expect(all.some((f) => f.relativeFile === "README.md")).toBe(false);
  });

  test("caps: every band capped by limit with honest totals and truncated flags", () => {
    const r = run({
      sizes: [size("/fx/src/a.ts", 1, 4), size("/fx/src/b.ts", 1, 3), size("/fx/src/c.ts", 1, 2)],
      churn: new Map([
        ["/fx/src/a.ts", 20],
        ["/fx/src/b.ts", 20],
        ["/fx/src/c.ts", 20],
      ]),
      limit: 1,
    });
    // sizeRaw 5/4/3 → warm (25..50) for all three, ranked a/b/c.
    expect(r.warm.total).toBe(3);
    expect(r.warm.items).toHaveLength(1);
    expect(r.warm.truncated).toBe(true);
    expect(rels(r.warm)).toEqual(["src/a.ts"]);
    expect(r.critical.total).toBe(0);
    expect(r.critical.truncated).toBe(false);
    expect(r.truncated).toBe(true);
  });

  test("snapshot truncation and the commit-walk cap are surfaced, never silent", () => {
    const r = run({ snapshotTruncated: true, commitsScanned: 500, commitsTruncated: true });
    expect(r.snapshotTruncated).toBe(true);
    expect(r.commitsTruncated).toBe(true);
    expect(r.commitsScanned).toBe(500);
  });

  test("DEAD_DENSITY_CONFIDENCE sits between uncertain and likely-dead", () => {
    expect(DEAD_DENSITY_CONFIDENCE).toBe(40);
  });
});

// ------------------------------------------------- 2. churnCounts — the git helper

/** A scripted temp repo: git helper factory (throws on failure — test-only). */
function makeGit(dir: string) {
  const git = (args: string[], env: Record<string, string> = {}): void => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  const commit = (msg: string, name: string, date: string): void => {
    git(["add", "-A"]);
    git(
      ["-c", "commit.gpgsign=false", "-c", `user.name=${name}`, "-c", `user.email=${name.toLowerCase()}@example.com`, "commit", "-m", msg],
      {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@example.com`,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@example.com`,
        GIT_COMMITTER_DATE: date,
      },
    );
  };
  return { git, commit };
}

const OLD_DATE = "2020-01-01T10:00:00+00:00"; // outside every window below
const WIN_DATE_A = "2026-03-02T10:00:00+00:00"; // inside "2026-01-01"

describe("churnCounts — scripted repo", () => {
  const REPO = mkdtempSync(path.join(tmpdir(), "cidx-churn-repo-"));

  beforeAll(() => {
    const { git, commit } = makeGit(REPO);
    git(["init", "-q", "-b", "main"]);
    mkdirSync(path.join(REPO, "src"), { recursive: true });
    writeFileSync(path.join(REPO, "src", "old.ts"), "export const old = 1;\n");
    commit("old", "Alice", OLD_DATE);
    // In-window commits: a.ts twice, b.ts once, a spaced path once.
    writeFileSync(path.join(REPO, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(REPO, "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(path.join(REPO, "src", "with space.ts"), "export const s = 1;\n");
    commit("c1", "Alice", WIN_DATE_A);
    writeFileSync(path.join(REPO, "src", "a.ts"), "export const a = 2;\n");
    commit("c2", "Bob", "2026-03-03T10:00:00+00:00");
  });

  afterAll(() => {
    rmSync(REPO, { recursive: true, force: true });
  });

  test("counts per file over the window; old commits excluded by --since", async () => {
    const c = await churnCounts(REPO, { since: "2026-01-01" });
    expect(c.counts.get("src/a.ts")).toBe(2); // c1 + c2
    expect(c.counts.get("src/b.ts")).toBe(1);
    expect(c.counts.get("src/old.ts")).toBeUndefined(); // 2020 commit is outside
    expect(c.commits).toBe(2);
    expect(c.truncated).toBe(false);
  });

  test("NUL-safe: a path containing a space survives intact", async () => {
    const c = await churnCounts(REPO, { since: WIN_DATE_A.split("T")[0] });
    expect(c.counts.get("src/with space.ts")).toBe(1);
  });

  test("the commit-walk cap surfaces truncated instead of silently dropping", async () => {
    const c = await churnCounts(REPO, { since: "2026-01-01", maxCommits: 1 });
    expect(c.commits).toBe(1);
    expect(c.truncated).toBe(true); // 2 in-window commits exist
    // Only the newest commit's files are counted under the cap.
    expect(c.counts.get("src/a.ts")).toBe(1);
    expect(c.counts.has("src/b.ts")).toBe(false);
  });

  test("a directory that is not a repo yields zeros (not an error)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cidx-churn-norepo-"));
    try {
      const c = await churnCounts(dir, { since: "2026-01-01" });
      expect(c.counts.size).toBe(0);
      expect(c.commits).toBe(0);
      expect(c.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------- 3. the IndexManager engine

const HUB_V1 = [
  `import { u1 } from "./util";`,
  ``,
  `export function hubA(): number { return 1; }`,
  `export function hubB(): number { return 2; }`,
  `export function hubC(): number { return 3; }`,
  `export function hubD(): number { return 4; }`,
  `export function hubE(): number { return 5; }`,
].join("\n");
const HUB_V2 = HUB_V1 + "\nexport function hubF(): number { return 6; }\n";
const HUB_V3 = HUB_V2 + "// revisited in a third in-window commit\n";
const UTIL_V = `export function u1(): number { return 1; }\n`;
const DEAD_V = [`function deadProbe(): number {`, `  return 0;`, `}`].join("\n");
const DEAD_V2 = [`function deadProbe(): number {`, `  // revisited in a second in-window commit`, `  return 0;`, `}`].join("\n");
// stable.ts is deliberately signal-free: an exported const is no candidate type
// (no dead feed), it imports nothing and nothing imports it (no coupling edge),
// and its only commit is outside the window (no churn) → `notListed`.
const STABLE_V = `export const stableFlag = 1;\n`;
const README_V = `# churn fixture\n`;
const NOREPO_V = `# not a repo\n\njust text, no symbols.\n`;

describe("IndexManager.getHotspots — fixture project (real table + real git)", () => {
  // HOME comes from the `[test]` preload (see tests/helpers/isolated-cidx-home.ts):
  // the fixture tables + registry land on the throw-away root, removed by the
  // preload's own global hook.
  const HOME = isolatedHome;
  const REPO_GIT = mkdtempSync(path.join(tmpdir(), "cidx-hotspots-repo-"));
  const DIR_NOREPO = mkdtempSync(path.join(tmpdir(), "cidx-hotspots-norepo-"));
  const DB_PATH = path.join(HOME, `hotspots-${randomUUID()}.db`);

  let registry: Registry;
  let manager: IndexManager;
  let report: HotspotReport;
  let norepoReport: HotspotReport;

  beforeAll(async () => {
    const db = await import("../src/services/db");
    const { chunkCode } = await import("../src/chunking/chunker");

    const { git, commit } = makeGit(REPO_GIT);
    git(["init", "-q", "-b", "main"]);
    mkdirSync(path.join(REPO_GIT, "src"), { recursive: true });
    writeFileSync(path.join(REPO_GIT, "src", "stable.ts"), STABLE_V);
    commit("stable", "Alice", OLD_DATE); // committed OUTSIDE the window → churn 0
    writeFileSync(path.join(REPO_GIT, "src", "hub.ts"), HUB_V1);
    writeFileSync(path.join(REPO_GIT, "src", "util.ts"), UTIL_V);
    commit("c1", "Alice", WIN_DATE_A);
    writeFileSync(path.join(REPO_GIT, "src", "hub.ts"), HUB_V2);
    writeFileSync(path.join(REPO_GIT, "src", "dead.ts"), DEAD_V);
    commit("c2", "Bob", "2026-03-03T10:00:00+00:00");
    writeFileSync(path.join(REPO_GIT, "src", "hub.ts"), HUB_V3);
    writeFileSync(path.join(REPO_GIT, "src", "dead.ts"), DEAD_V2);
    writeFileSync(path.join(REPO_GIT, "README.md"), README_V);
    commit("c3", "Carol", "2026-03-04T10:00:00+00:00");

    mkdirSync(path.join(DIR_NOREPO, "src"), { recursive: true });
    // A symbol-free file: no dead-code candidate, no churn → must stay unlisted.
    writeFileSync(path.join(DIR_NOREPO, "src", "notes.md"), NOREPO_V);

    await db.initDB();
    registry = new Registry(DB_PATH);
    const registerProject = (name: string, dir: string, table: string): void => {
      registry.upsertIndex({
        name,
        path: dir,
        tableName: table,
        status: "ready",
        fileCount: 3,
        chunkCount: 8,
        embedModel: null,
        embedDim: null,
        lastIndexedAt: 1700000000000,
        createdAt: 1,
        error: null,
      });
    };
    const registerFile = async (name: string, dir: string, rel: string, table: string, source: string): Promise<void> => {
      const abs = path.join(dir, rel);
      registry.setFileMtime(name, abs, statSync(abs).mtimeMs);
      const chunks = await chunkCode(abs, source);
      await db.insertChunks(
        table,
        chunks.map((c, i) => ({
          id: `${path.basename(rel)}#${i}`,
          filePath: abs,
          content: c.content,
          vector: [0.1],
          language: c.language ?? null,
          symbolName: c.symbolName ?? null,
          symbolType: c.symbolType ?? null,
          startLine: c.startLine,
          endLine: c.endLine,
          doc: null,
          doc_vector: null,
          id_terms: null,
        })),
      );
    };

    registerProject("hotspotfix", REPO_GIT, "idx_hotspots_a");
    await registerFile("hotspotfix", REPO_GIT, "src/hub.ts", "idx_hotspots_a", HUB_V3);
    await registerFile("hotspotfix", REPO_GIT, "src/util.ts", "idx_hotspots_a", UTIL_V);
    await registerFile("hotspotfix", REPO_GIT, "src/dead.ts", "idx_hotspots_a", DEAD_V);
    await registerFile("hotspotfix", REPO_GIT, "src/stable.ts", "idx_hotspots_a", STABLE_V);
    registerProject("norepofix", DIR_NOREPO, "idx_hotspots_n");
    await registerFile("norepofix", DIR_NOREPO, "src/notes.md", "idx_hotspots_n", NOREPO_V);

    manager = new IndexManager(registry, new JobQueue());
    report = await manager.getHotspots("hotspotfix", undefined, { since: "2026-01-01" });
    norepoReport = await manager.getHotspots("norepofix");
  }, 30000);

  afterAll(() => {
    manager?.stopAll?.();
    registry?.close();
    rmSync(DB_PATH, { force: true });
    rmSync(REPO_GIT, { recursive: true, force: true });
    rmSync(DIR_NOREPO, { recursive: true, force: true });
    // HOME is removed by the preload's own hook.
  });

  test("churn joins by path: hub (3 in-window commits) lands critical, ranked first", () => {
    expect(report.project).toBe("hotspotfix");
    expect(report.notARepo).toBe(false);
    expect(report.commitsScanned).toBe(3); // c1..c3 (the stable commit is outside the window)
    expect(report.filesWithChurn).toBe(3); // hub, util, dead — README is not indexed
    expect(report.unindexedChurnFiles).toBe(1); // README.md churns but is not indexed
    const hub = byRel(report.critical, "src/hub.ts");
    expect(hub.churn).toBe(3);
    expect(hub.symbols).toBe(6); // hubA..hubF, deduped across chunks
    // End-to-end honesty: the six exports are unreferenced in this fixture, so
    // the dead-code density signal promotes on top of churn × size — and the
    // rationale says so instead of hiding it.
    expect(hub.rationale).toContain("6 dead of 6 candidates");
    // Churn × size (+ debt) keeps hub above the debt-only and single-commit files.
    const all = [...report.critical.items, ...report.warm.items, ...report.review.items];
    expect(all[0]!.relativeFile).toBe("src/hub.ts");
  });

  test("the dead symbol feeds the debt signal; stable churn-free code stays unlisted", () => {
    const dead = byRel(report.warm, "src/dead.ts");
    expect(dead.churn).toBe(2); // c2 created it, c3 revisited it
    expect(dead.deadSymbols).toBe(1);
    expect(dead.deadDensity).toBe(1);
    expect(dead.band).toBe("warm"); // debt promotes a small-churn file across the warm line
    const util = byRel(report.review, "src/util.ts");
    expect(util.score).toBeLessThan(dead.score); // no debt signal, one commit
    // stable.ts: indexed, zero churn, zero signals → counted, never listed.
    for (const band of [report.critical, report.warm, report.review]) {
      expect(band.items.some((f) => f.relativeFile === "src/stable.ts")).toBe(false);
    }
    expect(report.notListed).toBe(1);
    expect(report.review.items.some((f) => f.relativeFile === "src/util.ts")).toBe(true);
    const banded = report.critical.total + report.warm.total + report.review.total;
    expect(banded + report.notListed).toBe(report.scannedFiles);
  });

  test("the window override and since surfacing round-trip", () => {
    expect(report.since).toBe("2026-01-01");
    expect(report.commitsTruncated).toBe(false);
    expect(report.snapshotTruncated).toBe(false);
    expect(report.truncated).toBe(false);
  });

  test("a non-repo project reports notARepo with empty churn (never throws)", () => {
    expect(norepoReport.project).toBe("norepofix");
    expect(norepoReport.notARepo).toBe(true);
    expect(norepoReport.filesWithChurn).toBe(0);
    expect(norepoReport.commitsScanned).toBe(0);
    expect(norepoReport.notListed).toBe(1);
    for (const band of [norepoReport.critical, norepoReport.warm, norepoReport.review]) {
      expect(band.total).toBe(0);
    }
  });

  test("two indexed projects → the anchor is refused with a self-healing error", async () => {
    let msg = "";
    try {
      await manager.getHotspots();
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain("Multiple projects are indexed");
    expect(msg).toMatch(/pass the 'project' \(or 'path'\)/);
  });
});