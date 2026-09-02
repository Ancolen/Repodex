# Architecture

The design of `cidx` (`cidx` / `repodex`): a single long-lived Bun daemon that vectorizes codebases with a local Ollama and exposes hybrid code search over MCP.

## Purpose

- A single server (daemon) manages all indexing work.
- New indexing jobs are sent to the running daemon via a thin CLI client.
- While one project is being indexed, search in another continues uninterrupted (async job queue).
- Search quality and indexing efficiency are significantly better than the old single-threaded design.
- The architecture is extensible: new job types, tools, and transports can be added easily.

## Runtime and toolchain

| Topic | Decision | Rationale |
|------|-------|---------|
| Runtime | **Bun** (≥ 1.3) | Native TS execution, fast startup, built-in SQLite, single-binary compilation |
| Language | TypeScript (Bun runs it directly) | `tsx`/`ts-node` unnecessary |
| Persistent store | **`bun:sqlite`** (embedded SQLite) | Atomic, queryable, crash-resilient for registry + job state |
| Vector DB | LanceDB (`@lancedb/lancedb`) | Confirmed to run under Bun (native NAPI test passed) |
| Embedding | Ollama (`qwen3-embedding`), batch API | Local, fast |
| Chunking | **`web-tree-sitter` (WASM)** | Runtime-independent, Bun-safe, no native compilation |
| Distribution | Single executable via `bun build --compile` | Daemon + CLI in one binary |

> **Version pinning (chunking):** `web-tree-sitter@0.22.6` + `tree-sitter-wasms@0.1.13`. The grammars are compiled against the tree-sitter-cli 0.20.x ABI; with web-tree-sitter 0.25+ they throw a `getDylinkMetadata` error. 0.22.6 is compatible.
>
> **GDScript exception (vendored wasm):** `tree-sitter-wasms@0.1.13` (frozen) has no gdscript, so the GDScript grammar is **vendored at `src/chunking/wasm/tree-sitter-gdscript.wasm`** and built by `scripts/build-gdscript-wasm.sh` from `tree-sitter-gdscript@2.0.0` (MIT, PrestonKnopp; Godot-4-capable, external scanner included) — compiled as shipped (`tree-sitter-cli@0.20.8` `build-wasm`, **no `generate`** — regenerating could shift the ABI/node shapes) inside `emscripten/emsdk:3.1.61` docker. The script hard-fails unless `src/parser.c` still declares `LANGUAGE_VERSION 14` (web-tree-sitter 0.22.6 accepts 13–14 only). Built wasm: ~200 KB, sha256 `33e7de5db98e…`. Any grammar bump must re-pass the interleaved-determinism suite (`tests/tree-sitter.test.ts`) — the Lua precedent.

## Core architecture decisions

| Topic | Decision | Rationale |
|------|-------|---------|
| DB location | Central: `~/.cidx/` | The daemon finds all indexes no matter where it runs from |
| Isolation | Separate LanceDB table per project (`idx_<name>`) + central registry | Clean isolation + multi-project search via registry |
| Registry / Job store | `~/.cidx/meta.db` (bun:sqlite) | Atomic, queryable, persistent |
| Indexing | Asynchronous job queue + background worker pool | Server opens instantly, indexing runs in the background |
| Control API | HTTP, **bound to `127.0.0.1` only** | Security: others on the network cannot access it |
| Chunking | web-tree-sitter (AST-based) | Splitting by code structure → highest quality gain |

## High-level data flow

```
CLI client ──HTTP──▶ Control API (127.0.0.1:9372) ─┐
                                                    ├─▶ IndexManager ──▶ JobQueue ──▶ Worker pool
AI agent ──/mcp · /sse──▶ MCP Server (127.0.0.1:9371) ─┘       │                       │
stdio client ──▶ cidx mcp (bridge) ──▶ Control API    Registry (bun:sqlite)    LanceDB (idx_*)
```

**Three sub-programs, one binary.** `src/main.ts` is the `bun build --compile` target and dispatches by first arg: `__daemon` → `src/index.ts`, `__bridge` → `src/stdio-bridge.ts`, anything else → `src/cli.ts`. `src/runtime.ts` detects compiled-vs-dev (`IS_COMPILED` keys off `$bunfs` / `B:\~BUN` in argv) and produces the right spawn command. When editing the CLI↔daemon handoff, keep `runtime.ts` and the matching logic in `cli.ts`/`stdio-bridge.ts` in sync.

**The daemon (`src/index.ts`)** boots `Registry` → `JobQueue` (worker pool) → `IndexManager` (the hub). It opens **two localhost-only HTTP servers before any indexing**, then `restore()`s watchers and re-enqueues half-finished projects:

- **MCP server** (`src/server/mcp.ts`, port 9371): `POST /mcp` Streamable HTTP (stateless), `GET /sse` legacy, `GET /health`. For AI agents.
- **Control API** (`src/server/control-api.ts`, port 9372): JSON endpoints the CLI calls.
- **stdio bridge** (`cidx mcp`, `src/stdio-bridge.ts`): speaks MCP over stdin/stdout, forwards to the Control API, and **auto-starts the daemon if down**. Never logs to stdout (it's the JSON-RPC channel).

**Hub: `IndexManager` (`src/core/index-manager.ts`)** owns per-project chokidar watchers + a `.git/HEAD` branch watcher (auto-syncs on checkout). All mutations go through it: `createIndex` / `reindex` / `syncIndex` **enqueue an async job and return immediately** — search keeps serving while indexing runs. It also implements `searchIndex` / `searchAll` / `findSymbol` / `findReferences` / `repoOverview` and result enrichment. New job types are added via `JobQueue.registerHandler(type, fn)` (see `core/types.ts`); `index` is the only registered type today.

## Persistence split

- **`Registry`** (`src/core/registry.ts`, **`bun:sqlite`**) — `indexes`, `file_cache` (mtime skip), `jobs` (survives restart), `embedding_cache` (content-hash → Float32 BLOB).
- **LanceDB** (`src/services/db.ts`, `~/.cidx/db/`) — one table per project, `idx_<name>`. Fixed schema: every row carries `id, filePath, content, vector, language, symbolName, symbolType, startLine, endLine`.

## Directory layout

```
src/
  index.ts              # daemon entrypoint
  main.ts               # compiled-binary dispatcher (__daemon / __bridge / CLI)
  runtime.ts            # IS_COMPILED detection + spawn commands
  cli.ts                # thin CLI client
  stdio-bridge.ts       # MCP-over-stdio bridge → Control API
  config.ts             # YAML + env config → flattened CONFIG
  server/
    mcp.ts              # MCP / SSE / Streamable HTTP + tool wiring
    control-api.ts      # HTTP API the CLI talks to (127.0.0.1)
    tool-defs.ts        # single source for MCP tool schemas (mcp + bridge)
    format.ts           # single source for result formatters
  core/
    types.ts            # shared types (Job, JobStatus, JobContext, JobHandler)
    job-queue.ts        # async queue + worker pool + handler registry
    index-manager.ts    # registry + project lifecycle + search hub
    registry.ts         # bun:sqlite (meta.db) read/write
  services/
    db.ts               # multi-table LanceDB
    ollama.ts           # batch embedding
    indexer.ts          # file scan + indexing flow (progress + AbortSignal)
    git.ts              # git ls-files + branch detection
    watcher.ts          # chokidar + debounce
  chunking/
    tree-sitter.ts      # web-tree-sitter loader (init + grammar cache + ext→grammar)
    chunker.ts          # AST-based smart chunker + character fallback
    wasm/               # vendored gdscript grammar (built by scripts/build-gdscript-wasm.sh)
  utils/
    hash.ts             # content hash cache
    concurrency.ts      # mapWithConcurrency (bounded parallel, order-preserving, fail-fast)
    rrf.ts              # Reciprocal Rank Fusion (k=60)
    text.ts             # deriveSignature / matchIdentifierLines / escaping
# Language grammars (.wasm) are embedded into the binary via import ... with { type: "file" }.
# 15 grammars come from tree-sitter-wasms (node_modules); gdscript is vendored under
# src/chunking/wasm/ (see the pinning note above for provenance and the ABI guard).
```

## Security model

- Both HTTP servers bind **`127.0.0.1` only** — not exposed to the network.
- **CORS** is restricted to localhost origins (`127.0.0.1` / `localhost` / `[::1]`, any port). Native MCP clients with no `Origin` header (curl, SDK) are allowed; cross-site browser requests are rejected.
- **Streamable HTTP** enables DNS-rebinding protection (`enableDnsRebindingProtection` + explicit `allowedHosts`).
- The daemon is designed for the user's own machine, for their own codebase — it is **not** an externally exposed service.
- Token-based auth is **optional and not yet implemented** (localhost is sufficient); see [`status.md`](./status.md).

> The arbitrary path access of `index_project` / `get_file_outline` is **by design** (the agent must be able to index any project). It is open only to trusted local clients via origin/host control.

## Test strategy

- **Unit tests (`bun test`)** — pure, side-effect-free logic: concurrency, registry (temp sqlite), job-queue + worker pool, chunker, multi-language extraction, tree-sitter, RRF / `buildWhere`, config, indexer, text helpers. They **do not require a running Ollama**. Some load the LanceDB native module, so `bun install` must have run.
- **Integration smoke tests** — verified against real LanceDB after each version, then deleted (see [`changelog.md`](./changelog.md)). Persistent `db` / Control-API integration tests are a proposed addition.

## See also

- **[`../CLAUDE.md`](../CLAUDE.md) → "Critical invariants"** — the load-bearing rules developers must respect when touching persistence, watchers, search, and security. That section is the operational contract; this document is the design.
- [`features.md`](./features.md) for what the tools do; [`status.md`](./status.md) for done / proposed; [`changelog.md`](./changelog.md) for how it got here.
