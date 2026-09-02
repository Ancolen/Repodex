import type { ScopedSearchResult, SymbolReference, RepoOverview } from "../core/index-manager";
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
      const meta = [relevance, r.indexedAt ? `indexed: ${fmtTime(r.indexedAt)}` : ""]
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
