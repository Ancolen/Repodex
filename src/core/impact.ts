/**
 * Change-impact join — pure helpers, no I/O and no LanceDB.
 *
 * Sibling of `callgraph.ts` / `deadcode.ts`. "If I change X, what breaks?" needs
 * three adjacency views that already exist and are already cached — the call
 * graph's callers, the dependency graph's imported-by, and the whole-identifier
 * reference pass — so this module only JOINS them into one ranked report:
 *
 *   direct callers  →  module importers  →  textual references
 *
 * A consumer that *calls* the symbol outranks a file that merely *imports* its
 * module, which outranks a loose textual mention; the sections are returned in
 * that severity order, each capped by `limit` with its own `truncated` flag.
 * Test files are split out into `coveredBy` ("exercised by a test") instead of
 * the production sections ("consumed by"); the predicate is injected by the
 * engine so the centralized test-file patterns stay in exactly one place.
 *
 * The same-name caveat of its three parents applies verbatim: matching is
 * whole-identifier over indexed content, not LSP resolution — this is a review
 * aid, not proof.
 */
import path from "node:path";
import { buildNameRegex, matchNamesFor } from "./deadcode";
import { deriveSignature } from "../utils/text";

// ------------------------------------------------------------------ defaults

/** Default caller-traversal depth (1 = direct callers only). */
export const IMPACT_DEFAULT_DEPTH = 3;

/** Default cap per section (callers / importers / reference samples / coveredBy). */
export const IMPACT_DEFAULT_LIMIT = 25;

/** Default number of representative `file:line` reference hits returned. */
export const IMPACT_DEFAULT_REF_SAMPLES = 10;

/**
 * Hard work bound for the caller traversal — a safety net over `depth`, so a
 * pathological hub symbol can't walk the whole graph before the section cap is
 * applied. Hitting it sets `truncated` (coverage is partial, not just capped).
 */
const CALLER_TRAVERSAL_CAP = 2000;

/**
 * Representative hits kept by the reference scan before the join ranks them.
 * The COUNT and the per-file set are computed over every match regardless —
 * only the returned sample list is capped here (a memory guard, not a metric).
 */
const REFERENCE_SCAN_CAP = 500;

/** Imported-file paths listed in the fan-out (the `importedFiles` count stays exact). */
export const FANOUT_SAMPLE_CAP = 8;

// --------------------------------------------------------------------- types

/** Metadata for one symbol in the impact inventory (the call graph's inventory). */
export interface ImpactSymbolMeta {
  /** `${symbolName}\0${filePath}` — the call-graph key. */
  key: string;
  symbolName: string;
  symbolType: string;
  filePath: string;
  /** 1-based declaration line. */
  declarationLine: number;
  endLine: number;
  language?: string;
  /** Longest chunk body — used to derive the anchor/caller signature. */
  content?: string;
}

/** The changed symbol the report is anchored on. */
export interface ImpactAnchor {
  key: string;
  symbol: string;
  symbolType: string;
  file: string;
  relativeFile: string;
  startLine: number;
  endLine: number;
  language?: string;
  signature?: string;
}

/** One chunk body to scan for textual references (already in memory — no re-read). */
export interface ImpactChunk {
  filePath: string;
  startLine: number;
  content: string;
  /** The symbol the chunk belongs to, when it has one (shown on a reference hit). */
  symbolName?: string;
  symbolType?: string;
}

/** A consumer that CALLS the changed symbol (or, at depth ≥ 2, calls a caller). */
export interface ImpactCaller {
  key: string;
  symbol: string;
  symbolType: string;
  file: string;
  relativeFile: string;
  startLine: number;
  endLine: number;
  /** 1 = calls the anchor directly, 2 = calls a direct caller, … */
  depth: number;
  signature?: string;
}

/** A file that IMPORTS the changed symbol's module. */
export interface ImpactImporter {
  file: string;
  relativeFile: string;
  /** The importer's own body also mentions the symbol name (not just the module specifier). */
  alsoReferences: boolean;
}

/** One textual (whole-identifier) mention of the changed symbol. */
export interface ImpactReferenceHit {
  file: string;
  relativeFile: string;
  line: number;
  /** The trimmed source line containing the mention. */
  text: string;
  inSymbol?: string;
  inSymbolType?: string;
}

/** A test file that exercises the changed symbol ("covered by", not "consumed by"). */
export interface ImpactCover {
  file: string;
  relativeFile: string;
  /** How the test reaches the symbol: it calls it, imports its module, mentions it. */
  via: ("call" | "import" | "reference")[];
}

/** One capped section of the report. */
export interface ImpactSection<T> {
  items: T[];
  /** The true count before the section cap (production consumers only; tests live in `coveredBy`). */
  total: number;
  truncated: boolean;
}

/** How entangled the change site itself is. */
export interface ImpactFanOut {
  /** Distinct indexed files the anchor's own file imports. */
  importedFiles: number;
  /** Distinct symbols the anchor itself calls (in-index). */
  calledSymbols: number;
  /** The imported files (project-relative), capped at `FANOUT_SAMPLE_CAP`. */
  imports: string[];
}

/** The ranked "if I change X, what breaks?" report. */
export interface ChangeImpactReport {
  project: string;
  anchor: ImpactAnchor;
  /** The change site's own fan-out: how entangled the file/symbol is. */
  fanOut: ImpactFanOut;
  /** Severity 1 — consumers that call the symbol (directly, or transitively up to `depth`). */
  callers: ImpactSection<ImpactCaller>;
  /** Severity 2 — files that import the symbol's module. */
  importers: ImpactSection<ImpactImporter>;
  /** Distinct source lines mentioning the symbol (whole-identifier match, definition line excluded). */
  referenceCount: number;
  /** Severity 3 — a few representative mentions (never the whole list). */
  references: ImpactSection<ImpactReferenceHit>;
  /** Test files that exercise the symbol, split out of the production sections. */
  coveredBy: ImpactSection<ImpactCover>;
  /** Callable symbols inventoried for the call-graph leg. */
  scannedSymbols: number;
  /** Chunk bodies scanned for the reference leg. */
  scannedChunks: number;
  /** A section cap was hit — pass a higher `limit` for more. */
  truncated: boolean;
  /** The table hit its row cap — coverage is partial regardless of `limit`. */
  scanTruncated?: boolean;
}

/** Everything the join needs — the engine gathers it from the existing caches. */
export interface ImpactInput {
  project: string;
  projectRoot: string;
  anchor: ImpactAnchor;
  /** calleeKey → callerKeys (the cached call graph, reverse direction). */
  callersOf: Map<string, Set<string>>;
  /** callerKey → calleeKeys (the cached call graph, forward direction — anchor fan-out). */
  calleesOf: Map<string, Set<string>>;
  /** call-graph key → symbol metadata (caller rendering). */
  symbolsByKey: Map<string, ImpactSymbolMeta>;
  /** imported abs path → importing abs paths (the cached dependency graph, reverse). */
  importedBy: Map<string, string[]>;
  /** importer abs path → imported abs paths (the cached dependency graph, forward — file fan-out). */
  importsOf: Map<string, string[]>;
  /** Chunk bodies to scan for the reference leg (one indexed-content pass). */
  chunks: ImpactChunk[];
  /** Test-file classifier (the engine passes the centralized patterns). */
  isTestFile?: (filePath: string) => boolean;
  depth?: number;
  limit?: number;
  refSamples?: number;
  /** The indexed-content pass hit the table's row cap (surfaced, never silent). */
  scanTruncated?: boolean;
}

// ------------------------------------------------------------------- helpers

/** Project-relative path when the file is inside the root, else the absolute path. */
function relTo(root: string, file: string): string {
  const rel = path.relative(root, file);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? file : rel;
}

/** A caller entry from the inventory (pure). */
function toCaller(
  meta: ImpactSymbolMeta,
  projectRoot: string,
  depth: number,
): ImpactCaller {
  const c: ImpactCaller = {
    key: meta.key,
    symbol: meta.symbolName,
    symbolType: meta.symbolType,
    file: meta.filePath,
    relativeFile: relTo(projectRoot, meta.filePath),
    startLine: meta.declarationLine,
    endLine: meta.endLine,
    depth,
  };
  const sig = meta.content ? deriveSignature(meta.content) : undefined;
  if (sig) c.signature = sig;
  return c;
}

/** Stable, deterministic order for caller entries: depth, then path, then name. */
function compareCallers(a: ImpactCaller, b: ImpactCaller): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.relativeFile !== b.relativeFile) {
    return a.relativeFile < b.relativeFile ? -1 : 1;
  }
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
}

// ------------------------------------------------------- caller traversal

/**
 * Collects every caller of `rootKeys` within `maxDepth` as a FLAT list (the
 * impact report ranks consumers; it does not render a tree — `traverseCallGraph`
 * already does that for `get_call_graph`). Breadth-first, so a consumer reached
 * by several paths is reported once at its MINIMUM depth; the anchor itself is
 * never its own consumer (a recursive self-edge is dropped). Bounded by
 * `maxDepth` (by design) and `cap` (a safety net — hitting it sets `truncated`).
 */
export function flattenCallers(
  rootKeys: string[],
  callersOf: Map<string, Set<string>>,
  maxDepth: number,
  cap: number = CALLER_TRAVERSAL_CAP,
): { callers: { key: string; depth: number }[]; truncated: boolean } {
  const out: { key: string; depth: number }[] = [];
  if (maxDepth <= 0) return { callers: out, truncated: false };
  const visited = new Set(rootKeys);
  let truncated = false;
  let frontier = [...visited];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const caller of callersOf.get(key) ?? []) {
        if (visited.has(caller)) continue;
        visited.add(caller);
        if (out.length >= cap) {
          truncated = true;
          return { callers: out, truncated };
        }
        out.push({ key: caller, depth });
        next.push(caller);
      }
    }
    frontier = next;
  }
  return { callers: out, truncated };
}

// ------------------------------------------------------- reference scanning

/** One raw mention, before the join ranks/slices it. */
export interface RawReferenceHit {
  filePath: string;
  line: number;
  text: string;
  inSymbol?: string;
  inSymbolType?: string;
}

export interface ReferenceScan {
  /** Distinct source lines mentioning the name (the definition line excluded). */
  count: number;
  /** Distinct files mentioning the name (every match — not subject to the hit cap). */
  files: Set<string>;
  /** Representative hits, at most `cap` of them. */
  hits: RawReferenceHit[];
}

/**
 * One whole-identifier pass over the given chunk bodies for a SINGLE symbol's
 * match names (`matchNamesFor` → full name + bare segment). Same discipline as
 * `countReferences` / `find_references`: a match on the symbol's own declaration
 * line in its own file is the definition, everything else counts. Overlapping
 * chunks cannot double-count a line (dedup by file:line), so `count` is "how many
 * places touch this", not "how many regex matches exist". `count` and `files`
 * always cover every match; only `hits` is capped.
 */
export function collectReferenceHits(
  names: string[],
  anchorFile: string,
  declarationLine: number,
  chunks: ImpactChunk[],
  cap: number = REFERENCE_SCAN_CAP,
): ReferenceScan {
  const scan: ReferenceScan = { count: 0, files: new Set<string>(), hits: [] };
  const re = buildNameRegex(names);
  if (!re) return scan;
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (typeof chunk.content !== "string" || chunk.content.length === 0) continue;
    const lines = chunk.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      re.lastIndex = 0;
      let matched = false;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        matched = true;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (!matched) continue;
      const absLine = chunk.startLine + i;
      if (chunk.filePath === anchorFile && absLine === declarationLine) continue;
      const key = `${chunk.filePath} ${absLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scan.count++;
      scan.files.add(chunk.filePath);
      if (scan.hits.length < cap) {
        const hit: RawReferenceHit = { filePath: chunk.filePath, line: absLine, text: line.trim() };
        if (chunk.symbolName) hit.inSymbol = chunk.symbolName;
        if (chunk.symbolType) hit.inSymbolType = chunk.symbolType;
        scan.hits.push(hit);
      }
    }
  }
  return scan;
}

// ------------------------------------------------------------------ the join

/**
 * Reduces the engine's resolved candidate symbols to THE anchor a ranked report
 * needs. Candidates are deduped by key (the inventory can hold several chunks per
 * symbol); several DISTINCT symbols are an error that names them — unlike the call
 * graph, which renders a tree per root, an impact report is about one change site.
 */
export function selectAnchor(
  candidates: ImpactSymbolMeta[],
  projectRoot: string,
  query: string,
): ImpactAnchor {
  const byKey = new Map<string, ImpactSymbolMeta>();
  for (const c of candidates) if (!byKey.has(c.key)) byKey.set(c.key, c);
  const unique = [...byKey.values()];
  if (unique.length === 0) {
    throw new Error(`No callable symbol '${query}' found.`);
  }
  if (unique.length > 1) {
    const names = [...new Set(unique.map((s) => s.symbolName))].slice(0, 8).join(", ");
    const more = unique.length > 8 ? `, … (${unique.length} total)` : "";
    throw new Error(
      `'${query}' matches ${unique.length} callable symbols (${names}${more}); ` +
        `a change-impact report needs one anchor — name the symbol, or pass a path to disambiguate.`,
    );
  }
  const m = unique[0]!;
  const anchor: ImpactAnchor = {
    key: m.key,
    symbol: m.symbolName,
    symbolType: m.symbolType,
    file: m.filePath,
    relativeFile: relTo(projectRoot, m.filePath),
    startLine: m.declarationLine,
    endLine: m.endLine,
  };
  if (m.language) anchor.language = m.language;
  const sig = m.content ? deriveSignature(m.content) : undefined;
  if (sig) anchor.signature = sig;
  return anchor;
}

/**
 * Joins the three adjacency sources into one ranked report. Pure: every input is
 * already in memory, so this is the only "new work" `get_change_impact` does.
 */
export function buildImpactReport(input: ImpactInput): ChangeImpactReport {
  const depth = input.depth ?? IMPACT_DEFAULT_DEPTH;
  const limit = input.limit ?? IMPACT_DEFAULT_LIMIT;
  const refSamples = input.refSamples ?? IMPACT_DEFAULT_REF_SAMPLES;
  const isTest = input.isTestFile ?? ((): boolean => false);
  const root = input.projectRoot;
  const anchor = input.anchor;

  // Textual references first: both other sections need the per-file view.
  const scan = collectReferenceHits(
    matchNamesFor(anchor.symbol),
    anchor.file,
    anchor.startLine,
    input.chunks,
  );

  // Test files are pulled out of every production section into `coveredBy`.
  const covered = new Map<string, ImpactCover>();
  const addCover = (file: string, via: ImpactCover["via"][number]): void => {
    const existing = covered.get(file);
    if (existing) {
      if (!existing.via.includes(via)) existing.via.push(via);
      return;
    }
    covered.set(file, { file, relativeFile: relTo(root, file), via: [via] });
  };

  // 1) Direct callers (severity 1): the cached call graph, reverse, depth-bounded.
  const traversal = flattenCallers([anchor.key], input.callersOf, depth);
  const callers: ImpactCaller[] = [];
  for (const c of traversal.callers) {
    const meta = input.symbolsByKey.get(c.key);
    if (!meta) continue; // adjacency without metadata should not happen; skip, don't lie
    if (isTest(meta.filePath)) {
      addCover(meta.filePath, "call");
      continue;
    }
    callers.push(toCaller(meta, root, c.depth));
  }
  callers.sort(compareCallers);
  const callerTotal = callers.length;

  // 2) Importers (severity 2): the cached dependency graph, reverse.
  const importers: ImpactImporter[] = [];
  for (const file of input.importedBy.get(anchor.file) ?? []) {
    if (isTest(file)) {
      addCover(file, "import");
      continue;
    }
    importers.push({ file, relativeFile: relTo(root, file), alsoReferences: scan.files.has(file) });
  }
  // A file that also mentions the symbol is the stronger of the two import signals.
  importers.sort((a, b) => {
    if (a.alsoReferences !== b.alsoReferences) return a.alsoReferences ? -1 : 1;
    return a.relativeFile < b.relativeFile ? -1 : a.relativeFile > b.relativeFile ? 1 : 0;
  });
  const importerTotal = importers.length;

  // 3) Textual references (severity 3): representative mentions, tests excluded.
  const refHits: ImpactReferenceHit[] = [];
  for (const h of scan.hits) {
    if (isTest(h.filePath)) {
      addCover(h.filePath, "reference");
      continue;
    }
    const hit: ImpactReferenceHit = {
      file: h.filePath,
      relativeFile: relTo(root, h.filePath),
      line: h.line,
      text: h.text,
    };
    if (h.inSymbol) hit.inSymbol = h.inSymbol;
    if (h.inSymbolType) hit.inSymbolType = h.inSymbolType;
    refHits.push(hit);
  }
  refHits.sort((a, b) =>
    a.relativeFile === b.relativeFile ? a.line - b.line : a.relativeFile < b.relativeFile ? -1 : 1,
  );
  const refTotal = refHits.length;

  // Cross-cut: the test files that exercise the symbol.
  const coveredList = [...covered.values()].sort((a, b) =>
    a.relativeFile < b.relativeFile ? -1 : a.relativeFile > b.relativeFile ? 1 : 0,
  );
  const coveredTotal = coveredList.length;

  // Cross-cut: the change site's own fan-out.
  const importedFiles = input.importsOf.get(anchor.file) ?? [];
  const fanOut: ImpactFanOut = {
    importedFiles: importedFiles.length,
    calledSymbols: input.calleesOf.get(anchor.key)?.size ?? 0,
    imports: importedFiles.slice(0, FANOUT_SAMPLE_CAP).map((f) => relTo(root, f)),
  };

  const callersSection: ImpactSection<ImpactCaller> = {
    items: callers.slice(0, limit),
    total: callerTotal,
    truncated: traversal.truncated || callerTotal > limit,
  };
  const importersSection: ImpactSection<ImpactImporter> = {
    items: importers.slice(0, limit),
    total: importerTotal,
    truncated: importerTotal > limit,
  };
  const referencesSection: ImpactSection<ImpactReferenceHit> = {
    items: refHits.slice(0, refSamples),
    total: refTotal,
    truncated: refTotal > refSamples,
  };
  const coveredSection: ImpactSection<ImpactCover> = {
    items: coveredList.slice(0, limit),
    total: coveredTotal,
    truncated: coveredTotal > limit,
  };

  const report: ChangeImpactReport = {
    project: input.project,
    anchor,
    fanOut,
    callers: callersSection,
    importers: importersSection,
    referenceCount: scan.count,
    references: referencesSection,
    coveredBy: coveredSection,
    scannedSymbols: input.symbolsByKey.size,
    scannedChunks: input.chunks.length,
    truncated:
      callersSection.truncated ||
      importersSection.truncated ||
      referencesSection.truncated ||
      coveredSection.truncated,
  };
  if (input.scanTruncated) report.scanTruncated = true;
  return report;
}
