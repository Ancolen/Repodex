/**
 * Git-history / commit-message search — pure parser, no I/O and no git.
 *
 * Sibling of `deadcode.ts` / `callgraph.ts`: the git `exec` lives in
 * `services/git.ts → searchGitLog`; this module owns the parse recipe so it can
 * be unit-tested without spawning git. The engine (`IndexManager.searchCommits`)
 * composes the two.
 *
 * The format is unambiguous even with multi-line commit bodies: fields are
 * unit-separator (`\x1f`) delimited, and `-z` makes the inter-commit (and
 * inter-filename) separator a NUL (`\0`). A commit header ALWAYS begins with a
 * 40-hex SHA followed by `\x1f`, so a filename (which never contains `\x1f`)
 * can't be mistaken for a new commit — that is what lets `--name-only` files be
 * told apart from headers in a single split pass.
 */

/**
 * The `git log --format` string. Field order (each `\x1f`-separated):
 *   %H full hash · %h abbreviated · %an author name · %ae author email ·
 *   %aI ISO-8601 author date · %at author date (epoch seconds) · %s subject ·
 *   %b body (may be empty / multi-line).
 * Exported so `searchGitLog` reuses the exact recipe the parser expects.
 */
export const COMMIT_FORMAT =
  "%H\x1f%h\x1f%an\x1f%ae\x1f%aI\x1f%at\x1f%s\x1f%b";

/** Search options understood by the runner (`searchGitLog`) and the engine. */
export interface CommitQueryOpts {
  /** Case-insensitive regex matched against the commit message (subject + body). */
  query?: string;
  /** Restrict to commits that touched this path (file / dir / glob), repo-relative. */
  path?: string;
  /** Case-insensitive regex matched against the author name / email. */
  author?: string;
  /** git `--since` date, e.g. `"2 weeks ago"` or `"2024-01-01"`. */
  since?: string;
  /** git `--until` date. */
  until?: string;
  /** Maximum commits to return (default 50). */
  limit?: number;
  /** Include the list of changed files per commit (git `--name-only`). */
  withFiles?: boolean;
}

/** One matching commit. */
export interface CommitHit {
  hash: string;
  abbreviatedHash: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601 author date. */
  date: string;
  /** Author date in epoch ms (for sorting / recency). */
  timestamp: number;
  subject: string;
  /** Commit body, minus trailing whitespace; present only when non-empty. */
  body?: string;
  /** Changed file paths (repo-relative); present only with `withFiles` and non-empty. */
  files?: string[];
}

const SEP = "\x1f";
/** A token is a new commit header iff it starts with a 40-hex SHA then `\x1f`. */
const HEADER_RE = /^[0-9a-f]{40}\x1f/;

/**
 * Parse the stdout of `git log -z --format=<COMMIT_FORMAT> [--name-only]`.
 *
 * Tokens are NUL-delimited. A header token yields a `CommitHit` (fields split on
 * `\x1f`); any other token — present only with `--name-only` — is a changed file
 * belonging to the most recent commit. Trailing empty tokens (from the final
 * NUL) are skipped. `withFiles: false` makes every non-empty token a header.
 */
export function parseCommitLog(stdout: string, withFiles: boolean): CommitHit[] {
  const hits: CommitHit[] = [];
  let current: CommitHit | null = null;
  for (const token of stdout.split("\0")) {
    if (token.length === 0) continue;
    if (HEADER_RE.test(token)) {
      const f = token.split(SEP);
      // f = [hash, abbreviated, name, email, iso, tsSec, subject, body...]
      const tsSec = Number(f[5] ?? "");
      const hit: CommitHit = {
        hash: f[0] ?? "",
        abbreviatedHash: f[1] ?? "",
        authorName: f[2] ?? "",
        authorEmail: f[3] ?? "",
        date: f[4] ?? "",
        timestamp: Number.isFinite(tsSec) ? tsSec * 1000 : 0,
        subject: f[6] ?? "",
      };
      // The body is everything after the 7th field (joined defensively; a real
      // body can't contain `\x1f`, so this is normally a single element).
      const body = f.slice(7).join(SEP).trimEnd();
      if (body.length > 0) hit.body = body;
      current = hit;
      hits.push(hit);
    } else if (withFiles && current) {
      if (!current.files) current.files = [];
      current.files.push(token);
    }
  }
  return hits;
}
