#!/usr/bin/env bun
import path from "node:path";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { CONFIG, RESOLVED, CONFIG_SOURCE, resolveConfigPath } from "./config";
import { daemonCommand, bridgeCommand } from "./runtime";

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
    console.error('Usage: cidx search "<query>" [--project x] [--limit n] [--mode hybrid|vector|text] [--language x] [--type x] [--path glob]');
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
  } = { query };
  if (typeof flags.project === "string") body.project = flags.project;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  if (typeof flags.mode === "string") body.mode = flags.mode;
  if (typeof flags.language === "string") body.language = flags.language;
  if (typeof flags.type === "string") body.symbolType = flags.type;
  if (typeof flags.path === "string") body.pathGlob = flags.path;
  if (typeof flags.context === "string") body.contextLines = Number(flags.context);
  const results = await api<any[]>("POST", "/search", body);
  printResults(results);
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

const CLI_VERSION = "2.1.0";

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
      ["--language <lang>", "Filter by language (e.g. python, typescript)."],
      ["--type <type>", "Filter by symbol type (function, class, method, ...)."],
      ["--path <glob>", "File path pattern ('*' wildcard; e.g. 'src/*')."],
      ["--context <n>", "Include ±n surrounding lines (read live from the file) around each result."],
    ],
    details: [
      "mode=text requires no model compatibility (uses no vectors); works on old/incompatible indexes.",
      "mode=vector/hybrid requires the index's embedding model to match the active model.",
    ],
    examples: [
      'cidx search "user authentication logic"',
      'cidx search "jwt token generation" --project api --limit 10',
      'cidx search "retry" --mode text --language go --path "src/*"',
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
    details: ["If installed as a systemd service, the service may restart it; use 'systemctl --user stop mcp-code-indexer'."],
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
  "search", "find", "refs", "overview", "config", "mcp", "stop", "version", "help",
];

/** Detailed help for a single command. */
function printCommandHelp(name: string): void {
  const key = name === "ls" ? "list" : name === "rm" ? "remove" : name === "stdio" ? "mcp" : name === "references" ? "refs" : name;
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
  lines.push(`mcp-code-indexer ${CLI_VERSION} — local, multi-project, asynchronous code search daemon`);
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
  lines.push("  --language <lang>  e.g. python, typescript, go, rust ...");
  lines.push("  --type <type>      function | class | method | interface | enum | struct | ...");
  lines.push("  --path <glob>      file path pattern; '*' wildcard (search only)");
  lines.push("");
  lines.push("EXAMPLES");
  lines.push('  cidx index ~/projects/api --name api');
  lines.push('  cidx status api');
  lines.push('  cidx search "payment flow validation" --project api --limit 10');
  lines.push('  cidx search "RetryPolicy" --mode text --type class');
  lines.push('  cidx find loginUser');
  lines.push('  cidx refs loginUser              # where is it used (call sites)');
  lines.push('  cidx overview api                # project onboarding summary');
  lines.push('  cidx sync api          # fast incremental update');
  lines.push("");
  lines.push("CONNECTING TO AN AI AGENT (MCP)");
  lines.push(`  Streamable HTTP (recommended):  http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/mcp`);
  lines.push(`  SSE (legacy):                http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/sse`);
  lines.push(`  Health + progress:           http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/health`);
  lines.push("  Stdio-expecting clients (Claude Desktop): cidx mcp");
  lines.push("  Tools: search_codebase, find_symbol, find_references, get_repo_overview,");
  lines.push("            list_indexes, get_index_status, index_project, get_file_outline");
  lines.push("");
  lines.push("CONFIGURATION");
  lines.push(`  Active file: ${CONFIG_SOURCE ?? "(none — defaults)"}`);
  lines.push("  Search order: $INDEXER_CONFIG → ./indexer.yml → <home>/config.yml (created if absent)");
  lines.push("  Priority: in-code default < YAML < environment variable");
  lines.push("  Show:    cidx config   ·   path only:  cidx config path");
  lines.push("  Add extra ignore rules by placing a .mcpignore at the project root (.gitignore is also obeyed).");
  lines.push("");
  lines.push("ENVIRONMENT VARIABLES (temporary override)");
  lines.push("  MCP_INDEXER_HOME, OLLAMA_URL, OLLAMA_MODEL, MCP_PORT, CONTROL_PORT,");
  lines.push("  EMBED_BATCH_SIZE, EMBED_CONCURRENCY, EMBED_CACHE_MAX, VECTOR_INDEX_THRESHOLD");
  lines.push("");
  lines.push("DATA LOCATION");
  lines.push(`  Root:    ${CONFIG.ROOT_DIR}`);
  lines.push(`  LanceDB: ${CONFIG.DB_DIR}  (idx_<name> per project)`);
  lines.push(`  Meta:    ${CONFIG.META_DB_PATH}  (registry + file cache + job state)`);
  lines.push(`  Log:     ${path.join(CONFIG.ROOT_DIR, "daemon.log")}`);
  lines.push("");
  lines.push("SERVERS");
  lines.push(`  MCP (AI agent):  http://${CONFIG.HOST}:${CONFIG.MCP_PORT}`);
  lines.push(`  Control (CLI):   http://${CONFIG.HOST}:${CONFIG.CONTROL_PORT}   (127.0.0.1 only)`);
  lines.push("");
  lines.push("Detailed architecture and roadmap: DESIGN.md");
  console.log(lines.join("\n"));
}

async function cmdVersion(): Promise<void> {
  console.log(`cidx (mcp-code-indexer) ${CLI_VERSION}`);
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
    case "find": await cmdFind(positionals, flags); break;
    case "refs": case "references": await cmdRefs(positionals, flags); break;
    case "overview": await cmdOverview(positionals); break;
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
