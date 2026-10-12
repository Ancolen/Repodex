/**
 * Ownership / blame enrichment (proposal C4) — pure porcelain parser, no I/O
 * and no git.
 *
 * Sibling of `commits.ts`: the git `exec` lives in `services/git.ts →
 * blameRange`; this module owns the parse recipe so it can be unit-tested
 * without spawning git. The engine (`IndexManager.applyBlame`) composes the two:
 * ONE `git blame --porcelain -L min,max -- <file>` per hit file is parsed here
 * once, then each hit of that file is aggregated from the records of its own
 * line subrange (no second git process per chunk — chunks of one file share the
 * blame).
 *
 * `git blame --porcelain` layout, per blamed line:
 *
 *   <40-hex sha> <origLine> <resultLine> [<runSize>]   ← entry line
 *   author <name>                                      ← the full header block is
 *   author-mail <email>                                  printed only for a commit's
 *   author-time <epochSec>                               FIRST entry in the output;
 *   author-tz <tz>                                       continuation entries of the
 *   committer ... / committer-mail ...                   same commit repeat only the
 *   committer-time / committer-tz                        entry line (see the memo
 *   summary <subject>                                    inside `parseGitBlamePorcelain`)
 *   [boundary]                                         ← may appear alone, no value
 *   [previous <sha> <path>]
 *   filename <path>
 *   \t<code line>                                      ← one per entry line
 *
 * Malformed or truncated output NEVER throws: lines that parse cleanly become
 * records, the rest are skipped, and the summary reports whatever parsed
 * ("" author / "" date when the header was lost). A record for an entry line
 * without its `\t` content line (truncated stream) is still emitted when the
 * next entry line or EOF flushes it.
 */

/** Upper bound on the reported distinct-commit count (proposal C4's churn cap). */
export const BLAME_CHURN_CAP = 10;

/** One blamed line: whose last-touching commit it has, and when. */
export interface BlameLineRecord {
  /** 1-based line number in the current file (the `<resultLine>` field). */
  line: number;
  /** The last commit that touched this line (40-hex; all-zero == uncommitted). */
  sha: string;
  /** Author name of that commit ("" when the header was absent/malformed). */
  author: string;
  /** Author time of that commit in epoch ms (0 when the header was absent). */
  authorTime: number;
}

/** Aggregate of the blame records of one line range. */
export interface BlameRangeSummary {
  /** Author of the most recent commit touching the range ("" when unknown). */
  lastAuthor: string;
  /** UTC calendar date (YYYY-MM-DD) of that commit's author time ("" when unknown). */
  lastCommitDate: string;
  /** Distinct commits touching the range, capped at BLAME_CHURN_CAP. */
  distinctCommits: number;
  /** True when more distinct commits than the cap touch the range. */
  distinctTruncated?: boolean;
}

/** `<sha> <origLine> <resultLine>[ <runSize>]` — a 40-hex sha anchors the line. */
const ENTRY_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?\r?$/;
/** `key <value>` header line; `boundary` alone does not match (no space+value). */
const HEADER_RE = /^([A-Za-z-]+) (\S.*|\S)$/;

/**
 * Parses the stdout of `git blame --porcelain [-L start,end] -- <file>`.
 *
 * One record per entry line. Git prints the full header block only for each
 * commit's FIRST occurrence in the output — later entries of the same commit
 * (`continuation` lines, when its lines are non-contiguous or a run is long)
 * repeat only the `<sha> <orig> <result>` line. The parser therefore memoizes
 * the header fields per sha and back-fills the bare entries, so a chunk that
 * starts inside a run still gets its author's name and time.
 *
 * A `\t` content line flushes the current entry; so do the next entry line and
 * EOF — a truncated stream still yields the entries it carried (degrading to
 * whatever header data they had).
 */
export function parseGitBlamePorcelain(text: string): BlameLineRecord[] {
  const records: BlameLineRecord[] = [];
  // Header fields seen so far for each sha (headers appear once per sha per output).
  const bySha = new Map<string, { author: string; authorTime: number }>();
  let pending: BlameLineRecord | null = null;
  // Did THIS entry carry its own header block? (continuation entries: no)
  let ownHeaders = false;

  const flush = (): void => {
    if (!pending) return;
    if (ownHeaders) {
      bySha.set(pending.sha, { author: pending.author, authorTime: pending.authorTime });
    } else {
      const memo = bySha.get(pending.sha);
      if (memo) {
        pending.author = memo.author;
        pending.authorTime = memo.authorTime;
      }
    }
    records.push(pending);
    pending = null;
    ownHeaders = false;
  };

  for (const rawFull of text.split("\n")) {
    // Normalize CRLF once — `.` in the header regex does not match `\r`, and a
    // trailing CR would otherwise corrupt the LAST header value of every line.
    const raw = rawFull.endsWith("\r") ? rawFull.slice(0, -1) : rawFull;
    const entry = ENTRY_RE.exec(raw);
    if (entry) {
      flush();
      pending = {
        line: Number(entry[3]),
        sha: entry[1] ?? "",
        author: "",
        authorTime: 0,
      };
      continue;
    }
    const header = HEADER_RE.exec(raw);
    if (header && pending) {
      const key = header[1] ?? "";
      const value = header[2] ?? "";
      if (key === "author") {
        pending.author = value;
        ownHeaders = true;
      } else if (key === "author-time") {
        const secs = Number(value);
        pending.authorTime = Number.isFinite(secs) ? secs * 1000 : 0;
        ownHeaders = true;
      }
      continue;
    }
    // A `\t` content line closes the current entry (the remaining lines of the
    // stream belong to further entries); anything else — `boundary`,
    // `previous <sha> <path>`, blank lines, garbage — degrades: skipped.
    if (pending && raw.startsWith("\t")) flush();
  }
  flush();
  return records;
}

/**
 * Aggregates the blame records of a line range into the ownership summary:
 * the most recent author (max author-time; ties resolved toward the higher
 * line number) and the distinct-commit count, capped. Returns `null` when
 * there are no records or nothing usable (no author AND no date anywhere) —
 * the caller then simply leaves the blame fields unset.
 */
export function summarizeBlameRange(records: BlameLineRecord[]): BlameRangeSummary | null {
  if (records.length === 0) return null;
  let last = records[0]!;
  for (const r of records) {
    if (r.authorTime > last.authorTime || (r.authorTime === last.authorTime && r.line > last.line)) {
      last = r;
    }
  }
  if (last.author.length === 0 && last.authorTime <= 0) return null;

  const shas = new Set<string>();
  for (const r of records) shas.add(r.sha);
  const capped = shas.size > BLAME_CHURN_CAP;
  const summary: BlameRangeSummary = {
    lastAuthor: last.author,
    lastCommitDate:
      last.authorTime > 0
        ? new Date(last.authorTime).toISOString().slice(0, 10)
        : "",
    distinctCommits: Math.min(shas.size, BLAME_CHURN_CAP),
  };
  if (capped) summary.distinctTruncated = true;
  return summary;
}