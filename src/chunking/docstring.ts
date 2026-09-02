import type Parser from "web-tree-sitter";

type Node = Parser.SyntaxNode;

/**
 * Docstring / doc-comment extraction for the docstring embedding leg.
 *
 * Goal: a short, natural-language text per symbol that describes WHAT it does,
 * so it can be embedded into a separate vector (`doc_vector`) and retrieved by
 * intent-style queries ("how do we retry with backoff?") that code text answers
 * poorly. Extraction is heuristic and language-family based:
 *
 * - Python: the docstring — the first `string` statement inside the function/
 *   class body (delimiters/prefix stripped via the `string_content` child).
 * - Everything else: the run of `comment`-type nodes immediately preceding the
 *   definition in its parent's named children (JSDoc `/** *`-blocks, Rust `///`,
 *   Go/C/C++ line comments, GDScript `##` …). Anonymous tokens (keywords,
 *   punctuation) between the comment and the definition don't break the run;
 *   any other named sibling does.
 *
 * The result is advisory: a missing docstring just means no doc leg for that
 * chunk. Comments remain part of the normal chunk content (loose chunks), so
 * nothing is removed from the regular index.
 */

/** Cap: docs longer than this are truncated (closest to the symbol is kept). */
export const MAX_DOC_CHARS = 1200;

/** Does this node look like a comment node across the bundled grammars? */
function isComment(node: Node): boolean {
  return node.type.includes("comment");
}

/**
 * The contiguous run of comment nodes immediately before `node` in its parent's
 * named children (identity via `node.id` — tree-sitter re-wraps nodes per access,
 * so object identity is unreliable). Returns undefined when there is none.
 */
function precedingComments(node: Node): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  const siblings = parent.namedChildren;
  const idx = siblings.findIndex((s) => s.id === node.id);
  if (idx <= 0) return undefined;
  const parts: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i];
    if (!sib || !isComment(sib)) break;
    parts.unshift(sib.text);
  }
  if (parts.length === 0) return undefined;
  return cap(parts.join("\n"));
}

/** Python docstring: the first statement of the body, when it is a bare string. */
function pythonDocstring(node: Node): string | undefined {
  const body = node.childForFieldName("body");
  const first = body?.namedChildren[0];
  if (!first) return undefined;
  const inner = first.type === "expression_statement" ? first.namedChildren[0] : first;
  if (!inner || inner.type !== "string") return undefined;
  // `string_content` excludes the quotes and any r/b/f prefix; fall back to
  // slicing the raw text for grammars that don't split string children.
  const content = inner.namedChildren.find((c) => c.type === "string_content");
  const text = content?.text ?? inner.text;
  if (!text || text.trim().length === 0) return undefined;
  return cap(text.trim());
}

/** Truncates to MAX_DOC_CHARS, keeping the head (doc intent lives up front). */
function cap(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DOC_CHARS ? trimmed.slice(0, MAX_DOC_CHARS) : trimmed;
}

/**
 * Extracts the docstring / doc-comment for a definition node.
 * `top` is the outer node as it appears among its siblings (wrapper included —
 * a comment sits before `export_statement`, not before the inner `function`),
 * `inner` the unwrapped definition. Returns undefined when nothing doc-like is
 * attached (or `doc` extraction yields only whitespace).
 */
export function extractDoc(
  top: Node,
  inner: Node,
  language: string | undefined,
): string | undefined {
  if (language === "python") {
    return pythonDocstring(inner) ?? precedingComments(top);
  }
  return precedingComments(top);
}