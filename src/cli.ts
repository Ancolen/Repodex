#!/usr/bin/env bun
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { CONFIG, RESOLVED, CONFIG_SOURCE, resolveConfigPath } from "./config";
import { daemonCommand, bridgeCommand } from "./runtime";
import { daemonCheck, type DoctorCheck, type DoctorReport } from "./core/doctor";
import { resolveEditor, buildEditorArgs } from "./utils/editor";
import type { QueryLogStats, SearchEnvelope } from "./core/index-manager";
import type { StatsReport } from "./core/stats";
import type { CompactResult } from "./services/db";
import { formatContextPack, formatReferences, formatApiDiff, formatImpact, formatDocCheck, formatDocCheckStored, formatBlameNote, formatEnvelopeNotes, formatQueryLogStats, formatCoupling, formatStatsSections, formatCompactResult, formatHotspots } from "./server/format";

const BASE = `http://${CONFIG.HOST}:${CONFIG.CONTROL_PORT}`;

// --------------------------------------------------------------- helpers
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function ping(timeoutMs = 1000): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function api<T = any>(method: string, pathname: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const msg = data && typeof data === "object" && data.error ? data.error : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as T;
}

async function requireDaemon(): Promise<void> {
  if (!(await ping())) {
    console.error("Daemon is not running. Start it first:  cidx start");
    process.exit(1);
  }
}

function statusBadge(s: string): string {
  return { ready: "✓ ready", indexing: "… indexing", error: "✗ error", queued: "· queued" }[s] ?? s;
}

function printIndex(ix: any): void {
  const prog = ix.job && ix.job.total > 0 ? `  (${ix.job.percent}% — ${ix.job.processed}/${ix.job.total})` : "";
  console.log(`• ${ix.name}  [${statusBadge(ix.status)}]${prog}`);
  console.log(`    path:   ${ix.path}`);
  console.log(`    data:   ${ix.files} files, ${ix.chunks} chunks  (table: ${ix.table})`);
  if (ix.error) console.log(`    error:  ${ix.error}`);
}

// ------------------------------------------------------------------ commands
async function cmdStart(positionals: string[]): Promise<void> {
  if (await ping()) {
    console.log("Daemon is already running.");
  } else {
    mkdirSync(CONFIG.ROOT_DIR, { recursive: true });
    const logPath = path.join(CONFIG.ROOT_DIR, "daemon.log");
    const out = openSync(logPath, "a");
    const proc = Bun.spawn({
      cmd: daemonCommand(import.meta.dir),
      stdout: out,
      stderr: out,
      stdin: "ignore",
      env: process.env,
    });
    proc.unref();
    process.stdout.write("Starting daemon");
    let up = false;
    for (let i = 0; i < 60; i++) {
      process.stdout.write(".");
      if (await ping()) {
        up = true;
        break;
      }
      await Bun.sleep(500);
    }
    console.log(up ? `\nDaemon ready (pid ${proc.pid}). Logs: ${logPath}` : "\nFailed to start daemon, check the logs.");
    if (!up) process.exit(1);
  }
  // optional initial indexing after start
  const dir = positionals[0];
  if (dir) await cmdIndex([dir], {});
}

async function cmdIndex(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const dir = positionals[0];
  if (!dir) {
    console.error("Usage: cidx index <directory> [--name <name>]");
    process.exit(1);
  }
  const abs = path.resolve(dir);
  if (!existsSync(abs)) {
    console.error(`Directory not found: ${abs}`);
    process.exit(1);
  }
  const body: { path: string; name?: string } = { path: abs };
  if (typeof flags.name === "string") body.name = flags.name;
  const ix = await api("POST", "/index", body);
  console.log("Indexing started (in the background):");
  printIndex(ix);
  console.log(`\nTo see progress:  cidx status ${ix.name}`);
}

async function cmdList(): Promise<void> {
  await requireDaemon();
  const indexes = await api<any[]>("GET", "/indexes");
  if (indexes.length === 0) {
    console.log("No projects indexed yet.  cidx index <directory>");
    return;
  }
  for (const ix of indexes) printIndex(ix);
}

async function cmdStatus(positionals: string[]): Promise<void> {
  await requireDaemon();
  const name = positionals[0];
  if (name) {
    const ix = await api("GET", `/indexes/${encodeURIComponent(name)}`);
    printIndex(ix);
  } else {
    await cmdList();
  }
}

async function cmdReindex(positionals: string[]): Promise<void> {
  await requireDaemon();
  const name = positionals[0];
  if (!name) {
    console.error("Usage: cidx reindex <name>");
    process.exit(1);
  }
  const ix = await api("POST", "/reindex", { name });
  console.log("Reindexing started:");
  printIndex(ix);
}

async function cmdSync(positionals: string[]): Promise<void> {
  await requireDaemon();
  const name = positionals[0];
  if (!name) {
    console.error("Usage: cidx sync <name>");
    process.exit(1);
  }
  const ix = await api("POST", "/sync", { name });
  console.log("Incremental sync started (changed + deleted files):");
  printIndex(ix);
}

async function cmdRemove(positionals: string[]): Promise<void> {
  await requireDaemon();
  const name = positionals[0];
  if (!name) {
    console.error("Usage: cidx remove <name>");
    process.exit(1);
  }
  await api("DELETE", `/indexes/${encodeURIComponent(name)}`);
  console.log(`'${name}' removed.`);
}

async function cmdSearch(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const query = positionals.join(" ");
  if (!query) {
    console.error('Usage: cidx search "<query>" [--project x] [--limit n] [--mode hybrid|vector|text] [--language x] [--type x] [--path glob] [--rerank] [--mmr] [--boost] [--max-chars n] [--doc] [--blame] [--expand]');
    process.exit(1);
  }
  const body: {
    query: string;
    project?: string;
    limit?: number;
    mode?: string;
    language?: string;
    symbolType?: string;
    pathGlob?: string;
    contextLines?: number;
    rerank?: boolean;
    mmr?: boolean;
    boost?: boolean;
    maxChars?: number;
    doc?: boolean;
    blame?: boolean;
    expand?: boolean;
  } = { query };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags.mode === "string") body.mode = flags.mode;
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  if (typeof flags.path === "string") body.pathGlob = flags.path;
  if (typeof flags.context === "string") body.contextLines = Number(flags.context);
  // --rerank / --rerank true turns it on; --rerank false turns it off (default-on).
  if (flags.rerank === true || flags.rerank === "true") body.rerank = true;
  else if (flags.rerank === "false") body.rerank = false;
  // --mmr / --mmr true turns diversification on; --mmr false turns it off (default-on).
  if (flags.mmr === true || flags.mmr === "true") body.mmr = true;
  else if (flags.mmr === "false") body.mmr = false;
  // --boost / --boost true turns path/surface boosting on; --boost false turns it off (default-on).
  if (flags.boost === true || flags.boost === "true") body.boost = true;
  else if (flags.boost === "false") body.boost = false;
  // --max-chars caps the returned text (results dropped whole to fit; top-1 always kept).
  if (typeof flags["max-chars"] === "string") body.maxChars = Number(flags["max-chars"]);
  // --doc false skips the docstring retrieval legs (on by default where available).
  if (flags.doc === true || flags.doc === "true") body.doc = true;
  else if (flags.doc === "false") body.doc = false;
  // --blame opts in to the ownership/last-author enrichment (one git call per hit file, ≤ 8).
  if (flags.blame === true || flags.blame === "true") body.blame = true;
  else if (flags.blame === "false") body.blame = false;
  // --expand opts in to query expansion (one local-LLM round-trip; needs search.expand.model).
  if (flags.expand === true || flags.expand === "true") body.expand = true;
  else if (flags.expand === "false") body.expand = false;
  const env = await api<SearchEnvelope>("POST", "/search", body);
  printResults(env.results);
  printBlameNote(formatEnvelopeNotes(env));
}

async function cmdOpen(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const query = positionals.join(" ");
  if (!query) {
    console.error('Usage: cidx open "<query>" [--pick n] [--project x] [--mode hybrid|vector|text] [--limit n] [--language x] [--type x] [--path glob] [--rerank] [--mmr] [--boost] [--doc] [--blame] [--expand]');
    console.error("\nSearches, prints the results, and opens the selected one in $VISUAL/$EDITOR at the matching line.");
    process.exit(1);
  }
  const body: {
    query: string;
    project?: string;
    limit?: number;
    mode?: string;
    language?: string;
    symbolType?: string;
    pathGlob?: string;
    rerank?: boolean;
    mmr?: boolean;
    boost?: boolean;
    doc?: boolean;
    blame?: boolean;
    expand?: boolean;
  } = { query, limit: 10 }; // a list worth picking from, unless --limit says otherwise
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags.mode === "string") body.mode = flags.mode;
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  if (typeof flags.path === "string") body.pathGlob = flags.path;
  if (flags.rerank === true || flags.rerank === "true") body.rerank = true;
  else if (flags.rerank === "false") body.rerank = false;
  if (flags.mmr === true || flags.mmr === "true") body.mmr = true;
  else if (flags.mmr === "false") body.mmr = false;
  if (flags.boost === true || flags.boost === "true") body.boost = true;
  else if (flags.boost === "false") body.boost = false;
  if (flags.doc === true || flags.doc === "true") body.doc = true;
  else if (flags.doc === "false") body.doc = false;
  if (flags.blame === true || flags.blame === "true") body.blame = true;
  else if (flags.blame === "false") body.blame = false;
  if (flags.expand === true || flags.expand === "true") body.expand = true;
  else if (flags.expand === "false") body.expand = false;

  const env = await api<SearchEnvelope>("POST", "/search", body);
  const results = env.results;
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }
  printResults(results);
  printBlameNote(formatEnvelopeNotes(env));

  const pick = flags.pick !== undefined ? Number(flags.pick) : 1;
  const r = results[pick - 1];
  if (!r || !Number.isInteger(pick) || pick < 1) {
    console.error(`--pick ${flags.pick ?? 1} is out of range (1-${results.length})`);
    process.exit(1);
  }
  const filePath: string = r.filePath;
  if (!filePath || !existsSync(filePath)) {
    console.error(`File no longer exists on disk: ${filePath ?? "(no path in result)"} — run 'cidx sync' and retry.`);
    process.exit(1);
  }
  const line = typeof r.startLine === "number" && r.startLine >= 1 ? r.startLine : 1;
  const editor = resolveEditor(process.env);
  const args = buildEditorArgs(editor, filePath, line);
  console.log(`\nOpening #${pick} in ${editor}: ${filePath}:${line}`);
  const spawned = spawnSync(editor, args, { stdio: "inherit" });
  if (spawned.error) {
    console.error(`Failed to launch editor '${editor}': ${spawned.error.message}`);
    process.exit(1);
  }
  if (spawned.status !== 0 && spawned.status !== null) {
    process.exit(spawned.status);
  }
}

async function cmdBatch(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  // Each positional is a separate query (quote multi-word queries).
  const queries = positionals;
  if (queries.length === 0) {
    console.error('Usage: cidx batch "<q1>" "<q2>" ... [--project x] [--limit n] [--mode hybrid|vector|text] [--language x] [--type x] [--path glob] [--max-chars n] [--doc] [--blame] [--expand]');
    process.exit(1);
  }
  const body: {
    queries: string[];
    project?: string;
    limit?: number;
    mode?: string;
    language?: string;
    symbolType?: string;
    pathGlob?: string;
    contextLines?: number;
    rerank?: boolean;
    mmr?: boolean;
    boost?: boolean;
    maxChars?: number;
    doc?: boolean;
    blame?: boolean;
    expand?: boolean;
  } = { queries };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags.mode === "string") body.mode = flags.mode;
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  if (typeof flags.path === "string") body.pathGlob = flags.path;
  if (typeof flags.context === "string") body.contextLines = Number(flags.context);
  if (flags.rerank === true || flags.rerank === "true") body.rerank = true;
  else if (flags.rerank === "false") body.rerank = false;
  if (flags.mmr === true || flags.mmr === "true") body.mmr = true;
  else if (flags.mmr === "false") body.mmr = false;
  if (flags.boost === true || flags.boost === "true") body.boost = true;
  else if (flags.boost === "false") body.boost = false;
  if (typeof flags["max-chars"] === "string") body.maxChars = Number(flags["max-chars"]);
  if (flags.doc === true || flags.doc === "true") body.doc = true;
  else if (flags.doc === "false") body.doc = false;
  if (flags.blame === true || flags.blame === "true") body.blame = true;
  else if (flags.blame === "false") body.blame = false;
  if (flags.expand === true || flags.expand === "true") body.expand = true;
  else if (flags.expand === "false") body.expand = false;
  const groups = await api<any[]>("POST", "/search/batch", body);
  printBatchResults(groups);
}

/** Prints batch (multi-query) search results grouped by query. */
function printBatchResults(groups: any[]): void {
  if (!Array.isArray(groups) || groups.length === 0) {
    console.log("No results found for any query.");
    return;
  }
  groups.forEach((g, i) => {
    if (i > 0) console.log("");
    const n = g.results?.length ?? 0;
    console.log(`## Query: "${g.query}" (${n} result${n === 1 ? "" : "s"})`);
    printResults(g.results ?? []);
    printBlameNote(formatEnvelopeNotes(g));
  });
}

/** Prints the envelope notes (blame C4, expansion S4; no-op when nothing to say). */
function printBlameNote(note: string | null): void {
  if (note) console.log(`\n${note}`);
}

async function cmdPack(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const query = positionals.join(" ");
  if (!query) {
    console.error(
      'Usage: cidx pack "<query>" [--project x] [--limit n] [--max-chars n] [--context n] [--language x] [--type x] [--path glob]',
    );
    process.exit(1);
  }
  const body: {
    query: string;
    project?: string;
    limit?: number;
    maxChars?: number;
    contextLines?: number;
    language?: string;
    symbolType?: string;
    pathGlob?: string;
  } = { query };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags["max-chars"] === "string") body.maxChars = Number(flags["max-chars"]);
  if (typeof flags.context === "string") body.contextLines = Number(flags.context);
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  if (typeof flags.path === "string") body.pathGlob = flags.path;
  const pack = await api<any>("POST", "/pack", body);
  console.log(formatContextPack(pack));
}

async function cmdFind(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const name = positionals.join(" ");
  if (!name) {
    console.error('Usage: cidx find <symbolName> [--project x] [--limit n] [--fuzzy [bool]] [--language x] [--type x]');
    process.exit(1);
  }
  const body: { name: string; project?: string; limit?: number; fuzzy?: boolean; language?: string; symbolType?: string } = { name };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  // --fuzzy false keeps the strict exact/prefix-only behavior (default-on).
  if (flags.fuzzy === true || flags.fuzzy === "true") body.fuzzy = true;
  else if (flags.fuzzy === "false") body.fuzzy = false;
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  const results = await api<any[]>("POST", "/find", body);
  printResults(results);
}

/** Prints search/symbol results in a common format. */
function printResults(results: any[]): void {
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }
  results.forEach((r, i) => {
    const loc = r.startLine !== undefined ? `${r.filePath}:${r.startLine}-${r.endLine}` : r.filePath;
    const sym = r.symbolName ? ` (${r.symbolType ?? "symbol"} ${r.symbolName})` : "";
    const score =
      r._score !== undefined
        ? `relevance ${r._score.toFixed(3)}`
        : r._distance !== undefined
          ? `score ${r._distance.toFixed(3)}`
          : "";
    const docHit = r._docHit ? "  [doc hit]" : "";
    const fuzzyMark = r.fuzzy ? "  [⚠ fuzzy]" : "";
    console.log(`\n${i + 1}. [${r.project}] ${loc}${sym}${score ? `  (${score})` : ""}${docHit}${fuzzyMark}`);
    if (r.signature) console.log(`   ↳ ${r.signature}`);
    // Blame enrichment (opt-in, C4): same compact line as the MCP formatter.
    if (r.lastAuthor !== undefined || r.lastCommitDate !== undefined || r.churnCommits !== undefined) {
      const n = typeof r.churnCommits === "number" ? r.churnCommits : 0;
      const churn = n > 0 ? `${n} commit${n === 1 ? "" : "s"}${r.churnTruncated ? "+" : ""}` : "no commit";
      console.log(`   last: ${r.lastAuthor ?? "unknown"} ${r.lastCommitDate ?? "—"} (${churn})`);
    }
    if (Array.isArray(r.contextBefore)) {
      r.contextBefore.forEach((l: string) => console.log(`   · ${l}`));
    }
    console.log(
      String(r.content ?? "")
        .split("\n")
        .slice(0, 6)
        .map((l: string) => `   ${l}`)
        .join("\n"),
    );
    if (Array.isArray(r.contextAfter)) {
      r.contextAfter.forEach((l: string) => console.log(`   · ${l}`));
    }
  });
}

async function cmdRefs(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const name = positionals.join(" ");
  if (!name) {
    console.error("Usage: cidx refs <symbolName> [--project x] [--limit n] [--language x] [--type x] [--no-docs]");
    process.exit(1);
  }
  const body: { name: string; project?: string; limit?: number; language?: string; symbolType?: string; includeDocs?: boolean } = { name };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  if (flags["no-docs"] === true) body.includeDocs = false;
  console.log(formatReferences(await api<Parameters<typeof formatReferences>[0]>("POST", "/references", body)));
}

async function cmdOverview(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  // An existing dir path as the positional (or --path) anchors the project; a
  // bare name is the project name; nothing given → the daemon resolves the
  // single indexed project (or errors naming them all).
  const arg = positionals[0];
  let body: { name?: string | undefined; path?: string | undefined } = {};
  if (typeof flags.path === "string") body.path = path.resolve(flags.path);
  else if (arg && existsSync(arg) && statSync(arg).isDirectory()) body.path = path.resolve(arg);
  else if (arg) body.name = arg;
  const o = await api<any>("POST", "/overview", body);
  const t = o.lastIndexedAt ? new Date(o.lastIndexedAt).toISOString() : "—";
  console.log(`\nRepo: ${o.name}  [${o.status}]`);
  console.log(`Path: ${o.path}`);
  console.log(`${o.files} files · ${o.chunks} chunks · ${o.symbols} symbols · model: ${o.embedModel ?? "—"} · indexed: ${t}`);
  if (o.languages?.length) {
    console.log("\nLanguages:");
    for (const l of o.languages.slice(0, 12)) {
      console.log(`  ${String(l.language).padEnd(14)} ${l.files} files, ${l.symbols} symbols`);
    }
  }
  if (o.symbolTypes?.length) {
    console.log("\nSymbol types:");
    console.log("  " + o.symbolTypes.map((s: any) => `${s.type}: ${s.count}`).join(", "));
  }
  if (o.topDirectories?.length) {
    console.log("\nTop-level directories:");
    for (const d of o.topDirectories) console.log(`  ${String(d.dir).padEnd(20)} ${d.files} files`);
  }
  if (o.entryPoints?.length) {
    console.log("\nLikely entry points:");
    for (const e of o.entryPoints) console.log(`  ${e}`);
  }
  if (o.largestFiles?.length) {
    console.log("\nFiles with the most symbols:");
    for (const f of o.largestFiles) console.log(`  ${String(f.symbols).padStart(4)}  ${f.file}`);
  }
}

async function cmdDeps(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const filePath = positionals[0];
  if (!filePath) {
    console.error("Usage: cidx deps <file> [--project x] [--limit n]");
    process.exit(1);
  }
  const body: { path: string; project?: string; limit?: number } = { path: path.resolve(filePath) };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  const r = await api<any>("POST", "/dependencies", body);
  printDependencies(r);
}

/** Prints a dependency-graph result (CLI inline formatter). */
function printDependencies(r: any): void {
  console.log(`\nDependencies for '${r.relativeFile || r.file}' (project: ${r.project})`);
  const imports: any[] = r.imports ?? [];
  const resolved = imports.filter((e) => e.status === "resolved");
  const external = imports.filter((e) => e.status === "external");
  const unresolved = imports.filter((e) => e.status === "unresolved");
  console.log(
    `\nImports (${resolved.length} resolved, ${external.length} external${unresolved.length ? `, ${unresolved.length} unresolved` : ""}):`,
  );
  if (imports.length === 0) {
    console.log("  (none — this file imports nothing)");
  } else {
    for (const e of resolved) console.log(`  → ${e.relativePath ?? e.path ?? e.raw}  (from "${e.raw}")`);
    for (const e of external) console.log(`  ⊘ ${e.raw}  (external${e.reason ? `: ${e.reason}` : ""})`);
    for (const e of unresolved) console.log(`  ? ${e.raw}  (unresolved${e.reason ? `: ${e.reason}` : ""})`);
  }
  const importedBy: string[] = r.importedBy ?? [];
  console.log(`\nImported by (${importedBy.length}):`);
  if (importedBy.length === 0) {
    console.log("  (none — no indexed file imports this one)");
  } else {
    for (const f of importedBy) console.log(`  ${f}`);
  }
  console.log(`\n(reverse graph built from ${r.scannedFiles} indexed file(s))`);
  if (r.truncated) console.log("⚠ reverse scan hit the file cap — pass a higher --limit for more.");
}

async function cmdCallGraph(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const arg = positionals[0];
  if (!arg) {
    console.error(
      "Usage: cidx callgraph <symbol|file> [--project x] [--direction both|callers|callees] [--depth n] [--limit n]",
    );
    process.exit(1);
  }
  const body: {
    symbol?: string;
    path?: string;
    project?: string;
    direction?: "callers" | "callees" | "both";
    depth?: number;
    limit?: number;
  } = {};
  // A positional that points at a real file → module mode (all callables in it);
  // otherwise treat it as a symbol name.
  if (existsSync(arg)) body.path = path.resolve(arg);
  else body.symbol = arg;
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.direction === "string") body.direction = flags.direction as "callers" | "callees" | "both";
  if (typeof flags.depth === "string") body.depth = Number(flags.depth);
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  const r = await api<any>("POST", "/callgraph", body);
  printCallGraph(r);
}

/** Prints a call-graph result (CLI inline formatter). */
function printCallGraph(r: any): void {
  const roots: any[] = r.roots ?? [];
  const nodeLine = (n: any): string => {
    const type = n.symbolType ? ` [${n.symbolType}]` : "";
    const loc = n.startLine ? `  ${n.relativeFile || n.file}:${n.startLine}${n.endLine ? `-${n.endLine}` : ""}` : "";
    const sig = n.signature ? ` — ${n.signature}` : "";
    return `${n.symbol}${type}${loc}${sig}`;
  };
  const anchor =
    roots.length === 1
      ? nodeLine(roots[0])
      : `${roots.length} symbol(s)${roots[0]?.file ? ` in ${roots[0].relativeFile || roots[0].file}` : ""}`;
  console.log(`\nCall graph — project: ${r.project} · direction: ${r.direction} · depth: ${r.depth}`);
  console.log(`Anchor: ${anchor}`);
  const walk = (n: any, indent: number): void => {
    const pad = "  ".repeat(indent);
    const cyc = n.cyclic ? "  ↻ cycle" : "";
    console.log(`${pad}${nodeLine(n)}${cyc}`);
    for (const c of n.children ?? []) walk(c, indent + 1);
  };
  const callers: any[] = r.callers ?? [];
  const callees: any[] = r.callees ?? [];
  if (callers.length > 0) {
    console.log("\n▲ Callers (who calls the anchor)");
    for (const root of callers) walk(root, 0);
  }
  if (callees.length > 0) {
    console.log("\n▼ Callees (what the anchor calls)");
    for (const root of callees) walk(root, 0);
  }
  if (callers.length === 0 && callees.length === 0) {
    console.log("\n(no in-index call edges found)");
  }
  console.log(`\n(scanned ${r.scannedSymbols} callable symbol(s))`);
  if (r.truncated) console.log("⚠ node cap or table cap hit — the graph is partial; pass a higher --limit for more.");
}

async function cmdCommits(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  // The first positional is the project NAME, or an existing dir path (which
  // anchors the project by path, like callgraph/impact do).
  const arg = positionals[0];
  if (!arg) {
    console.error(
      "Usage: cidx commits <project|dir> [query] [--path x] [--author x] [--since x] [--until x] [--limit n] [--files]",
    );
    process.exit(1);
  }
  const isDir = existsSync(arg) && statSync(arg).isDirectory();
  const body: {
    project?: string | undefined;
    path?: string | undefined;
    query?: string;
    author?: string;
    since?: string;
    until?: string;
    withFiles?: boolean;
    limit?: number;
  } = isDir ? { path: path.resolve(arg) } : { project: arg };
  // The message query is the 2nd positional (ergonomic) or the --query flag.
  const query = typeof flags.query === "string" ? flags.query : positionals[1];
  if (typeof query === "string" && query.length > 0) body.query = query;
  if (typeof flags.path === "string") body.path = flags.path;
  if (typeof flags.author === "string") body.author = flags.author;
  if (typeof flags.since === "string") body.since = flags.since;
  if (typeof flags.until === "string") body.until = flags.until;
  if (flags.files === true) body.withFiles = true;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  const r = await api<any>("POST", "/commits", body);
  printCommits(r);
}

/** Prints a commit-search result (CLI inline formatter). */
function printCommits(r: any): void {
  const commits: any[] = r.commits ?? [];
  const scope = r.query ? ` · query: "${r.query}"` : "";
  console.log(`\nCommit search — project: ${r.project}${scope} · ${r.count} match(es)`);
  if (r.notARepo) {
    console.log("\n(The project directory is not a git repository — no history to search.)");
    return;
  }
  if (commits.length === 0) {
    console.log("\n(no commits matched; broaden the query / filters, or check --since/--until)");
    return;
  }
  const head = (c: any): string => {
    const who = c.authorName ? `  ${c.authorName} <${c.authorEmail}>` : "";
    const abbr = c.abbreviatedHash || String(c.hash ?? "").slice(0, 7);
    return `${abbr}  ${c.date}${who}`;
  };
  for (const c of commits) {
    console.log("");
    console.log(head(c));
    console.log(`    ${c.subject}`);
    if (c.body) console.log(`    ${String(c.body).replace(/\n/g, "\n    ")}`);
    if (Array.isArray(c.files) && c.files.length > 0) {
      console.log(`    (${c.files.length} file${c.files.length === 1 ? "" : "s"} changed:)`);
      for (const f of c.files) console.log(`      ${f}`);
    }
  }
  if (r.truncated) console.log("\n⚠ commit limit hit — older matches exist; pass a higher --limit for more.");
}

async function cmdDeadcode(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  // The positional is the project NAME, an existing dir path (anchors by path,
  // like callgraph/impact do), or absent → the daemon resolves the single
  // indexed project (or errors naming them all).
  const arg = positionals[0];
  if (!arg && typeof flags.path !== "string") {
    console.error(
      "Usage: cidx deadcode [project|dir] [--path x] [--language x] [--type x] [--min-confidence n] [--limit n]",
    );
    process.exit(1);
  }
  const body: {
    project?: string | undefined;
    path?: string | undefined;
    language?: string;
    symbolType?: string;
    minConfidence?: number;
    limit?: number;
  } =
    typeof flags.path === "string"
      ? { path: path.resolve(flags.path) }
      : arg && existsSync(arg) && statSync(arg).isDirectory()
        ? { path: path.resolve(arg) }
        : { project: arg };
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  if (typeof flags["min-confidence"] === "string") body.minConfidence = Number(flags["min-confidence"]);
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  const r = await api<any>("POST", "/deadcode", body);
  printDeadCode(r);
}

/** Prints a dead-code report (CLI inline formatter). */
function printDeadCode(r: any): void {
  const results: any[] = r.results ?? [];
  console.log(
    `\nPotential dead code in '${r.project}' — ${results.length} candidate(s) (scanned ${r.scannedSymbols} symbols / ${r.scannedChunks} chunks)`,
  );
  if (r.truncated) {
    console.log("⚠ the table exceeded the row cap — coverage is partial; reindex/raise the cap for full coverage.");
  }
  if (results.length === 0) {
    console.log("\nNo dead-code candidates above the threshold.");
    return;
  }
  for (const cat of ["likely dead", "uncertain", "review"]) {
    const group = results.filter((x) => x.category === cat);
    if (group.length === 0) continue;
    console.log(`\n### ${cat} (${group.length})`);
    for (const x of group) {
      const signals = (x.signals ?? [])
        .map((s: any) => s.signal + (s.detail ? ` (${s.detail})` : ""))
        .join(", ");
      console.log(`  [${String(x.confidence).padStart(3)}] ${x.symbolType}  ${x.symbolName}`);
      console.log(`    ${x.relativePath}:${x.startLine}-${x.endLine}${x.language ? `  [${x.language}]` : ""}`);
      if (signals) console.log(`    signals: ${signals}`);
      if (x.signature) console.log(`    signature: ${x.signature}`);
    }
  }
}

// ---------------------------------------------------- API diff (proposal C2)

/** `cidx apidiff <project> <base> [--head x] [--limit n] [--max-files n] [--exported-only] [--all]` */
async function cmdApiDiff(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  // The first positional is the project NAME or an existing dir path (which
  // anchors the project by path, like callgraph/impact do); the second is the
  // 'before' git ref.
  const arg = positionals[0];
  const base = positionals[1];
  if (!arg || !base) {
    console.error("Usage: cidx apidiff <project|dir> <base> [--head x] [--limit n] [--max-files n] [--exported-only] [--all]");
    process.exit(1);
  }
  const isDir = existsSync(arg) && statSync(arg).isDirectory();
  const body: {
    project?: string | undefined;
    path?: string | undefined;
    base: string;
    head?: string;
    limit?: number;
    maxFiles?: number;
    exportedOnly?: boolean;
    includeUnchanged?: boolean;
  } = isDir ? { path: path.resolve(arg), base } : { project: arg, base };
  if (typeof flags.head === "string") body.head = flags.head;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags["max-files"] === "string") body.maxFiles = Number(flags["max-files"]);
  if (flags["exported-only"] === true) body.exportedOnly = true;
  if (flags.all === true) body.includeUnchanged = true;
  const r = await api<any>("POST", "/apidiff", body);
  console.log(formatApiDiff(r));
}

// ------------------------------------------------------- change impact (C1)

async function cmdImpact(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const arg = positionals[0];
  if (!arg) {
    console.error("Usage: cidx impact <symbol|file> [--project x] [--depth n] [--limit n]");
    process.exit(1);
  }
  const body: {
    symbol?: string;
    path?: string;
    project?: string;
    depth?: number;
    limit?: number;
  } = {};
  // A positional that points at a real file → module mode (that file's callable);
  // otherwise treat it as a symbol name (the call graph's convention).
  if (existsSync(arg)) body.path = path.resolve(arg);
  else body.symbol = arg;
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.depth === "string") body.depth = Number(flags.depth);
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  const r = await api<any>("POST", "/impact", body);
  console.log(formatImpact(r));
}

// ------------------------------------------------- coupling metrics (C5)

/**
 * `cidx coupling [project|dir] [--path x] [--limit n]` — project-level fan-in /
 * fan-out over the dependency graph, sectioned into three bands. The positional
 * is a project NAME or an existing dir (which anchors by path, like deadcode
 * does); absent → the daemon resolves the single indexed project.
 */
async function cmdCoupling(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const arg = positionals[0];
  const body: {
    project?: string | undefined;
    path?: string | undefined;
    limit?: number;
  } =
    typeof flags.path === "string"
      ? { path: path.resolve(flags.path) }
      : arg && existsSync(arg) && statSync(arg).isDirectory()
        ? { path: path.resolve(arg) }
        : { project: arg };
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  const r = await api<any>("POST", "/coupling", body);
  console.log(formatCoupling(r));
}

// ------------------------------------------------- hotspot report (C3)

/**
 * `cidx hotspots [project|dir] [--since <git date>] [--limit n]` — the churn ×
 * size hotspot report with dead-code/coupling signals. The positional is a
 * project NAME or an existing dir (which anchors by path, like coupling does);
 * absent → the daemon resolves the single indexed project.
 */
async function cmdHotspots(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const arg = positionals[0];
  const body: {
    project?: string | undefined;
    path?: string | undefined;
    since?: string | undefined;
    limit?: number;
  } =
    typeof flags.path === "string"
      ? { path: path.resolve(flags.path) }
      : arg && existsSync(arg) && statSync(arg).isDirectory()
        ? { path: path.resolve(arg) }
        : { project: arg };
  if (typeof flags.since === "string") body.since = flags.since;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  const r = await api<any>("POST", "/hotspots", body);
  console.log(formatHotspots(r));
}

// -------------------------------------------------- doc conformance (D1)

/**
 * `cidx doccheck [project|path] [--since ref] [--window] [--files a,b] [--ignore a,b]
 *  [--limit n] [--max-chars n] [--no-undocumented] [--judge false] [--last]`
 *
 * Doc–code conformance check. Exit code 1 only when there are drift findings
 * (CI/hook-friendly); needsReview/undocumented never set it. `--last` prints
 * the STORED latest report (the doccheck watch job's snapshot) instead of
 * running a fresh check — its store time is surfaced so a stale snapshot never
 * reads as a fresh check.
 */
async function cmdDoccheck(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const arg = positionals[0];
  const body: {
    project?: string;
    path?: string;
    files?: string[];
    ignore?: string[];
    limit?: number;
    maxChars?: number;
    undocumentedLimit?: number;
    noUndocumented?: boolean;
    since?: string;
    window?: boolean;
    judge?: boolean;
  } = {};
  // A positional that exists on disk → path mode; otherwise a project name.
  if (arg) {
    if (existsSync(arg)) body.path = path.resolve(arg);
    else body.project = arg;
  }
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.since === "string") body.since = flags.since;
  if (flags.window === true) body.window = true;
  if (typeof flags.files === "string" && flags.files.length > 0) {
    body.files = flags.files.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (typeof flags.ignore === "string" && flags.ignore.length > 0) {
    body.ignore = flags.ignore.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags["max-chars"] === "string") body.maxChars = Number(flags["max-chars"]);
  if (typeof flags["undocumented-limit"] === "string") body.undocumentedLimit = Number(flags["undocumented-limit"]);
  if (flags["no-undocumented"] === true) body.noUndocumented = true;
  // D1b: --judge false skips the semantic judge for this call (default-on via config).
  if (flags.judge === true || flags.judge === "true") body.judge = true;
  else if (flags.judge === "false") body.judge = false;
  // D1c watch mode: --last prints the STORED latest report for the project.
  if (flags.last === true) {
    const q = body.project
      ? `project=${encodeURIComponent(body.project)}`
      : body.path
        ? `path=${encodeURIComponent(body.path)}`
        : "";
    const r = await api<{ project: string; ts: number; findings: unknown[]; report: any }>(
      "GET",
      `/doccheck/last${q ? `?${q}` : ""}`,
    );
    // Honesty: the snapshot's store time leads the output — it must never read
    // as a fresh check.
    console.log(formatDocCheckStored(r.project, r.ts, r.report));
    if ((r.report.findings ?? []).length > 0) process.exit(1);
    return;
  }
  const r = await api<any>("POST", "/doccheck", body);
  console.log(formatDocCheck(r));
  if ((r.findings ?? []).length > 0) process.exit(1);
}

async function cmdMcp(): Promise<void> {
  // Starts the stdio bridge, taking over stdio (MCP client ↔ bridge).
  const proc = Bun.spawn({
    cmd: bridgeCommand(import.meta.dir),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const code = await proc.exited;
  process.exit(code);
}

async function cmdStop(): Promise<void> {
  if (!(await ping())) {
    console.log("Daemon is already not running.");
    return;
  }
  await api("POST", "/shutdown");
  console.log("Daemon stopped.");
}

async function cmdConfig(positionals: string[]): Promise<void> {
  if (positionals[0] === "path") {
    console.log(resolveConfigPath() ?? "(no configuration file)");
    return;
  }
  console.log(`Active configuration file: ${CONFIG_SOURCE ?? "(none — defaults)"}\n`);
  console.log(JSON.stringify(RESOLVED, null, 2));
  console.log(`\nEdit it and restart the daemon. For the path: indexer config path`);
}

const CLI_VERSION = "2.5.0";

/** Per-command detailed help catalog (`repodex help <command>` and `<command> --help`). */
interface CmdDoc {
  usage: string;
  summary: string;
  aliases?: string[];
  flags?: [string, string][];
  details?: string[];
  examples?: string[];
}

const COMMANDS: Record<string, CmdDoc> = {
  start: {
    usage: "start [directory]",
    summary: "Starts the daemon in the background if it's not running; if a directory is given, indexes it too.",
    details: [
      "If the daemon is already running (e.g. a systemd service), it says 'already running'.",
      "Logs: <home>/daemon.log. Waits until ready (~30 sec).",
    ],
    examples: ["cidx start", "cidx start ~/projects/backend"],
  },
  index: {
    usage: "index <directory> [--name <name>]",
    summary: "Sends a new indexing job to the running daemon (returns immediately, processes in the background).",
    flags: [["--name <name>", "Project name (if not given, the folder name is used)."]],
    details: [
      "If the same path is already registered, it is reindexed.",
      "If the same name is used for a different path, a unique name is generated (e.g. backend-2).",
      "Searching in other projects continues uninterrupted during indexing.",
    ],
    examples: ["cidx index ~/projects/api --name api", "cidx index ."],
  },
  list: {
    usage: "list",
    summary: "Lists all projects, their statuses (ready/indexing/error) and statistics.",
    aliases: ["ls"],
  },
  status: {
    usage: "status [name]",
    summary: "Shows the status and live progress of a project (or all of them if no name is given).",
    examples: ["cidx status", "cidx status backend"],
  },
  reindex: {
    usage: "reindex <name>",
    summary: "Reindexes the project FROM SCRATCH (table + cache are cleared and rebuilt).",
    details: ["Use it when the embedding model changes or a full refresh is needed."],
  },
  sync: {
    usage: "sync <name>",
    summary: "Incremental sync: indexes only changed/new files, cleans up deleted ones.",
    details: [
      "With the mtime cache, unchanged files are skipped → much faster than a full reindex.",
      "Ideal for catching up on changes that happened while the daemon was down.",
    ],
  },
  remove: {
    usage: "remove <name>",
    summary: "Completely removes the project — registry, LanceDB table, file cache, job records, and all traces.",
    aliases: ["rm"],
    details: [
      "Full deep cleanup: removes the index registry, LanceDB table, file cache, job history, and stale data.",
      "An in-progress indexing is cancelled safely (waited for before the table is dropped).",
      "After removal, the project name becomes available for reuse.",
      "This is irreversible — make sure you meant to remove the project.",
    ],
  },
  search: {
    usage: 'search "<query>" [flags]',
    summary: "Hybrid search: semantic vector + BM25 exact term, merged with RRF.",
    flags: [
      ["--project <name>", "Search only in this project (if not given, ALL projects)."],
      ["--limit <n>", "Maximum number of results (default: 5)."],
      ["--mode <m>", "hybrid (default) | vector (pure semantic) | text (pure BM25)."],
      ["--language <lang>", "Filter by language (e.g. python, typescript, gdscript)."],
      ["--type <type>", "Filter by symbol type (function, class, method, ...)."],
      ["--path <glob>", "File path pattern ('*' wildcard; e.g. 'src/*')."],
      ["--context <n>", "Include ±n surrounding lines (read live from the file) around each result."],
      ["--rerank [bool]", "Second-stage reranker (on by default). --rerank true forces it on; --rerank false skips it for a faster lookup. Auto-disables if no reranker model is configured."],
      ["--mmr [bool]", "MMR diversification (on by default). --mmr true forces it on; --mmr false keeps a pure relevance order. Drops near-duplicate chunks so the top results are distinct."],
      ["--boost [bool]", "Path/surface boost (on by default). --boost true forces it on; --boost false keeps a pure RRF order. Nudges merged results: short paths & src-like roots slightly up, test & generated paths slightly down."],
      ["--max-chars <n>", "Cap returned text to ~n chars: results are kept whole in ranked order while they fit (top-1 always returned). Pair with a higher --limit for recall without bloating output."],
      ["--doc [bool]", "Docstring retrieval legs (on by default where available): results whose docstring/doc comment matched are marked [doc hit]. --doc false skips the doc legs."],
      ["--blame", "Ownership enrichment: stamp each result with lastAuthor / lastCommitDate / churnCommits via one git blame per hit file (≤ 8; extras reported as blameSkipped). Off by default — costs one git call per hit file."],
      ["--expand [bool]", "Query expansion (off by default). --expand turns the query into 2-3 variants with the configured local expansion model (search.expand.model) and merges their rankings — the original query keeps rank dominance. Costs one local LLM round-trip; degrades to the plain base search with an expand note when no model is configured or the call fails."],
    ],
    details: [
      "mode=text requires no model compatibility (uses no vectors); works on old/incompatible indexes.",
      "mode=vector/hybrid requires the index's embedding model to match the active model.",
    ],
    examples: [
      'cidx search "user authentication logic"',
      'cidx search "jwt token generation" --project api --limit 10',
      'cidx search "retry" --mode text --language go --path "src/*"',
      'cidx search "retry backoff" --project api --limit 5 --rerank',
      'cidx search "parseGitBlamePorcelain" --blame --limit 3',
    ],
  },
  open: {
    usage: 'open "<query>" [flags]',
    summary: "Search, then open the chosen result in $VISUAL/$EDITOR at the matching line.",
    flags: [
      ["--pick <n>", "Which result to open, 1-based (default: 1). The full result list is printed first."],
      ["--project <name>", "Search only in this project (if not given, ALL projects)."],
      ["--limit <n>", "Maximum results shown/picked from (default: 10)."],
      ["--mode <m>", "hybrid (default) | vector | text."],
      ["--language <lang>", "Filter by language."],
      ["--type <type>", "Filter by symbol type."],
      ["--path <glob>", "File path pattern ('*' wildcard)."],
      ["--rerank [bool]", "Reranker (on by default). --rerank false skips it."],
      ["--mmr [bool]", "MMR diversification (on by default). --mmr false skips it."],
      ["--boost [bool]", "Path/surface boost (on by default). --boost false keeps a pure RRF order."],
      ["--doc [bool]", "Docstring retrieval legs (on by default where available). --doc false skips them."],
      ["--blame", "Ownership enrichment (lastAuthor / lastCommitDate / churnCommits), same as cidx search --blame."],
      ["--expand [bool]", "Query expansion (off by default), same as cidx search --expand."],
    ],
    details: [
      "Editor is $VISUAL, then $EDITOR, then vi. Line positioning: +<line> for terminal editors",
      "(vim/nano/emacs...), --goto <file>:<line> for the VS Code family, <file>:<line> for Helix.",
      "Set VISUAL='code -w' (or EDITOR='code -w') if you want the CLI to wait for a GUI editor.",
      "Prints the result list, opens the picked one, and exits with the editor's exit code.",
    ],
    examples: [
      'cidx open "retry backoff logic" --project api',
      'cidx open "IndexManager" --pick 2 --mode text',
    ],
  },
  batch: {
    usage: 'batch "<q1>" "<q2>" ... [flags]',
    summary: "Hybrid search for several queries in one round-trip; results grouped per query.",
    flags: [
      ["--project <name>", "Search only in this project (if not given, ALL projects)."],
      ["--limit <n>", "Maximum results PER query (default: 5)."],
      ["--mode <m>", "hybrid (default) | vector (pure semantic) | text (pure BM25)."],
      ["--language <lang>", "Filter by language (e.g. python, typescript, gdscript)."],
      ["--type <type>", "Filter by symbol type (function, class, method, ...)."],
      ["--path <glob>", "File path pattern ('*' wildcard; e.g. 'src/*')."],
      ["--context <n>", "Include ±n surrounding lines around each result."],
      ["--rerank [bool]", "Second-stage reranker (on by default). --rerank false skips it."],
      ["--mmr [bool]", "MMR diversification (on by default). --mmr false keeps pure relevance."],
      ["--boost [bool]", "Path/surface boost (on by default). --boost false keeps a pure RRF order."],
      ["--max-chars <n>", "Character budget applied PER QUERY; results kept whole while they fit."],
      ["--doc [bool]", "Docstring retrieval legs (on by default where available). --doc false skips them."],
      ["--blame", "Ownership enrichment (lastAuthor / lastCommitDate / churnCommits), applied per query; same as cidx search --blame."],
      ["--expand [bool]", "Query expansion (off by default), applied PER QUERY — each query pays its own expansion round-trip."],
    ],
    details: ["Each argument is a separate query; quote multi-word queries. Duplicate queries are de-duped."],
    examples: [
      'cidx batch "user login" "password reset" --project api',
      'cidx batch "jwt" "session" "cookie" --limit 3',
    ],
  },
  pack: {
    usage: 'pack "<query>" [flags]',
    summary: "Context pack: search hits + per-hit file outline + imports + context lines, in ONE call.",
    flags: [
      ["--project <name>", "Search only in this project (if not given, ALL projects)."],
      ["--limit <n>", "Maximum hits considered for the pack (default: 5)."],
      ["--max-chars <n>", "Pack-level character budget (default: 6000); hits are dropped whole to fit, top-1 always kept."],
      ["--context <n>", "Include ±n surrounding lines (read live from the file) around each hit."],
      ["--language <lang>", "Filter the underlying search by language (labels via 'cidx overview' or get_repo_overview)."],
      ["--type <t>", "Filter the underlying search by symbol type (e.g. function, class)."],
      ["--path <glob>", "Filter the underlying search by file path glob (e.g. 'src/*')."],
    ],
    details: [
      "Assembles what an agent otherwise burns 4-6 calls on: search, then per-hit outline + imports + context.",
      "ONE budget over the whole pack — hits are added whole in ranked order while the pack fits; the rest are counted in 'omitted' (never truncated). Internal legs never truncate on top of it.",
    ],
    examples: [
      'cidx pack "retry with backoff" --project api',
      'cidx pack "job queue worker" --limit 8 --max-chars 4000 --context 3',
    ],
  },
  find: {
    usage: "find <symbolName> [flags]",
    summary: "Finds a symbol directly by NAME (exact + prefix). Most precise when you know the exact name.",
    flags: [
      ["--project <name>", "Search only in this project (if not given, all)."],
      ["--limit <n>", "Maximum results (default: 20)."],
      ["--fuzzy [bool]", "Fuzzy fallback when exact + prefix find nothing (default on). --fuzzy false keeps the strict exact/prefix-only behavior."],
      ["--language <lang>", "Filter by language."],
      ["--type <type>", "Filter by symbol type."],
    ],
    details: [
      "Uses no vectors → independent of the embedding model, works on every index.",
      "A typo falls back to an n-gram fuzzy match, marked [⚠ fuzzy]; tables indexed before the fuzzy tier existed need an index job (reindex) to gain it.",
    ],
    examples: ["cidx find loginUser", "cidx find IndexManager --type class"],
  },
  refs: {
    usage: "refs <symbolName> [flags]",
    summary: "Finds where a symbol is USED (call sites + definition) as file:line occurrences.",
    aliases: ["references"],
    flags: [
      ["--project <name>", "Search only in this project (if not given, all)."],
      ["--limit <n>", "Maximum occurrences (default: 50)."],
      ["--no-docs", "Exclude doc artifacts (.md/.xml/...) from the occurrences."],
      ["--language <lang>", "Filter by language."],
      ["--type <type>", "Filter by the containing symbol's type."],
    ],
    details: [
      "Complements 'find' (definition only). Practical whole-identifier matcher over indexed chunks;",
      "may include same-named symbols from other scopes (not full LSP resolution).",
      "The heading is honest about its cap: 'N of M reference(s)' when the limit bites — 'total' is never capped.",
    ],
    examples: ["cidx refs loginUser", "cidx refs IndexManager --project api"],
  },
  overview: {
    usage: "overview [project|dir] [flags]",
    summary: "Structural onboarding summary of a project (languages, symbol types, dirs, entry points).",
    details: [
      "Aggregated from the index (no LLM). Use it to quickly learn 'what is this repo, where to start'.",
    ],
    examples: ["cidx overview api"],
  },
  deps: {
    usage: "deps <file> [flags]",
    summary: "Import graph of a file: what it imports + which indexed files import it.",
    aliases: ["dependencies"],
    flags: [
      ["--project <name>", "Restrict to this project (inferred from the path if not given)."],
      ["--limit <n>", "Cap on 'imported-by' files returned (default: 200)."],
    ],
    details: [
      "Forward edges are parsed from the file's AST and resolved against the indexed set.",
      "Reverse edges come from an on-demand graph cached by file mtime (the first call scans all imports).",
    ],
    examples: ["cidx deps src/core/index-manager.ts", "cidx deps src/server/mcp.ts --project repodex"],
  },
  callgraph: {
    usage: "callgraph <symbol|file> [flags]",
    summary: "Call graph: who calls a symbol and what it calls (bounded, cycle-safe trees).",
    aliases: ["call-graph"],
    flags: [
      ["--project <name>", "Restrict to this project (inferred from the path, or the single indexed project)."],
      ["--direction <d>", "both | callers | callees (default: both)."],
      ["--depth <n>", "Maximum traversal depth, 0 = anchor only (default: 3)."],
      ["--limit <n>", "Cap on nodes per direction (default: 100)."],
    ],
    details: [
      "A file argument centers the graph on every callable symbol in it; any other argument is a symbol name.",
      "Edges come from whole-identifier matching over indexed content (a navigation aid, not full LSP).",
    ],
    examples: [
      "cidx callgraph handleRequest --project repodex",
      "cidx callgraph src/core/index-manager.ts --direction callees --depth 2",
    ],
  },
  impact: {
    usage: "impact <symbol|file> [flags]",
    summary: "Change impact: one ranked answer to 'if I change X, what breaks?'.",
    aliases: ["change-impact"],
    flags: [
      ["--project <name>", "Restrict to this project (inferred from the path, or the single indexed project)."],
      ["--depth <n>", "How many caller levels to follow, 1 = direct callers only (default: 3)."],
      ["--limit <n>", "Cap per section (default: 25); exceeding it prints a truncation warning."],
    ],
    details: [
      "Sections are ranked by severity: direct callers, then files that import the module, then textual mentions.",
      "Test files are listed separately as 'covered by' rather than as production consumers.",
      "Whole-identifier matching (not full LSP): same-named symbols in different scopes are indistinguishable.",
      "Joins the cached call graph, dependency graph and reference pass — no schema change, no reindex.",
    ],
    examples: [
      "cidx impact buildCallEdges --project repodex",
      "cidx impact src/core/impact.ts --depth 2",
    ],
  },
  coupling: {
    usage: "coupling [project|dir] [flags]",
    summary: "Coupling metrics: fan-in/fan-out and instability per file, in three ranked bands.",
    flags: [
      ["--path <dir>", "Alternative to the positional: a dir/file inside the project."],
      ["--limit <n>", "Cap per band (default: 50); exceeding it prints a truncation warning."],
    ],
    details: [
      "topFanIn — most imported; changeMagnets — fan-in >= 2 AND fan-out >= 2 (one change ripples);",
      "unstableLeaves — imported by nothing, importing others. Every band is capped with honest totals;",
      "files with no internal edges are counted ('no band'), not listed.",
      "External/unresolved imports are excluded from the metrics and counted separately per file.",
      "Reuses the dependency graph's mtime cache — the first call per project scans; later calls are free.",
      "CAVEAT: flat (package-indexed) projects give trivially shallow metrics — needs real module structure.",
    ],
    examples: ["cidx coupling repodex", "cidx coupling ~/projects/api --limit 20"],
  },
  hotspots: {
    usage: "hotspots [project|dir] [flags]",
    summary: "Hotspot report: churn x size (a proxy), banded critical/warm/review with debt signals.",
    flags: [
      ["--path <dir>", "Alternative to the positional: a dir/file inside the project."],
      ["--since <date>", "Churn window, git date syntax (default: '90 days ago')."],
      ["--limit <n>", "Cap per band (default: 20); exceeding it prints a truncation warning."],
    ],
    details: [
      "Score = churn x size, log-scaled, on 0-100 — a deliberate PROXY: size is chunk count +",
      "distinct symbol count, NOT cyclomatic complexity. Debt signals adjust the score:",
      "dead-code density and coupling (fan-in + fan-out) promote; test files and entry points",
      "are demoted into review. Bands: critical (>= 50) → warm (>= 25) → review.",
      "Churn runs git log --since live per call; size/dead feeds come from the cached index",
      "snapshot (fresh at reindex). A non-repo degrades to size/debt bands (notARepo reported).",
      "Every cap is surfaced: commitsTruncated (churn walk cap), snapshotTruncated, truncated.",
    ],
    examples: ["cidx hotspots repodex", "cidx hotspots --since '30 days ago' --limit 10"],
  },
  doccheck: {
    usage: "doccheck [project|path] [flags]",
    summary: "Doc–code conformance: resolves markdown claims against the index (deterministic, no LLM).",
    aliases: ["check-docs", "checkdocs"],
    flags: [
      ["--since <ref>", "Drift window: keep only findings whose doc or code side changed since that commit."],
      ["--window", "Anchor the drift window at the docs' own last commit."],
      ["--files <a,b>", "Restrict the doc set (root-anchored globs; default: root *.md + docs/**)."],
      ["--ignore <a,b>", "Doc files/globs to skip."],
      ["--limit <n>", "Max findings/review items kept (default 100)."],
      ["--max-chars <n>", "Char budget over rendered findings (kept whole)."],
      ["--no-undocumented", "Skip the 'exported but undocumented' advisory section."],
      ["--judge false", "Skip the semantic judge for this call even when doccheck.judgeModel is configured."],
      ["--last", "Print the STORED latest report (doccheck watch snapshot) instead of running a fresh check."],
    ],
    details: [
      "Identifier/path/dep/endpoint/cmd/flag/env/config claims from backtick spans, resolved against",
      "the indexed code; a total-resolution miss at confidence >= 90 is a hard drift finding, every",
      "doubt goes to 'needs review'. Historical files, planned regions and fenced examples are never",
      "accused. Exit code 1 only when there are drift findings (CI/hook-friendly).",
      "Evidence comes from the index (lags edits by ~1-2s) — see checked.indexFreshness.",
      "With doccheck.judgeModel set in config, a local instruct model re-judges the uncertain claims",
      "(yes/no logprobs); consistent verdicts drop them out of 'needs review' — the judge never",
      "produces drift findings. Default off.",
      "--last reads the snapshot the doccheck.watch job stored after a successful index/migrate",
      "run (config doccheck.watch, default off) — its store time leads the output; without a",
      "stored report the command fails with a hint instead of pretending to check fresh.",
    ],
    examples: ["cidx doccheck .", "cidx doccheck repodex --window", "cidx doccheck repodex --last"],
  },
  commits: {
    usage: "commits <project|dir> [query] [flags]",
    summary: "Git-history / commit-message search: when/why a feature was added, who changed a file.",
    aliases: ["git-log", "gitlog"],
    flags: [
      ["--query <text>", "Case-insensitive regex on the commit message (or pass it as the 2nd positional)."],
      ["--path <p>", "Only commits that touched this file/path/glob."],
      ["--author <name>", "Case-insensitive regex on the author name/email."],
      ["--since <date>", "git date, e.g. '2 weeks ago' or '2024-01-01'."],
      ["--until <date>", "git date."],
      ["--files", "Also list the changed files per commit."],
      ["--limit <n>", "Maximum commits (default: 50)."],
    ],
    details: [
      "Runs `git log` live in the project directory — no indexing, no embedding, no reindex.",
      "With no query/filters it returns the most recent commits.",
    ],
    examples: [
      'cidx commits repodex "dependency graph"',
      "cidx commits api --path src/auth --since '2 weeks ago' --files",
      "cidx commits api --author alice --limit 20",
    ],
  },
  deadcode: {
    usage: "deadcode [project|dir] [flags]",
    summary: "Potential dead code: zero-reference symbols, scored conservatively (candidates to verify).",
    flags: [
      ["--language <lang>", "Only this language."],
      ["--type <type>", "Only this symbol type (function, method, class, ...)."],
      ["--min-confidence <n>", "Minimum confidence 0-100 to report (default: 0)."],
      ["--limit <n>", "Maximum candidates (default: 200)."],
    ],
    details: [
      "Labels: 'likely dead' (>=70), 'uncertain' (40-69), 'review' (<40).",
      "Test files and entry points are excluded; exported/polymorphic/dynamic names are demoted.",
    ],
    examples: [
      "cidx deadcode repodex --language typescript --min-confidence 70",
      "cidx deadcode api --type function",
    ],
  },
  apidiff: {
    usage: "apidiff <project|dir> <base> [flags]",
    summary: "Public-API diff between two git refs: removed / signature-changed / added symbols.",
    aliases: ["api-diff"],
    flags: [
      ["--head <ref>", "The 'after' ref (default: the working tree as currently indexed)."],
      ["--limit <n>", "Maximum diff entries (default: 200)."],
      ["--max-files <n>", "Cap on files parsed per historical side (default: 1000)."],
      ["--exported-only", "Keep only symbols that look exported on at least one side."],
      ["--all", "Also list the unchanged symbols (they are always counted)."],
    ],
    details: [
      "The base ref's surface is re-parsed from git (ls-tree + show + the same tree-sitter recipe);",
      "the head defaults to the current index, so no reindex is needed.",
      "Removed / signature-changed / visibility-narrowed entries are BREAKING and carry the",
      "before → after signatures. Parameter comparison is approximate (arity + parameter names).",
      "Files that fail to parse at the old ref are listed as 'unparsed' — never skipped silently.",
    ],
    examples: [
      "cidx apidiff api v1.2.0",
      "cidx apidiff api v1.2.0 --head v1.3.0 --exported-only",
      "cidx apidiff api main~5 --limit 50",
    ],
  },
  doctor: {
    usage: "doctor",
    summary: "One read-only diagnostic pass: daemon, embedding backend, models, tables, schema, config, disk.",
    details: [
      "Every check reports ok / warn / fail with a one-line fix hint.",
      "Checks the daemon, the embedding backend (Ollama or llama-server) + the configured embed model, the reranker probe, each project's table and schema freshness (pre-2.4.0 tables get the reindex hint), ANN/FTS index presence, file-cache sanity, orphan tables, config-file validity, and the disk usage of the data root.",
      "Read-only — doctor never mutates anything. Exits 1 only when a check fails.",
    ],
    examples: ["cidx doctor"],
  },
  stats: {
    usage: "stats [project]",
    summary: "Table/disk stats + search analytics: fragments, cache, data-root usage, queries.",
    aliases: ["analytics"],
    details: [
      "Table/disk sections (read-only): per project — registry row count, file-cache count, measured table size, ANN/FTS index presence, lastIndexedAt, pending job; global — data-root total, per-table sizes, meta.db size, embedding-cache rows + estimated size.",
      "Query-log sections (proposal A3): aggregates the daemon's local query log (capped by search.queryLogSize, default 10k rows; 0 = off). Every searchIndex/searchAll call writes one row — batch and context-pack queries log per query.",
      "Zero-hit queries are flagged as possible index gaps: either a bad query or nothing relevant indexed.",
      "Cross-project (searchAll) queries are logged without a project and count toward the global stats only.",
      "Local-only data — nothing leaves ~/.cidx. Many small fragments on a project are the table-maintenance signal: run 'cidx compact <name>'.",
    ],
    examples: ["cidx stats", "cidx stats api"],
  },
  compact: {
    usage: "compact <name>",
    summary: "Compacts a project's table: merges small fragments, prunes old versions, refreshes indices.",
    details: [
      "Runs LanceDB's native optimize inside the per-table write lock — never a hand-rolled rewriter.",
      "Refuses while an index/sync/migrate job runs on the project (the busy rule the watcher deferral also uses).",
      "Safe to call anytime: on an already-compact table it is a fast native no-op and reports 'nothing to do'.",
    ],
    examples: ["cidx compact api"],
  },
  config: {
    usage: "config [path]",
    summary: "Shows the active YAML configuration as JSON; 'path' prints only the file path.",
    examples: ["cidx config", "cidx config path"],
  },
  mcp: {
    usage: "mcp",
    summary: "Starts the stdio MCP bridge (for stdio-expecting clients like Claude Desktop).",
    aliases: ["stdio"],
    details: [
      "The bridge forwards tool calls to the running daemon's Control API; starts the daemon if absent.",
      'Claude Desktop configuration: { "command": "cidx", "args": ["mcp"] }',
    ],
  },
  stop: {
    usage: "stop",
    summary: "Stops the running daemon gracefully (via the Control API).",
    details: ["If installed as a systemd service, the service may restart it; use 'systemctl --user stop cidx'."],
  },
  version: {
    usage: "version",
    summary: "Shows the CLI version and (if running) the daemon version/pid info.",
    aliases: ["--version", "-v"],
  },
  help: {
    usage: "help [command]",
    summary: "Shows the general help or the detailed help for a specific command.",
    examples: ["cidx help", "cidx help search"],
  },
};

const HELP_ORDER = [
  "start", "index", "list", "status", "reindex", "sync", "remove",
  "search", "open", "batch", "pack", "find", "refs", "overview", "deps", "deadcode", "callgraph", "commits", "apidiff", "impact", "coupling", "hotspots", "doccheck", "doctor", "stats", "compact", "config", "mcp", "stop", "version", "help",
];

/** Detailed help for a single command. */
function printCommandHelp(name: string): void {
  const key =
    name === "ls" ? "list"
    : name === "rm" ? "remove"
    : name === "stdio" ? "mcp"
    : name === "references" ? "refs"
    : name === "dependencies" ? "deps"
    : name === "dead-code" ? "deadcode"
    : name === "call-graph" ? "callgraph"
    : name === "change-impact" ? "impact"
    : name === "git-log" || name === "gitlog" ? "commits"
    : name === "api-diff" ? "apidiff"
    : name === "check-docs" || name === "checkdocs" ? "doccheck"
    : name === "analytics" ? "stats"
    : name;
  const doc = COMMANDS[key];
  if (!doc) {
    console.error(`Unknown command: ${name}\n`);
    printHelp();
    return;
  }
  console.log(`\n  ${doc.usage}\n`);
  console.log(`  ${doc.summary}`);
  if (doc.aliases?.length) console.log(`\n  Alias: ${doc.aliases.join(", ")}`);
  if (doc.flags?.length) {
    console.log(`\n  Flags:`);
    for (const [f, d] of doc.flags) console.log(`    ${f.padEnd(20)} ${d}`);
  }
  if (doc.details?.length) {
    console.log(`\n  Notes:`);
    for (const d of doc.details) console.log(`    • ${d}`);
  }
  if (doc.examples?.length) {
    console.log(`\n  Examples:`);
    for (const e of doc.examples) console.log(`    $ ${e}`);
  }
  console.log("");
}

/** Comprehensive general help — everything is reachable from here. */
function printHelp(): void {
  const lines: string[] = [];
  lines.push(`cidx ${CLI_VERSION} — local, multi-project, asynchronous code search daemon`);
  lines.push("");
  lines.push("Indexes codebases with local embeddings (Ollama or llama-server); offers AI agents");
  lines.push("hybrid (semantic + exact-term) search over MCP. A single daemon manages multiple projects.");
  lines.push("");
  lines.push("USAGE");
  lines.push("  cidx <command> [arguments]            (alias: repodex)");
  lines.push("  cidx help <command>                  detailed help for a command");
  lines.push("  cidx <command> --help                same");
  lines.push("");
  lines.push("COMMANDS");
  for (const name of HELP_ORDER) {
    const doc = COMMANDS[name]!;
    lines.push(`  ${doc.usage.padEnd(34)} ${doc.summary}`);
  }
  lines.push("");
  lines.push("SEARCH MODES (search --mode)");
  lines.push("  hybrid   Vector (semantic similarity) + BM25 (exact term), merged with RRF. Default.");
  lines.push("  vector   Semantic vector search only. For natural language queries.");
  lines.push("  text     BM25/exact term only. For rare tokens / exact symbol names; requires no model.");
  lines.push("");
  lines.push("FILTERS (search & find)");
  lines.push("  --language <lang>  e.g. python, typescript, go, rust, gdscript ...");
  lines.push("  --type <type>      function | class | method | interface | enum | struct | ...");
  lines.push("  --path <glob>      file path pattern; '*' wildcard (search only)");
  lines.push("");
  lines.push("EXAMPLES");
  lines.push('  cidx index ~/projects/api --name api');
  lines.push('  cidx status api');
  lines.push('  cidx search "payment flow validation" --project api --limit 10');
  lines.push('  cidx open "payment flow validation" --project api   # search, then open in $EDITOR');
  lines.push('  cidx search "RetryPolicy" --mode text --type class');
  lines.push('  cidx find loginUser');
  lines.push('  cidx refs loginUser              # where is it used (call sites)');
  lines.push('  cidx overview api                # project onboarding summary');
  lines.push('  cidx deps src/server/mcp.ts      # import graph of a file');
  lines.push('  cidx callgraph handleRequest     # caller/callee trees for a function');
  lines.push('  cidx impact handleRequest        # if I change it, what breaks?');
  lines.push('  cidx commits api "login flow"     # git-history / commit-message search');
  lines.push('  cidx deadcode api --min-confidence 70  # potential dead code');
  lines.push('  cidx coupling api                 # fan-in/fan-out bands per file');
  lines.push("  cidx hotspots api                 # churn x size hotspot bands (+ debt signals)");
  lines.push('  cidx apidiff api v1.2.0           # public-API diff between two git refs');
  lines.push('  cidx stats api                   # table/disk stats + search analytics');
  lines.push('  cidx compact api                 # merge small fragments, prune old versions');
  lines.push('  cidx sync api          # fast incremental update');
  lines.push("");
  lines.push("CONNECTING TO AN AI AGENT (MCP)");
  lines.push(`  Streamable HTTP (recommended):  http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/mcp`);
  lines.push(`  SSE (legacy):                http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/sse`);
  lines.push(`  Health + progress:           http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/health`);
  lines.push("  Stdio-expecting clients (Claude Desktop): cidx mcp");
  lines.push("  Tools: search_codebase, search_codebase_batch, find_symbol, find_references,");
  lines.push("            get_file_outline, get_dependencies, get_call_graph, find_dead_code, search_commits,");
  lines.push("            get_api_diff, get_change_impact, get_coupling, get_hotspots, get_context_pack, get_repo_overview,");
  lines.push("            list_indexes, get_index_status, index_project");
  lines.push("");
  lines.push("CONFIGURATION");
  lines.push(`  Active file: ${CONFIG_SOURCE ?? "(none — defaults)"}`);
  lines.push("  Search order: $CIDX_CONFIG → ./cidx.yml → <home>/config.yml (created if absent)");
  lines.push("  Priority: in-code default < YAML < environment variable");
  lines.push("  Show:    cidx config   ·   path only:  cidx config path");
  lines.push("  Add extra ignore rules by placing a .cidxignore at the project root (.gitignore is also obeyed).");
  lines.push("");
  lines.push("ENVIRONMENT VARIABLES (temporary override)");
  lines.push("  CIDX_HOME, CIDX_CONFIG, EMBED_PROVIDER, LLAMACPP_URL, OLLAMA_URL, OLLAMA_MODEL,");
  lines.push("  OLLAMA_NUM_CTX, MCP_PORT, CONTROL_PORT, EMBED_BATCH_SIZE, EMBED_CONCURRENCY,");
  lines.push("  EMBED_CACHE_MAX, MAX_CHUNK_TOKENS, VECTOR_INDEX_THRESHOLD, JOB_CONCURRENCY,");
  lines.push("  RERANK_MODEL, RERANK_URL, RERANK_TOP_K, RERANK_CONCURRENCY, RERANK_NUM_CTX,");
  lines.push("  MMR_LAMBDA, MMR_TOP_K, BOOST_SHORT_PATH, BOOST_SOURCE_ROOT, BOOST_TEST_DEMOTION,");
  lines.push("  BOOST_GENERATED_DEMOTION, QUERY_LOG_SIZE");
  lines.push("");
  lines.push("DATA LOCATION");
  lines.push(`  Root:    ${CONFIG.ROOT_DIR}`);
  lines.push(`  LanceDB: ${CONFIG.DB_DIR}  (idx_<name> per project)`);
  lines.push(`  Meta:    ${CONFIG.META_DB_PATH}  (registry + file cache + job state)`);
  lines.push(`  Log:     ${path.join(CONFIG.ROOT_DIR, "daemon.log")}`);
  lines.push("");
  lines.push("SERVERS");
  lines.push(`  MCP (AI agent):  http://${CONFIG.HOST}:${CONFIG.MCP_PORT}`);
  lines.push(`  Control (CLI):   http://${CONFIG.HOST}:${CONFIG.CONTROL_PORT}`);
  lines.push("");
  lines.push("Detailed architecture and roadmap: see the docs/ folder");
  console.log(lines.join("\n"));
}

/** Prints a doctor report (CLI inline formatter): one line per check + its fix hint. */
function printDoctor(checks: DoctorCheck[]): void {
  const width = checks.reduce((n, c) => Math.max(n, c.title.length), 0);
  for (const c of checks) {
    const badge = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
    console.log(`  ${badge}  ${c.title.padEnd(width)}  ${c.detail ?? ""}`);
    if (c.hint) console.log(`        fix: ${c.hint}`);
  }
}

/**
 * `cidx doctor` — one read-only diagnostic pass (proposal O1).
 * The daemon-owning checks come from `GET /doctor`; the daemon-reachability +
 * version-match check is the only one evaluated here (an unreachable daemon is
 * the one thing the daemon cannot report itself). Exit 0 unless a check fails.
 */
async function cmdDoctor(): Promise<void> {
  let daemonVersion: string | undefined;
  let pid: number | undefined;
  let reachable = false;
  try {
    const r = await fetch(`${BASE}/ping`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const data = (await r.json()) as { version?: string; pid?: number };
      daemonVersion = data.version;
      pid = data.pid;
      reachable = true;
    }
  } catch {
    reachable = false;
  }

  const checks: DoctorCheck[] = [
    daemonCheck({
      reachable,
      cliVersion: CLI_VERSION,
      ...(daemonVersion !== undefined ? { daemonVersion } : {}),
      ...(pid !== undefined ? { pid } : {}),
    }),
  ];
  let report: DoctorReport | null = null;
  if (reachable) {
    try {
      report = await api<DoctorReport>("GET", "/doctor");
    } catch (err) {
      checks.push({
        id: "doctor",
        title: "doctor",
        status: "fail",
        detail: `the daemon's diagnostic pass failed: ${err instanceof Error ? err.message : String(err)}`,
        hint: "check the daemon log (~/.cidx/daemon.log)",
      });
    }
  }

  const all = report ? checks.concat(report.checks) : checks;
  console.log(`\ncidx doctor — daemon ${reachable ? `v${daemonVersion} (pid ${pid})` : "not running"} · data: ${report?.home ?? CONFIG.ROOT_DIR}\n`);
  printDoctor(all);

  const fails = all.filter((c) => c.status === "fail").length;
  const warns = all.filter((c) => c.status === "warn").length;
  if (fails > 0) {
    console.log(`\n${fails} failure${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"} — follow the fix hints above.`);
    process.exit(1);
  }
  console.log(
    warns > 0
      ? `\nNo failures, ${warns} warning${warns === 1 ? "" : "s"}.`
      : "\nAll checks passed.",
  );
}

async function cmdVersion(): Promise<void> {
  console.log(`cidx ${CLI_VERSION}`);
  try {
    const r = await api<{ version: string; pid: number }>("GET", "/ping");
    console.log(`daemon: running (version ${r.version}, pid ${r.pid})`);
  } catch {
    console.log("daemon: not running");
  }
}

/**
 * `cidx stats [project]` — table/disk stats (proposal O3) first, then the
 * search analytics (proposal A3). Two read-only endpoints compose it: the
 * aggregate `GET /stats` (per-project table picture + the global data root,
 * rendered by the exported `formatStatsSections` formatter) and the existing
 * `GET /querylog` (unchanged; rendered by `formatQueryLogStats`). A failed
 * half is reported but does not hide the other half.
 */
async function cmdStats(positionals: string[]): Promise<void> {
  await requireDaemon();
  const project = positionals[0];
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  let failed = false;
  try {
    const stats = await api<StatsReport>("GET", `/stats${query}`);
    for (const section of formatStatsSections(stats)) console.log(section);
  } catch (err) {
    failed = true;
    console.error("Error:", err instanceof Error ? err.message : err);
  }
  try {
    const stats = await api<QueryLogStats>("GET", `/querylog${query}`);
    console.log("");
    console.log(formatQueryLogStats(stats, project ? { project } : undefined));
  } catch (err) {
    failed = true;
    console.error("Error:", err instanceof Error ? err.message : err);
  }
  if (failed) process.exit(1);
}

/**
 * `cidx compact <name>` — native table maintenance (proposal O3) via
 * `POST /compact`: merges small fragments, prunes old versions and refreshes
 * the ANN/FTS indices inside the per-table write lock. Refused (with the
 * server's clear message) while an index/sync/migrate job runs on the project.
 */
async function cmdCompact(positionals: string[]): Promise<void> {
  await requireDaemon();
  const name = positionals[0];
  if (!name) {
    console.error("Usage: cidx compact <name>");
    process.exit(1);
  }
  const r = await api<CompactResult>("POST", "/compact", { name });
  console.log(formatCompactResult(r));
}

// ----------------------------------------------------------------------- main
async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const { positionals, flags } = parseArgs(rest);

  // Global flags: --help/-h on any command shows that command's details.
  if ((flags.help || flags.h) && command && command !== "help") {
    printCommandHelp(command);
    return;
  }
  if (command === "--version" || command === "-v") {
    await cmdVersion();
    return;
  }

  switch (command) {
    case "start": await cmdStart(positionals); break;
    case "index": await cmdIndex(positionals, flags); break;
    case "list": case "ls": await cmdList(); break;
    case "status": await cmdStatus(positionals); break;
    case "reindex": await cmdReindex(positionals); break;
    case "sync": await cmdSync(positionals); break;
    case "remove": case "rm": await cmdRemove(positionals); break;
    case "search": await cmdSearch(positionals, flags); break;
    case "open": await cmdOpen(positionals, flags); break;
    case "batch": await cmdBatch(positionals, flags); break;
    case "pack": await cmdPack(positionals, flags); break;
    case "find": await cmdFind(positionals, flags); break;
    case "refs": case "references": await cmdRefs(positionals, flags); break;
    case "overview": await cmdOverview(positionals, flags); break;
    case "deps": case "dependencies": await cmdDeps(positionals, flags); break;
    case "deadcode": case "dead-code": await cmdDeadcode(positionals, flags); break;
    case "callgraph": case "call-graph": await cmdCallGraph(positionals, flags); break;
    case "impact": case "change-impact": await cmdImpact(positionals, flags); break;
    case "coupling": await cmdCoupling(positionals, flags); break;
    case "hotspots": case "hotspot": await cmdHotspots(positionals, flags); break;
    case "doccheck": case "check-docs": case "checkdocs": await cmdDoccheck(positionals, flags); break;
    case "commits": case "git-log": case "gitlog": await cmdCommits(positionals, flags); break;
    case "apidiff": case "api-diff": await cmdApiDiff(positionals, flags); break;
    case "doctor": await cmdDoctor(); break;
    case "stats": case "analytics": await cmdStats(positionals); break;
    case "compact": await cmdCompact(positionals); break;
    case "config": await cmdConfig(positionals); break;
    case "mcp": case "stdio": await cmdMcp(); break;
    case "stop": await cmdStop(); break;
    case "version": await cmdVersion(); break;
    case "help":
      if (positionals[0]) printCommandHelp(positionals[0]);
      else printHelp();
      break;
    case undefined: printHelp(); break;
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
