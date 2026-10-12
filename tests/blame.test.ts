/**
 * Ownership / blame enrichment tests (proposal C4).
 *
 * Layers, no Ollama anywhere:
 *   1. the PURE porcelain parser (`parseGitBlamePorcelain` /
 *      `summarizeBlameRange`): multi-commit ranges, continuation entries
 *      (headers appear only once per commit → back-fill by sha), boundary
 *      markers, churn cap, truncated and malformed input — all without a repo,
 *   2. the git helper (`blameRange`) against a scripted temp repo: real
 *      porcelain output for a range, reversed ranges normalized, and every
 *      failure path (untracked file, out-of-range, non-repo) reported as null,
 *   3. the ENGINE (`IndexManager.searchIndex` over a real git fixture, indexed
 *      by hand): hits stamped with lastAuthor/lastCommitDate/churnCommits,
 *      blame-off default untouched, not-a-repo → one envelope note and no
 *      fields, the ≤8-file cap → honest `blameSkipped` at the tail, and a
 *      per-file blame failure (untracked file) omitting just that file's
 *      fields without ever failing the search.
 *
 * Like `tests/search-payload.test.ts` (whose harness this mirrors), the
 * fixture registries/tables live on the throw-away root pinned by the `[test]`
 * preload; text mode needs no vectors.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isolatedHome } from "./helpers/isolated-cidx-home";

const { parseGitBlamePorcelain, summarizeBlameRange, BLAME_CHURN_CAP } = await import("../src/core/blame");
const { blameRange } = await import("../src/services/git");
const db = await import("../src/services/db");
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { chunkCode } = await import("../src/chunking/chunker");

// ------------------------------------------------- 1. the pure parser

/** Real-shaped porcelain: two commits, a re-visited commit (continuation entries). */
const PORCELAIN_TWO_COMMIT = [
  "28f082c5674123e67bd1022edcff3a8dd4733ba0 1 1 1",
  "author Alice",
  "author-mail <alice@x>",
  "author-time 1767607200", // 2026-01-05T10:00:00Z
  "author-tz +0000",
  "committer Alice",
  "committer-mail <alice@x>",
  "committer-time 1791840626",
  "committer-tz +0300",
  "summary v1",
  "boundary", // the root-commit boundary marker (must not become a record)
  "filename src/lib.ts",
  "\texport function blameProbe(a: string): string {",
  "df342486dfc119d69b533e791e2af16d8fd17a71 2 2 1",
  "author Bob",
  "author-mail <bob@x>",
  "author-time 1770717600", // 2026-02-10T10:00:00Z
  "author-tz +0000",
  "summary v2",
  "previous 28f082c5674123e67bd1022edcff3a8dd4733ba0 src/lib.ts",
  "filename src/lib.ts",
  "\t  const s = a.trim() + 'v2';",
  "28f082c5674123e67bd1022edcff3a8dd4733ba0 3 3 2", // continuation: NO headers
  "\t  return s;",
  "28f082c5674123e67bd1022edcff3a8dd4733ba0 4 4", // continuation again
  "\t}",
  "",
].join("\n");

describe("parseGitBlamePorcelain", () => {
  test("one record per blamed line, entries back-filled from the per-sha header memo", () => {
    const recs = parseGitBlamePorcelain(PORCELAIN_TWO_COMMIT);
    expect(recs.length).toBe(4);
    expect(recs[0]).toEqual({ line: 1, sha: "28f082c5674123e67bd1022edcff3a8dd4733ba0", author: "Alice", authorTime: 1767607200000 });
    expect(recs[1]!.author).toBe("Bob");
    // Continuation entries carry only the sha — the memo restores Alice's fields.
    expect(recs[2]).toEqual({ line: 3, sha: "28f082c5674123e67bd1022edcff3a8dd4733ba0", author: "Alice", authorTime: 1767607200000 });
    expect(recs[3]!.line).toBe(4);
    expect(recs[3]!.author).toBe("Alice");
  });

  test("aggregate: most-recent author, UTC calendar date, distinct commits", () => {
    const recs = parseGitBlamePorcelain(PORCELAIN_TWO_COMMIT);
    const sum = summarizeBlameRange(recs);
    expect(sum).toEqual({
      lastAuthor: "Bob",
      lastCommitDate: "2026-02-10",
      distinctCommits: 2,
    });
  });

  test("aggregate of a subrange (a chunk inside the file) honors the run it starts in", () => {
    const recs = parseGitBlamePorcelain(PORCELAIN_TWO_COMMIT);
    const sum = summarizeBlameRange(recs.filter((r) => r.line >= 3));
    expect(sum).toEqual({ lastAuthor: "Alice", lastCommitDate: "2026-01-05", distinctCommits: 1 });
  });

  test("boundary marker, previous/filename/committer headers and garbage never become records", () => {
    const recs = parseGitBlamePorcelain(PORCELAIN_TWO_COMMIT);
    // 4 entry lines in → 4 records; `boundary` produced nothing extra.
    expect(recs.length).toBe(4);
    expect(recs.some((r) => r.sha === "boundary")).toBe(false);
  });

  test("truncated mid-headers → the entry still parses with what it had", () => {
    const truncated = [
      "28f082c5674123e67bd1022edcff3a8dd4733ba0 1 1 1",
      "author Alice",
      "author-mail <alice@x>",
      "", // stream cut before author-time/tab
    ].join("\n");
    const recs = parseGitBlamePorcelain(truncated);
    expect(recs.length).toBe(1);
    expect(recs[0]).toEqual({ line: 1, sha: "28f082c5674123e67bd1022edcff3a8dd4733ba0", author: "Alice", authorTime: 0 });
    // Usable author but no date yet — the summary reports what it has.
    expect(summarizeBlameRange(recs)).toEqual({ lastAuthor: "Alice", lastCommitDate: "", distinctCommits: 1 });
  });

  test("truncated at a bare entry line → a bare record; nothing usable → null summary", () => {
    const recs = parseGitBlamePorcelain("61c242b82dfec39f4d4aa1f85affe1b7528746f3 2 2");
    expect(recs.length).toBe(1);
    expect(recs[0]!.author).toBe("");
    expect(recs[0]!.authorTime).toBe(0);
    expect(summarizeBlameRange(recs)).toBeNull();
    expect(summarizeBlameRange([])).toBeNull();
    expect(parseGitBlamePorcelain("this is not porcelain\nat all")).toEqual([]);
    expect(parseGitBlamePorcelain("")).toEqual([]);
  });

  test("CRLF output parses the same", () => {
    const crlf = PORCELAIN_TWO_COMMIT.replace(/\n/g, "\r\n");
    const recs = parseGitBlamePorcelain(crlf);
    expect(recs.length).toBe(4);
    expect(recs[1]!.author).toBe("Bob");
  });

  test("uncommitted lines (all-zero sha, Not Committed Yet) count as the newest change", () => {
    const recs = parseGitBlamePorcelain(
      [
        "0000000000000000000000000000000000000000 2 2 1",
        "author Not Committed Yet",
        "author-mail <not-committed-yet@localhost>",
        "author-time 1770768000", // 2026-02-11T00:00:00Z
        "author-tz +0000",
        "summary Version control",
        "\tin progress",
        "",
      ].join("\n"),
    );
    expect(summarizeBlameRange(recs)).toEqual({
      lastAuthor: "Not Committed Yet",
      lastCommitDate: "2026-02-11",
      distinctCommits: 1,
    });
  });
});

describe("summarizeBlameRange — churn cap", () => {
  test("distinct commits are capped at BLAME_CHURN_CAP and flagged", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      line: i + 1,
      sha: i.toString(16).padStart(40, "0"),
      author: `Author${i}`,
      authorTime: 1000 + i,
    }));
    expect(BLAME_CHURN_CAP).toBe(10);
    const sum = summarizeBlameRange(many);
    expect(sum?.distinctCommits).toBe(10);
    expect(sum?.distinctTruncated).toBe(true);
    // 10 distinct = under the cap → no flag.
    expect(summarizeBlameRange(many.slice(0, 10))?.distinctTruncated).toBeUndefined();
  });

  test("empty input yields null", () => {
    expect(summarizeBlameRange([])).toBeNull();
  });
});

// ------------------------------------------------- 2. the git helper

/** A scripted temp repo: git helper factory (throws on failure — test-only). */
function makeGit(dir: string) {
  const git = (args: string[], env: Record<string, string> = {}): string => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
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
      },
    );
  };
  return { git, commit };
}

const LIB_V1 = [
  "export function blameProbe(a: string): string {",
  "  const s = a.trim();",
  "  return s;",
  "}",
].join("\n");
const LIB_V2 = [
  "export function blameProbe(a: string): string {",
  "  const s = a.trim() + 'v2';",
  "  return s;",
  "}",
].join("\n");

describe("blameRange", () => {
  const REPO = mkdtempSync(path.join(tmpdir(), "cidx-blame-repo-"));

  beforeAll(() => {
    const { git, commit } = makeGit(REPO);
    git(["init", "-q", "-b", "main"]);
    mkdirSync(path.join(REPO, "src"), { recursive: true });
    writeFileSync(path.join(REPO, "src", "lib.ts"), LIB_V1);
    commit("v1", "Alice", "2026-01-05T10:00:00+00:00");
    writeFileSync(path.join(REPO, "src", "lib.ts"), LIB_V2);
    commit("v2", "Bob", "2026-02-10T10:00:00+00:00");
  });

  afterAll(() => {
    rmSync(REPO, { recursive: true, force: true });
  });

  test("returns raw porcelain for the range; parses into the right ownership summary", async () => {
    const raw = await blameRange(path.join(REPO, "src", "lib.ts"), 1, 4, REPO);
    expect(raw).toBeTypeOf("string");
    const recs = parseGitBlamePorcelain(raw ?? "");
    expect(recs.length).toBe(4);
    expect(summarizeBlameRange(recs)).toEqual({
      lastAuthor: "Bob",
      lastCommitDate: "2026-02-10",
      distinctCommits: 2,
    });
  });

  test("reversed range bounds are normalized, not fatal", async () => {
    const forward = await blameRange(path.join(REPO, "src", "lib.ts"), 1, 4, REPO);
    const reversed = await blameRange(path.join(REPO, "src", "lib.ts"), 4, 1, REPO);
    expect(reversed).toBe(forward);
  });

  test("a sub-range covering only old lines keeps the old author", async () => {
    const raw = await blameRange(path.join(REPO, "src", "lib.ts"), 3, 4, REPO);
    const sum = summarizeBlameRange(parseGitBlamePorcelain(raw ?? ""));
    expect(sum).toEqual({ lastAuthor: "Alice", lastCommitDate: "2026-01-05", distinctCommits: 1 });
  });

  test("out-of-range lines, a missing file and a non-repo all report null (never throw)", async () => {
    const lib = path.join(REPO, "src", "lib.ts");
    expect(await blameRange(lib, 900, 901, REPO)).toBeNull();
    expect(await blameRange(path.join(REPO, "src", "missing.ts"), 1, 2, REPO)).toBeNull();
    const notRepo = mkdtempSync(path.join(tmpdir(), "cidx-blame-norepo-"));
    try {
      expect(await blameRange(lib, 1, 4, notRepo)).toBeNull();
      expect(await blameRange(lib, 0, 4, REPO)).toBeNull();
      expect(await blameRange(lib, Number.NaN, 4, REPO)).toBeNull();
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------- 3. the IndexManager engine

const CAP_FILE_COUNT = 10;
const capFileSource = (i: number): string =>
  [`export function capProbe${i}(): number {`, `  // capProbe marker`, `  return ${i};`, `}`].join("\n");

const STRAY_V = [
  "export function strayProbe(): number {",
  "  // companion of blameProbe",
  "  return 1;",
  "}",
].join("\n");
const NOREPO_V = [
  "export function norepoProbe(): string {",
  "  return 'never committed';",
  "}",
].join("\n");

describe("IndexManager blame enrichment (real git fixture)", () => {
  const HOME = isolatedHome;
  // A real two-commit repo (Alice → Bob), committed for real so git blame works.
  const REPO_GIT = mkdtempSync(path.join(tmpdir(), "cidx-blame-indexed-"));
  // A directory that was never a repo.
  const DIR_NOREPO = mkdtempSync(path.join(tmpdir(), "cidx-blame-norepofix-"));
  // A repo with 10 files (one commit) for the per-search file cap.
  const REPO_CAP = mkdtempSync(path.join(tmpdir(), "cidx-blame-cap-"));
  // A repo where one fixture file is tracked and another is NOT (blame fails per-file).
  const REPO_FAIL = mkdtempSync(path.join(tmpdir(), "cidx-blame-fail-"));

  const DB_PATH = path.join(HOME, `blame-${randomUUID()}.db`);
  let registry: InstanceType<typeof Registry>;
  let manager: InstanceType<typeof IndexManager>;

  /** Registers one index row (like search-payload). */
  function registerProject(name: string, projectDir: string, table: string, fileCount: number): void {
    registry.upsertIndex({
      name,
      path: projectDir,
      tableName: table,
      status: "ready",
      fileCount,
      chunkCount: fileCount,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });
  }

  /** Hand-indexes one file into the project's table (mtime cache + a real AST chunk). */
  async function registerFile(
    name: string,
    projectDir: string,
    relFile: string,
    table: string,
    source: string,
  ): Promise<void> {
    const abs = path.join(projectDir, relFile);
    registry.setFileMtime(name, abs, 1);
    const chunks = await chunkCode(abs, source);
    await db.insertChunks(
      table,
      chunks.map((c, i) => ({
        id: `${path.basename(relFile)}#${i}`,
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
  }

  beforeAll(async () => {
    const gitRepo = makeGit(REPO_GIT);
    gitRepo.git(["init", "-q", "-b", "main"]);
    mkdirSync(path.join(REPO_GIT, "src"), { recursive: true });
    writeFileSync(path.join(REPO_GIT, "src", "lib.ts"), LIB_V1);
    gitRepo.commit("v1", "Alice", "2026-01-05T10:00:00+00:00");
    writeFileSync(path.join(REPO_GIT, "src", "lib.ts"), LIB_V2);
    gitRepo.commit("v2", "Bob", "2026-02-10T10:00:00+00:00");

    const gitCap = makeGit(REPO_CAP);
    gitCap.git(["init", "-q", "-b", "main"]);
    mkdirSync(path.join(REPO_CAP, "src"), { recursive: true });
    for (let i = 0; i < CAP_FILE_COUNT; i++) {
      writeFileSync(path.join(REPO_CAP, "src", `cap${i}.ts`), capFileSource(i));
    }
    gitCap.commit("cap", "Eve", "2026-03-15T12:00:00+00:00");

    const gitFail = makeGit(REPO_FAIL);
    gitFail.git(["init", "-q", "-b", "main"]);
    mkdirSync(path.join(REPO_FAIL, "src"), { recursive: true });
    writeFileSync(path.join(REPO_FAIL, "src", "lib.ts"), LIB_V1);
    gitFail.commit("v1", "Alice", "2026-01-05T10:00:00+00:00");
    // stray.ts is written but NEVER committed → `git blame` fails for that file only.
    writeFileSync(path.join(REPO_FAIL, "src", "stray.ts"), STRAY_V);

    mkdirSync(path.join(DIR_NOREPO, "src"), { recursive: true });
    writeFileSync(path.join(DIR_NOREPO, "src", "norepo.ts"), NOREPO_V);

    await db.initDB();
    registry = new Registry(DB_PATH);
    registerProject("blamefix", REPO_GIT, "idx_blame_a", 1);
    await registerFile("blamefix", REPO_GIT, path.join("src", "lib.ts"), "idx_blame_a", LIB_V2);
    registerProject("norepofix", DIR_NOREPO, "idx_blame_n", 1);
    await registerFile("norepofix", DIR_NOREPO, path.join("src", "norepo.ts"), "idx_blame_n", NOREPO_V);
    // failfix: tracked lib.ts + untracked stray.ts in the same table/search.
    registerProject("failfix", REPO_FAIL, "idx_blame_f", 2);
    await registerFile("failfix", REPO_FAIL, path.join("src", "lib.ts"), "idx_blame_f", LIB_V1);
    await registerFile("failfix", REPO_FAIL, path.join("src", "stray.ts"), "idx_blame_f", STRAY_V);
    registerProject("capfix", REPO_CAP, "idx_blame_c", CAP_FILE_COUNT);
    for (let i = 0; i < CAP_FILE_COUNT; i++) {
      await registerFile("capfix", REPO_CAP, path.join("src", `cap${i}.ts`), "idx_blame_c", capFileSource(i));
    }
    manager = new IndexManager(registry, new JobQueue());
  }, 30000);

  afterAll(() => {
    manager?.stopAll?.();
    registry?.close();
    rmSync(DB_PATH, { force: true });
    for (const dir of [REPO_GIT, DIR_NOREPO, REPO_CAP, REPO_FAIL]) {
      rmSync(dir, { recursive: true, force: true });
    }
    // HOME is removed by the preload's own hook.
  });

  const textOpts = { mode: "text", rerank: false, mmr: false, blame: true } as const;

  test("hits carry lastAuthor / lastCommitDate / churnCommits of their chunk range", async () => {
    const env = await manager.searchIndex("blamefix", "blameProbe", 5, textOpts);
    expect(env.results.length).toBeGreaterThan(0);
    const hit = env.results.find((r) => r.symbolName === "blameProbe");
    expect(hit).toBeDefined();
    expect(hit!.lastAuthor).toBe("Bob"); // the most recent commit touching the range
    expect(hit!.lastCommitDate).toBe("2026-02-10"); // fixed GIT_AUTHOR_DATE → deterministic
    expect(hit!.churnCommits).toBe(2); // Alice (3 lines) + Bob (1 line) inside the chunk
    expect(hit!.churnTruncated).toBeUndefined();
    expect(env.blameNotARepo).toBeUndefined();
    expect(env.blameSkipped).toBeUndefined();
  });

  test("blame off (default) leaves the fields unset and the envelope bare", async () => {
    const env = await manager.searchIndex("blamefix", "blameProbe", 5, {
      mode: "text",
      rerank: false,
      mmr: false,
    });
    expect(env.results.length).toBeGreaterThan(0);
    for (const r of env.results) {
      expect(r.lastAuthor).toBeUndefined();
      expect(r.lastCommitDate).toBeUndefined();
      expect(r.churnCommits).toBeUndefined();
    }
    expect(env.blameNotARepo).toBeUndefined();
    expect(env.blameSkipped).toBeUndefined();
  });

  test("a not-a-repo project stamps nothing and notes the envelope once (also via batch)", async () => {
    const env = await manager.searchIndex("norepofix", "norepoProbe", 5, textOpts);
    expect(env.results.length).toBeGreaterThan(0);
    expect(env.blameNotARepo).toBe(true);
    for (const r of env.results) {
      expect(r.lastAuthor).toBeUndefined();
      expect(r.churnCommits).toBeUndefined();
    }
    const groups = await manager.searchBatch(["norepoProbe"], "norepofix", 5, textOpts);
    expect(groups.length).toBe(1);
    expect(groups[0]!.blameNotARepo).toBe(true);
    for (const r of groups[0]!.results) expect(r.lastAuthor).toBeUndefined();
  });

  test("beyond the 8-file cap the tail files are skipped and counted in blameSkipped", async () => {
    const env = await manager.searchIndex("capfix", "capProbe", CAP_FILE_COUNT, textOpts);
    expect(env.results.length).toBe(CAP_FILE_COUNT);
    expect(env.blameSkipped).toBe(CAP_FILE_COUNT - 8);
    const stamped = env.results.filter((r) => r.churnCommits !== undefined);
    expect(stamped.length).toBe(8);
    // The kept ones (rank order) carry the commit's ownership; the tail does not.
    for (const r of stamped) {
      expect(r.lastAuthor).toBe("Eve");
      expect(r.churnCommits).toBe(1);
    }
    expect(env.results[8]!.lastAuthor).toBeUndefined();
    expect(env.results[8]!.churnCommits).toBeUndefined();
    expect(env.results[9]!.lastAuthor).toBeUndefined();
    expect(env.blameNotARepo).toBeUndefined();
  });

  test("a per-file blame failure (untracked file) omits only that file's fields — the search survives", async () => {
    const env = await manager.searchIndex("failfix", "blameProbe", 5, textOpts);
    expect(env.results.length).toBe(2); // tracked lib.ts + untracked stray.ts comment
    const tracked = env.results.find((r) => r.filePath.includes("lib.ts"));
    const stray = env.results.find((r) => r.filePath.includes("stray.ts"));
    expect(tracked).toBeDefined();
    expect(stray).toBeDefined();
    expect(tracked!.lastAuthor).toBe("Alice"); // v1 committed; never re-touched
    expect(stray!.lastAuthor).toBeUndefined(); // git blame fails on an untracked path
    expect(stray!.lastCommitDate).toBeUndefined();
    // The failure is per-file: no envelope note may claim a not-a-repo territory.
    expect(env.blameNotARepo).toBeUndefined();
    expect(env.blameSkipped).toBeUndefined();
  });
});