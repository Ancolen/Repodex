/**
 * Git-history / commit-message search — pure parser tests (git-free).
 *
 * `parseCommitLog` is the pure half of `searchGitLog`; the git `exec` is covered
 * by the live smoke in the changelog. These pin the parse recipe: field/record
 * separators, the 40-hex+SEP header anchor (so a 40-hex FILENAME can't be
 * mistaken for a commit), multi-line bodies, and the withFiles interleaving.
 */
import { test, expect, describe } from "bun:test";
import { parseCommitLog } from "../src/core/commits";

const SEP = "\x1f";
const H1 = "a".repeat(40); // 40 hex chars
const H2 = "b".repeat(40);

/** Builds one record's contribution to the `-z` stream, with optional files. */
function record(
  hash: string,
  abbr: string,
  name: string,
  email: string,
  iso: string,
  ts: string,
  subject: string,
  body = "",
  files: string[] = [],
): string {
  let s = [hash, abbr, name, email, iso, ts, subject, body].join(SEP);
  for (const f of files) s += "\0" + f;
  return s;
}

describe("parseCommitLog", () => {
  test("parses a single commit with subject, body and ms timestamp", () => {
    const stream = record(
      H1, "abcdef1", "Alice", "alice@example.com",
      "2024-01-15T10:00:00+00:00", "1705312800",
      "Add login flow", "Signed-off-by: Alice\nFixes #1",
    );
    const hits = parseCommitLog(stream, false);
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.hash).toBe(H1);
    expect(h.abbreviatedHash).toBe("abcdef1");
    expect(h.authorName).toBe("Alice");
    expect(h.authorEmail).toBe("alice@example.com");
    expect(h.date).toBe("2024-01-15T10:00:00+00:00");
    expect(h.timestamp).toBe(1705312800 * 1000); // seconds → ms
    expect(h.subject).toBe("Add login flow");
    expect(h.body).toBe("Signed-off-by: Alice\nFixes #1");
  });

  test("parses multiple commits in emission order", () => {
    const stream = [
      record(H1, "aaaaaaa", "Alice", "a@x", "2024-01-02", "1704", "second"),
      record(H2, "bbbbbbb", "Bob", "b@x", "2024-01-01", "1703", "first"),
    ].join("\0");
    const hits = parseCommitLog(stream, false);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.subject).toBe("second");
    expect(hits[1]!.subject).toBe("first");
  });

  test("withFiles attaches changed files to the owning commit", () => {
    const stream = [
      record(H1, "a1", "Alice", "a@x", "2024-01-02", "1", "feat", "", ["src/a.ts", "src/b.ts"]),
      record(H2, "b1", "Bob", "b@x", "2024-01-01", "2", "docs", "", ["README.md"]),
    ].join("\0");
    const hits = parseCommitLog(stream, true);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(hits[1]!.files).toEqual(["README.md"]);
  });

  test("withFiles=false ignores file tokens (they are not commits)", () => {
    const stream = [
      record(H1, "a1", "Alice", "a@x", "2024-01-02", "1", "feat", "", ["src/a.ts"]),
    ].join("\0");
    const hits = parseCommitLog(stream, false);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.files).toBeUndefined();
  });

  test("a 40-hex FILENAME is not mistaken for a commit header", () => {
    // The anchor is 40 hex + SEP; a real filename has no SEP, so it stays a file.
    const stream = record(H1, "a1", "Alice", "a@x", "2024-01-02", "1", "feat", "", [H2]);
    const hits = parseCommitLog(stream, true);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.files).toEqual([H2]);
  });

  test("preserves newlines inside a multi-line body", () => {
    const stream = record(H1, "a1", "Alice", "a@x", "2024", "1", "subj", "line one\nline two\nline three");
    const hits = parseCommitLog(stream, false);
    expect(hits[0]!.body).toBe("line one\nline two\nline three");
  });

  test("trailing whitespace is stripped from the body", () => {
    const stream = record(H1, "a1", "Alice", "a@x", "2024", "1", "subj", "body text\n\n");
    const hits = parseCommitLog(stream, false);
    expect(hits[0]!.body).toBe("body text");
  });

  test("empty body → body omitted", () => {
    const stream = record(H1, "a1", "Alice", "a@x", "2024", "1", "subj only");
    const hits = parseCommitLog(stream, false);
    expect(hits[0]!.body).toBeUndefined();
  });

  test("non-numeric timestamp falls back to 0", () => {
    const stream = record(H1, "a1", "Alice", "a@x", "2024", "not-a-number", "subj");
    const hits = parseCommitLog(stream, false);
    expect(hits[0]!.timestamp).toBe(0);
  });

  test("empty stdout and trailing NULs yield no hits and do not crash", () => {
    expect(parseCommitLog("", false)).toEqual([]);
    expect(parseCommitLog("\0\0\0", false)).toEqual([]);
  });
});
