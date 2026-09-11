/**
 * Identifier-part tokenization for the `id_terms` BM25 column (proposal S1).
 *
 * Pure helpers, no I/O and no LanceDB — like `src/utils/text.ts` and
 * `src/core/deadcode.ts` — so the whole tokenization model is unit-testable.
 *
 * The problem: BM25/FTS indexes `content` verbatim, so a query like
 * "update user name" never matches `getUserName` — FTS tokenizes on word
 * boundaries and `getUserName` is one identifier token. The fix mirrors the
 * 2.4.0 docstring legs from the *code* side: at chunk time every compound
 * identifier in the chunk is split into its subparts and stored — lowercased,
 * space-joined, with the raw identifier kept first — in a nullable `id_terms`
 * column that gets its own FTS index:
 *
 *     getUserName → `getusername get user name`
 *     user_id     → `user_id user id`
 *
 * Extraction is deliberately a **combined-regex pass over the chunk text**
 * (the `countReferences` precedent in `src/core/deadcode.ts`), not an AST walk:
 * it is language-agnostic, it never touches the shared tree-sitter parser (no
 * second parse per file, so the interleaved-determinism surface is unchanged),
 * and it also covers character-fallback chunks (json/md/xml/rst) that have no
 * identifier nodes at all.
 */

/**
 * Upper bound for one chunk's `id_terms` string. Minified / generated files can
 * carry tens of thousands of distinct identifiers; without a cap a single chunk
 * could produce a pathological row. The cap is applied at a term boundary (the
 * extraction stops before the identifier that would overflow it), so a row is
 * never cut mid-term.
 */
export const MAX_ID_TERMS_CHARS = 2000;

/** An identifier is written if it splits into at least this many parts. */
const MIN_PARTS = 2;

/**
 * Identifier-shaped token in source text: starts with a letter / `_` / `$`,
 * continues with letters, digits, `_`, `$` or `.` (dotted paths like
 * `fs.readFile`, which the splitter then breaks apart). Notably `-` is NOT a
 * token character — kebab-case shows up in source almost exclusively inside
 * strings and prose, and letting it through would tokenize every hyphenated
 * prose word into the column.
 */
const IDENT_RE = /(?<![0-9])([\p{L}_$][\p{L}\p{N}_$.]*)/gu;

type CharKind = "lower" | "upper" | "digit" | "other";

function kindOf(ch: string): CharKind {
  if (/\p{Ll}/u.test(ch)) return "lower";
  if (/\p{Lu}/u.test(ch)) return "upper";
  if (/\p{N}/u.test(ch)) return "digit";
  return "other";
}

/**
 * Splits one identifier into its subparts at camelCase / snake_case /
 * kebab-case / dotted / `$` boundaries. `_`, `-`, `.`, `$` and any other
 * non-alphanumeric character act as separators and are dropped; digits stay
 * attached to the word they follow (`md5Hash` → `md5 hash`, `sha256sum` stays
 * one part). Unicode-aware — accented / non-Latin letters count as letters
 * (`getUserİD` → ["get", "User", "İD"]). The returned parts keep their case.
 *
 *     getUserName    → ["get", "User", "Name"]
 *     user_id        → ["user", "id"]
 *     SCREAMING_SNAKE→ ["SCREAMING", "SNAKE"]
 *     HTTPServer     → ["HTTP", "Server"]
 *     fs.readFile    → ["fs", "read", "File"]
 */
export function splitIdentifier(name: string): string[] {
  const parts: string[] = [];
  let current = "";
  let prev: CharKind | null = null;
  const chars = [...name];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const kind = kindOf(ch);
    if (kind === "other") {
      // Separator (_ - . $ whitespace …): close the current word, drop the char.
      if (current) parts.push(current);
      current = "";
      prev = null;
      continue;
    }
    const next = i + 1 < chars.length ? kindOf(chars[i + 1]!) : null;
    const startsNew =
      current === "" ||
      // camelCase: a lower/digit followed by an upper starts a new word.
      (kind === "upper" && (prev === "lower" || prev === "digit")) ||
      // End of an acronym run: `HTTPServer` → `HTTP` | `Server`.
      (kind === "upper" && prev === "upper" && next === "lower");
    if (startsNew && current) parts.push(current);
    current = startsNew ? ch : current + ch;
    prev = kind;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Builds one chunk's `id_terms` string: every compound identifier-shaped token
 * in `content`, deduplicated in first-seen order, each contributing
 * `<identifier> <part> <part> …` lowercased. Identifiers that split into a
 * single word are skipped — a bare word is already indexed verbatim by the
 * `content` leg, so repeating it here would only bloat the column.
 *
 * Returns "" when nothing compound was found (the indexer writes null).
 * Stops before the identifier that would push the string past `maxChars`
 * (default `MAX_ID_TERMS_CHARS`); a lone oversized identifier is truncated.
 */
export function extractIdTerms(content: string, maxChars = MAX_ID_TERMS_CHARS): string {
  // Reset first (the module-level regex carries `g` state between calls).
  IDENT_RE.lastIndex = 0;
  if (!content) return "";
  const seen = new Set<string>();
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = IDENT_RE.exec(content)) !== null) {
    const ident = m[1]!;
    const parts = splitIdentifier(ident);
    if (parts.length < MIN_PARTS) continue;
    const terms = (ident + " " + parts.join(" ")).toLowerCase();
    if (seen.has(terms)) continue;
    seen.add(terms);
    const piece = out.length === 0 ? terms : ` ${terms}`;
    if (out.length + piece.length > maxChars) {
      // Cap reached: keep whole terms only. A single identifier longer than the
      // whole budget is truncated (bounded row, never a mid-term cut of a pair).
      if (out.length === 0) return terms.slice(0, maxChars);
      break;
    }
    out += piece;
  }
  return out;
}

/**
 * Tokenizes a search query the same way `extractIdTerms` builds the column, so
 * the two sides agree on what "matches" means. Used to gate the `id_terms` leg:
 * it only runs when the query itself splits into ≥ 2 parts — a single-word
 * query ("cache") is already served by the `content` leg, and skipping the leg
 * keeps the RRF rank pool undiluted for exactly the queries it can't help.
 *
 *     "update user name" → ["update", "user", "name"]
 *     "getUserName"      → ["get", "user", "name"]
 *     "cache"            → ["cache"]
 */
export function idTermsQueryParts(query: string): string[] {
  const out: string[] = [];
  if (!query) return out;
  for (const word of query.split(/\s+/)) {
    if (!word) continue;
    for (const part of splitIdentifier(word)) {
      const lower = part.toLowerCase();
      // Bare separator runs (`-`, `.`) yield empty parts — skip them.
      if (lower.length > 0 && /\p{L}|\p{N}/u.test(lower)) out.push(lower);
    }
  }
  return out;
}

/** Should the `id_terms` BM25 leg run for this query/table? (S1 gate) */
export function wantIdTermsLeg(query: string, hasColumn: boolean): boolean {
  return hasColumn && idTermsQueryParts(query).length >= MIN_PARTS;
}
