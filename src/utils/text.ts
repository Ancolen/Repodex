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
  for (let j = i; j < lines.length && collected.length < 3; j++) {
    const line = lines[j]!;
    collected.push(line.trim());
    // Stop once we reach the end of the declaration head.
    if (line.includes("{") || /[:=]>?\s*$/.test(line) || /\)\s*$/.test(line)) break;
  }

  let sig = collected.join(" ").replace(/\s+/g, " ").trim();
  // Cut everything from the body opener onward.
  const brace = sig.indexOf("{");
  if (brace > 0) sig = sig.slice(0, brace).trim();
  if (sig.endsWith(":")) sig = sig.slice(0, -1).trim();
  if (sig.length > SIGNATURE_MAX) sig = sig.slice(0, SIGNATURE_MAX) + "…";
  return sig;
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
