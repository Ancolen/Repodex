/**
 * Per-language "is this symbol exported?" recovery from a chunk's own text.
 *
 * The index carries no `exported`/visibility column, so both consumers that need
 * the notion recover it from the symbol's chunk text here, in ONE place:
 *
 *  - `src/core/deadcode.ts → scoreDeadCode` (an exported symbol is a worse
 *    dead-code candidate), and
 *  - `src/core/apidiff.ts` (the public-API surface, which must also notice a
 *    symbol going from exported to private → `visibility-narrowed`).
 *
 * Pure function (string in, boolean out), no I/O — like `src/utils/text.ts`.
 * Conservative by design: false NEGATIVES (calling something private that is
 * actually public) are preferred over false positives.
 */

/**
 * Does this symbol look exported, given its name, type, language and the
 * (first 300 chars of the) chunk text it was extracted from?
 *
 * The chunker slices from the OUTER node, so an exported JS/TS symbol's chunk
 * text begins with its `export` wrapper; Rust carries `pub`, Java/C# a `public`
 * modifier, Go uses capitalization, and GDScript's `class_name X` registers the
 * file's API globally (`@export` exposes members to the editor).
 */
export function detectExported(
  symbolName: string,
  _symbolType: string,
  language: string,
  content: string,
): boolean {
  const head = content.slice(0, 300);
  switch (language) {
    case "javascript":
    case "typescript":
    case "tsx":
      // Chunker slices from the outer node, so an exported symbol's chunk text
      // begins with the `export` wrapper.
      return /(^|\n)\s*export(\s+default|\s+type|\s+\*|\s+const|\s+function|\s+class|\s+abstract|\s+interface|\s+enum|\s+async|\s+\{)?\b/.test(
        head,
      );
    case "rust":
      return /\bpub(\([^)]*\))?\s+(fn|struct|enum|trait|mod|const|static|type)\b/.test(head);
    case "go":
      // Idiomatic Go: an uppercase-first identifier is exported.
      return /^[A-Z]/.test(symbolName);
    case "java":
      return /\bpublic\b/.test(head);
    case "c_sharp":
      return /\bpublic\b/.test(head);
    case "gdscript":
      // `class_name X` registers the class globally (its top-level members are the
      // file's API); `@export` exposes members to the editor. Both are recoverable
      // from the chunk text — in practice class_name (annotations are separate
      // sibling statements in the grammar, so a `func` chunk never contains them).
      return /@export\b|\bclass_name\b/.test(head);
    // C/C++/Ruby/PHP/Swift/Scala/Python: exported/visibility is unreliable from
    // text → omit (Python's `_`-prefix is a privacy *convention*, not a visibility
    // modifier, and every module-level `def` is importable anyway).
    default:
      return false;
  }
}
