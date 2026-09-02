import type {
  ScopedSearchResult,
  SymbolReference,
  RepoOverview,
  BatchSearchGroup,
  DependencyResult,
  DeadCodeReport,
  CallGraphResult,
  CallGraphNode,
  CommitSearchResult,
  CommitHit,
} from "../core/index-manager";
import type { OutlineEntry } from "../chunking/chunker";

/** Formats an epoch-ms timestamp as a compact ISO string (or "—"). */
function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "—";
  }
}

/** Converts search/symbol results to agent-friendly text (shared by mcp + stdio bridge). */
export function formatResults(results: ScopedSearchResult[]): string {
  if (results.length === 0) return "No relevant code chunk found.";
  return results
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
      return `Result ${i + 1}: [${r.project}] ${loc}${sym}${sig}\n${meta}\n${before}\`\`\`\n${r.content}\n\`\`\`${after}`;
    })
    .join("\n---\n\n");
}

/** Converts batch (multi-query) search results to text, one section per query. */
export function formatBatchResults(groups: BatchSearchGroup[]): string {
  if (groups.length === 0) return "No relevant code chunk found for any query.";
  return groups
    .map((g) => {
      const n = g.results.length;
      const header = `## Query: "${g.query}" (${n} result${n === 1 ? "" : "s"})`;
      const body = n > 0 ? formatResults(g.results) : "No relevant code chunk found.";
      return `${header}\n\n${body}`;
    })
    .join("\n\n---\n\n");
}

/** Converts a file's symbol map to text. */
export function formatOutline(outline: OutlineEntry[]): string {
  if (outline.length === 0) return "No symbols found in this file.";
  return outline.map((o) => `L${o.startLine}-${o.endLine}  ${o.symbolType} ${o.symbolName}`).join("\n");
}

/** Converts symbol references (usages) to text grouped by file. */
export function formatReferences(refs: SymbolReference[]): string {
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
  return `${refs.length} reference(s):\n\n${blocks.join("\n\n")}`;
}

/** Converts a repository overview to an agent-friendly onboarding summary. */
export function formatOverview(o: RepoOverview): string {  const lines: string[] = [];
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
