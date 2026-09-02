/**
 * Dead-code analysis — pure helpers, no I/O and no LanceDB.
 *
 * Two concerns live here so they're unit-testable in isolation (like
 * `src/utils/text.ts`):
 *
 *  1. `scoreDeadCode` — a deliberately CONSERVATIVE multi-signal model that is
 *     reluctant to call a zero-reference symbol dead. Because the index carries
 *     no `exported`/visibility/parent flag, "exported" is recovered from the
 *     chunk's own text (`export …`, `pub …`, Go capitalization, `public …`) and
 *     polymorphism/dynamic-hook/common-name signals demote confidence.
 *
 *  2. `countReferences` — a single-pass whole-identifier counter over all chunk
 *     content. The "definition rule" excludes only a symbol's exact declaration
 *     line, so a recursive call inside the body still counts as a reference
 *     (no false-dead on recursive functions) while the declaration itself is not
 *     double-counted. Identical names across files share a count (collision →
 *     conservative: neither is flagged).
 *
 * The engine (`IndexManager.findDeadCode`) composes these.
 */
import { escapeRegExp } from "../utils/text";

export interface DeadSignal {
  signal: string;
  detail?: string;
}

export interface ScoredDead {
  confidence: number; // 0–100
  category: "likely dead" | "uncertain" | "review";
  signals: DeadSignal[];
}

/** Names that are very often invoked dynamically / by convention — never trust "0 refs". */
export const DYNAMIC_HOOK_NAMES = new Set([
  // JS/TS lifecycle & coercion
  "toString", "valueOf", "toJSON", "toLocaleString", "then", "catch", "finally",
  "call", "apply", "bind",
  // React-ish lifecycle
  "render", "componentDidMount", "componentWillUnmount", "mount", "unmount", "useEffect",
  // entry points
  "main", "__main__", "run", "start", "stop",
  // constructors / destructors
  "__init__", "init", "initialize", "constructor", "new", "ctor", "create", "destroy",
  "dispose", "close", "finalize", "del",
  // test lifecycle
  "setup", "teardown", "setUp", "tearDown", "beforeEach", "afterEach",
  // Godot engine-invoked virtuals (`_init` included: CONSTRUCTOR_LIKE's anchored
  // pattern does not match the leading underscore)
  "_init", "_ready", "_enter_tree", "_exit_tree", "_process", "_physics_process",
  "_input", "_input_event", "_shortcut_input", "_unhandled_input", "_unhandled_key_input",
  "_draw", "_gui_input", "_clips_input", "_notification", "_get", "_set",
  "_get_property_list", "_get_minimum_size", "_validate_property", "_to_string",
]);

const DYNAMIC_NAME_PREFIXES = /^(handle|command|do|on|run|get|set|is|has|can|should|visit|accept)([A-Z_])/;
const CONSTRUCTOR_LIKE = /^(init|initialize|constructor|new|ctor|__init__|create|setup|__new)$/i;

// ---- exported detection (per-language; conservative — false negatives over false positives) ----

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
    // C/C++/Ruby/PHP/Swift/Scala: exported/visibility is unreliable from text → omit.
    default:
      return false;
  }
}

// ---- scoring ----

export interface ScoreInput {
  symbolName: string;
  symbolType: string;
  language: string;
  content: string;
  referenceCount: number;
  /** For a dotted `Class.method`: is the owning class itself referenced anywhere? */
  ownerClassReferenced: boolean;
  /** Is this bare name shared across many distinct symbols? (collision risk) */
  isCommonName: boolean;
}

/**
 * Score a zero-reference symbol. Start confident (80), then demote for every
 * signal that could mean "used despite no static reference". Tunable: the
 * thresholds below are the single place to dial precision/recall.
 */
export function scoreDeadCode(input: ScoreInput): ScoredDead {
  let confidence = 80;
  const signals: DeadSignal[] = [];
  const bare = input.symbolName.split(".").pop() ?? input.symbolName;

  if (detectExported(input.symbolName, input.symbolType, input.language, input.content)) {
    confidence -= 30;
    signals.push({ signal: "exported", detail: "possibly public API" });
  }
  if (input.symbolType === "method" && input.ownerClassReferenced) {
    confidence -= 20;
    signals.push({ signal: "owner-class-referenced", detail: "may be called via instance" });
  }
  const isPoly =
    input.symbolType === "trait" ||
    input.symbolType === "interface" ||
    /@Override\b|\boverride\b|\bvirtual\b|\bimplements\b|\bextends\b|\babstract\b/.test(
      input.content.slice(0, 400),
    );
  if (isPoly) {
    confidence -= 35;
    signals.push({ signal: "polymorphic", detail: "may be overridden / implemented" });
  }
  // Constructor-like and dynamic-hook are mutually exclusive (a ctor is the stronger signal).
  if (CONSTRUCTOR_LIKE.test(bare)) {
    confidence -= 30;
    signals.push({ signal: "constructor-like" });
  } else if (DYNAMIC_HOOK_NAMES.has(bare) || DYNAMIC_NAME_PREFIXES.test(bare)) {
    confidence -= 25;
    signals.push({ signal: "dynamic-hook-name", detail: bare });
  }
  if (input.isCommonName) {
    confidence -= 15;
    signals.push({ signal: "common-name", detail: "name shared across many symbols" });
  }
  // Python private (single leading underscore) is more likely genuinely unused.
  if (input.language === "python" && bare.startsWith("_") && !bare.startsWith("__")) {
    confidence += 10;
    signals.push({ signal: "private-by-convention" });
  }
  // GDScript signal handlers (`_on_Button_pressed`) are wired up in scenes via the
  // editor — zero textual references by design.
  if (input.language === "gdscript" && /^_on_/.test(bare)) {
    confidence -= 25;
    signals.push({ signal: "signal-handler-convention", detail: "connected via editor/scenes" });
  }

  confidence = Math.max(0, Math.min(100, confidence));
  const category: ScoredDead["category"] =
    confidence >= 70 ? "likely dead" : confidence >= 40 ? "uncertain" : "review";
  return { confidence, category, signals };
}

// ---- single-pass reference counting ----

export interface CountSymbol {
  /** Unique id for this symbol (e.g. `symbolName@file:line`). */
  key: string;
  /** Identifiers that count as a reference to this symbol (full name + bare segment). */
  matchNames: string[];
  filePath: string;
  /** The declaration line (1-based) — occurrences here are the definition, not references. */
  declarationLine: number;
}

export interface CountChunk {
  filePath: string;
  startLine: number;
  content: string;
}

/** Identifiers that reference a symbol: the full name, plus the bare last segment if dotted. */
export function matchNamesFor(symbolName: string): string[] {
  const names = [symbolName];
  if (symbolName.includes(".")) {
    const bare = symbolName.split(".").pop();
    if (bare) names.push(bare);
  }
  return names;
}

export const NAME_REGEX_CAP = 5000;

/** Build one combined whole-identifier regex (longest-literal-first alternation). */
export function buildNameRegex(names: string[]): RegExp | null {
  const uniq = [...new Set(names)].filter((n) => n.length > 0);
  if (uniq.length === 0) return null;
  const sorted = uniq.sort((a, b) => b.length - a.length).slice(0, NAME_REGEX_CAP);
  const pattern = `(?<![A-Za-z0-9_$])(${sorted.map(escapeRegExp).join("|")})(?![A-Za-z0-9_$])`;
  return new RegExp(pattern, "g");
}

/**
 * Count whole-identifier references for every symbol in one pass over all chunk
 * content. Returns a Map<symbolKey, referenceCount> (0 for symbols never referenced).
 * The definition rule: an occurrence on a symbol's exact declaration line in its
 * own file is the definition and is skipped; everything else (incl. recursion in
 * the body) counts.
 */
export function countReferences(symbols: CountSymbol[], chunks: CountChunk[]): Map<string, number> {
  const nameToKeys = new Map<string, Set<string>>();
  const defLookup = new Map<string, Map<string, Set<number>>>(); // name → file → declaration lines
  const refCount = new Map<string, number>();
  for (const s of symbols) {
    refCount.set(s.key, 0);
    for (const name of s.matchNames) {
      if (!name) continue;
      let keys = nameToKeys.get(name);
      if (!keys) {
        keys = new Set();
        nameToKeys.set(name, keys);
      }
      keys.add(s.key);
      let perFile = defLookup.get(name);
      if (!perFile) {
        perFile = new Map();
        defLookup.set(name, perFile);
      }
      let lines = perFile.get(s.filePath);
      if (!lines) {
        lines = new Set();
        perFile.set(s.filePath, lines);
      }
      lines.add(s.declarationLine);
    }
  }

  const allNames = [...nameToKeys.keys()];
  if (allNames.length === 0) return refCount;

  // Scan in name-GROUPS so no single combined regex exceeds NAME_REGEX_CAP. The
  // def-index (defLookup / nameToKeys) is GLOBAL — built from every symbol — so the
  // declaration-line exclusion stays correct across groups, and each name is scanned
  // exactly once (no silent drop of symbols past a regex cap).
  for (let gi = 0; gi < allNames.length; gi += NAME_REGEX_CAP) {
    const re = buildNameRegex(allNames.slice(gi, gi + NAME_REGEX_CAP));
    if (!re) continue;
    for (const chunk of chunks) {
      if (typeof chunk.content !== "string" || chunk.content.length === 0) continue;
      const lines = chunk.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const matched = m[1]!;
          const absLine = chunk.startLine + i;
          const defLines = defLookup.get(matched)?.get(chunk.filePath);
          if (defLines && defLines.has(absLine)) {
            // Declaration line for this name in this file → it's a definition, not a reference.
            if (m.index === re.lastIndex) re.lastIndex++;
            continue;
          }
          const keys = nameToKeys.get(matched);
          if (keys) {
            for (const key of keys) refCount.set(key, (refCount.get(key) ?? 0) + 1);
          }
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      }
    }
  }
  return refCount;
}
