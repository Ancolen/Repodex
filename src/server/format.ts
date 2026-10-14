import type {
  ScopedSearchResult,
  SymbolReference,
  ReferenceResult,
  RepoOverview,
  BatchSearchGroup,
  SearchEnvelope,
  DependencyResult,
  DeadCodeReport,
  CallGraphResult,
  CallGraphNode,
  CommitSearchResult,
  CommitHit,
  ContextPack,
  ApiDiffResult,
  ApiDiffSide,
  ApiChangeKind,
  ChangeImpactReport,
  QueryLogStats,
  CouplingReport,
  CouplingBand,
  FileCoupling,
  HotspotReport,
  HotspotFile,
  HotspotBand,
} from "../core/index-manager";
import type { DocCheckReport, DocFinding, UndocumentedEntry } from "../core/doccheck";
import type { OutlineEntry } from "../chunking/chunker";
import { formatBytes } from "../core/doctor";
import type { CompactResult, TableIndexStat } from "../services/db";
import type { StatsReport, ProjectStats } from "../core/stats";

/** Formats an epoch-ms timestamp as a compact ISO string (or "—"). */
function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "—";
  }
}

/** One hit's blame line ("last: <author> <date> (<n> commits)"), or "" when unstamped. */
function blameLine(r: ScopedSearchResult): string {
  if (r.lastAuthor === undefined && r.lastCommitDate === undefined && r.churnCommits === undefined) {
    return "";
  }
  const author = r.lastAuthor ?? "unknown";
  const date = r.lastCommitDate ?? "—";
  const n = r.churnCommits ?? 0;
  // A trailing "+" flags the churn cap (more distinct commits than reported).
  const churn = n > 0 ? `${n} commit${n === 1 ? "" : "s"}${r.churnTruncated ? "+" : ""}` : "no commit";
  return `\n  last: ${author} ${date} (${churn})`;
}

/**
 * The envelope-level blame notes (proposal C4) → one rendered note line, or
 * null when there is nothing to say. Blame FIELDS ride on the hits; this covers
 * the whole-search cases: every hit outside a git repo, and the honest
 * per-search file-cap count.
 */
export function formatBlameNote(
  notes: Pick<SearchEnvelope, "blameNotARepo" | "blameSkipped"> | undefined,
): string | null {
  if (!notes) return null;
  const parts: string[] = [];
  if (notes.blameNotARepo === true) {
    parts.push("no blame: the hit files are not in a git working tree");
  }
  if (notes.blameSkipped !== undefined && notes.blameSkipped > 0) {
    parts.push(`${notes.blameSkipped} more file(s) skipped by the per-search blame cap (≤8)`);
  }
  if (parts.length === 0) return null;
  return `⚠ blame: ${parts.join(" · ")}`;
}

/**
 * The envelope-level expansion notes (proposal S4) → one rendered fragment, or
 * null when expansion was not requested. `expanded > 0` tells the reader the
 * ranking is a merge (and that the original query dominates it);
 * `expandNote` explains why a requested expansion did not run.
 */
export function formatExpandNote(
  notes: Pick<SearchEnvelope, "expanded" | "expandNote"> | undefined,
): string | null {
  if (!notes) return null;
  const parts: string[] = [];
  if (typeof notes.expanded === "number" && notes.expanded > 0) {
    parts.push(
      `${notes.expanded} expansion variant ranking(s) merged into this result (the original query keeps rank dominance)`,
    );
  }
  if (notes.expandNote !== undefined && notes.expandNote.length > 0) {
    parts.push(notes.expandNote);
  }
  if (parts.length === 0) return null;
  return `⚠ expand: ${parts.join(" · ")}`;
}

/**
 * All envelope-level notes (C4 blame + S4 expansion) in one rendered line, or
 * null when there is nothing to say. The blame-only and expansion-only cases
 * render exactly like their own formatters.
 */
export function formatEnvelopeNotes(
  notes: Pick<SearchEnvelope, "blameNotARepo" | "blameSkipped" | "expanded" | "expandNote"> | undefined,
): string | null {
  const blame = formatBlameNote(notes);
  const expand = formatExpandNote(notes);
  if (blame === null) return expand;
  if (expand === null) return blame;
  // Both: strip the expand fragment's own ⚠ prefix; they share the line.
  return `${blame} · ${expand.replace(/^⚠\s*/, "")}`;
}

/**
 * Converts search/symbol results to agent-friendly text (shared by mcp + stdio
 * bridge). `envelopeNotes` renders the envelope-level notes (blame C4, and the
 * expansion count/degrade note of S4; `find_symbol` passes none — it has no
 * envelope).
 */
export function formatResults(
  results: ScopedSearchResult[],
  envelopeNotes?: Pick<SearchEnvelope, "blameNotARepo" | "blameSkipped" | "expanded" | "expandNote">,
): string {
  if (results.length === 0) return "No relevant code chunk found.";
  const body = results
    .map((r, i) => {
      const loc =
        r.startLine !== undefined && r.endLine !== undefined
          ? `${r.filePath}:${r.startLine}-${r.endLine}`
          : r.filePath;
      const sym = r.symbolName ? ` (${r.symbolType ?? "symbol"} ${r.symbolName})` : "";
      const relevance =
        r._score !== undefined
          ? `Relevance (high=good): ${r._score.toFixed(4)}`
          : r._distance !== undefined
            ? `Score (low=close): ${r._distance.toFixed(4)}`
            : "";
      const meta = [
        relevance,
        r._docHit ? "doc hit" : "",
        r.fuzzy ? "⚠ fuzzy" : "",
        r.indexedAt ? `indexed: ${fmtTime(r.indexedAt)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const sig = r.signature && r.signature !== r.content.trim() ? `\nSignature: ${r.signature}` : "";
      const before = r.contextBefore?.length
        ? `--- ${r.contextBefore.length} lines before ---\n${r.contextBefore.join("\n")}\n`
        : "";
      const after = r.contextAfter?.length
        ? `\n--- ${r.contextAfter.length} lines after ---\n${r.contextAfter.join("\n")}`
        : "";
      return `Result ${i + 1}: [${r.project}] ${loc}${sym}${sig}\n${meta}${blameLine(r)}\n${before}\`\`\`\n${r.content}\n\`\`\`${after}`;
    })
    .join("\n---\n\n");
  const note = formatEnvelopeNotes(envelopeNotes);
  return note ? `${body}\n—\n${note}` : body;
}

/** Converts batch (multi-query) search results to text, one section per query. */
export function formatBatchResults(groups: BatchSearchGroup[]): string {
  if (groups.length === 0) return "No relevant code chunk found for any query.";
  return groups
    .map((g) => {
      const n = g.results.length;
      const header = `## Query: "${g.query}" (${n} result${n === 1 ? "" : "s"})`;
      const body = n > 0 ? formatResults(g.results) : "No relevant code chunk found.";
      const note = formatEnvelopeNotes(g);
      return note ? `${header}\n\n${body}\n—\n${note}` : `${header}\n\n${body}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Converts a context pack to text: one block per hit — the hit itself plus its
 * file outline and its forward imports (the legs an agent would otherwise fetch
 * with separate calls). Mirrors `formatResults` for the hit body, with the legs
 * in front of it so the shape reads as "where am I, what's around it".
 */
export function formatContextPack(pack: ContextPack): string {
  const lines: string[] = [];
  const scope = pack.project ? `project: ${pack.project}` : "all projects";
  const budget =
    pack.omitted > 0
      ? ` · ~${pack.totalChars} chars · ${pack.omitted} omitted (budget ${pack.maxChars})`
      : ` · ~${pack.totalChars} chars${pack.maxChars !== null ? ` of ${pack.maxChars}` : ""}`;
  lines.push(`Context pack — "${pack.query}" · ${scope} · ${pack.hits.length} hit(s)${budget}`);
  if (pack.hits.length === 0) {
    lines.push("\nNo relevant code chunk found.");
    return lines.join("\n");
  }
  pack.hits.forEach((h, i) => {
    const r = h.hit;
    const loc =
      r.startLine !== undefined && r.endLine !== undefined
        ? `${r.filePath}:${r.startLine}-${r.endLine}`
        : r.filePath;
    const sym = r.symbolName ? ` (${r.symbolType ?? "symbol"} ${r.symbolName})` : "";
    const relevance =
      r._score !== undefined
        ? `Relevance (high=good): ${r._score.toFixed(4)}`
        : r._distance !== undefined
          ? `Score (low=close): ${r._distance.toFixed(4)}`
          : "";
    const meta = [relevance, r._docHit ? "doc hit" : "", r.indexedAt ? `indexed: ${fmtTime(r.indexedAt)}` : ""]
      .filter(Boolean)
      .join(" · ");
    lines.push(`\nHit ${i + 1}: [${r.project}] ${loc}${sym}`);
    if (meta) lines.push(meta);
    if (r.signature && r.signature !== r.content.trim()) lines.push(`Signature: ${r.signature}`);
    if (h.outline && h.outline.length > 0) {
      lines.push(`Outline (${h.outline.length}):`);
      for (const o of h.outline) {
        lines.push(`  L${o.startLine}-${o.endLine}  ${o.symbolType} ${o.symbolName}`);
      }
    }
    if (h.imports && h.imports.length > 0) {
      lines.push(`Imports (${h.imports.length}${h.importsTruncated ? "+, capped" : ""}):`);
      for (const e of h.imports) {
        lines.push(`  → ${e.relativePath ?? e.path ?? e.raw}  (from "${e.raw}")`);
      }
    }
    const before = r.contextBefore?.length
      ? `--- ${r.contextBefore.length} lines before ---\n${r.contextBefore.join("\n")}\n`
      : "";
    const after = r.contextAfter?.length
      ? `\n--- ${r.contextAfter.length} lines after ---\n${r.contextAfter.join("\n")}`
      : "";
    lines.push(`${before}\`\`\`\n${r.content}\n\`\`\`${after}`);
  });
  if (pack.omitted > 0) {
    lines.push(`\n⚠ ${pack.omitted} further hit(s) omitted by the pack budget — raise --max-chars / lower --limit for more.`);
  }
  return lines.join("\n");
}

/** Converts a file's symbol map to text. */
export function formatOutline(outline: OutlineEntry[]): string {
  if (outline.length === 0) return "No symbols found in this file.";
  return outline.map((o) => `L${o.startLine}-${o.endLine}  ${o.symbolType} ${o.symbolName}`).join("\n");
}

/** Converts a reference-scan result (usages) to text grouped by file, honest about its cap. */
export function formatReferences(result: ReferenceResult): string {
  const refs = result.refs;
  if (refs.length === 0) return "No references found.";
  const byFile = new Map<string, SymbolReference[]>();
  for (const r of refs) {
    const key = `${r.project}\u0000${r.filePath}`;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(r);
  }
  const blocks: string[] = [];
  for (const [, group] of byFile) {
    const first = group[0]!;
    const head = `[${first.project}] ${first.filePath}`;
    const lines = group
      .map((r) => {
        const ctx = r.inSymbol ? `  (in ${r.inSymbolType ?? "symbol"} ${r.inSymbol})` : "";
        return `  L${r.line}: ${r.text}${ctx}`;
      })
      .join("\n");
    blocks.push(`${head}\n${lines}`);
  }
  const heading = result.truncated
    ? `${refs.length} of ${result.total} reference(s) (limit reached — pass a higher --limit for more):\n\n`
    : `${refs.length} reference(s):\n\n`;
  return heading + blocks.join("\n\n");
}

/** Converts a repository overview to an agent-friendly onboarding summary. */
export function formatOverview(o: RepoOverview): string {
  const lines: string[] = [];
  lines.push(`Repo: ${o.name}  [${o.status}]`);
  lines.push(`Path: ${o.path}`);
  lines.push(
    `${o.files} files · ${o.chunks} chunks · ${o.symbols} symbols · model: ${o.embedModel ?? "—"} · indexed: ${fmtTime(o.lastIndexedAt)}`,
  );

  if (o.languages.length > 0) {
    lines.push("\nLanguages:");
    for (const l of o.languages.slice(0, 12)) {
      lines.push(`  ${l.language.padEnd(14)} ${l.files} files, ${l.symbols} symbols`);
    }
  }
  if (o.symbolTypes.length > 0) {
    lines.push("\nSymbol types:");
    lines.push("  " + o.symbolTypes.map((s) => `${s.type}: ${s.count}`).join(", "));
  }
  if (o.topDirectories.length > 0) {
    lines.push("\nTop-level directories:");
    for (const d of o.topDirectories) lines.push(`  ${d.dir.padEnd(20)} ${d.files} files`);
  }
  if (o.entryPoints.length > 0) {
    lines.push("\nLikely entry points:");
    for (const e of o.entryPoints) lines.push(`  ${e}`);
  }
  if (o.largestFiles.length > 0) {
    lines.push("\nFiles with the most symbols:");
    for (const f of o.largestFiles) lines.push(`  ${f.symbols.toString().padStart(4)}  ${f.file}`);
  }
  return lines.join("\n");
}

/** Converts a dependency-graph result to text (imports + reverse deps). */
export function formatDependencies(r: DependencyResult): string {
  const resolved = r.imports.filter((e) => e.status === "resolved");
  const external = r.imports.filter((e) => e.status === "external");
  const unresolved = r.imports.filter((e) => e.status === "unresolved");
  const lines: string[] = [];
  lines.push(`Dependencies for '${r.relativeFile || r.file}' (project: ${r.project})`);
  lines.push(
    `\nImports (${resolved.length} resolved, ${external.length} external` +
      `${unresolved.length > 0 ? `, ${unresolved.length} unresolved` : ""}):`,
  );
  if (r.imports.length === 0) {
    lines.push("  (none — this file imports nothing)");
  } else {
    for (const e of resolved) lines.push(`  → ${e.relativePath ?? e.path ?? e.raw}  (from "${e.raw}")`);
    for (const e of external) lines.push(`  ⊘ ${e.raw}  (external${e.reason ? `: ${e.reason}` : ""})`);
    for (const e of unresolved) lines.push(`  ? ${e.raw}  (unresolved${e.reason ? `: ${e.reason}` : ""})`);
  }
  lines.push(`\nImported by (${r.importedBy.length}):`);
  if (r.importedBy.length === 0) {
    lines.push("  (none — no indexed file imports this one)");
  } else {
    for (const f of r.importedBy) lines.push(`  ${f}`);
  }
  lines.push(`\n(reverse graph built from ${r.scannedFiles} indexed file(s))`);
  if (r.truncated) {
    lines.push("⚠ reverse scan hit the file cap — pass a higher --limit for more.");
  }
  return lines.join("\n");
}

/** Converts a dead-code report to text, sectioned by confidence category. */
export function formatDeadCode(report: DeadCodeReport): string {
  const cats = ["likely dead", "uncertain", "review"] as const;
  const lines: string[] = [];
  lines.push(
    `Potential dead code in '${report.project}' — ${report.results.length} candidate(s) ` +
      `(scanned ${report.scannedSymbols} symbols / ${report.scannedChunks} chunks)`,
  );
  if (report.truncated) {
    lines.push("⚠ the table exceeded the row cap — coverage is partial; reindex/raise the cap for full coverage.");
  }
  if (report.results.length === 0) {
    lines.push("\nNo dead-code candidates above the threshold.");
    return lines.join("\n");
  }
  for (const cat of cats) {
    const group = report.results.filter((r) => r.category === cat);
    if (group.length === 0) continue;
    lines.push(`\n### ${cat} (${group.length})`);
    for (const r of group) {
      const signals = r.signals
        .map((s) => s.signal + (s.detail ? ` (${s.detail})` : ""))
        .join(", ");
      lines.push(`[${r.confidence.toString().padStart(3)}] ${r.symbolType}  ${r.symbolName}`);
      lines.push(`  ${r.relativePath}:${r.startLine}-${r.endLine}${r.language ? `  [${r.language}]` : ""}`);
      if (signals) lines.push(`  signals: ${signals}`);
      if (r.signature) lines.push(`  signature: ${r.signature}`);
    }
  }
  return lines.join("\n");
}

/** One-line description of a call-graph node (symbol + type + location + signature). */
function callNodeLine(n: CallGraphNode): string {
  const type = n.symbolType ? ` [${n.symbolType}]` : "";
  const loc = n.startLine
    ? `  ${n.relativeFile || n.file}:${n.startLine}${n.endLine ? `-${n.endLine}` : ""}`
    : "";
  const sig = n.signature ? ` — ${n.signature}` : "";
  return `${n.symbol}${type}${loc}${sig}`;
}

/** Renders an indented call tree (one line per node, 2 spaces per depth level). */
function renderCallTree(roots: CallGraphNode[], lines: string[]): void {
  const walk = (node: CallGraphNode, indent: number): void => {
    const pad = "  ".repeat(indent);
    const cyc = node.cyclic ? "  ↻ cycle" : "";
    lines.push(`${pad}${callNodeLine(node)}${cyc}`);
    for (const c of node.children) walk(c, indent + 1);
  };
  for (const root of roots) walk(root, 0);
}

/** Converts a call-graph result to text: caller/callee trees rooted at the anchor. */
export function formatCallGraph(r: CallGraphResult): string {
  const lines: string[] = [];
  const anchor =
    r.roots.length === 1
      ? callNodeLine(r.roots[0]!)
      : `${r.roots.length} symbol(s)${r.roots[0]?.file ? ` in ${r.roots[0]!.relativeFile || r.roots[0]!.file}` : ""}`;
  lines.push(`Call graph — project: ${r.project} · direction: ${r.direction} · depth: ${r.depth}`);
  lines.push(`Anchor: ${anchor}`);

  if (r.callers.length > 0) {
    lines.push("\n▲ Callers (who calls the anchor)");
    renderCallTree(r.callers, lines);
  }
  if (r.callees.length > 0) {
    lines.push("\n▼ Callees (what the anchor calls)");
    renderCallTree(r.callees, lines);
  }
  if (r.callers.length === 0 && r.callees.length === 0) {
    lines.push("\n(no in-index call edges found)");
  }
  lines.push(`\n(scanned ${r.scannedSymbols} callable symbol(s))`);
  if (r.truncated) {
    lines.push("⚠ node cap or table cap hit — the graph is partial; pass a higher --limit for more.");
  }
  return lines.join("\n");
}

/** One-line description of a commit (abbreviated hash · date · author · subject). */
function commitLine(c: CommitHit): string {
  const who = c.authorName ? `  ${c.authorName} <${c.authorEmail}>` : "";
  return `${c.abbreviatedHash || c.hash.slice(0, 7)}  ${c.date}${who}\n    ${c.subject}`;
}

/** Converts a commit-search result to text: one block per matching commit. */
export function formatCommits(r: CommitSearchResult): string {
  const lines: string[] = [];
  const scope = r.query ? ` · query: "${r.query}"` : "";
  lines.push(`Commit search — project: ${r.project}${scope} · ${r.count} match(es)`);
  if (r.notARepo) {
    lines.push("\n(The project directory is not a git repository — no history to search.)");
    return lines.join("\n");
  }
  if (r.commits.length === 0) {
    lines.push("\n(no commits matched; broaden the query / filters, or check --since/--until)");
    return lines.join("\n");
  }
  lines.push("");
  for (const c of r.commits) {
    lines.push(commitLine(c));
    if (c.body) lines.push(`    ${c.body.replace(/\n/g, "\n    ")}`);
    if (c.files && c.files.length > 0) {
      const shown = c.files.length;
      lines.push(`    (${shown} file${shown === 1 ? "" : "s"} changed:)`);
      for (const f of c.files) lines.push(`      ${f}`);
    }
  }
  if (r.truncated) {
    lines.push("\n⚠ commit limit hit — older matches exist; pass a higher --limit for more.");
  }
  return lines.join("\n");
}

// ------------------------------------------------------ API diff (proposal C2)

/** One-line location + signature of a diff side. */
function apiDiffSideLine(side: ApiDiffSide | undefined, label: string): string | null {
  if (!side) return null;
  const loc = side.startLine ? `  (L${side.startLine}-${side.endLine})` : "";
  const vis = side.exported ? "" : "  [not exported]";
  const sig = side.signature ? `  ${side.signature}` : "";
  return `${label}${loc}${vis}${sig}`;
}

const API_DIFF_SECTIONS: { kind: ApiChangeKind; title: string; breaking: boolean }[] = [
  { kind: "removed", title: "removed", breaking: true },
  { kind: "signature-changed", title: "signature-changed", breaking: true },
  { kind: "visibility-narrowed", title: "visibility-narrowed", breaking: true },
  { kind: "added", title: "added", breaking: false },
  { kind: "unchanged", title: "unchanged", breaking: false },
];

/** Converts an API-diff result to text, sectioned breaking-kinds-first. */
export function formatApiDiff(r: ApiDiffResult): string {
  const lines: string[] = [];
  lines.push(`API diff — project: ${r.project} · ${r.base} → ${r.head}${r.headIsIndex ? " (index)" : ""}`);
  if (r.notARepo) {
    lines.push("\n(The project directory is not a git repository — there is no ref to diff against.)");
    return lines.join("\n");
  }
  if (r.unknownRef) {
    lines.push(`\nUnknown ref: '${r.unknownRef === "base" ? r.base : r.head}' does not resolve in this repo.`);
    return lines.join("\n");
  }
  if (r.invalidRef) {
    lines.push(
      `\nInvalid ref: '${r.invalidRef === "base" ? r.base : r.head}' is not a ref/revision git can be given.`,
    );
    return lines.join("\n");
  }
  const c = r.counts;
  lines.push(
    `${c.breaking} breaking · removed ${c.removed} · signature-changed ${c.signatureChanged} · ` +
      `visibility-narrowed ${c.visibilityNarrowed} · added ${c.added} · unchanged ${c.unchanged}` +
      `  (scanned ${r.scannedFiles} file(s))`,
  );
  if (r.truncated) {
    lines.push("⚠ a cap was hit — the diff is partial; raise --max-files / --limit for full coverage.");
  }
  if (r.unparsedFiles.length > 0) {
    lines.push(`\nUnparsed at a ref (${r.unparsedFiles.length}) — these files contribute NO symbols:`);
    for (const u of r.unparsedFiles.slice(0, 20)) {
      lines.push(`  ${u.path}  [${u.reason}, ${u.side}]`);
    }
    if (r.unparsedFiles.length > 20) lines.push(`  … and ${r.unparsedFiles.length - 20} more`);
  }
  if (r.entries.length === 0) {
    lines.push("\nNo public-API difference (unchanged symbols are counted above).");
    return lines.join("\n");
  }
  for (const sec of API_DIFF_SECTIONS) {
    const group = r.entries.filter((e) => e.kind === sec.kind);
    if (group.length === 0) continue;
    lines.push(`\n### ${sec.title} (${group.length})${sec.breaking ? " — BREAKING" : ""}`);
    for (const e of group) {
      const vis = e.base?.exported || e.head?.exported ? "" : "  [not exported]";
      lines.push(`  ${e.symbolType}  ${e.symbolName}${vis}  [${e.language}]`);
      lines.push(`    ${e.relativePath}`);
      const was = apiDiffSideLine(e.base, "was:  ");
      const now = apiDiffSideLine(e.head, "now:  ");
      if (was) lines.push(`    ${was}`);
      if (now) lines.push(`    ${now}`);
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------- change impact (C1)

/** One line for a caller entry: symbol + type + location + depth + signature. */
function impactCallerLine(c: ChangeImpactReport["callers"]["items"][number]): string {
  const type = c.symbolType ? ` [${c.symbolType}]` : "";
  const loc = `  ${c.relativeFile || c.file}:${c.startLine}${c.endLine ? `-${c.endLine}` : ""}`;
  const depth = c.depth > 1 ? `  (depth ${c.depth})` : "";
  const sig = c.signature ? ` — ${c.signature}` : "";
  return `${c.symbol}${type}${loc}${depth}${sig}`;
}

/**
 * Converts a change-impact report to text, sections in severity order:
 * direct callers → importers → textual references, with the test files
 * ("covered by") and the change site's own fan-out called out alongside.
 */
export function formatImpact(r: ChangeImpactReport): string {
  const lines: string[] = [];
  const a = r.anchor;
  lines.push(`Change impact — project: ${r.project}`);
  lines.push(
    `Anchor: ${a.symbol}${a.symbolType ? ` [${a.symbolType}]` : ""}  ${a.relativeFile || a.file}:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}${a.signature ? ` — ${a.signature}` : ""}`,
  );
  lines.push(
    `Change site: ${r.fanOut.importedFiles} imported file(s), ${r.fanOut.calledSymbols} called symbol(s)` +
      (r.fanOut.imports.length > 0 ? ` — ${r.fanOut.imports.join(", ")}` : ""),
  );

  lines.push(
    `\n▲ Direct callers (${r.callers.total}) — a caller breaks when the signature or behavior changes`,
  );
  if (r.callers.items.length === 0) {
    lines.push("  (no indexed caller within the requested depth)");
  } else {
    for (const c of r.callers.items) lines.push(`  ${impactCallerLine(c)}`);
  }

  lines.push(`\n→ Importers (${r.importers.total}) — the module's exports matter to these files`);
  if (r.importers.items.length === 0) {
    lines.push("  (no indexed file imports this file)");
  } else {
    for (const i of r.importers.items) {
      lines.push(`  ${i.relativeFile || i.file}${i.alsoReferences ? "  (also mentions the symbol)" : ""}`);
    }
  }

  lines.push(
    `\n≈ Textual references — ${r.referenceCount} line(s) mention "${a.symbol}"` +
      (r.references.total > 0 ? ` (${r.references.total} outside test files):` : ""),
  );
  if (r.references.items.length === 0) {
    lines.push("  (no textual reference outside test files)");
  } else {
    for (const ref of r.references.items) {
      const sym = ref.inSymbol ? `  (in ${ref.inSymbolType ?? "symbol"} ${ref.inSymbol})` : "";
      lines.push(`  ${ref.relativeFile || ref.file}:${ref.line}: ${ref.text}${sym}`);
    }
  }

  lines.push(
    `\n✓ Covered by tests (${r.coveredBy.total}) — exercised, not consumed` +
      (r.coveredBy.items.length > 0 ? ":" : ""),
  );
  if (r.coveredBy.items.length === 0) {
    lines.push("  (no test file calls, imports or mentions this symbol)");
  } else {
    for (const c of r.coveredBy.items) {
      lines.push(`  ${c.relativeFile || c.file}  (via ${c.via.join(", ")})`);
    }
  }

  lines.push(`\n(scanned ${r.scannedSymbols} callable symbol(s) / ${r.scannedChunks} chunk(s))`);
  if (r.truncated) {
    lines.push("⚠ a section cap was hit — pass a higher --limit for more.");
  }
  if (r.scanTruncated) {
    lines.push("⚠ the table exceeded its row cap — coverage is partial; reindex for full coverage.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- doc check (D1)

/** One rendered finding line: id, confidence, kind, location, message (+ suggestion/evidence). */
function docCheckFindingLine(f: DocFinding): string {
  let s = `  ${f.id} [${f.confidence}] ${f.kind} — ${f.doc.path}:${f.doc.line}`;
  s += `\n      ${f.doc.excerpt}`;
  s += `\n      ${f.message}`;
  if (f.suggestion) s += `\n      → suggestion: ${f.suggestion}`;
  if (f.evidence && f.evidence.length > 0) {
    const ev = f.evidence
      .slice(0, 3)
      .map((e) => `${e.path}${e.line !== undefined ? `:${e.line}` : ""}${e.symbol ? ` (${e.symbol})` : ""}`)
      .join(", ");
    s += `\n      evidence: ${ev}`;
  }
  return s;
}

/**
 * Converts a doc–code conformance report to text, sections in severity order:
 * drift findings → needs review → undocumented. Deterministic input →
 * deterministic output (same report, same bytes). The semantic judge (D1b) is
 * surfaced only when the report carries `checked.judge` — absent on the pure
 * deterministic path, so those renders stay byte-identical.
 */
export function formatDocCheck(r: DocCheckReport): string {
  const lines: string[] = [];
  const c = r.checked;
  const freshness = c.indexFreshness === null ? "never" : new Date(c.indexFreshness).toISOString();
  lines.push(`Doc–code conformance — project: ${r.project}`);
  lines.push(`Docs: ${c.docs} checked / ${c.spans} span(s), ${c.claims} resolved against the index (index: ${freshness})`);
  if (c.window) {
    lines.push(
      `Window: since ${c.window.since} — ${c.window.docsChanged} doc file(s), ${c.window.codeChanged} code file(s) changed`,
    );
  }
  if (c.judge) {
    const j = c.judge;
    lines.push(
      j.available
        ? `Judge: ${j.model} — ${j.judged} claim(s) judged, ${j.resolved} resolved as consistent (dropped from needs review)${j.failed > 0 ? `, ${j.failed} failed` : ""}`
        : `Judge: ${j.model || "(unset)"} — NOT available this run, nothing judged`,
    );
  }
  const skipped = Object.entries(c.skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ");
  if (skipped) lines.push(`Skipped (never findings): ${skipped}`);
  if (r.requestedDocs) {
    const matched = r.requestedDocs.filter((x) => x.status === "matched").length;
    const unmatched = r.requestedDocs.filter((x) => x.status !== "matched");
    if (unmatched.length > 0) {
      lines.push(
        `\n⚠ requested docs — ${matched} of ${r.requestedDocs.length} made it into the check; NOT included:`,
      );
      for (const x of unmatched) lines.push(`  ${x.ref} [${x.status}]`);
    }
  }

  lines.push(`\n✗ drift (${r.verdict.findings}) — the doc contradicts the code`);
  if (r.findings.length === 0) {
    lines.push("  (none — docs and code agree on every resolvable claim)");
  } else {
    for (const f of r.findings) lines.push(docCheckFindingLine(f));
  }

  lines.push(`\n? needs review (${r.verdict.needsReview}) — the checker is unsure, NOT a failure`);
  if (r.needsReview.length === 0) {
    lines.push("  (nothing unresolved)");
  } else {
    for (const f of r.needsReview) lines.push(docCheckFindingLine(f));
  }

  if (!r.undocumentedDisabled) {
    lines.push(`\n◌ undocumented (${r.verdict.undocumented}) — exported, but no doc mentions them (advisory)`);
    if (r.undocumented.length === 0) {
      lines.push("  (every exported symbol is mentioned somewhere)");
    } else {
      for (const u of r.undocumented) {
        lines.push(`  ${u.symbolName} [${u.symbolType}] — ${u.relativePath}:${u.line}`);
      }
    }
  }

  if (r.notes.length > 0) {
    lines.push(`\nNotes:`);
    for (const n of r.notes) lines.push(`  - ${n}`);
  }
  if (r.omitted > 0) {
    lines.push(`⚠ ${r.omitted} item(s) omitted by the char budget (kept whole, never truncated).`);
  }
  if (c.truncated) {
    lines.push("⚠ the doc set or the table hit its cap — coverage is partial.");
  }
  return lines.join("\n");
}

/**
 * The `--last` / stored-report rendering (proposal D1c watch mode): the
 * SNAPSHOT header leads — its store time is surfaced so a stale snapshot never
 * reads as a fresh check — followed by the stored report itself. Shared by the
 * MCP server, the stdio bridge and the CLI, so all three surfaces state the
 * staleness exactly the same way.
 */
export function formatDocCheckStored(project: string, ts: number, report: DocCheckReport): string {
  const when = new Date(ts).toISOString();
  return (
    `Stored doc–code report for ${project} — snapshot from ${when} (doccheck.watch job; NOT a fresh check)\n` +
    formatDocCheck(report)
  );
}

// ---------------------------------------------------------- query log (A3)

/**
 * The query-log analytics sections in display order: Top queries → Zero-hit
 * queries (the index-gap signal) → Latency → Repeat rate. Exported separately
 * so `cidx stats` stays composable — a later wave appends table/disk sections
 * under the same command instead of reimplementing these.
 */
export function formatQueryLogSections(s: QueryLogStats): string[] {
  const sections: string[] = [];

  if (s.topQueries.length > 0) {
    const lines: string[] = ["Top queries (count · avg results · query):"];
    for (const t of s.topQueries) {
      lines.push(`  ${String(t.count).padStart(4)}×  avg ${t.avgResultCount.toFixed(1)} hits  ${t.query}`);
    }
    sections.push(lines.join("\n"));
  }

  if (s.total > 0) {
    const lines: string[] = ["Zero-hit queries — possible index gaps (bad query or nothing indexed):"];
    if (s.zeroHit.length === 0) {
      lines.push("  (none — every recorded query found something)");
    } else {
      for (const z of s.zeroHit) {
        lines.push(`  ${String(z.count).padStart(4)}×  ${z.query}`);
      }
    }
    sections.push(lines.join("\n"));
    sections.push(`Search latency: avg ${s.avgLatencyMs.toFixed(1)} ms · max ${Math.round(s.maxLatencyMs)} ms`);
    sections.push(
      `Repeat rate: ${(s.repeatRate * 100).toFixed(1)}% of searches repeated an identical earlier query (the shared query-embedding cache already absorbs these)`,
    );
  }

  return sections;
}

/**
 * The full query-log analytics block for `cidx stats`: a scope header (project
 * or global, honest about the cross-project-search exclusion) followed by the
 * section formatters above.
 */
export function formatQueryLogStats(s: QueryLogStats, opts?: { project?: string | undefined }): string {
  const scope = opts?.project ? `project '${opts.project}'` : "all projects";
  const head = `Query log — ${scope} · ${s.total} recorded search(s)`;
  if (s.total === 0) {
    const note = opts?.project
      ? "No searches recorded for this project yet. Cross-project (searchAll) queries are logged without a project and count toward the global stats only."
      : "No searches recorded yet.";
    return `${head}\n${note}`;
  }
  return [head, "", ...formatQueryLogSections(s)].join("\n");
}

// --------------------------------------------- table stats / compact (O3)

/** One index's display line: `vector [IVF_PQ]` + native coverage when known. */
function formatIndexStat(s: TableIndexStat, rows: number): string {
  const bits = [`${s.columns.join("+")} [${s.indexType}]`];
  if (s.indexedRows !== undefined) {
    bits.push(`${s.indexedRows}/${rows} rows`);
    if (s.unindexedRows !== undefined && s.unindexedRows > 0) bits.push(`+${s.unindexedRows} unindexed`);
  }
  return bits.join(" ");
}

/** One project's stats lines: head summary, index presence, fragment signal, job, notes. */
function formatProjectStat(p: ProjectStats): string[] {
  const lines: string[] = [
    `• ${p.name} [${p.status}] — ${p.table}: ${p.rows} row(s) · ${p.cachedFiles} cached file(s) · ` +
      (p.tableBytes === null ? "size unknown" : formatBytes(p.tableBytes)) +
      ` · last indexed ${fmtTime(p.lastIndexedAt)}`,
  ];

  if (p.indices === null) {
    lines.push("  table not found on disk");
  } else if (p.indices.length === 0) {
    lines.push("  no ANN/FTS index built (small table — brute-force serves it)");
  } else {
    lines.push(`  ${p.indices.map((ix) => formatIndexStat(ix, p.rows)).join(" · ")}`);
  }

  if (p.fragments !== null && p.smallFragments !== null) {
    const hint = p.smallFragments > 0 ? " — compact would merge them" : "";
    lines.push(`  fragments: ${p.fragments} (${p.smallFragments} small)${hint}`);
  }
  if (p.job) {
    const pct = p.job.total > 0 ? ` (${Math.round((p.job.processed / p.job.total) * 100)}%)` : "";
    lines.push(`  job: ${p.job.type} ${p.job.status}${pct}`);
  }
  for (const n of p.notes) lines.push(`  ! ${n}`);
  return lines;
}

/** The data-root block: total, per-table sizes, meta.db, embedding cache. */
function formatGlobalStat(lines: string[], r: StatsReport): void {
  const g = r.global;
  if (!g.rootExists) {
    lines.push(`Data root: ${r.home} — not created yet (nothing indexed, no disk usage).`);
    return;
  }
  const tables = [...g.tables].sort((a, b) => b.bytes - a.bytes).map((t) => `${t.name} ${formatBytes(t.bytes)}`);
  const bits: string[] = [`total ${formatBytes(g.totalBytes)}`];
  if (tables.length > 0) bits.push(`tables: ${tables.join(", ")}`);
  bits.push(`meta.db ${g.metaDbBytes === null ? "size unknown" : formatBytes(g.metaDbBytes)}`);
  bits.push(`embedding cache ${g.embeddingCache.rows} row(s) ≈ ${formatBytes(g.embeddingCache.estimatedBytes)}`);
  if (g.unreadableEntries > 0) {
    bits.push(`${g.unreadableEntries} unreadable entr${g.unreadableEntries === 1 ? "y" : "ies"}`);
  }
  lines.push(`Data root — ${r.home}:`);
  lines.push(`  ${bits.join(" · ")}`);
}

/**
 * The table/disk stat sections for `cidx stats` (proposal O3), exported so the
 * command stays composable: these print BEFORE the query-log sections of A3
 * (see `formatQueryLogSections`). One section: every project's table picture,
 * then the global data-root block. Honest unknowns — a missing table or an
 * unreadable stat shows up as text, never as an invented zero.
 */
export function formatStatsSections(r: StatsReport): string[] {
  const lines: string[] = [`Tables & disk (${r.projects.length} project(s) · data root ${r.home}):`];
  if (r.projects.length === 0) {
    lines.push("  (nothing indexed yet — cidx index <dir> starts one)");
  } else {
    for (const p of r.projects) lines.push(...formatProjectStat(p));
  }
  formatGlobalStat(lines, r);
  return [lines.join("\n")];
}

/**
 * The compact result line for `cidx compact` (proposal O3): what the native
 * `optimize` actually did — a merge, a prune, or an honest "nothing to do".
 */
export function formatCompactResult(r: CompactResult): string {
  const c = r.compaction;
  const compacted = c.fragmentsRemoved > 0;
  const head = `Compacted '${r.table}':`;
  if (!compacted && r.prune.oldVersionsRemoved === 0) {
    return `${head} nothing to do (already compact — no fragmented files, no old versions).`;
  }
  const bits: string[] = [];
  if (compacted) {
    bits.push(
      `${c.fragmentsRemoved} fragment(s) merged into ${c.fragmentsAdded}`,
      `${c.filesRemoved} file(s) into ${c.filesAdded}`,
    );
  }
  if (r.prune.oldVersionsRemoved > 0) {
    bits.push(`${r.prune.oldVersionsRemoved} old version(s) pruned (${formatBytes(r.prune.bytesRemoved)} freed)`);
  }
  return `${head} ${bits.join("; ")}.`;
}

// ---------------------------------------------------- coupling metrics (C5)

/**
 * Converts a coupling report to text, sectioned in the three band views:
 * Most imported → Change magnets → Unstable leaves, with the files that fall in
 * no band counted (not listed) and the external-import total alongside — those
 * edges are excluded from the fan metrics by design.
 */
export function formatCoupling(r: CouplingReport): string {
  const lines: string[] = [];
  lines.push(`Coupling — project: ${r.project}`);
  if (r.scannedFiles === 0) {
    lines.push("(the project has no indexed files — nothing to measure)");
    return lines.join("\n");
  }
  lines.push(
    `${r.scannedFiles} file(s) scanned · ${r.externalImports} external import(s) excluded from the metrics` +
      (r.unclassified > 0 ? ` · ${r.unclassified} file(s) in no band (no internal edges)` : ""),
  );
  const instability = (v: number | null): string => (v === null ? "—" : v.toFixed(2));
  const bandLine = (f: FileCoupling): string =>
    `  ${String(f.fanIn).padStart(3)} in · ${String(f.fanOut).padStart(3)} out · inst ${instability(f.instability)}` +
    ` · ${f.relativeFile}` +
    (f.externalImports > 0 ? `  (+${f.externalImports} external)` : "");
  const band = (title: string, hint: string, b: CouplingBand): void => {
    lines.push(`\n${title} (${b.total}) — ${hint}`);
    if (b.items.length === 0) {
      lines.push("  (none)");
      return;
    }
    for (const f of b.items) lines.push(bandLine(f));
  };

  band("▲ Most imported", "files other modules import the most", r.topFanIn);
  band("⟳ Change magnets", "heavily imported AND heavily importing — one change ripples", r.changeMagnets);
  band("↗ Unstable leaves", "imported by nothing, importing others — pure dependents", r.unstableLeaves);

  if (r.truncated) {
    lines.push("⚠ a band hit its cap — pass a higher --limit for more.");
  }
  return lines.join("\n");
}
// ---------------------------------------------------- hotspot report (C3)

/**
 * Converts a hotspot report to text, sectioned in the three bands
 * (critical → warm → review), one ranked line per file with its rationale.
 * The header carries the churn window and repeats the PROXY caveat: size here
 * is chunk+symbol volume, never cyclomatic complexity.
 */
export function formatHotspots(r: HotspotReport): string {
  const lines: string[] = [];
  lines.push(`Hotspots — project: ${r.project} · churn window: ${r.since}`);
  if (r.scannedFiles === 0) {
    lines.push("(the project has no indexed files — nothing to measure)");
    return lines.join("\n");
  }
  const notes: string[] = [`${r.scannedFiles} file(s) scanned`];
  if (r.notARepo) notes.push("not a git repo — churn empty (window/debt bands only)");
  else notes.push(`${r.filesWithChurn} changed in window`, `${r.commitsScanned} commit(s) walked`);
  if (r.unindexedChurnFiles > 0) notes.push(`${r.unindexedChurnFiles} churn path(s) not in the index`);
  if (r.notListed > 0) notes.push(`${r.notListed} file(s) below every band (score 0, no signal)`);
  lines.push(`${notes.join(" · ")} — size is a chunk+symbol PROXY, not cyclomatic complexity`);
  if (r.commitsTruncated) {
    lines.push("⚠ the churn walk hit its commit cap — older in-window commits exist, counts may undercount.");
  }
  if (r.snapshotTruncated) {
    lines.push("⚠ the table snapshot hit its row cap — size/dead-code feeds are partial.");
  }
  // One ranked line per file: score · path, then the one-line rationale.
  const fileLine = (f: HotspotFile): string => `  ${String(f.score).padStart(5)}  ${f.relativeFile} — ${f.rationale}`;
  const band = (title: string, hint: string, b: HotspotBand): void => {
    lines.push(`\n${title} (${b.total}) — ${hint}`);
    if (b.items.length === 0) {
      lines.push("  (none)");
      return;
    }
    for (const f of b.items) lines.push(fileLine(f));
  };

  band("▲ Critical", "hot churn × size — refactor here first", r.critical);
  band("◐ Warm", "getting hot — changes landing on meaningful volume", r.warm);
  band("○ Review", "below the warm line: stable files with debt, demoted test/entry files", r.review);

  if (r.truncated) {
    lines.push("⚠ a band hit its cap — pass a higher --limit for more.");
  }
  return lines.join("\n");
}

// ---------------------------------------------- overview pick-one (agent UX)

/**
 * The graceful response `/overview` (and the `get_repo_overview` tool) gives
 * when NO anchor (project/path) is given and more than one project is indexed
 * — a plain 200 describing the choices, instead of a hard error. First seen in
 * real usage: an agent in a not-indexed session directory guessed the project
 * name, lost a round-trip on the error, then re-issued the identical call.
 */
export interface OverviewPickOne {
  pickOne: true;
  note: string;
}

/** Renders the pick-one list from index views (same bullet style as list_indexes). */
export function overviewPickOneNote(
  views: ReadonlyArray<{ name: string; path: string; status: string; files: number; chunks: number }>,
): string {
  const lines = views.map(
    (ix) => `• ${ix.name} [${ix.status}] — ${ix.path} (${ix.files} files, ${ix.chunks} chunks)`,
  );
  return (
    "Multiple projects are indexed — pass the 'project' (or 'path') argument to pick one:\n" +
    lines.join("\n")
  );
}

/** Type-guard for the Control-API `/overview` pick-one payload. */
export function isOverviewPickOne(x: unknown): x is OverviewPickOne {
  return typeof x === "object" && x !== null && (x as OverviewPickOne).pickOne === true;
}
