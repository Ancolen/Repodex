import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { COMMIT_FORMAT, parseCommitLog, type CommitHit, type CommitQueryOpts } from "../core/commits";

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
 * Returns the path to `.git/HEAD`, or null when absent
 * (used for mtime-based branch-change detection).
 */
export function gitHeadPath(baseDir: string): string | null {
  const head = path.join(baseDir, ".git", "HEAD");
  return existsSync(head) ? head : null;
}

/**
 * Runs `git log` in `baseDir` and returns matching commits — the engine for
 * git-history / commit-message search. Live (no indexing), NUL-safe (`-z`),
 * case-insensitive message/author matching (`-i`). The path filter is
 * relativized to the repo root and passed as a LITERAL argv element after `--`
 * (`execFile` uses no shell → no injection). Returns `[]` if git is missing, the
 * directory isn't a repo, or the query matches nothing (the engine reports the
 * not-a-repo case via `isGitRepo` separately).
 */
export async function searchGitLog(
  baseDir: string,
  opts: CommitQueryOpts,
): Promise<CommitHit[]> {
  const limit = opts.limit ?? 50;
  const args: string[] = [
    "-C", baseDir, "log", "-z", "-i", "-n", String(limit),
    `--format=${COMMIT_FORMAT}`,
  ];
  if (opts.withFiles) args.push("--name-only");
  if (opts.query) args.push(`--grep=${opts.query}`);
  if (opts.author) args.push(`--author=${opts.author}`);
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.until) args.push(`--until=${opts.until}`);
  if (opts.path) {
    // git pathspecs are relative to the repo root; relativize absolute paths.
    const rel = path.isAbsolute(opts.path) ? path.relative(baseDir, opts.path) : opts.path;
    args.push("--", rel);
  }
  try {
    const { stdout } = await execFileAsync("git", args, {
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseCommitLog(stdout, !!opts.withFiles);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reading a tree/ref (the API-diff historical surface, proposal C2).
// Same discipline as `searchGitLog`: `execFile` with no shell (a ref or path can
// never inject an option or a command), NUL-safe where paths are involved, and
// every failure is REPORTED (`null`) rather than thrown.
// ---------------------------------------------------------------------------

/**
 * Characters allowed in a revision string we are willing to pass to git:
 * refnames (`v1.2.0`, `feature/x`, `refs/tags/v1`), SHAs, and the revision
 * suffixes `~`/`^` (`HEAD~3`). Everything else — whitespace, `:` (which would
 * turn the string into an `object:path` spec), `*?[` (globs), `@{`, `..`, and
 * any leading `-`/`.`/`/` (option- or path-like) — is rejected.
 */
const SAFE_REF_RE = /^[A-Za-z0-9._^~/-]+$/;

/**
 * Validates a user-supplied git ref before it reaches a git argv. Returns the
 * (trimmed) ref unchanged when it is safe to pass, or null when it is not —
 * the caller reports `invalidRef` instead of throwing.
 */
export function safeGitRef(ref: string): string | null {
  const r = ref.trim();
  if (r.length === 0 || r.length > 256) return null;
  if (!SAFE_REF_RE.test(r)) return null;
  if (r.startsWith("-") || r.startsWith(".") || r.startsWith("/")) return null;
  if (r.endsWith(".") || r.endsWith(".lock") || r.endsWith("/")) return null;
  if (r.includes("..") || r.includes("@")) return null;
  return r;
}

/**
 * Does `ref` resolve to an object in this repo? (`git rev-parse --verify`.)
 * Refs are validated with `safeGitRef` first; a non-repo / missing git also
 * returns false (the caller checks `isGitRepo` separately to report `notARepo`).
 */
export async function gitRefExists(baseDir: string, ref: string): Promise<boolean> {
  if (!safeGitRef(ref)) return false;
  try {
    await execFileAsync("git", ["-C", baseDir, "rev-parse", "--verify", "--quiet", `${ref}^{object}`], {
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Repo-relative paths of every file tracked at `ref` —
 * `git ls-tree -r --name-only -z <ref>` (NUL-separated, so paths with spaces or
 * Unicode survive). Returns null when the ref doesn't resolve or git fails; the
 * caller reports `unknownRef`/an error instead of treating it as "no files".
 */
export async function gitLsTreeFiles(baseDir: string, ref: string): Promise<string[] | null> {
  if (!safeGitRef(ref)) return null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", baseDir, "ls-tree", "-r", "--name-only", "-z", ref],
      { timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

/**
 * Content of `<ref>:<relPath>` (`git show`), decoded as UTF-8. `relPath` comes
 * from `gitLsTreeFiles` (git's own output, passed as a literal argv element), so
 * it needs no escaping. Returns null when the path is absent at the ref or git
 * fails — never throws.
 */
export async function gitShowFile(baseDir: string, ref: string, relPath: string): Promise<string | null> {
  if (!safeGitRef(ref)) return null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", baseDir, "show", `${ref}:${relPath}`], {
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return null;
  }
}
