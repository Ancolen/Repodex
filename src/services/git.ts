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
// Churn (proposal C3 — hotspots). Per-file change counts over a `--since`
// window: the engine for the hotspot report's churn feed. It reuses
// `searchGitLog` verbatim (same `-z` no-shell execFile, same tested parse
// recipe) and only reduces its `--name-only` file lists to counts. Paths are
// REPO-RELATIVE git output — the caller resolves them against the project root
// before joining with the indexed-file set. Git absence / not-a-repo yields a
// zero result after the caller's own `isGitRepo` probe (the same shape
// `searchCommits` reports through `notARepo`).
// ---------------------------------------------------------------------------

/** Upper bound on the churn commit walk (a busy 90-day history can be long). */
export const CHURN_DEFAULT_MAX_COMMITS = 5000;

/** The reduction of one churn walk. */
export interface ChurnCounts {
  /** Repo-relative path → number of window commits that touched it. */
  counts: Map<string, number>;
  /** Commits actually walked (≤ maxCommits). */
  commits: number;
  /** The walk hit its cap — older in-window commits may exist (surfaced upstream). */
  truncated: boolean;
}

/** Options of `churnCounts`: the churn window (git `--since` date syntax) and the commit cap. */
export interface ChurnOpts {
  /** git `--since` date, e.g. `"90 days ago"` or `"2024-01-01"`. */
  since?: string;
  /** Maximum commits to walk (default `CHURN_DEFAULT_MAX_COMMITS`). */
  maxCommits?: number;
}

/**
 * Per-file change counts inside the window: `git log --since --name-only`
 * reduced to counts. Zero counts (no commit touched anything in the window) is
 * a normal result, not an error — the caller distinguishes not-a-repo with the
 * `isGitRepo` probe, exactly like `searchCommits`.
 */
export async function churnCounts(baseDir: string, opts: ChurnOpts = {}): Promise<ChurnCounts> {
  const maxCommits = opts.maxCommits ?? CHURN_DEFAULT_MAX_COMMITS;
  const churnOpts: CommitQueryOpts = { limit: maxCommits, withFiles: true };
  if (opts.since !== undefined) churnOpts.since = opts.since;
  const commits: CommitHit[] = await searchGitLog(baseDir, churnOpts);
  const counts = new Map<string, number>();
  for (const c of commits) {
    for (const f of c.files ?? []) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return { counts, commits: commits.length, truncated: commits.length >= maxCommits };
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

/**
 * Commit time of `<ref>` as epoch milliseconds (`git show -s --format=%at`).
 * `ref` is guarded by `safeGitRef` and passed as a literal argv element. Returns
 * null when the ref does not resolve or git fails — never throws.
 *
 * The ref is dereferenced to its COMMIT (`<ref>^{commit}`): `git show` on an
 * annotated tag object prints the tag header ("tag v2.7.2", Tagger, message)
 * and `%at` formats the tagger date only after dereferencing — without the
 * suffix the first output line is prose, not a timestamp, and every annotated
 * tag would be reported as unresolvable (lightweight tags and SHAs were fine).
 */
export async function gitCommitTimeAt(baseDir: string, ref: string): Promise<number | null> {
  if (!safeGitRef(ref)) return null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", baseDir, "show", "-s", "--format=%at", `${ref}^{commit}`], {
      timeout: 10000,
      encoding: "utf8",
    });
    const first = stdout.trim().split("\n")[0] ?? "";
    const secs = Number.parseInt(first, 10);
    return Number.isFinite(secs) ? secs * 1000 : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Blame / ownership (proposal C4). `git blame` gives, per line of a `-L` range,
// the LAST commit that touched it — so ONE invocation per file (covering the
// min..max of the hit line ranges) answers "who last changed this code, when"
// for every chunk of that file. The raw porcelain output is parsed by the pure
// `core/blame.ts` (the churn summary costs nothing beyond the parse).
// Same discipline as `searchGitLog`: `execFile` with no shell (the path is a
// literal argv element after `--`, so it can never inject an option), integer
// range bounds, the repo checked first, and every failure REPORTED (`null`)
// rather than thrown — the caller omits that file's blame fields and the
// search itself never fails.
// -----------------------------------------------------------------------------

/**
 * Raw `git blame --porcelain -L <start>,<end> -- <absPath>` output for one line
 * range of one file. `cwd` anchors the repo (`git -C`); the absolute file path
 * after `--` keeps working whatever `-C` resolves to. Returns null when the
 * directory is not a git working tree, when the range is not well-formed, or
 * when git fails/absent — never throws.
 */
export async function blameRange(
  absPath: string,
  startLine: number,
  endLine: number,
  cwd: string,
): Promise<string | null> {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
    return null;
  }
  if (!(await isGitRepo(cwd))) return null;
  // A reversed / zero-width range is normalized, never fatal.
  const start = Math.min(startLine, endLine);
  const end = Math.max(startLine, endLine);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "blame", "--porcelain", "-L", `${start},${end}`, "--", absPath],
      { timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
    );
    return stdout;
  } catch {
    return null;
  }
}
