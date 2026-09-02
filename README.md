# MCP Code Indexer

[![CI](https://github.com/Ancolen/repodex/actions/workflows/ci.yml/badge.svg)](https://github.com/Ancolen/repodex/actions/workflows/ci.yml)
[![Release](https://github.com/Ancolen/repodex/actions/workflows/release.yml/badge.svg)](https://github.com/Ancolen/repodex/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

A **Bun**-based daemon that vectorizes codebases with a local **Ollama** (`qwen3-embedding`) and exposes them so your AI agents can perform **hybrid (semantic + exact-term) search** over the **Model Context Protocol (MCP)**.

A single long-lived daemon manages **multiple projects**. By sending commands to the running daemon through a thin **CLI**, you can index new projects; while one project is being indexed in the background, you can run **uninterrupted searches** in other projects.

**Contents**: [Features](#features) · [Requirements](#requirements) · [Installation](#installation) · [Service management](#automatic-startup-and-service-management) · [Usage](#usage) · [AI-agent setup](#connecting-to-an-ai-agent) · [Configuration](#configuration) · [Data and Storage](#data-and-storage) · [Architecture](#architecture) · [Development](#development) · [Releases](#releases) · [Contributing](#contributing) · [Security](#security) · [License](#license)

## Features

- 🚀 **Asynchronous daemon** — the server opens instantly, indexing runs in the background on a job queue; while one project is being indexed, search continues uninterrupted in the others. Thanks to a configurable **worker pool** (`jobConcurrency`, default 2), multiple projects can be indexed in parallel; a long/large job does not block other projects.
- 🗂️ **Multi-project** — each project lives in its own isolated LanceDB table (`idx_<name>`); search a single project or all projects.
- 🔎 **Hybrid search** — semantic **vector** + **BM25** exact-term, merged with **RRF**. `hybrid` / `vector` / `text` modes; `language` / `symbolType` / `pathGlob` filters; **reranker on by default** for precision and **MMR** to drop near-duplicate results; `--max-chars` caps returned text.
- 🎯 **`find_symbol`** — finds a symbol directly by its name (exact + prefix); requires no vector, fully precise.
- 🔗 **`find_references`** — finds where a symbol is **used** (call sites + definition) as `file:line` occurrences; complements `find_symbol` for impact/refactor analysis.
- 🧭 **`get_repo_overview`** — a structural onboarding summary of a project (language distribution, symbol-type breakdown, top-level directories, likely entry points, largest files); aggregated from the index with no LLM.
- 🧠 **Code intelligence** — `get_dependencies` (a file's import graph: what it imports + who imports it), `get_call_graph` (who calls a symbol and what it calls, as bounded trees), `find_dead_code` (potential dead symbols, scored conservatively), and `search_commits` (git-history / commit-message search — "when/why was X added", file history). All are derived from the existing index or run `git log` live — **no reindex, no schema change**.
- 🪟 **Rich results** — each search result carries a derived `signature`, the `indexedAt` freshness stamp, and an optional `--context N` window of surrounding lines read live from the file.
- 🌳 **Smart chunking** — splitting at function/class/method boundaries with `web-tree-sitter` (AST); grammars for 16 languages (JS/TS/TSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Kotlin, Swift, Scala, GDScript) embedded in the binary. By **descending into namespace/module/mod**, symbols (function/class/struct/interface/enum/record/trait) are extracted correctly in each language. Character-based fallback for languages without a grammar. Results are returned with a `file:line` range.
- 🎮 **Godot support** — GDScript (`.gd`) gets full AST chunking (`class_name`, inner classes, `signal`, `enum`, `func`/`_init`), `extends "res://…"` + `preload`/`load` dependency resolution against the project root, and dead-code scoring that understands engine virtuals (`_ready`, `_process`, …) and editor-connected `_on_*` handlers. Godot text formats — `.gdshader`, `.tscn`, `.tres`, `project.godot` — are indexed with character-based chunking (searchable text, no symbols); the `.godot/` cache directory is ignored.
- ⚡ **Efficient indexing** — batch + bounded parallel embedding, content-hash embedding cache (does not re-embed an unchanged symbol), mtime cache (skips an unchanged file), an ANN vector index + BM25/FTS index on large tables.
- 🔁 **Incremental sync** — `sync` indexes only changed/new files and cleans up deleted ones; catches up at startup on changes made while the daemon was down.
- 👀 **Live watching** — `chokidar` + debounce; supports atomic save/rename; obeys `.gitignore`/`.cidxignore` rules.
- 🌿 **Git awareness** — respects `.gitignore`, optional git-tracked-only files, automatic incremental sync on branch change.
- 💾 **Persistent state** — registry, file cache and job state with `bun:sqlite`; resumes where it left off even if the daemon restarts.
- 🔌 **Multiple transports** — **Streamable HTTP** (`/mcp`, recommended) + **SSE** (`/sse`, legacy) for AI agents; a **stdio bridge** (`cidx mcp`) for clients that expect stdio like Claude Desktop.
- 🔒 **Secure** — both servers listen only on `127.0.0.1`; CORS restricted to localhost + Host-header (DNS-rebinding) protection on every endpoint.
- 📦 **Single binary** — standalone executable via `bun build --compile` (`dist/cidx`); grammars embedded.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 — install **with the official installer**:
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
  > ⚠️ **Do not install via Snap.** Snap gives the app an isolated `HOME` (`~/snap/.../<revision>`); since the revision changes on every update, your data/settings "disappear". If `install.sh` detects a bun installed via snap, it stops the installation and redirects you to the official installer. If you already have a snap bun: `sudo snap remove bun-js` then the official installation above.
- A running [Ollama](https://ollama.com) and the embedding model:
  ```bash
  ollama pull qwen3-embedding
  ```

## Installation

### Quick install — single command, no clone (recommended)

Without cloning the repository, downloads and installs the prebuilt **single-binary** in one line:

```bash
curl -fsSL https://raw.githubusercontent.com/Ancolen/repodex/main/web-install.sh | bash
```

This command (Linux/macOS · x64/arm64):

1. Detects the operating system + architecture and downloads the appropriate binary from **GitHub Releases** (+ verifies sha256).
2. Installs the **`cidx`** command and its alias **`repodex`** to PATH (`~/.local/bin`).
3. Checks **Ollama** and the `qwen3-embedding` model.
4. On Linux, installs a **systemd user service** → the daemon starts automatically on every boot (with `linger`). On macOS, the daemon is started with `cidx start`.
5. Starts the daemon and performs a health check.

> **No Bun or source code needed** — the binary carries everything (including grammars) within itself. You still need a running [Ollama](https://ollama.com) for embeddings: `ollama pull qwen3-embedding`.

Optional environment variables:

```bash
# install a specific version (default: latest release)
curl -fsSL https://raw.githubusercontent.com/Ancolen/repodex/main/web-install.sh | REPODEX_VERSION=v2.2.0 bash
NO_SERVICE=1 ... | bash    # don't install the systemd service (manual only: cidx start)
ASSUME_YES=1 ... | bash    # auto-confirm prompts (headless install)
BIN_DIR=~/bin ... | bash   # choose the directory where cidx/repodex go
```

> For the one-line install to work, at least one **release** (a `v*` tag) must be published in the repo — see [Releases](#releases).

### Install from source (with the script)

```bash
git clone https://github.com/Ancolen/repodex.git cidx
cd cidx
./install.sh          # or: bun run setup
```

`install.sh` handles everything (idempotent — you can run it as many times as you like):

1. Checks **Bun**, installs it if missing.
2. Installs dependencies (`bun install`).
3. Adds the **`cidx`** command and its alias **`repodex`** to PATH.
4. Checks **Ollama** and the `qwen3-embedding` model (offers to download it if missing).
5. Installs a **systemd user service** → the daemon starts automatically on every boot (with `linger`, even when not logged in).
6. Starts the daemon and performs a health check.

After installation, open a new terminal (so PATH is updated) and verify:

```bash
cidx help        # alias: repodex help
cidx list
```

Optional environment variables:

```bash
NO_SERVICE=1 ./install.sh     # don't install automatic startup (manual only: cidx start)
ASSUME_YES=1 ./install.sh     # auto-confirm prompts (CI / headless install)
BIN_DIR=~/bin ./install.sh    # choose the directory where cidx/repodex go
```

### Manual installation

```bash
bun install
bun run src/cli.ts start      # starts the daemon in the background
```

> `bun run src/cli.ts` ≈ `cidx`. With the single-script install, `cidx`/`repodex` are available globally out of the box.

## Automatic startup and service management

`install.sh` manages the daemon as a **systemd user service** (`cidx`):

```bash
systemctl --user status  cidx     # status
systemctl --user restart cidx     # restart (after a config change)
systemctl --user stop    cidx     # stop
journalctl  --user -u    cidx -f  # live log
```

For automatic startup at boot, user `linger` is enabled; manually if needed:

```bash
sudo loginctl enable-linger "$USER"
```

> **daemon service vs `cidx start`:** the systemd service runs and supervises `src/index.ts` (the daemon itself) in the foreground and restarts it if it crashes. `cidx start`, on the other hand, is a helper that starts the daemon in the background if it isn't running — if the service is already running it says "already running". The two can be used together safely.

### Uninstall

```bash
./uninstall.sh                # removes the service and commands, preserves data
PURGE_DATA=1 ./uninstall.sh   # also deletes the ~/.cidx data
```

## Usage

> You can always reach the full list and details of all commands with `cidx help` (or `repodex help`). For the details of a command: `cidx help <command>` or `cidx <command> --help`.

### Commands (summary)

| Command | Description |
|---------|-------------|
| `start [directory]` | Starts the daemon if it isn't running; if a directory is given, indexes it too |
| `index <directory> [--name x]` | Sends a new indexing job to the running daemon (returns immediately) |
| `list` (`ls`) | Lists all projects and their statuses |
| `status [name]` | Shows the status/progress of a project (or all of them) |
| `reindex <name>` | Reindexes the project from scratch |
| `sync <name>` | Incremental sync: updates changed/new + deleted files |
| `remove <name>` (`rm`) | Removes the project and its data |
| `search "<query>" [flags]` | Hybrid search (semantic + BM25), filterable; `--context N` for surrounding lines |
| `batch "<q1>" "<q2>" ... [flags]` | Hybrid search for several queries in one round-trip; results grouped per query |
| `find <symbolName> [flags]` | Finds a symbol directly by name (exact + prefix) |
| `refs <symbolName> [flags]` | Finds where a symbol is used (call sites + definition) |
| `overview <name>` | Structural onboarding summary of a project |
| `deps <file> [flags]` | Import graph of a file: what it imports + which indexed files import it |
| `callgraph <symbol\|file> [flags]` | Call graph: who calls a symbol and what it calls (bounded, cycle-safe trees) |
| `deadcode <project> [flags]` | Potential dead code: zero-reference symbols, scored conservatively |
| `commits <project> [query] [flags]` | Git-history / commit-message search (when/why a feature was added, file history) |
| `config [path]` | Shows the active YAML configuration (or its path) |
| `mcp` (`stdio`) | Starts the stdio MCP bridge (Claude Desktop etc.) |
| `stop` | Stops the daemon |
| `version` | Shows the CLI and daemon version |
| `help [command]` | General or command-specific detailed help |

### 1) Start the daemon

With the single-script install, the daemon is already running (systemd service). Manually:

```bash
cidx start
cidx start /path/project     # also index a project while starting
```

### 2) Index a project (command to the running daemon)

```bash
cidx index /path/project --name backend
```
The command **returns immediately**; indexing continues in the background. Meanwhile you can keep searching in other projects.

### 3) Status / list

```bash
cidx list
cidx status backend          # progress: 63% — 1200/1900
```

### 4) Search

Hybrid (default) — semantic vector + BM25 exact-term:

```bash
cidx search "user authentication logic"               # in all projects
cidx search "jwt token generation" --project backend    # in a single project
cidx search "db connection" --limit 10
```

Modes and filters:

```bash
cidx search "RetryPolicy" --mode text                   # pure BM25/exact term
cidx search "cache strategy" --mode vector               # pure semantic
cidx search "handler" --language go --type function      # language + symbol type filter
cidx search "config" --path "src/*"                      # file path pattern
```

- **`--mode hybrid`** (default): vector + BM25, merged with RRF.
- **`--mode vector`**: semantic only. **`--mode text`**: BM25 only (requires no embedding model; works on old/incompatible indexes too).
- **`--rerank [true|false]`**: a second-stage reranker (a small Qwen3-Reranker model in Ollama) re-scores the top results for higher precision. On by default; auto-disables if no reranker model is configured, and `--rerank false` skips it for a faster lookup.
- **`--mmr [true|false]`**: MMR diversification re-orders the top results so they aren't near-duplicates (e.g. copies of the same function). On by default (`search.mmr.lambda`, default 0.5); `--mmr false` keeps a pure relevance order.
- **`--max-chars <n>`**: cap the returned text to ~n characters — results are kept whole in ranked order while they fit (top-1 always returned), so you can raise `--limit` for recall without bloating output.
- The **`--language`**, **`--type`**, **`--path`** filters work with `search`; `--language`/`--type` can also be used with `find`.

Several queries in one round-trip (`batch` — results grouped per query; same flags as `search`):

```bash
cidx batch "user login" "password reset" "session expiry" --project backend --limit 3
```

Finding a symbol directly by name (most precise when you know the exact name):

```bash
cidx find loginUser
cidx find IndexManager --type class --project backend
```

Finding where a symbol is used, and getting to know a project:

```bash
cidx refs loginUser                      # call sites + definition (file:line)
cidx refs IndexManager --project backend
cidx overview backend                    # languages, symbol types, dirs, entry points
cidx search "retry" --context 3          # ±3 surrounding lines on each result
```

#### Code intelligence (index-derived — no reindex, no schema change)

```bash
cidx deps src/core/index-manager.ts        # import graph: what it imports + who imports it
cidx callgraph searchIndex                 # callers/callees of a function (bounded trees)
cidx callgraph src/core/index-manager.ts --direction callees --depth 2
cidx deadcode backend --min-confidence 70  # potential dead code candidates (verify before deleting)
cidx commits backend "login flow"          # when/why was this feature added
cidx commits backend --path src/auth --since '2 weeks ago' --files   # file history + changed files
```

All of these work against the existing index (`commits` runs `git log` live in the project directory); test files and entry points are excluded from dead-code analysis, and results are labeled `likely dead` / `uncertain` / `review` with the signals that drove the score.

### 5) Incremental sync / reindex / remove

```bash
cidx sync backend            # fast: only changed + deleted files
cidx reindex backend         # full reindex from scratch
cidx remove backend          # remove the project and its data
```

### 6) Configuration / version / stop

```bash
cidx config                  # active YAML configuration (as JSON)
cidx config path             # the file path only
cidx version                 # CLI + daemon version
cidx stop                    # stop the daemon
```

## Connecting to an AI Agent

The daemon offers two HTTP transports (on `127.0.0.1` only):

| Transport | Address | Note |
|-----------|---------|------|
| **Streamable HTTP** | `http://127.0.0.1:9371/mcp` | Current, recommended (stateless) |
| **SSE** (legacy) | `http://127.0.0.1:9371/sse` | Backward compatibility |
| Health + progress | `http://127.0.0.1:9371/health` | Status and job metrics |

For clients that support Streamable HTTP:

```json
{
  "mcpServers": {
    "localCodeIndexer": {
      "url": "http://127.0.0.1:9371/mcp"
    }
  }
}
```

### Clients that expect stdio (e.g. Claude Desktop)

`cidx mcp` starts a **stdio bridge**: it forwards tool calls to the running daemon, and starts the daemon automatically if it isn't running.

```json
{
  "mcpServers": {
    "localCodeIndexer": {
      "command": "cidx",
      "args": ["mcp"]
    }
  }
}
```

### MCP tools exposed to the agent

- `search_codebase(query, project?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?, rerank?, mmr?, maxChars?)` — hybrid search; if `project` is not given, in all projects. `mode` = `hybrid`/`vector`/`text`. Each result carries a derived `signature` + `indexedAt`; `contextLines > 0` adds ±N surrounding lines read live from the file; reranking and MMR diversification are on by default (pass `rerank: false` / `mmr: false` to skip); `maxChars` caps returned text (results kept whole while they fit).
- `search_codebase_batch(queries, project?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?, rerank?, mmr?, maxChars?)` — run several queries in one round-trip; results grouped per query (`## Query: "…"` sections). Same options/behavior as `search_codebase`, applied per query.
- `find_symbol(name, project?, limit?, language?, symbolType?)` — finds a symbol by name (exact + prefix).
- `find_references(name, project?, limit?, language?, symbolType?)` — finds where a symbol is used (call sites + definition) as `file:line` occurrences.
- `get_repo_overview(project)` — structural onboarding summary (languages, symbol types, top directories, entry points, largest files).
- `list_indexes()` — lists indexed projects and their statuses.
- `get_index_status(project?)` — indexing status and live progress (% / file).
- `index_project(path, name?)` — the agent itself starts indexing a new directory (in the background).
- `get_file_outline(path)` — the symbol map of a file (function/class/method + line ranges).
- `get_dependencies(path, project?, limit?)` — a file's import graph: what it imports (resolved against the index) + which indexed files import it (reverse). `project` is inferred from the path; import edges are parsed from the file's AST.
- `get_call_graph(symbol?, path?, project?, direction?, depth?, limit?)` — who calls a symbol and what it calls, as bounded, cycle-safe trees; centers on a symbol name and/or every callable in a file.
- `find_dead_code(project, language?, symbolType?, minConfidence?, limit?)` — potential dead code: zero-reference symbols scored conservatively, labeled `likely dead` / `uncertain` / `review`; test files and entry points excluded.
- `search_commits(project, query?, path?, author?, since?, until?, withFiles?, limit?)` — git-history / commit-message search; runs `git log` live in the project directory (no indexing, no embedding).

### Index freshness (important for agents)

The daemon watches file changes live, but a change is reflected in the index **not instantly** but with a **~1-2 sec delay**. The chain: save detection (`awaitWriteFinish` ~200ms) + debounce (~300ms) + embedding of the changed parts (Ollama, variable by file size) + LanceDB write.

Practical consequences — what AI agents need to know:

- **The index is a DISCOVERY tool** (to find related/similar code, where a symbol is). It is not for reading back content you just wrote yourself.
- **`edit → search` in the same turn**: the new content is most likely not in the index yet; the search may return the old version of the file. To confirm a change you just made, **read the file directly**.
- **Search across turns** (after the user has intervened): since the elapsed time is longer than the indexing delay, the results are up to date.
- If you really need to see an edit reflected in the index, **wait ~2 sec** before searching.

## Configuration

Everything is managed from a **YAML file**. On its first run, the daemon automatically creates `~/.cidx/config.yml` with comments. Edit it and restart the daemon.

The file is searched in this order:
1. `$CIDX_CONFIG` (full path)
2. `./cidx.yml` / `./.cidx.yml` (working directory — project-specific setting)
3. `<home>/config.yml` (created here if absent)

To see the active file: `cidx config` (or the path only: `cidx config path`).

> **Where is the data kept?** The default data root is `~/.cidx/` (config.yml, `db/`, `meta.db`, `daemon.log`).
> With a bun installed via the official installer, `os.homedir()` returns the real `~`, so this path works naturally; no machine-specific path is forced. If you want a different location, set `CIDX_HOME` (if you provide it before installation, `install.sh` also passes it to the service and to `cidx`/`repodex`) or edit the `home:` field in `config.yml`.
> (If bun is installed via **snap**, the data ends up in an isolated directory; that's why snap is not supported — see Requirements.)

Example `config.yml`:
```yaml
home: ~/.cidx          # data root (db + meta.db + log)

server:
  host: 127.0.0.1             # localhost only is recommended
  mcpPort: 9371               # AI agent (MCP/SSE/Streamable HTTP)
  controlPort: 9372           # CLI control API

# ⚠️ SECURITY: keep host on 127.0.0.1. The daemon serves NO authentication —
# changing host (e.g. 0.0.0.0) exposes an API that can read your indexed code,
# index any directory on disk, and shut the daemon down, to your whole network.

ollama:
  url: http://127.0.0.1:11434
  model: qwen3-embedding
  batchSize: 8                # number of chunks per embed request
  concurrency: 4              # number of parallel embed requests (bounded pool)

embedding:
  cacheMax: 50000             # max records in the content-hash embedding cache

search:
  rerank:
    enabled: true             # on by default; auto-disables if the reranker model is absent in Ollama
    model: qwen3-reranker-q8  # causal-LM reranker; scored via yes/no token logprobs
    topK: 20                  # how many candidates to rerank before slicing to limit
    concurrency: 4            # concurrent reranker calls to Ollama
  mmr:
    enabled: true             # diversify the top results (Maximal Marginal Relevance)
    lambda: 0.5               # 1.0 = pure relevance, 0.0 = pure diversity (0.5 dedupes near-duplicates)
    topK: 20                  # how many candidates to diversify over before slicing to limit

indexing:
  maxChunkSize: 1500
  overlapSize: 200
  maxChunkTokens: 512         # approximate per-chunk token cap (effective size = min(maxChunkSize, maxChunkTokens*4)); lower to split big chunks, then reindex
  allowedExtensions: [".ts", ".js", ".py", ".go", ".rs", ".java", ".cpp", ".c", ".cs", ".php", ".rb", ".gd", ".gdshader", ".tscn", ".tres", ".godot", "..."]
  ignoredDirs: ["node_modules", ".git", "dist", ".godot", "..."]
  vectorIndexThreshold: 50000 # an ANN vector index is built when a table exceeds this chunk count
  respectGitignore: true      # also obey .gitignore rules
  gitTrackedOnly: false       # if true, index only git-tracked files
  jobConcurrency: 2           # number of projects (jobs) indexed in parallel at the same time

# NOTE: the YAML list REPLACES the in-code default wholesale — an existing
# config.yml written before Godot support does not pick up the new extensions
# automatically. Add "- .gd", "- .gdshader", "- .tscn", "- .tres", "- .godot"
# (and ".godot" to ignoredDirs) by hand, then reindex.

watcher:
  debounceMs: 300
```

**Priority:** in-code defaults < YAML < environment variables. Environment variables can also be used for a quick temporary override: `CIDX_HOME`, `OLLAMA_URL`, `OLLAMA_MODEL`, `MCP_PORT`, `CONTROL_PORT`, `EMBED_BATCH_SIZE`, `EMBED_CONCURRENCY`, `EMBED_CACHE_MAX`, `MAX_CHUNK_TOKENS`, `VECTOR_INDEX_THRESHOLD`, `JOB_CONCURRENCY`, `RERANK_MODEL`, `RERANK_TOP_K`, `RERANK_CONCURRENCY`, `MMR_LAMBDA`, `MMR_TOP_K`. You can define additional ignore rules by placing a `.cidxignore` at a project root (`.gitignore` is also obeyed).

> 💡 **Exclude large data folders.** Since `allowedExtensions` includes `.json`, generated/very large JSON data files (e.g. HuggingFace `tokenizer.json`, fixture/static data) get split into thousands of chunks and embedded — this slows down indexing and pollutes search results. Exclude such folders by placing a `.cidxignore` at the project root:
> ```gitignore
> # .cidxignore
> tokenizers/
> **/*.lock
> testdata/
> ```

## Per-project configuration (`.cidx.json`)

The global `~/.cidx/config.yml` applies to every project. A project root can carry a **`.cidx.json`** to customize how *that* project is indexed. All fields are optional; invalid values are dropped with a warning and indexing never fails because of the file.

```json
{
  "languages": ["typescript", "gdscript"],
  "ignore": ["vendor/**", "*.gen.ts"],
  "embedModel": "qwen3-embedding:8b-q8_0"
}
```

- **`languages`** — allowlist of language labels (same labels as the `language` search filter: `typescript`, `python`, `gdscript`, `markdown`, …). Files with no label for their extension are dropped while the filter is active; already-indexed files that no longer pass are pruned on the next `sync` (and removed live by the watcher).
- **`ignore`** — extra ignore patterns layered on top of `.gitignore` + `.cidxignore`.
- **`embedModel`** — a per-project embedding model. Set it **before the first index** (the model is pinned to the project at creation). Changing it later escalates the next `sync` to a full reindex, and the watcher skips writes until that reindex runs, so vectors from two models never share a table. Queries are always embedded with the model the table was built with.

The file is read fresh on every index job and watcher event — no daemon restart needed.

## Data and Storage

All data is kept under the central `~/.cidx/`:
- `db/` — LanceDB tables (`idx_<name>` per project)
- `meta.db` — `bun:sqlite`: registry, file cache, job state
- `daemon.log` — daemon logs

To reset, just stop the daemon and delete the `~/.cidx/` folder.

## Architecture

For detailed architecture, decisions, features, and roadmap, see the [`docs/`](./docs/) folder:

- [`docs/architecture.md`](./docs/architecture.md) — design, runtime, core decisions, security model
- [`docs/features.md`](./docs/features.md) — capability catalog (what the tool does)
- [`docs/status.md`](./docs/status.md) — ✅ done / 💡 proposed / ⏸️ deferred roadmap
- [`docs/changelog.md`](./docs/changelog.md) — version history (v1 → v4)
- [`docs/cpu-only-ops.md`](./docs/cpu-only-ops.md) — running Ollama + cidx on a CPU-only machine

```
CLI client ──HTTP──▶ Control API (127.0.0.1:9372) ─┐
                                                    ├─▶ IndexManager ──▶ JobQueue ──▶ Worker
AI agent ──/mcp · /sse──▶ MCP Server (127.0.0.1:9371) ─┘       │                       │
stdio client ──▶ cidx mcp (bridge) ──▶ Control API    Registry (bun:sqlite)    LanceDB (idx_*)
```

## Development

```bash
bun run typecheck     # tsc --noEmit
bun test              # unit tests (concurrency, registry, job-queue + worker pool, chunker, multi-language extraction, tree-sitter, config, indexer, rrf/buildWhere)
bun run dev           # run the daemon with --watch
bun run build:binary  # produce a single executable → dist/cidx (grammars embedded)
```

Once the single binary is built, `dist/cidx` can be run directly; the CLI, daemon and stdio bridge are dispatched within the same binary (`__daemon` / `__bridge` / CLI).

## Releases

Binaries for Linux and macOS (x64 + arm64) are built automatically on each tagged release and published as GitHub Release assets (with sha256 checksums) — that's what the one-line install downloads. For how releases are produced, see [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project ground rules, and the release process.

## Security

This tool is designed to run **locally, for a single user**; both servers are localhost-only and unauthenticated. To report a security issue, please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 Ancolen.

Use, modification and (including commercial) redistribution are free; the license includes patent protection. When distributing, keep the `LICENSE` and `NOTICE` files, and leave a change notice in the files you modified. For details, see the [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) files.

> repodex was developed using **Yuxor AI**.
