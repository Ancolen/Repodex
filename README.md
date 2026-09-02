# MCP Code Indexer

[![CI](https://github.com/Ancolen/repodex/actions/workflows/ci.yml/badge.svg)](https://github.com/Ancolen/repodex/actions/workflows/ci.yml)
[![Release](https://github.com/Ancolen/repodex/actions/workflows/release.yml/badge.svg)](https://github.com/Ancolen/repodex/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

A **Bun**-based daemon that vectorizes codebases with a local **Ollama** (`qwen3-embedding`) and exposes them so your AI agents can perform **hybrid (semantic + exact-term) search** over the **Model Context Protocol (MCP)**.

A single long-lived daemon manages **multiple projects**. By sending commands to the running daemon through a thin **CLI**, you can index new projects; while one project is being indexed in the background, you can run **uninterrupted searches** in other projects.

## Features

- 🚀 **Asynchronous daemon** — the server opens instantly, indexing runs in the background on a job queue; while one project is being indexed, search continues uninterrupted in the others. Thanks to a configurable **worker pool** (`jobConcurrency`, default 2), multiple projects can be indexed in parallel; a long/large job does not block other projects.
- 🗂️ **Multi-project** — each project lives in its own isolated LanceDB table (`idx_<name>`); search a single project or all projects.
- 🔎 **Hybrid search** — semantic **vector** + **BM25** exact-term, merged with **RRF**. `hybrid` / `vector` / `text` modes; `language` / `symbolType` / `pathGlob` filters.
- 🎯 **`find_symbol`** — finds a symbol directly by its name (exact + prefix); requires no vector, fully precise.
- 🔗 **`find_references`** — finds where a symbol is **used** (call sites + definition) as `file:line` occurrences; complements `find_symbol` for impact/refactor analysis.
- 🧭 **`get_repo_overview`** — a structural onboarding summary of a project (language distribution, symbol-type breakdown, top-level directories, likely entry points, largest files); aggregated from the index with no LLM.
- 🪟 **Rich results** — each search result carries a derived `signature`, the `indexedAt` freshness stamp, and an optional `--context N` window of surrounding lines read live from the file.
- 🌳 **Smart chunking** — splitting at function/class/method boundaries with `web-tree-sitter` (AST); grammars for 15 languages (JS/TS/TSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Kotlin, Swift, Scala) embedded in the binary. By **descending into namespace/module/mod**, symbols (function/class/struct/interface/enum/record/trait) are extracted correctly in each language. Character-based fallback for languages without a grammar. Results are returned with a `file:line` range.
- ⚡ **Efficient indexing** — batch + bounded parallel embedding, content-hash embedding cache (does not re-embed an unchanged symbol), mtime cache (skips an unchanged file), an ANN vector index + BM25/FTS index on large tables.
- 🔁 **Incremental sync** — `sync` indexes only changed/new files and cleans up deleted ones; catches up at startup on changes made while the daemon was down.
- 👀 **Live watching** — `chokidar` + debounce; supports atomic save/rename; obeys `.gitignore`/`.mcpignore` rules.
- 🌿 **Git awareness** — respects `.gitignore`, optional git-tracked-only files, automatic incremental sync on branch change.
- 💾 **Persistent state** — registry, file cache and job state with `bun:sqlite`; resumes where it left off even if the daemon restarts.
- 🔌 **Multiple transports** — **Streamable HTTP** (`/mcp`, recommended) + **SSE** (`/sse`, legacy) for AI agents; a **stdio bridge** (`cidx mcp`) for clients that expect stdio like Claude Desktop.
- 🔒 **Secure** — all servers listen only on `127.0.0.1`; CORS restricted to localhost + DNS-rebinding protection.
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
curl -fsSL https://raw.githubusercontent.com/Ancolen/repodex/main/web-install.sh | REPODEX_VERSION=v2.0.0 bash
NO_SERVICE=1 ... | bash    # don't install the systemd service (manual only: cidx start)
ASSUME_YES=1 ... | bash    # auto-confirm prompts (headless install)
BIN_DIR=~/bin ... | bash   # choose the directory where cidx/repodex go
```

> For the one-line install to work, at least one **release** (a `v*` tag) must be published in the repo — see [Releases and CI](#releases-and-ci).

### Install from source (with the script)

```bash
git clone <repo-url> mcp-code-indexer
cd mcp-code-indexer
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

`install.sh` manages the daemon as a **systemd user service** (`mcp-code-indexer`):

```bash
systemctl --user status  mcp-code-indexer     # status
systemctl --user restart mcp-code-indexer     # restart (after a config change)
systemctl --user stop    mcp-code-indexer     # stop
journalctl  --user -u    mcp-code-indexer -f  # live log
```

For automatic startup at boot, user `linger` is enabled; manually if needed:

```bash
sudo loginctl enable-linger "$USER"
```

> **daemon service vs `cidx start`:** the systemd service runs and supervises `src/index.ts` (the daemon itself) in the foreground and restarts it if it crashes. `cidx start`, on the other hand, is a helper that starts the daemon in the background if it isn't running — if the service is already running it says "already running". The two can be used together safely.

### Uninstall

```bash
./uninstall.sh                # removes the service and commands, preserves data
PURGE_DATA=1 ./uninstall.sh   # also deletes the ~/.mcp-indexer data
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
| `find <symbolName> [flags]` | Finds a symbol directly by name (exact + prefix) |
| `refs <symbolName> [flags]` | Finds where a symbol is used (call sites + definition) |
| `overview <name>` | Structural onboarding summary of a project |
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
- The **`--language`**, **`--type`**, **`--path`** filters work with `search`; `--language`/`--type` can also be used with `find`.

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
| **Streamable HTTP** | `http://127.0.0.1:3001/mcp` | Current, recommended (stateless) |
| **SSE** (legacy) | `http://127.0.0.1:3001/sse` | Backward compatibility |
| Health + progress | `http://127.0.0.1:3001/health` | Status and job metrics |

For clients that support Streamable HTTP:

```json
{
  "mcpServers": {
    "localCodeIndexer": {
      "url": "http://127.0.0.1:3001/mcp"
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

- `search_codebase(query, project?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?)` — hybrid search; if `project` is not given, in all projects. `mode` = `hybrid`/`vector`/`text`. Each result carries a derived `signature` + `indexedAt`; `contextLines > 0` adds ±N surrounding lines read live from the file.
- `find_symbol(name, project?, limit?, language?, symbolType?)` — finds a symbol by name (exact + prefix).
- `find_references(name, project?, limit?, language?, symbolType?)` — finds where a symbol is used (call sites + definition) as `file:line` occurrences.
- `get_repo_overview(project)` — structural onboarding summary (languages, symbol types, top directories, entry points, largest files).
- `list_indexes()` — lists indexed projects and their statuses.
- `get_index_status(project?)` — indexing status and live progress (% / file).
- `index_project(path, name?)` — the agent itself starts indexing a new directory (in the background).
- `get_file_outline(path)` — the symbol map of a file (function/class/method + line ranges).

### Index freshness (important for agents)

The daemon watches file changes live, but a change is reflected in the index **not instantly** but with a **~1-2 sec delay**. The chain: save detection (`awaitWriteFinish` ~200ms) + debounce (~300ms) + embedding of the changed parts (Ollama, variable by file size) + LanceDB write.

Practical consequences — what AI agents need to know:

- **The index is a DISCOVERY tool** (to find related/similar code, where a symbol is). It is not for reading back content you just wrote yourself.
- **`edit → search` in the same turn**: the new content is most likely not in the index yet; the search may return the old version of the file. To confirm a change you just made, **read the file directly**.
- **Search across turns** (after the user has intervened): since the elapsed time is longer than the indexing delay, the results are up to date.
- If you really need to see an edit reflected in the index, **wait ~2 sec** before searching.

## Configuration

Everything is managed from a **YAML file**. On its first run, the daemon automatically creates `~/.mcp-indexer/config.yml` with comments. Edit it and restart the daemon.

The file is searched in this order:
1. `$INDEXER_CONFIG` (full path)
2. `./indexer.yml` / `./.indexer.yml` (working directory — project-specific setting)
3. `<home>/config.yml` (created here if absent)

To see the active file: `cidx config` (or the path only: `cidx config path`).

> **Where is the data kept?** The default data root is `~/.mcp-indexer/` (config.yml, `db/`, `meta.db`, `daemon.log`).
> With a bun installed via the official installer, `os.homedir()` returns the real `~`, so this path works naturally; no machine-specific path is forced. If you want a different location, set `MCP_INDEXER_HOME` (if you provide it before installation, `install.sh` also passes it to the service and to `cidx`/`repodex`) or edit the `home:` field in `config.yml`.
> (If bun is installed via **snap**, the data ends up in an isolated directory; that's why snap is not supported — see Requirements.)

Example `config.yml`:
```yaml
home: ~/.mcp-indexer          # data root (db + meta.db + log)

server:
  host: 127.0.0.1             # localhost only is recommended
  mcpPort: 3001               # AI agent (MCP/SSE/Streamable HTTP)
  controlPort: 3002           # CLI control API

ollama:
  url: http://127.0.0.1:11434
  model: qwen3-embedding
  batchSize: 8                # number of chunks per embed request
  concurrency: 4              # number of parallel embed requests (bounded pool)

embedding:
  cacheMax: 50000             # max records in the content-hash embedding cache

indexing:
  maxChunkSize: 1500
  overlapSize: 200
  allowedExtensions: [".ts", ".js", ".py", ".go", ".rs", ".java", ".cpp", ".c", ".cs", ".php", ".rb", "..."]
  ignoredDirs: ["node_modules", ".git", "dist", "..."]
  vectorIndexThreshold: 50000 # an ANN vector index is built when a table exceeds this chunk count
  respectGitignore: true      # also obey .gitignore rules
  gitTrackedOnly: false       # if true, index only git-tracked files
  jobConcurrency: 2           # number of projects (jobs) indexed in parallel at the same time

watcher:
  debounceMs: 300
```

**Priority:** in-code defaults < YAML < environment variables. Environment variables can also be used for a quick temporary override: `MCP_INDEXER_HOME`, `OLLAMA_URL`, `OLLAMA_MODEL`, `MCP_PORT`, `CONTROL_PORT`, `EMBED_BATCH_SIZE`, `EMBED_CONCURRENCY`, `EMBED_CACHE_MAX`, `VECTOR_INDEX_THRESHOLD`, `JOB_CONCURRENCY`. You can define additional ignore rules by placing a `.mcpignore` at a project root (`.gitignore` is also obeyed).

> 💡 **Exclude large data folders.** Since `allowedExtensions` includes `.json`, generated/very large JSON data files (e.g. HuggingFace `tokenizer.json`, fixture/static data) get split into thousands of chunks and embedded — this slows down indexing and pollutes search results. Exclude such folders by placing a `.mcpignore` at the project root:
> ```gitignore
> # .mcpignore
> tokenizers/
> **/*.lock
> testdata/
> ```

## Data and Storage

All data is kept under the central `~/.mcp-indexer/`:
- `db/` — LanceDB tables (`idx_<name>` per project)
- `meta.db` — `bun:sqlite`: registry, file cache, job state
- `daemon.log` — daemon logs

To reset, just stop the daemon and delete the `~/.mcp-indexer/` folder.

## Architecture

For detailed architecture, decisions and roadmap, see [`DESIGN.md`](./DESIGN.md) (for the v3 robustness & security fixes see §15; for multi-language symbol extraction + worker pool + mid-file cancellation see §16; for result enrichment + `find_references` + `get_repo_overview` + more languages see §18).

```
CLI client ──HTTP──▶ Control API (127.0.0.1:3002) ─┐
                                                    ├─▶ IndexManager ──▶ JobQueue ──▶ Worker
AI agent ──/mcp · /sse──▶ MCP Server (127.0.0.1:3001) ─┘       │                       │
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

## Releases and CI

There are two GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`) — runs on every push and PR to `main`: `bun install`, `typecheck`, `test`; plus a smoke test (`./dist/cidx version`) that verifies the single binary actually compiles and runs.
- **Release** (`.github/workflows/release.yml`) — runs when a `v*` tag is pushed. Since **native modules** like lancedb are **platform-specific**, the binaries are **not cross-compiled**; each is built on its own native runner:

  | Asset | Runner |
  |-------|--------|
  | `cidx-linux-x64`    | `ubuntu-latest` |
  | `cidx-linux-arm64`  | `ubuntu-24.04-arm` |
  | `cidx-darwin-x64`   | `macos-13` (Intel) |
  | `cidx-darwin-arm64` | `macos-14` (Apple Silicon) |

  Each asset is uploaded to the GitHub Release together with a `.sha256` checksum file. The clone-free one-line install (`web-install.sh`) downloads these assets.

### Publishing a new release

```bash
# update the version in package.json, then:
git tag v2.0.1
git push origin v2.0.1      # triggers the Release workflow
```

When the tag is pushed, binaries for four platforms are built and automatically added to the Release; after that the `curl … | web-install.sh | bash` one-liner becomes usable.

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 Ancolen.

Use, modification and (including commercial) redistribution are free; the license includes patent protection. When distributing, keep the `LICENSE` and `NOTICE` files, and leave a change notice in the files you modified. For details, see the [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) files.

> repodex was developed using **Yuxor AI**.
