#!/usr/bin/env bun
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { CONFIG, RESOLVED, CONFIG_SOURCE, resolveConfigPath } from "./config";
import { daemonCommand, bridgeCommand } from "./runtime";
import { resolveEditor, buildEditorArgs } from "./utils/editor";

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
    console.error('Usage: cidx search "<query>" [--project x] [--limit n] [--mode hybrid|vector|text] [--language x] [--type x] [--path glob] [--rerank] [--mmr] [--max-chars n]');
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
    maxChars?: number;
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
  // --max-chars caps the returned text (results dropped whole to fit; top-1 always kept).
  if (typeof flags["max-chars"] === "string") body.maxChars = Number(flags["max-chars"]);
  const results = await api<any[]>("POST", "/search", body);
  printResults(results);
}

async function cmdOpen(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const query = positionals.join(" ");
  if (!query) {
    console.error('Usage: cidx open "<query>" [--pick n] [--project x] [--mode hybrid|vector|text] [--limit n] [--language x] [--type x] [--path glob] [--rerank] [--mmr]');
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

  const results = await api<any[]>("POST", "/search", body);
  if (results.length === 0) {
    console.log("No results found.");
    return;
  }
  printResults(results);

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
    console.error('Usage: cidx batch "<q1>" "<q2>" ... [--project x] [--limit n] [--mode hybrid|vector|text] [--language x] [--type x] [--path glob] [--max-chars n]');
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
    maxChars?: number;
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
  if (typeof flags["max-chars"] === "string") body.maxChars = Number(flags["max-chars"]);
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
  });
}

async function cmdFind(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  await requireDaemon();
  const name = positionals.join(" ");
  if (!name) {
    console.error('Usage: cidx find <symbolName> [--project x] [--limit n] [--language x] [--type x]');
    process.exit(1);
  }
  const body: { name: string; project?: string; limit?: number; language?: string; symbolType?: string } = { name };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
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
    console.log(`\n${i + 1}. [${r.project}] ${loc}${sym}${score ? `  (${score})` : ""}`);
    if (r.signature) console.log(`   ↳ ${r.signature}`);
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
    console.error("Usage: cidx refs <symbolName> [--project x] [--limit n] [--language x] [--type x]");
    process.exit(1);
  }
  const body: { name: string; project?: string; limit?: number; language?: string; symbolType?: string } = { name };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  const refs = await api<any[]>("POST", "/references", body);
  if (refs.length === 0) {
    console.log("No references found.");
    return;
  }
  console.log(`${refs.length} reference(s):`);
  let lastFile = "";
  for (const r of refs) {
    const fileKey = `${r.project}:${r.filePath}`;
    if (fileKey !== lastFile) {
      console.log(`\n[${r.project}] ${r.filePath}`);
      lastFile = fileKey;
    }
    const ctx = r.inSymbol ? `  (in ${r.inSymbolType ?? "symbol"} ${r.inSymbol})` : "";
    console.log(`  L${r.line}: ${r.text}${ctx}`);
  }
}

async function cmdOverview(positionals: string[]): Promise<void> {
  await requireDaemon();
  const name = positionals[0];
  if (!name) {
    console.error("Usage: cidx overview <name>");
    process.exit(1);
  }
  const o = await api<any>("POST", "/overview", { name });
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
  const project = positionals[0];
  if (!project) {
    console.error(
      "Usage: cidx commits <project> [query] [--path x] [--author x] [--since x] [--until x] [--limit n] [--files]",
    );
    process.exit(1);
  }
  const body: {
    project: string;
    query?: string;
    path?: string;
    author?: string;
    since?: string;
    until?: string;
    withFiles?: boolean;
    limit?: number;
  } = { project };
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
  const project = positionals[0];
  if (!project) {
    console.error("Usage: cidx deadcode <project> [--language x] [--type x] [--min-confidence n] [--limit n]");
    process.exit(1);
  }
  const body: {
    project: string;
    language?: string;
    symbolType?: string;
    minConfidence?: number;
    limit?: number;
  } = { project };
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

const CLI_VERSION = "2.2.0";

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
      ["--max-chars <n>", "Cap returned text to ~n chars: results are kept whole in ranked order while they fit (top-1 always returned). Pair with a higher --limit for recall without bloating output."],
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
      ["--max-chars <n>", "Character budget applied PER QUERY; results kept whole while they fit."],
    ],
    details: ["Each argument is a separate query; quote multi-word queries. Duplicate queries are de-duped."],
    examples: [
      'cidx batch "user login" "password reset" --project api',
      'cidx batch "jwt" "session" "cookie" --limit 3',
    ],
  },
  find: {
    usage: "find <symbolName> [flags]",
    summary: "Finds a symbol directly by NAME (exact + prefix). Most precise when you know the exact name.",
    flags: [
      ["--project <name>", "Search only in this project (if not given, all)."],
      ["--limit <n>", "Maximum results (default: 20)."],
      ["--language <lang>", "Filter by language."],
      ["--type <type>", "Filter by symbol type."],
    ],
    details: ["Uses no vectors → independent of the embedding model, works on every index."],
    examples: ["cidx find loginUser", "cidx find IndexManager --type class"],
  },
  refs: {
    usage: "refs <symbolName> [flags]",
    summary: "Finds where a symbol is USED (call sites + definition) as file:line occurrences.",
    aliases: ["references"],
    flags: [
      ["--project <name>", "Search only in this project (if not given, all)."],
      ["--limit <n>", "Maximum occurrences (default: 50)."],
      ["--language <lang>", "Filter by language."],
      ["--type <type>", "Filter by the containing symbol's type."],
    ],
    details: [
      "Complements 'find' (definition only). Practical whole-identifier matcher over indexed chunks;",
      "may include same-named symbols from other scopes (not full LSP resolution).",
    ],
    examples: ["cidx refs loginUser", "cidx refs IndexManager --project api"],
  },
  overview: {
    usage: "overview <name>",
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
  commits: {
    usage: "commits <project> [query] [flags]",
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
    usage: "deadcode <project> [flags]",
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
  "search", "open", "batch", "find", "refs", "overview", "deps", "deadcode", "callgraph", "commits", "config", "mcp", "stop", "version", "help",
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
    : name === "git-log" || name === "gitlog" ? "commits"
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
  lines.push("Indexes codebases with Ollama embeddings; offers AI agents hybrid (semantic +");
  lines.push("exact-term) search over MCP. A single daemon manages multiple projects.");
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
  lines.push('  cidx commits api "login flow"     # git-history / commit-message search');
  lines.push('  cidx deadcode api --min-confidence 70  # potential dead code');
  lines.push('  cidx sync api          # fast incremental update');
  lines.push("");
  lines.push("CONNECTING TO AN AI AGENT (MCP)");
  lines.push(`  Streamable HTTP (recommended):  http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/mcp`);
  lines.push(`  SSE (legacy):                http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/sse`);
  lines.push(`  Health + progress:           http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/health`);
  lines.push("  Stdio-expecting clients (Claude Desktop): cidx mcp");
  lines.push("  Tools: search_codebase, search_codebase_batch, find_symbol, find_references,");
  lines.push("            get_file_outline, get_dependencies, get_call_graph, find_dead_code, search_commits,");
  lines.push("            get_repo_overview, list_indexes, get_index_status, index_project");
  lines.push("");
  lines.push("CONFIGURATION");
  lines.push(`  Active file: ${CONFIG_SOURCE ?? "(none — defaults)"}`);
  lines.push("  Search order: $CIDX_CONFIG → ./cidx.yml → <home>/config.yml (created if absent)");
  lines.push("  Priority: in-code default < YAML < environment variable");
  lines.push("  Show:    cidx config   ·   path only:  cidx config path");
  lines.push("  Add extra ignore rules by placing a .cidxignore at the project root (.gitignore is also obeyed).");
  lines.push("");
  lines.push("ENVIRONMENT VARIABLES (temporary override)");
  lines.push("  CIDX_HOME, CIDX_CONFIG, OLLAMA_URL, OLLAMA_MODEL, MCP_PORT, CONTROL_PORT,");
  lines.push("  EMBED_BATCH_SIZE, EMBED_CONCURRENCY, EMBED_CACHE_MAX, MAX_CHUNK_TOKENS,");
  lines.push("  VECTOR_INDEX_THRESHOLD, JOB_CONCURRENCY, RERANK_MODEL, RERANK_TOP_K,");
  lines.push("  RERANK_CONCURRENCY, MMR_LAMBDA, MMR_TOP_K");
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

async function cmdVersion(): Promise<void> {
  console.log(`cidx ${CLI_VERSION}`);
  try {
    const r = await api<{ version: string; pid: number }>("GET", "/ping");
    console.log(`daemon: running (version ${r.version}, pid ${r.pid})`);
  } catch {
    console.log("daemon: not running");
  }
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
    case "find": await cmdFind(positionals, flags); break;
    case "refs": case "references": await cmdRefs(positionals, flags); break;
    case "overview": await cmdOverview(positionals); break;
    case "deps": case "dependencies": await cmdDeps(positionals, flags); break;
    case "deadcode": case "dead-code": await cmdDeadcode(positionals, flags); break;
    case "callgraph": case "call-graph": await cmdCallGraph(positionals, flags); break;
    case "commits": case "git-log": case "gitlog": await cmdCommits(positionals, flags); break;
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
