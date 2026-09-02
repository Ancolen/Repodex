# MCP Code Indexer — Design and Roadmap

This document contains the architecture decided upon to transform MCP Code Indexer into a multi-project, asynchronous, and smarter code search system built around **a single long-lived daemon**. The project will be rebuilt **from scratch, cleanly** and on the **Bun runtime**.

---

## 1. Purpose

- A single server (daemon) manages all indexing work.
- New folder indexing commands can be sent to the running server via **a thin CLI client**.
- While one project is being indexed, search in another previously indexed project can continue uninterrupted (asynchronous job queue).
- Search quality and indexing efficiency improve significantly.
- The architecture is extensible so that new features (new job types, new tools, new transports) can be added easily in the future.

---

## 2. Runtime and Toolchain

| Topic | Decision | Rationale |
|------|-------|---------|
| Runtime | **Bun** (≥ 1.3) | Native TS execution, fast startup, built-in SQLite, single-binary compilation |
| Language | TypeScript (Bun runs it directly) | `tsx`/`ts-node` unnecessary |
| Persistent store | **`bun:sqlite`** (embedded SQLite) | Atomic, queryable, crash-resilient for registry + job state |
| Vector DB | LanceDB (`@lancedb/lancedb`) | Confirmed to run under Bun (native NAPI test passed) |
| Embedding | Ollama (`qwen3-embedding`), batch API | Local, fast |
| Chunking | **`web-tree-sitter` (WASM)** | Runtime-independent, Bun-safe, no native compilation |
| Distribution | Single executable via `bun build --compile` | Daemon + CLI in one binary |

> **Note:** The old `tsx`/`ts-node`/`.js` extension requirements disappear with Bun. Bun runs TS directly.

---

## 3. What Existed Before / What We Are Changing

The old structure was a flat, single-threaded, blocking design:
- The server did not open until the first indexing completed (synchronous, blocking).
- The CLI argument only specified the directory at startup; no work could be sent to a running server.
- There was no concept of project/index; everything was mixed in a single table.
- Chunking was a flat character window (it split functions in the middle).
- Embeddings were processed one by one, sequentially (slow).

**Decision:** The old `src/` is removed entirely (no legacy folder is kept). Only the *logic* of the proven small parts is carried over into new modules:
- LanceDB connect/insert/delete/search flow
- Ollama embedding call
- chokidar watcher logic
- `ignore` / `.mcpignore` handling
- mtime-based cache idea

---

## 4. Core Architecture Decisions Made

| Topic | Decision | Rationale |
|------|-------|---------|
| DB location | Central: `~/.mcp-indexer/` | The daemon finds all indexes no matter where it runs from |
| Isolation | Separate LanceDB table per project (`idx_<name>`) + central registry | Clean isolation + multi-project search via registry |
| Registry/Job store | `~/.mcp-indexer/meta.db` (bun:sqlite) | Atomic, queryable, persistent |
| Indexing | Asynchronous job queue + background worker | Server opens instantly, indexing runs in the background |
| Control API | HTTP, **bound to `127.0.0.1` only** | Security: others on the network cannot access it |
| Chunking | web-tree-sitter (AST-based) | Splitting by code structure → highest quality gain |

---

## 5. Target Architecture

```
┌─────────────────────────────────────────────────────┐
│              DAEMON (single server, Bun, 24/7)        │
│                                                       │
│  ┌──────────────┐   ┌──────────────────────────────┐ │
│  │  MCP / SSE   │   │   Control API (HTTP, 127.0.0.1)│ │
│  │  (AI agent)  │   │   CLI client connects here     │ │
│  └──────┬───────┘   └──────────┬───────────────────┘ │
│         │                      │                      │
│   ┌─────▼──────────────────────▼─────┐                │
│   │      IndexManager / Registry      │               │
│   │  (each project = separate "index")│               │
│   └─────┬─────────────────────────────┘               │
│         │                                              │
│   ┌─────▼──────┐    ┌──────────────────┐              │
│   │ Job Queue  │───▶│ Background Worker │              │
│   │ (async)    │    │ (chunk+embed)     │              │
│   └────────────┘    └──────────────────┘              │
│                                                        │
│   LanceDB: idx_projectA, idx_projectB, ...             │
│   meta.db (bun:sqlite): registry + job state           │
└────────────────────────────────────────────────────────┘
```

---

## 6. Feature List

### 6.1 Core Architecture
- **Daemon decoupling:** Indexing does not block the `main()` flow; the server opens immediately.
- **Index registry (bun:sqlite):** For each project: name, absolute path, status (`indexing`/`ready`/`error`), file/chunk counts, last indexing time, embedding model + dimension.
- **Project isolation:** Each project in its own LanceDB table (`idx_<name>`).
- **Async job queue:** Indexing/reindex/remove jobs enter a queue; the worker processes them in the background. Searches run uninterrupted in the meantime.
- **Extensible job system:** Handler registry — new job types are added simply by registering a handler.
- **Persistent job/registry state:** When the daemon restarts, interrupted work is known and resumes where it left off.

### 6.2 Thin CLI Client (commands to the running daemon)
```bash
cidx start                          # starts the daemon (if not running)
cidx index ./new-project --name projectB   # sends a job to the daemon, returns instantly
cidx list                           # shows all indexes and their statuses
cidx status projectB                # progress: 63%, 1200/1900 files
cidx reindex projectB               # reindex
cidx remove projectB                # deletes the index
cidx stop                           # stops the daemon
```

### 6.3 Search Quality
- **Smart chunking (web-tree-sitter):** Splitting at function/class/method boundaries. Language grammars are loaded as `.wasm`. Sub-splitting + overlap fallback for very large symbols. Character-based fallback chunker for languages without a grammar.
- **Rich metadata:** For each chunk: `language`, `symbolName`, `symbolType`, `startLine`, `endLine`, `filePath`, `projectName`.
- **Line-numbered results:** The agent sees `auth.ts:42-88 loginUser()` → can jump directly to that line.
- **(v2) Hybrid search:** Vector + BM25 (full-text) + reranking → hits on exact symbol names.

### 6.4 Efficiency
- **Batch + bounded parallel embedding:** Ollama `embed` (batch) API + e.g. a parallel pipeline of 4-8.
- **Content-hash embedding cache:** chunk hash via Bun's built-in hash; symbols that have not changed are not re-embedded even if the file changed.
- **mtime cache:** Skip unchanged files entirely (state in bun:sqlite).
- **Embedding model metadata check:** Automatic "reindex required" warning when the model/dimension changes.

### 6.5 Robustness & Monitoring
- **Git awareness (v2):** Respect `.gitignore`, optional git-tracked-only files, reindex on branch change.
- **Watcher debounce + rename support:** Debounce the burst of events on an editor save; handle move/rename properly.
- **Health endpoint + structured log:** `/health`, job progress metrics.
- **Per-project config:** Project-level settings via `.mcpindex.json` (extra ignore, language filters).

### 6.6 MCP Tool Set (extended)
- `search_codebase(query, project?, limit)` — search in a specific project or in all of them.
- `list_indexes()` — existing projects and their statuses.
- `get_index_status(name)` — indexing progress.
- `index_project(path, name)` — the agent itself triggers a new indexing.
- `get_file_outline(path)` — the symbol map of a file.

### 6.7 Transport
- **HTTP/SSE:** For AI agents.
- **(v2) Stdio bridge:** A thin stdio bridge that proxies to the daemon → for clients that expect stdio, like Claude Desktop.

---

## 7. Security

- The Control API is **bound to `127.0.0.1` only** (not to all interfaces).
- (Optional) Simple token-based authorization.
- The daemon is designed for the user's own machine, for their own codebase; it is not an externally exposed service.

---

## 8. Implementation Phases

| Phase | Scope | Output | Status |
|-----|--------|-------|-------|
| **Phase 0** | Clean Bun skeleton + directory structure + bun:sqlite meta store + migrating the working parts | Compiling/running base | ✅ Done |
| **Phase 1** | Decoupling + async job queue (handler registry) | Server opens immediately, indexing runs in the background | ✅ Done |
| **Phase 2** | Index registry + project isolation (multi-table) + central DB | Multi-project management | ✅ Done |
| **Phase 3** | Control API + thin CLI client | `index`/`list`/`status` commands to the running daemon | ✅ Done |
| **Phase 4** | web-tree-sitter smart chunking + rich metadata + line numbers | Search quality leap | ✅ Done |
| **Phase 5** | Batch/parallel embedding + content-hash cache + model metadata | Speed and efficiency | ✅ Done |
| **Phase 6** | Extended MCP tool set | Agent experience | ✅ Done |
| **v1.1** | Stabilization: parallel embedding, deleted-file cleanup/incremental sync, ANN vector index, watcher race lock, `.gitignore`, test suite | Robustness & speed fixes | ✅ Done (see §11) |
| **v2** | Hybrid search, git awareness, stdio bridge + StreamableHTTP, rename, single-binary | Advanced level | ✅ Done (see §12) |
| **v3 (robustness)** | Post-review data-consistency + security fixes (shrink bug, directory-protection, watcher ignore, remove race, CORS/DNS-rebinding, persist throttle) | Robustness & security | ✅ Done (see §15) |
| **v3.1** | Full multi-language symbol extraction support (descending into namespace/module/mod; C#/C/C++/Ruby + Go struct/interface) + worker pool (parallel jobs) + mid-file cancellation | Language coverage & robustness | ✅ Done (see §16) |
| **v4 (usability)** | Result enrichment (`indexedAt`/`signature`/context lines), `get_repo_overview`, `find_references`, +3 languages (Kotlin/Swift/Scala) | Agent onboarding & discovery | ✅ Done (see §18) |
| **v3+** | Search filters, `find_symbol`, context lines, multiple workers, service installation, etc. | Usability | 💡 Proposal (see §13) |

### v1 definitive scope
Phase 0 + 1 + 2 + 3 + 4 (web-tree-sitter) + 5 (batch embedding, persistent registry) + secure localhost binding.

### Phase 4 notes (smart chunking)
- `web-tree-sitter@0.22.6` + `tree-sitter-wasms@0.1.13`. **Version pinning matters:** the grammars are compiled against the tree-sitter-cli 0.20.x ABI; with web-tree-sitter 0.25+ they throw a `getDylinkMetadata` error. 0.22.6 is compatible.
- Chunk boundaries: top-level function/class; if a class is large, the header + each method as a separate chunk (qualified name `Class.method`). `export`/`decorated` wrappers are stripped.
- Each chunk: `language`, `symbolName`, `symbolType`, `startLine`, `endLine` (fixed schema — all fields in every record for LanceDB).
- Extension without a grammar / parse error → character-based fallback (line-numbered).

### Phase 5 notes (efficiency)
- **Batch embedding:** chunks are fetched via `ollama.embed(input[])` in groups of `EMBED_BATCH_SIZE` (fewer HTTP round-trips).
- **Content-hash cache:** `embedding_cache` (bun:sqlite, `(model, hash)` PK, vector BLOB). The same content is not re-embedded — in a changed file only the changed chunks, and code repeated across files comes for free. Test: a second project with identical content was indexed ~10x faster.
- **Cap:** `EMBED_CACHE_MAX` (default 50k); when exceeded, the oldest records are deleted (prune after each full index).
- **Model/dimension metadata:** `embed_model` + `embed_dim` are written to the index. At search time, if the index's model differs from the active model: `searchIndex` throws an error (reindex warning), `searchAll` skips that project.

### Configuration (YAML)
- All settings are loaded from a YAML file via `src/config.ts`. Priority: **in-code defaults < YAML < environment variables**.
- File search: `$INDEXER_CONFIG` → `./indexer.yml`/`.indexer.yml` → `<home>/config.yml`. If none exist, `<home>/config.yml` is **created automatically** with commented defaults.
- Sections: `home`, `server` (host/mcpPort/controlPort), `ollama` (url/model/batchSize/concurrency), `embedding` (cacheMax), `indexing` (maxChunkSize/overlapSize/allowedExtensions/ignoredDirs/vectorIndexThreshold/respectGitignore/gitTrackedOnly/jobConcurrency), `watcher` (debounceMs).
- The `CONFIG` (flattened) constant stays the same → other modules work unchanged. `cidx config[ path]` shows the active configuration/path.

### Control API contract (Phase 3 — 127.0.0.1:3002 only)
| Method | Path | Description |
|-------|-----|----------|
| GET | `/ping` | Daemon liveness check `{ok, version, pid}` |
| GET | `/indexes` | All projects + live job progress |
| GET | `/indexes/:name` | Status of a single project |
| POST | `/index` | `{path, name?}` → new indexing job (returns instantly) |
| POST | `/reindex` | `{name}` → reindex from scratch |
| DELETE | `/indexes/:name` | Remove the project and its data |
| POST | `/search` | `{query, project?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?}` → hybrid search results |
| POST | `/sync` | `{name}` → incremental sync (v1.1) |
| POST | `/find` | `{name, project?, limit?, language?, symbolType?}` → symbol search (v2) |
| POST | `/outline` | `{path}` → file symbol map (v2) |
| POST | `/references` | `{name, project?, limit?, language?, symbolType?}` → symbol usages (v4) |
| POST | `/overview` | `{name}` → project structural summary (v4) |
| POST | `/shutdown` | Stop the daemon gracefully |

### MCP transports (v2)
| Method | Path | Description |
|-------|-----|----------|
| POST | `/mcp` | Streamable HTTP (stateless) — current/recommended |
| GET | `/sse` | SSE — legacy, backward compatibility |
| POST | `/message` | SSE message channel |
| GET | `/health` | Health + job progress |

### CLI commands
`start [dir]` · `index <dir> [--name x]` · `list` · `status [name]` · `reindex <name>` ·
`sync <name>` (v1.1) · `remove <name>` ·
`search "<query>" [--project x] [--limit n] [--mode hybrid|vector|text] [--language x] [--type x] [--path glob] [--context n]` ·
`find <symbolName> [--project x] [--limit n] [--language x] [--type x]` (v2) ·
`refs <symbolName> [--project x] [--limit n] [--language x] [--type x]` (v4) ·
`overview <name>` (v4) ·
`mcp` (stdio bridge, v2) · `config [path]` · `stop`


---

## 9. Suggested Directory Structure (target)

```
src/
  index.ts              # daemon entrypoint
  cli.ts                # thin CLI client (bun)
  config.ts
  server/
    mcp.ts              # MCP/SSE handler + tool definitions
    control-api.ts      # HTTP API the CLI talks to (127.0.0.1)
  core/
    types.ts            # shared types (Job, JobStatus, JobContext, JobHandler)
    job-queue.ts        # async queue + worker + handler registry
    index-manager.ts    # registry + project lifecycle
    registry.ts         # bun:sqlite (meta.db) read/write
  services/
    db.ts               # multi-table LanceDB
    ollama.ts           # batch embedding
    indexer.ts          # file scan + indexing flow (progress + AbortSignal)
    watcher.ts          # chokidar + debounce
  chunking/
    tree-sitter.ts      # web-tree-sitter loader (init + grammar cache + ext→grammar)
    chunker.ts          # AST-based smart chunker + character fallback
  utils/
    hash.ts             # content hash cache (Phase 5)
# Language grammars (.wasm) are loaded from the `tree-sitter-wasms` package (node_modules).
```

---

## 10. Open / Deferred Topics
- Reranker model selection (RRF applied in hybrid search; cross-encoder rerank deferred to v3).
- Whether token-based auth is needed (localhost is sufficient for now).
- Memory/throttle settings for very large monorepos (the ANN index threshold arrived in v1.1).
- ~~Which language grammars to bundle~~ → in v2, 12 grammars + core wasm were embedded into the binary (§12.5).


---

## 11. v1.1 — Completed Stabilization Fixes

After v1 was completed, the parts that were promised in the design but missing
or error-prone in the code were fixed. All were verified with `bun run typecheck`
+ `bun test` (21 tests).

### 11.1 Parallel embedding (the missing half of Phase 5)
**Problem:** `ollama.concurrency` (default 4) was defined in `config`, and the
Phase 5 notes mentioned "a parallel pipeline of 4-8"; however, `indexFile`
processed embedding batches **completely sequentially** (`for ... await`).
`EMBED_CONCURRENCY` was not used anywhere.

**Solution:**
- New helper: `src/utils/concurrency.ts → mapWithConcurrency(items, limit, worker)`.
  - Returns results **in input order**, **fail-fast** (the first error propagates up),
    with at most `limit` workers running at once.
- `indexFile` now splits the missing embeddings into groups of `EMBED_BATCH_SIZE`
  and sends these groups to Ollama with `EMBED_CONCURRENCY` parallelism.
- **Effect:** Indexing time drops noticeably for files with many chunks / embedding-heavy
  projects; Ollama still is not overwhelmed (bounded pool).

### 11.2 Deleted-file cleanup + incremental sync (data-consistency bug)
**Problem:** If a file was deleted while the daemon was down, `restore()` at startup
only set up the watcher. The deleted file's chunks remained **permanently** in the
LanceDB table and in `file_cache` → stale search results.

**Solution:**
- `Registry.listCachedFiles(indexName): string[]` was added.
- `indexDirectory` now, every time it runs, compares the set of files on disk with
  `file_cache`; it cleans up files **not on disk** (deleted or now ignored by
  `.gitignore`/`.mcpignore`) via `removeFileIndex`. The `IndexResult.deleted` field
  was added and reflected in the job log.
- New **incremental sync** flow: `IndexManager.syncIndex(name)` (`fresh=false`).
  - Unchanged files are skipped via the mtime cache, changed/new files are
    re-indexed, deleted ones are cleaned up. Much faster than a full `reindex`
    (drop+rebuild).
- `restore()` now **incrementally syncs** not only `indexing` (interrupted) projects
  but also `ready` ones at startup → all changes that occurred while the daemon was
  down (add/change/delete) are caught. Search runs uninterrupted on the existing
  data in the meantime.
- Exposed: Control API `POST /sync {name}` and CLI `cidx sync <name>`.

### 11.3 ANN vector index for large tables
**Problem:** `searchTable` called `t.search(vector)` directly; since the table had
no vector index, this was a **brute-force (full scan)**. In large monorepos search
latency grew linearly (an "open topic" in DESIGN §10).

**Solution:**
- `db.ts → ensureVectorIndex(table, minRows)`: if the table row count exceeds
  `minRows` and there is not yet a vector index (checked via `listIndices()`),
  it builds LanceDB's ANN index (usually IVF_PQ, chosen by data type) via
  `table.createIndex("vector")`.
- Called automatically at the end of an indexing job.
- The threshold is configurable: `indexing.vectorIndexThreshold` (default 50000) /
  `VECTOR_INDEX_THRESHOLD` environment variable. Since brute-force is already fast
  on small tables, training cost is not wasted.

### 11.4 Preventing the watcher ↔ full-indexing race
**Problem:** While a project was being fully indexed (the `indexDirectory` job),
the watcher could trigger `indexFile` for the same files; both wrote concurrently
to the same LanceDB table → risk of inconsistency.

**Solution:**
- `WatchOptions.isBusy?: () => boolean` was added.
- `IndexManager.ensureWatcher` passes `isBusy = () => isIndexing(name)` to the
  watcher (an active `queued`/`running` job check).
- When the watcher's debounced timer fires, if `isBusy()` is true it does not
  process the event and **reschedules** it after the debounce interval. Thus the
  background job and the watcher never write at the same time. `add`/`change`/`unlink`
  go through the same scheduling path.

### 11.5 `.gitignore` awareness (pulled forward from v2 — low cost)
- `indexer.buildIgnore` now applies `.gitignore` + `.mcpignore` + global ignores
  together (the `ignore` package). It can be turned off with `indexing.respectGitignore`
  (default `true`). `.mcpignore` is added last (the project-specific final say).

### 11.6 Test suite
- The first working test suite running with `bun test` was added (`tests/`):
  - `concurrency.test.ts` — order preservation, limit, fail-fast.
  - `registry.test.ts` — index CRUD, file cache, `listCachedFiles`, embedding cache
    round-trip + prune, job persistence + `markInterruptedJobs`.
  - `job-queue.test.ts` — handler execution, progress events, cancellation of a
    running/queued job.
  - `chunker.test.ts` — AST boundary chunking + line numbers, fallback, `fileOutline`.
- `"test": "bun test"` was added to `package.json`. Result: **21 pass / 0 fail**.

---

## 12. v2 — Implemented Scope (✅ Completed)

> All v2 items were implemented; `bun run typecheck` is clean, `bun test` passes
> 30/30, and an end-to-end smoke test with the compiled single-binary (real indexing
> + hybrid search + `find_symbol` + StreamableHTTP `/mcp`) was verified.

### 12.1 Hybrid Search (vector + BM25 + RRF) — ✅
**Problem:** Pure vector search is good at semantic proximity, but weak on **exact
symbol names** (`loginUser`, `IndexManager`) or rare tokens. BM25 (exact term)
complements it.

**Implementation:**
- `db.ts`: `ensureFtsIndex(table)` → an `Index.fts()` (BM25) index on the `content`
  column; called alongside `ensureVectorIndex` at the end of each indexing.
- `db.ts`: `searchTableText()` (FTS/`fullTextSearch`); `searchTable()` now takes an
  optional `where` filter. `SearchResult._distance` is optional + `_score` (BM25/RRF)
  was added.
- `utils/rrf.ts`: `rrfMerge()` — Reciprocal Rank Fusion (k=60). Merges the vector and
  BM25 lists rank-based, independent of score scale.
- `index-manager.ts`: `searchOnTable()` offers three modes — **hybrid** (default;
  vector+BM25 → RRF), **vector** (pure semantic), **text** (pure BM25). `searchIndex`/
  `searchAll` now take `SearchOptions`; `rankCombined()` ranks across projects.
- **Rerank:** Since RRF alone made a big difference, cross-encoder rerank was deferred to v3.

**Bonus — search filters + `find_symbol`:**
- `buildWhere(SearchFilters)`: `language`/`symbolType` (equality) + `pathGlob`
  (`*`→SQL `LIKE %`); single-quote escaping (injection safety).
- `mode`, `language`, `symbolType`, `pathGlob` parameters on the `search_codebase` tool.
- New **`find_symbol`** tool: exact+prefix by symbol name (`searchSymbol`, `LIKE`
  scan; requires no vector → independent of model compatibility, fully precise).
- CLI: `cidx search ... --mode/--language/--type/--path`, new `cidx find <name>`.
- Control API: filters on `/search`, new `/find` and `/outline`.

### 12.2 Git Awareness — ✅
- `.gitignore` respect (in v1.1) + `services/git.ts`:
  - `gitTrackedFiles()` (`git ls-files -z`) → when `indexing.gitTrackedOnly: true`,
    only git-tracked files are indexed (`collectFiles(allowSet)`).
  - **Automatic sync on branch change:** `IndexManager` watches `.git/HEAD` for each
    project (`branchWatchers`); on checkout/switch, `syncIndex` (incremental) is
    triggered. Watchers are cleaned up on `removeIndex`/`shutdown`.

### 12.3 Stdio Bridge + StreamableHTTP — ✅
- **Streamable HTTP:** `POST /mcp` was added to `server/mcp.ts` (stateless
  `StreamableHTTPServerTransport`, Server+transport per request). `GET/DELETE /mcp`
  → 405. **SSE (`/sse`) was kept for backward compatibility.**
- **Stdio bridge:** `stdio-bridge.ts` — an MCP server via `StdioServerTransport`;
  forwards tool calls to the daemon Control API over HTTP, and starts the daemon
  automatically if absent. Tool definitions are in `server/tool-defs.ts` (shared
  `TOOL_DEFINITIONS`), formatters in `server/format.ts` from a single source → never
  diverges from the mcp server.
- CLI: `cidx mcp` (alias `stdio`) starts the bridge by taking over stdio;
  `package.json` bin `cidx-mcp`. Claude Desktop: `{ "command": "cidx", "args": ["mcp"] }`.

### 12.4 Watcher Rename/Move Hardening — ✅
- `atomic: true` (editors' temp→rename save) + `awaitWriteFinish` for chokidar
  (do not index a partial write, collapse a large copy/rename into a single event).
- Rename = `unlink`+`add`; thanks to the content-hash cache, the re-embed cost is ~0.

### 12.5 Single-Binary Distribution — ✅
- **wasm embedding:** `chunking/tree-sitter.ts` now embeds the core + 12 grammar
  `.wasm` files via `import ... with { type: "file" }` (the `src/wasm.d.ts` ambient
  type). `bun build --compile` includes these in the binary → no `node_modules`
  dependency at runtime. Works in both dev and compiled modes.
- **Unified entry:** `src/main.ts` dispatcher (`__daemon`/`__bridge`/CLI),
  `src/runtime.ts` (`IS_COMPILED` detection, `userArgs`, `daemonCommand`/`bridgeCommand`).
  The CLI and bridge spawn themselves with `__daemon`/`__bridge` when compiled, with
  `bun run` in dev.
- Build: `bun run build:binary` → `dist/cidx` (single executable).

---

## 13. v3+ — Usability Proposals (result of analysis)

After reviewing the codebase, these are the relatively independent improvements
proposed to make it "more usable", with an approximate impact/effort assessment.

> Note: **Search filters** and **`find_symbol`** were implemented in v2 (see §12.1).

| Proposal | Description | Impact | Effort |
|-------|----------|------|------|
| ~~**Search filters**~~ | ✅ Done in v2 (`language`/`symbolType`/`pathGlob`). | — | — |
| ~~**`find_symbol(name)`**~~ | ✅ Done in v2 (exact + prefix). | — | — |
| ~~**Context lines**~~ | ✅ Done in v4 (`contextLines` param on search; ±N lines read live from disk). See §18.1. | — | — |
| ~~**More languages**~~ | ✅ Done in v4: Kotlin/Swift/Scala added (`.kt/.kts/.swift/.scala/.sc`). Lua deferred — its grammar is unstable in the shared-WASM runtime (§18.4). | — | — |
| ~~**Multi-language symbol quality**~~ | ✅ Done in v3.1: descending into namespace/module/mod + C#/C/C++/Ruby + Go struct/interface naming (see §16.1). | — | — |
| **Token-based chunk boundary** | `MAX_CHUNK_SIZE` is currently characters; huge chunks exceeding the embedding model's token limit can be silently truncated. Approximate token measurement is safer. | Medium | Medium |
| **Query embedding cache** | Cache the query embedding for repeated searches (the content-hash cache infrastructure exists). | Low | Low |
| **Reranker (cross-encoder)** | Re-rank the top N candidates of hybrid search with a small rerank model. RRF is already good; this adds extra precision. | Medium | Medium |
| ~~**Multiple workers**~~ / job priority | ✅ Multiple workers done in v3.1 (`jobConcurrency` worker pool, see §16.3). Job priority (search > index) is still open. | — | — |
| **Service installation** | `cidx install-service` → systemd/launchd unit; the daemon starts automatically at boot. | Medium | Low |
| **`cidx open <result>`** | Opens the search result in the editor at the right line (`$EDITOR file:line`). | Low | Low |
| **Per-project `.mcpindex.json`** | Project-level language filter/extra ignore/embedding model (foreseen in DESIGN §6.5, not yet present). | Medium | Medium |

### Suggested implementation order
1. **Hybrid search (FTS + RRF) + search filters + `find_symbol`** — the biggest quality leap.
2. **Context lines + more languages** — low effort, visible benefit.
3. **Stdio bridge + StreamableHTTP** — compatibility with new clients.
4. **Single-binary** — ease of distribution.
5. **Token-based chunk + per-project config + service installation** — maturation.

---

## 14. Test Strategy

- **Unit tests (existing, `bun test`):** pure/side-effect-free logic — concurrency,
  registry (temporary SQLite file), job-queue, chunker (real tree-sitter wasm).
- **Integration tests that could be added:**
  - `indexer` — end-to-end indexing in a temporary directory with a mock embedding
    function; verifying deleted-file cleanup.
  - `db` — temporary LanceDB; `insertChunks`/`searchTable`/`ensureVectorIndex`.
  - Control API — `/index`, `/sync`, `/search` contract via something like `supertest`.
- **Regression sensitivity:** Because of the version dependency in the Phase 4 notes
  (`web-tree-sitter@0.22.6` ↔ grammar ABI), grammar loading tests provide an early
  warning on version upgrades.


---

## 15. v3 Review — Robustness & Security Fixes (✅ Completed)

After v2 was completed, the codebase was reviewed end to end. Although the design
was adhered to, two serious data-consistency issues and several medium-low level
security/robustness issues were identified and fixed. All were verified with
`bun run typecheck` (clean) + `bun test` (**31/31 pass**), and additionally with
temporary integration smoke tests against real LanceDB.

### 15.1 🔴 Shrinking files left stale chunks behind
**Problem:** `db.ts → insertChunks` deleted old records **by id** (`id IN (...)`).
Since chunk ids are `${filePath}#${i}` (index-based), when a file changed and
produced FEWER chunks (code deleted/refactored), only the new indexes (`#0..#2`)
were deleted and rewritten; the old high-indexed chunks (`#3..#9`) remained
**permanently** in the table → deleted code kept appearing in search results.
Triggered both on the watcher `change` path and on re-indexing of an mtime-changed
file.

**Solution:** `insertChunks` now deletes based on the **filePath** in the records
(`filePath IN (...)` → `add`). All of a file's old chunks are cleaned up regardless
of the new chunk count. (Verified: when a 4-chunk file drops to 2, `#2/#3` are
actually deleted, and other files are preserved.)

### 15.2 🔴 An inaccessible directory silently deleted the entire index
**Problem:** `indexer.ts → indexDirectory` did not check the existence of `baseDir`.
If `readdir` inside `collectFiles` errored, it silently returned an empty list →
the deleted-file cleanup assumed "no files on disk" and **deleted all records in the
table**. Disk unmount, folder moved/deleted, or a permission error → data loss. It
was especially dangerous because `restore()` (syncs all `ready` projects on every
daemon startup) and the branch-watcher `syncIndex` go through this path and do not
pass through the `existsSync` check in the Control API.

**Solution:** A `stat(baseDir)` guard was added at the start of `indexDirectory`.
If the directory does not exist / is not a directory, the job **ends with an error**
(status `error`) and never enters the cleanup step; the existing index is preserved
as is. (Verified: `indexDirectory` throws on a non-existent directory and `file_cache`
remains untouched.)

> Note (out of scope, self-healing): if a single subdirectory is temporarily
> unreadable, `collectFiles` skips it and those files may be counted as "deleted"
> and cleaned up; however, since the source is still on disk, the next successful
> sync re-indexes them.

### 15.3 🟠 The watcher did not obey `.gitignore`/`.mcpignore` rules
**Problem:** While full indexing (`indexDirectory`) respected ignore rules, the
watcher's incremental update path (`indexFile`) only checked **extension + mtime**.
A file excluded by `.gitignore` but with an allowed extension would be indexed by
the watcher when it changed; then the next full sync would delete it because
`collectFiles` excluded it → flapping (in-out) inconsistency between full-index and
incremental-index.

**Solution:** `buildIgnore` and `isPathIgnored` were exported from `indexer.ts`.
`watcher.ts` sets up the ignore matcher once at startup (`.gitignore` + `.mcpignore`
+ global); it does not index ignored files and cleans them from the table if they
were indexed before. Thus the watcher stays consistent with full indexing. (The
rules are read at watcher startup; if they change, the next reindex/sync reflects it.)

### 15.4 🟠 `remove` → `dropTable` race while indexing was in progress
**Problem:** `IndexManager.removeIndex` sent a cancel signal to a running job
(`jobQueue.cancel`) and called `dropTable` **without waiting**. If the handler was
inside `await insertChunks` at that moment, the insert continuing after the table
was dropped could recreate the table and leave an **orphan table** not in the registry.

**Solution:** `JobQueue.waitForJob(id)` was added (a promise resolved when the job
reaches a terminal state; listens for the `"finished"` event). `removeIndex` now,
after `cancel`, waits for the job to actually stop via `await waitForJob(jobId)`,
then performs `dropTable`. Since cancellation is checked at the file boundary, the
single in-progress insert completes and the loop breaks; then the table is dropped
safely.

### 15.5 🟠 Security: wide-open CORS + DNS-rebinding
**Problem:** `mcp.ts` was open to **all origins** via `app.use(cors())`. Even though
the server is bound to 127.0.0.1, a malicious web page in the user's browser could
send a cross-origin request to `http://127.0.0.1:3001/mcp` and call tools
(`index_project`, `get_file_outline` → local file/directory discovery/exfiltration).

**Solution:**
- CORS was restricted to localhost origins only (`127.0.0.1`/`localhost`/`[::1]`,
  with any port). Native MCP clients with no Origin header (curl, SDK) are allowed;
  cross-site browser requests are rejected.
- `enableDnsRebindingProtection: true` + `allowedHosts` were added to
  `StreamableHTTPServerTransport` → only the expected `Host` headers are accepted
  (closes the DNS-rebinding class of attack).
- The Control API is already CORS-free (a browser cross-origin POST is blocked at
  the JSON content-type preflight) and bound only to 127.0.0.1; no extra change was needed.

> The arbitrary path access of `index_project`/`get_file_outline` is **by design**
> (the agent must be able to index any project); it is now open only to trusted local
> clients via origin/host control. Token-based auth is still optional (§7) and can be
> added in the future.

### 15.6 🟠 Progress was written to SQLite on every file (perf)
**Problem:** `JobQueue` `updateProgress` called `persist(job)` on every file; in a
project with thousands of files this meant thousands of synchronous SQLite writes.

**Solution:** Progress persistence was throttled (`PROGRESS_PERSIST_MS = 1000`). The
in-memory job object stays instantly current on every call (for live `/health` and
`activeJob`) and the `"progress"` event is always emitted; SQLite is written at most
once per second. The final progress is persisted in any case inside `finish()`.
(On restart the interrupted job is already marked `failed` by `markInterruptedJobs`,
so persisting intermediate progress to disk is not critical.)

### 15.7 🟡 Low-level hardening
- **Per-table write lock:** `lockTable(table, fn)` was added to `db.ts`; `insertChunks`
  and `deleteFileRecords` run serially for the same table. Prevents the race where
  concurrent first-inserts `createTable` the same table at the same time (like the
  watcher processing two new files simultaneously). Complements the `isBusy`
  (watcher↔full-index) protection.
- **LIKE wildcard escaping:** `searchSymbol` and `buildWhere(pathGlob)` escape LIKE
  meta-characters (`\`, `%`, `_`) in user input and add `ESCAPE '\'`. Previously the
  `_` in snake_case symbol names behaved like "any single character" and produced
  false positives (e.g. `get_user` → `getXuser`). (Verified: a `get_user` search no
  longer matches `getXuser`.)
- **Graceful shutdown:** `index.ts → shutdown` now calls `jobQueue.abortAll()` (abort
  signal to running jobs) and `registry.close()` (clean SQLite shutdown). In-progress
  file writes stop at the file boundary.
- **Log fix:** The daemon startup log shows the MCP address as `/mcp` (Streamable
  HTTP, recommended) instead of `/sse`.

### 15.8 Intentionally left unchanged
- **Shared tree-sitter parser** (`tree-sitter.ts`): a single `sharedParser`; since
  there is no `await` between `setLanguage` and `parse` (JS is single-threaded, a
  synchronous block cannot be interleaved), it is safe for concurrent `chunkCode`
  calls. If multiple workers (the v3 proposal) are added, it must switch to a parser
  pool — noted in a code comment.
- **Structured (JSON) log:** Logs remained as plain `console.error` strings;
  structured logging was left out of scope (a disproportionate change).
- **`gitTrackedOnly` in the watcher:** The watcher does not apply the git-tracked
  filter (it still indexes new/untracked files); this filter remained specific to
  full indexing.

### 15.9 Tests
- `tests/hybrid.test.ts`: `buildWhere` tests were updated with the `ESCAPE '\'` suffix;
  a new test was added for literal `_` escaping (**31 tests** total).
- Temporary integration smoke tests (deleted after verification): on real LanceDB,
  the shrink-change (#15.1), `deleteFileRecords`, `searchSymbol` `_` escaping (#15.7),
  `ESCAPE`'d `LIKE where` syntax; and `Registry` with directory-protection (#15.2).
  All passed. (These can be turned into the persistent `db` integration tests in §14.)


---

## 16. v3.1 — Full Multi-language Symbol Extraction Support + Worker Pool + Mid-file Cancellation (✅ Completed)

While testing indexing/search on real multi-language codebases (`/home/user/projects`:
Go, Rust, C#, Python, TS, JS), it was found that the chunker could not extract symbols
in some languages, and there were cancellation/throughput issues with large files.
All were fixed. `bun run typecheck` is clean, `bun test` **85/85 pass** (288 expect);
additionally verified end to end with real projects on a live daemon (C# `PlanktonService`,
Go `OllamaTokenizerService`).

### 16.1 🔴 Multi-language symbol extraction was missing/incorrect

**Problem:** `chunker.ts → astChunks` classified only **root-level** (`root.namedChildren`)
nodes, and `nameOf` read only the direct `name` field. Therefore:

- **C#:** Since all types are inside `namespace { ... }`, the namespace remained a
  single "loose" node; **no symbols were extracted** (a 36 KB `Program.cs` fell back
  to character-chunking). In the live test, `c_sharp named=0`.
- **C / C++:** Since the function name is embedded inside `function_declarator`,
  `nameOf` could not find it → free functions came out **unnamed** (only the class
  was named).
- **Ruby:** `def`/`class` are `method`/`class` node types in the AST; these were not
  in the `FUNCTION_LIKE`/`CLASS_LIKE` sets → **no symbols were extracted at all**.
- **Go:** The name of `type Server struct {...}` is in the `type_spec` child;
  `type_declaration` does not carry a direct `name` field → struct/interface types
  remained **unnamed**.

**Solution:** `chunker.ts` was rewritten around a recursive walker (`walk`):

- **Container descent:** A new `CONTAINER` set (`namespace_declaration`,
  `file_scoped_namespace_declaration`, `namespace_definition`, `linkage_specification`,
  `module`, `internal_module`, `mod_item`) — these nodes are not emitted as symbols;
  their bodies are descended into **recursively** and the types/functions inside are
  processed as if top-level (depth-protected). This extracts the contents of C#
  namespaces, C++/PHP namespaces, Ruby `module`, Rust `mod`, and TS `namespace`.
- **Extended sets:** `CLASS_LIKE` += `record_declaration`, `struct_declaration`,
  `enum_item`, `union_specifier`, `class` (Ruby); `FUNCTION_LIKE` +=
  `destructor_declaration`, `operator_declaration`, `local_function_statement`,
  `method`, `singleton_method` (Ruby); `WRAPPERS` += `template_declaration`
  (C++ `template<...> <decl>` is stripped).
- **Robust `nameOf`:** if there is no `name` field, it follows the **`declarator`
  chain** (C/C++ `function_declarator → ... → identifier`); if still none, it falls
  back to the first identifier-like child.
- **Go type groups:** `emitGoTypeDecl` emits each `type_spec` inside a `type_declaration`
  as a separate symbol; it inspects the `type` field to determine `struct` / `interface`
  / `type` symbol type.

**Result (live, real projects):**
- C# `PlanktonService`: `named=58` — `class:MetricsService`,
  `method:MetricsService.TrackHttpRequest`, `interface:IGeminiService` … (was 0 before).
- Go `OllamaTokenizerService`: `struct:Handler`, `struct:HealthResponse`,
  `interface:…`, `function:…`, `method:…` (previously only func/method).
- In unit tests, symbol extraction was verified for Python, Rust, Java, PHP, JS,
  TS/TSX, C, C++, Ruby, Go, and for TS-namespace/Rust-mod content (`tests/languages.test.ts`).

> Note: Small classes (under MAX) remain a single chunk; methods are split into
> separate `Class.method` chunks only when the class exceeds MAX — this behavior is
> consistent across all languages (preserves embedding context). In Ruby, since all
> `def`s have node type `method`, `symbolType` is tagged as `method`.

### 16.2 🟠 `indexFile` did not listen to the mid-file cancel signal

**Problem:** `indexDirectory` checked the cancel signal only **between files**.
`indexFile` processed all the embedding batches of a single file without a signal
check. While a very large file (e.g. a 20 MB `tokenizer.json` → ~13k chunks) was
being processed, a `remove`/`reindex` cancellation **blocked for minutes** until that
file finished (the single worker also locked up).

**Solution:** `indexFile(target, filePath, registry?, signal?)` now takes an
`AbortSignal`; it checks (1) at the start, (2) **before each embedding batch** (in the
`mapWithConcurrency` worker), and (3) after embedding. If cancelled, the remaining
batches are not embedded and partial data is not written (safe, since cancellation
drops the table anyway). The cancellation delay is bounded to at most one in-flight
batch. `indexDirectory` passes the signal to `indexFile`; the watcher call (without
a signal) runs unchanged.

### 16.3 🟠 A single worker, one stuck job blocked all projects

**Problem:** `JobQueue` ran with a single worker (the `process()` loop). While a
large/slow indexing job was running, all other projects' jobs waited in the queue.

**Solution:** `JobQueue` was turned into a **worker pool**. The pool size is configured
via `JobQueueOptions.concurrency` (default **1** — backward compatible); instead of
`process()`, `pump()` runs at most `maxWorkers` jobs at once and refills the pool as
each job finishes. The daemon passes the `indexing.jobConcurrency` (YAML, default **2**;
env `JOB_CONCURRENCY`) value. Since projects write to separate LanceDB tables (+ the
per-table write lock, §15.7), parallel indexing is safe; a long job no longer **blocks**
other projects as slots free up.

- Config: `IndexerConfig.indexing.jobConcurrency`, `CONFIG.JOB_CONCURRENCY`,
  `JOB_CONCURRENCY` env override, a commented line in the YAML template.
- `index.ts`: `new JobQueue({ registry, concurrency: CONFIG.JOB_CONCURRENCY })`.

### 16.4 Large data files (solved with `.mcpignore`)

Since `allowedExtensions` includes `.json`, generated/large JSON data files (like the
20 MB HuggingFace `tokenizer.json`) get split into thousands of chunks and embedded
→ slowing indexing and polluting search. **Solution path (existing infrastructure):**
place a `.mcpignore` at the project root and exclude the relevant folder (e.g.
`tokenizers/`). Since `buildIgnore` adds `.mcpignore` (gitignore syntax) to the
`collectFiles` filter, these files are never collected. Verified live: when `tokenizers/`
was excluded, the file count dropped from 93 → 68 and indexing took seconds instead
of minutes. (A persistent `maxFileSizeBytes` guard could be added later — §13 proposals.)

### 16.5 Tests
- `tests/languages.test.ts` — multi-language symbol extraction (full support +
  descending into namespace/module/mod). The previous `[LIMITATION]` (no C#/C/Ruby
  symbols) tests were converted into positive assertions.
- `tests/chunker-advanced.test.ts`, `tests/tree-sitter.test.ts`,
  `tests/db-where.test.ts`, `tests/config.test.ts`, `tests/indexer.test.ts` —
  overlap/large-class splitting, ext→grammar mapping, `buildWhere` edge cases,
  config env-override (subprocess), `collectFiles`/ignore + `indexFile` abort.
- `tests/job-queue.test.ts` — worker pool: parallel execution, default serial
  behavior, a stuck job not blocking another.
- Total: **85 pass / 0 fail** (288 expect).


---

## 17. v4 — Extended Usability Proposals (analysis — 💡 proposal)

After the system (indexing + hybrid search + multi-language symbol extraction)
matured, this is a comprehensive brainstorm to take the **AI agent experience** one
step further. All are at the proposal level (not yet implemented); it extends the
list in §13 and references the items that overlap with it.

**Starting observation:** The vast majority of MCP tool traffic is `search_codebase`;
`find_symbol`/`get_file_outline`/`get_index_status`/`index_project` are used relatively
rarely. Therefore the highest leverage is (a) **enriching the dominant search tool**
and (b) adding **new capabilities** that agents frequently need but are not currently
served, like "find usages" / "get to know the project".

### 17.0 Related completed work: index freshness documentation (✅)
Before this proposal round, **documentation, not code**, was added so that agents
consciously manage the index delay (from save to searchable ~1-2 sec): a "FRESHNESS"
note on the `search_codebase` and `find_symbol` tool descriptions (do not rely on
searching for the new content of a just-edited file, read it directly; the index is
a DISCOVERY tool) + an "Index freshness" subsection in the README. Item 17.4 below
is the **code-side** complement of this.

### 17.1 `get_repo_overview` — project onboarding summary (high value / low effort)

> ✅ **Done in v4** (see §18.2). The structural-raw-material approach below was implemented.

**Need:** When an agent first enters a project, it wants to quickly acquire the
"what is this repo, where to start" information. `list_indexes` gives only name/status/count;
it gives no context about the *inside* of the project.

**Design decision — who produces the AI summary?** The daemon has only an **embedding**
model (`qwen3-embedding`), no generative LLM. Producing a plain prose summary would
require adding a separate generative model dependency to the daemon. Instead:

- **The daemon's job: structural raw material** (deterministic, cheap, cacheable) —
  top-level directories, principal modules, language distribution, file/symbol counts,
  detected entry points (`main`/`index`/`cli`, etc.), files with the most symbols.
  This data can **already be aggregated** from the registry + `file_cache` + chunk
  metadata (symbolType/symbolName/filePath); no new indexing is needed.
- **The calling agent synthesizes the summary** — with its own LLM. The daemon stays
  lightweight; the summary is as good as the model using it.

**Optional second stage:** if an external LLM endpoint is configured, a "repo card"
(prose summary) **cached** to disk could be produced and updated incrementally. Out
of scope in the first version.

### 17.2 Enrich the dominant `search` tool (highest leverage)

| Proposal | Description | Impact | Effort |
|-------|----------|------|------|
| ~~**Result context + `indexedAt`**~~ | ✅ Done in v4: `signature` + `indexedAt` on every result + `contextLines` for ±N surrounding lines. See §18.1. | High | Low |
| **Diversity (MMR)** | The 5 results should not all be copies of the same function; diversify with Maximal Marginal Relevance. | Medium-High | Medium |
| **Token-budget awareness** | A `maxChars`/`compact` parameter — return more results without bloating the agent's context. | Medium | Low |
| **Multi-query / batch search** | Multiple queries in a single round-trip; the agent reduces the number of turns. | Medium | Low-Medium |

> Note: **Reranker (cross-encoder)** already stands as a proposal in §13; MMR is a
> cheaper intermediate step and can come before rerank.

### 17.3 `find_references` and dependency graph — the biggest new capability

**Need:** What agents need **the most** after semantic search is "where is this symbol
called/used". `find_symbol` finds the *definition*, not the *usages*. Critical for
refactor/impact analysis.

| Proposal | Description | Impact | Effort |
|-------|----------|------|------|
| ~~**`find_references(name, project?)`**~~ | ✅ Done in v4: whole-identifier matches over indexed chunks → file:line occurrences (definition + call sites). See §18.3. | High | Medium |
| **Import/dependency graph** | `get_dependencies(file)` / "who imports this" — from tree-sitter's import nodes. Refactor and impact analysis. | Medium-High | Medium |

### 17.4 Indexing scope / quality

| Proposal | Description | Impact | Effort |
|-------|----------|------|------|
| **Embed docstring/comment separately** | Embed the function's docstring with a separate vector; precision improves on "how to do X" intent-queries. | Medium-High | Medium |
| **Recency signal** | Slightly boost recently changed code (git mtime); useful for "where is actively developed" questions. | Medium | Low-Medium |
| **Git history / commit message search** | A separate search space: "when/why was feature X added". Secondary but differentiating. | Medium | Medium-High |

### 17.5 Agent ergonomics / trust

| Proposal | Description | Impact | Effort |
|-------|----------|------|------|
| **Per-result freshness stamp** | `indexedAt` + a "this file has pending changes" flag — *makes visible rather than solves* the §17.0/§13 staleness issue; the agent decides for itself. (Optional: tie the `isBusy`/watcher pending state from §11.4 to `search` as an upper-bounded "settle barrier" — instead of a blind `sleep`.) | Medium | Low-Medium |
| **Combined `search + outline`** | Find the symbol and return the map of its containing file at the same time; saves a turn. | Low-Medium | Low |

### 17.6 Suggested implementation order (v4)

1. **`get_repo_overview` + `indexedAt`/`signature`/context on results** — high value, low risk, meets the onboarding need.
2. **`find_references`** — the biggest capability leap (finding usages/calls).
3. **MMR diversity + token-budget parameters** — the quality of the dominant search tool.
4. **Embed docstring separately + recency signal + import graph** — depth.
5. **Optional/advanced:** git-history search, LLM-generated cached repo card, combined tool.

> Items that overlap with §13 (context lines, reranker, more languages, per-project
> config) are listed there too; the v4 plan covers/prioritizes them.


---

## 18. v4 — Usability Implementation (✅ Completed)

The first wave of §17 proposals was implemented (the high-value / low-risk set):
result enrichment, `get_repo_overview`, `find_references`, and three more languages.
`bun run typecheck` is clean and `bun test` passes **100/100** (323 expect); the new
tools were additionally verified end-to-end against real LanceDB (signature/context
enrichment, reference expansion, overview aggregation) and the single binary compiles
and runs (`dist/cidx` 2.1.0). Version bumped 2.0.0 → **2.1.0**.

### 18.1 Result enrichment — `indexedAt` + `signature` + context lines (§13, §17.2)
- **`signature`** — a best-effort declaration line derived from the chunk content
  (`utils/text.ts → deriveSignature`): skips blank lines, collects the declaration
  head up to the body opener (`{` / trailing `:` / `=>`), capped at 3 lines / 200
  chars. So an agent sees `function loginUser(req, res)` without reading the block.
- **`indexedAt`** — every result now carries the owning project's `lastIndexedAt`
  (a freshness hint, complementing the §17.0/§17.5 staleness documentation).
- **Context lines** — a `contextLines` (CLI `--context`) parameter. When > 0, up to
  N lines immediately **before/after** the chunk are read **live from the file on
  disk** and attached (`contextBefore`/`contextAfter`). Context is read AFTER ranking
  + slicing, so only the final results trigger a file read; missing/changed files are
  skipped silently (still a valid result).
- Wired through `SearchOptions` → `searchIndex`/`searchAll`/`findSymbol` (a private
  `scope()` + `enrich()`/`attachContext()` pass), the Control API `/search`, the
  `search_codebase` tool schema, and the CLI/MCP/stdio formatters.

### 18.2 `get_repo_overview` — project onboarding (§17.1)
- `IndexManager.repoOverview(name)` aggregates, with no LLM and no re-indexing, from
  the registry + `file_cache` + chunk metadata (`db.tableMetadata` selects only the
  metadata columns — no vectors/content):
  - language distribution (files + symbols per language),
  - symbol-type breakdown (function/class/method/…),
  - top-level directories (relative to the project root),
  - likely entry points (basenames like `main`/`index`/`cli`/`server`/`program`/…),
  - the files with the most symbols.
- Exposed as Control API `POST /overview`, the `get_repo_overview` MCP tool, and CLI
  `cidx overview <name>`. The agent synthesizes the prose summary with its own model
  (the daemon only ships structural raw material).

### 18.3 `find_references` — symbol usages (§17.3)
- `IndexManager.findReferences(name, project?, limit?, filters?)` answers "where is
  this symbol USED" (call sites + definition), complementing `find_symbol`
  (definition only). Practical, non-LSP approach:
  1. `db.searchContent(table, name)` fetches candidate chunks whose `content` contains
     the token (escaped `LIKE` scan, generous pool).
  2. `utils/text.matchIdentifierLines` keeps only **whole-identifier** matches per line
     (boundary = `[A-Za-z0-9_$]`), so `getUser` does not match inside `getUserName`
     and `get_user` does not match across underscores.
  3. Occurrences are expanded to absolute `file:line` (using the chunk's `startLine`),
     deduped by `project+file+line`, sorted, and capped.
- Each reference carries the containing chunk's symbol (`inSymbol`/`inSymbolType`).
- Caveat (documented in the tool description): it may include same-named symbols from
  other scopes — it is a pragmatic matcher, not full LSP resolution.
- Exposed as Control API `POST /references`, the `find_references` MCP tool, and CLI
  `cidx refs <name>` (alias `references`).

### 18.4 More languages — Kotlin / Swift / Scala (Lua deferred)
- **Added:** Kotlin (`.kt`/`.kts`), Swift (`.swift`), Scala (`.scala`/`.sc`) — embedded
  `.wasm` grammars + `EXT_TO_GRAMMAR` + `allowedExtensions`. Chunker node sets gained
  `protocol_declaration` (Swift → `interface`), `object_definition`/`trait_definition`
  (Scala → `class`/`trait`). Verified deterministic across interleaved grammar switches
  (5× each: Kotlin/Swift/Scala extract their class/interface/protocol/trait/object/
  function symbols correctly and stably) and do NOT corrupt other languages.
- **Lua deferred (root-caused):** `tree-sitter-lua` is **unstable in the shared-WASM
  multi-grammar runtime**. After another grammar is parsed, a subsequent Lua parse
  drops symbols **nondeterministically** (results independent of the actual Lua code —
  clear shared-WASM-heap corruption). Neither `parser.reset()`, a fresh `Parser`
  instance, nor `tree.delete()` fixed it (the heap/grammar tables are shared across all
  languages). Crucially, Lua does **not** corrupt other languages (Python/Go/C#/… stay
  correct and deterministic when interleaved). Since it would ship flaky symbol
  extraction, Lua is intentionally NOT bundled; `.lua` files fall back to character
  chunking (content still indexed/searchable, only symbol metadata is absent). This is
  a grammar-side issue, not fixable at the chunker layer; it is the multi-worker
  parser-pool concern from §15.8 surfacing as cross-grammar memory interference.

### 18.5 Tests
- `tests/text.test.ts` (new) — pure unit tests for `deriveSignature` (JS/Python/multi-
  line/blank) and `matchIdentifierLines` (whole-identifier only, absolute line numbers,
  snake_case boundaries, empty name) + `escapeRegExp`.
- `tests/languages.test.ts` — Kotlin/Swift/Scala symbol-extraction cases added.
- `tests/tree-sitter.test.ts` — new ext→grammar mappings + grammar loading assertions.
- The reference-expansion and overview-aggregation paths were verified with a temporary
  real-LanceDB integration smoke (deleted after verification), per the §14 strategy.
