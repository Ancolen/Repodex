/**
 * Pure text helpers shared by search-result enrichment and reference scanning.
 * Kept side-effect free so they can be unit-tested without LanceDB/Ollama.
 */

/** Escapes a string for safe use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SIGNATURE_MAX = 200;

/**
 * Derives a short, human-readable signature from a code chunk's content.
 *
 * Strategy (language-agnostic, best-effort):
 *  - Skip leading blank lines.
 *  - Collect lines starting at the first non-blank one until the declaration
 *    "head" ends — i.e. a line that opens a body (`{`), a Python-style block
 *    (trailing `:`), or an arrow (`=>`) — capped at 3 lines.
 *  - Strip the trailing body opener and collapse whitespace.
 *
 * This yields e.g. `function loginUser(req, res)` or `def greet(name)` from the
 * full chunk, so an agent sees the declaration without reading the whole block.
 */
export function deriveSignature(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length) return "";

  const collected: string[] = [];
  for (let j = i; j < lines.length && collected.length < 6; j++) {
    const line = lines[j]!;
    collected.push(line.trim());
    // A `{` the head ends on opens the BODY — the head is complete. But a `{`
    // preceded by `:` / `(` / `=` / `,` opens an inline object TYPE or a call
    // argument list (e.g. `async checkDocs(opts: {`), so the declaration head
    // continues on the following lines. A lone `{` line follows the same rule
    // via the PREVIOUS line (Allman-style body braces break; an opener that
    // clearly continues like `const x =` does not).
    const brace = line.lastIndexOf("{");
    if (brace >= 0) {
      const before = line.slice(0, brace).trimEnd();
      const prev = collected.length > 1 ? collected[collected.length - 2]! : "";
      if (/[:,(=]$/.test(before) || (before === "" && /[:,(=]$/.test(prev))) continue;
      break;
    }
    // Stop once we reach the end of the declaration head.
    if (/[:=]>?\s*$/.test(line) || /\)\s*$/.test(line)) break;
  }

  let sig = collected.join(" ").replace(/\s+/g, " ").trim();
  // Cut everything from the BODY opener onward — skipping the inline
  // type-literal braces the head itself contains (the same discrimination as
  // the collection loop above).
  const bodyBrace = bodyBraceIndex(sig);
  if (bodyBrace > 0) sig = sig.slice(0, bodyBrace).trim();
  if (sig.endsWith(":")) sig = sig.slice(0, -1).trim();
  if (sig.endsWith("(")) sig = sig.slice(0, -1).trim();
  if (sig.length > SIGNATURE_MAX) sig = sig.slice(0, SIGNATURE_MAX) + "…";
  return sig;
}

/**
 * Index of the first BODY-opening `{` in a (joined) signature head — a brace
 * NOT preceded by `:` / `(` / `=` / `,` (those open inline object types or call
 * argument lists, which belong to the head). -1 when there is no body brace.
 */
function bodyBraceIndex(s: string): number {
  for (let k = 0; k < s.length; k++) {
    if (s[k] !== "{") continue;
    let p = k - 1;
    while (p >= 0 && /\s/.test(s[p]!)) p--;
    const prev = p >= 0 ? s[p]! : "";
    if (prev === "" || /[:,(=]/.test(prev)) continue;
    return k;
  }
  return -1;
}

/** A single line within a chunk where an identifier occurs. */
export interface IdentifierLine {
  /** 1-based absolute line number in the file. */
  line: number;
  /** The trimmed text of the matching line. */
  text: string;
}

/**
 * Finds the lines inside `content` where `name` appears as a WHOLE identifier
 * (not as a substring of a larger identifier). `baseLine` is the 1-based line
 * number of the chunk's first line, so the returned line numbers are absolute.
 *
 * Used by `find_references` to turn a chunk that contains the symbol token into
 * concrete file:line occurrences. Identifier boundaries treat `[A-Za-z0-9_$]` as
 * identifier characters, so `getUser` does not match inside `getUserName`.
 */
export function matchIdentifierLines(content: string, baseLine: number, name: string): IdentifierLine[] {
  if (!name) return [];
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`);
  const out: IdentifierLine[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) {
      out.push({ line: baseLine + i, text: lines[i]!.trim() });
    }
  }
  return out;
}
