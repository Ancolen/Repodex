/**
 * `gitCommitTimeAt` — the doccheck `--since` anchor resolver.
 *
 * Regression: `git show -s --format=%at <annotated-tag>` prints the TAG header
 * first ("tag v2.7.2", Tagger, message), so `parseInt` saw prose and every
 * annotated tag looked unresolvable (lightweight tags/SHAs worked). The helper
 * now dereferences to the commit (`<ref>^{commit}`).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitCommitTimeAt } from "../src/services/git";

const COMMIT_DATE = "2026-01-02T03:04:05Z";
const COMMIT_EPOCH_MS = new Date(COMMIT_DATE).getTime();

let repo: string;

function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: COMMIT_DATE,
      GIT_COMMITTER_DATE: COMMIT_DATE,
      GIT_AUTHOR_NAME: "cidx test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "cidx test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "cidx-git-ref-"));
  git(["init", "-q"]);
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "first"]);
  git(["tag", "v-light"]);
  git(["tag", "-a", "v-annotated", "-m", "annotated release"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("gitCommitTimeAt", () => {
  test("resolves HEAD and a lightweight tag", async () => {
    expect(await gitCommitTimeAt(repo, "HEAD")).toBe(COMMIT_EPOCH_MS);
    expect(await gitCommitTimeAt(repo, "v-light")).toBe(COMMIT_EPOCH_MS);
  });

  test("resolves an ANNOTATED tag to the commit time, not the tag object header", async () => {
    expect(await gitCommitTimeAt(repo, "v-annotated")).toBe(COMMIT_EPOCH_MS);
  });

  test("unknown ref and non-repo report null (never throw)", async () => {
    expect(await gitCommitTimeAt(repo, "v-does-not-exist")).toBeNull();
    const outside = mkdtempSync(path.join(os.tmpdir(), "cidx-git-norepo-"));
    try {
      expect(await gitCommitTimeAt(outside, "HEAD")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
