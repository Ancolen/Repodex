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
 * Comment conventions per indexed language: what a leading comment / docstring
 * / decorator looks like, so the signature is the declaration head — never the
 * doc comment that happens to sit above it (a chunk spans its preceding doc
 * comment too). Languages absent from this table (text formats like markdown,
 * unknown languages) keep the legacy first-line behavior.
 */
interface CommentStyle {
  /** Line-comment prefixes (`//`, `#`). */
  line: string[];
  /** Block comment delimiters (the C-style slash-star pair). */
  block?: { open: string; close: string };
  /** Bare docstring openers (`"""` — the opener may close on its own line). */
  docstring?: string[];
  /** `@`-decorator lines (Python, Java annotations, Kotlin, …). */
  decorators?: boolean;
  /** `[...]`-attribute lines (C#). */
  attribute?: boolean;
}

const COMMENT_STYLES: Record<string, CommentStyle> = {
  javascript: { line: ["//"], block: { open: "/*", close: "*/" } },
  typescript: { line: ["//"], block: { open: "/*", close: "*/" } },
  tsx: { line: ["//"], block: { open: "/*", close: "*/" } },
  go: { line: ["//"], block: { open: "/*", close: "*/" } },
  // Rust has no `#` comments — a leading `#` is only `#[derive]`-style attributes.
  rust: { line: ["//", "#"], block: { open: "/*", close: "*/" } },
  java: { line: ["//"], block: { open: "/*", close: "*/" }, decorators: true },
  c: { line: ["//"], block: { open: "/*", close: "*/" } },
  cpp: { line: ["//"], block: { open: "/*", close: "*/" } },
  php: { line: ["//", "#"], block: { open: "/*", close: "*/" } },
  ruby: { line: ["#"] },
  kotlin: { line: ["//"], block: { open: "/*", close: "*/" }, decorators: true },
  swift: { line: ["//"], block: { open: "/*", close: "*/" }, decorators: true },
  scala: { line: ["//"], block: { open: "/*", close: "*/" }, decorators: true },
  c_sharp: { line: ["//"], block: { open: "/*", close: "*/" }, attribute: true },
  python: { line: ["#"], docstring: ['"""', "'''"], decorators: true },
  gdscript: { line: ["#"], docstring: ['"""', "'''"], decorators: true },
};

/**
 * Index of the first line that can open a declaration head: blank lines are
 * always skipped, and — when the chunk's language has a known comment style —
 * so are leading comments, docstrings and decorator/attribute lines. Without a
 * style the first non-blank line is returned (legacy behavior).
 */
function firstDeclarationLine(lines: string[], style: CommentStyle | undefined): number {
  let i = 0;
  while (i < lines.length) {
    const t = lines[i]!.trim();
    if (t === "") {
      i++;
      continue;
    }
    if (!style) return i;
    if (style.decorators && t.startsWith("@")) {
      i++;
      continue;
    }
    if (style.attribute && t.startsWith("[")) {
      i++;
      continue;
    }
    if (style.line.some((p) => t.startsWith(p))) {
      i++;
      continue;
    }
    if (style.block && t.startsWith(style.block.open)) {
      const close = style.block.close;
      const end = t.indexOf(close);
      if (end >= 0) {
        // Code on the closer's own line (`/* x */ fn f()`) IS the declaration —
        // leave the line for the head collector.
        if (/[^*\s]/.test(t.slice(end + close.length))) return i;
        i++; // a self-contained comment line
        continue;
      }
      i++; // opener only — consume until the closer line
      while (i < lines.length && !lines[i]!.includes(close)) i++;
      i++;
      continue;
    }
    if (style.docstring) {
      const quote = style.docstring.find((q) => t.startsWith(q));
      if (quote) {
        if (t.slice(quote.length).includes(quote)) {
          i++; // single-line docstring
        } else {
          i++;
          while (i < lines.length && !lines[i]!.includes(quote)) i++;
          i++;
        }
        continue;
      }
    }
    return i;
  }
  return i;
}

/**
 * Derives a short, human-readable signature from a code chunk's content.
 *
 * Strategy (best-effort, language-aware where the chunk carries a label):
 *  - Skip leading blank lines; for a language with a known comment style, skip
 *    leading comments, docstrings and decorator/attribute lines too — the
 *    signature is the declaration head, not the doc comment above it.
 *  - Collect lines starting there until the declaration "head" ends — i.e. a
 *    line that opens a body (`{`), a Python-style block (trailing `:`), or an
 *    arrow (`=>`) — capped at 6 lines.
 *  - Strip the trailing body opener and collapse whitespace.
 *
 * This yields e.g. `function loginUser(req, res)` or `def greet(name)` from the
 * full chunk, so an agent sees the declaration without reading the whole block.
 */
export function deriveSignature(content: string, language?: string | null | undefined): string {
  const lines = content.split("\n");
  const i = firstDeclarationLine(lines, language ? COMMENT_STYLES[language] : undefined);
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
