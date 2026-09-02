import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Checks whether a directory is the root of (or inside) a git working tree. */
export async function isGitRepo(baseDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", baseDir, "rev-parse", "--is-inside-work-tree"], {
      timeout: 5000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Returns the ABSOLUTE paths of files tracked by `git ls-files`.
 * Returns null if it is not a git repo or git is unavailable (the caller falls
 * back to a normal scan). Covers both tracked files and files that are staged
 * (cached) but not yet committed.
 */
export async function gitTrackedFiles(baseDir: string): Promise<Set<string> | null> {
  if (!(await isGitRepo(baseDir))) return null;
  try {
    // -z: NUL-separated (safely handle paths containing spaces/Unicode)
    const { stdout } = await execFileAsync(
      "git",
      ["-C", baseDir, "ls-files", "-z", "--cached"],
      { timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
    const set = new Set<string>();
    for (const rel of stdout.split("\0")) {
      if (rel.length === 0) continue;
      set.add(path.resolve(baseDir, rel));
    }
    return set;
  } catch {
    return null;
  }
}

/**
 * Returns the branch/commit the current HEAD points to (to detect branch changes).
 * Falls back to the commit hash when `.git/HEAD` content is not sufficient (detached).
 */
export function gitHeadPath(baseDir: string): string | null {
  const head = path.join(baseDir, ".git", "HEAD");
  return existsSync(head) ? head : null;
}
