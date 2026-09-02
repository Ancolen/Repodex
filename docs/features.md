# Features — Capability Catalog

What the tool **does today** (version 2.2.0). For what's planned, see [`status.md`](./status.md); for how it's built, [`architecture.md`](./architecture.md). For user-facing install & usage, the root [`README.md`](../README.md).

## Daemon & multi-project

- **Asynchronous daemon** — the server opens instantly; indexing runs in the background on a job queue. Search continues uninterrupted while a project indexes.
- **Worker pool** — `jobConcurrency` (default 2) projects index in parallel; a long job doesn't block others.
- **Multi-project** — each project lives in its own isolated LanceDB table (`idx_<name>`); search one project or all.
- **Persistent state** — registry, file cache, and job state in `bun:sqlite`; resumes where it left off after a restart.

## Search

- **Hybrid search** — semantic **vector** + **BM25** exact-term, merged with **RRF** (k=60). Three modes:
  - `hybrid` (default) — vector ∪ BM25 → RRF.
  - `vector` — pure semantic.
  - `text` — pure BM25 (no embedding model needed; works on old / incompatible indexes too).
- **Filters** — `language`, `symbolType`, `pathGlob` (on `search`); `language` / `symbolType` also on `find`.
- **`find_symbol`** — finds a symbol by name (exact + prefix); no vectors, fully precise, model-independent.
- **`find_references`** — finds where a symbol is **used** (call sites + definition) as `file:line` occurrences. Pragmatic whole-identifier matcher (not full LSP).
- **`get_repo_overview`** — structural onboarding summary: language distribution, symbol-type breakdown, top-level directories, likely entry points, largest files. No LLM, no reindex.
- **`get_file_outline`** — the symbol map of a file (function / class / method + line ranges).
- **Rich results** — every result carries a derived `signature`, an `indexedAt` freshness stamp, and an optional `--context N` window of surrounding lines read live from disk.
- **Reranker** (on by default) — a second-stage cross-encoder-style model (Qwen3-Reranker via Ollama) re-ranks the top candidates after retrieval for higher precision. Scored via `/api/generate` yes/no-token logprobs. Configure with `search.rerank` or skip per-call via `rerank: false` / `--rerank false`; auto-disables (probed once) if no reranker model is configured. Surviving results carry `_rerankScore`.
- **MMR diversification** (on by default) — after the reranker, Maximal Marginal Relevance re-orders the top candidates so the top results aren't near-duplicates (e.g. copies of the same function). Pure-logic, no model. Configure with `search.mmr.lambda` (default 0.5: dedupes near-duplicates while keeping distinct relevant results) or skip per-call via `mmr: false` / `--mmr false`.
- **Query embedding cache** — the query is embedded through the content-hash cache shared with indexing, so repeated searches skip the Ollama round-trip (and a query matching an indexed chunk is free). Transparent; no configuration.
- **`maxChars` budget** — per-call `maxChars` caps the returned text: results are kept whole in ranked order while they fit (never truncated mid-chunk), so a higher `limit` gives recall without context bloat. Top result always returned. `maxChars` on `search_codebase` / `--max-chars` on the CLI.
- **Batch search** (`search_codebase_batch` / `cidx batch`) — run several queries in one round-trip; results grouped per query. Each query gets the full rerank/MMR/maxChars pipeline and the shared query cache.
- **Search → editor handoff** (`cidx open`) — searches, prints the result list, then launches `$VISUAL`/`$EDITOR` (fallback `vi`) on the picked result (`--pick n`, default 1) at its start line. Line-position conventions per editor: `+<line>` (vim/nano/emacs, the default), `--goto <file>:<line>` (VS Code family), `<file>:<line>` (Helix); `VISUAL='code -w'` makes a GUI editor block. Exits with the editor's exit code.

## Code intelligence

- **Dependency graph** (`get_dependencies` / `cidx deps`) — the module-level picture for a file: **what it imports** and **who imports it**.
  - **Forward (imports):** import specifiers are pulled from the **AST** (same `web-tree-sitter` recipe as chunking), per language — JS/TS/TSX `import …`, Python `import`/`from … import`, Go import blocks, Rust `use` (incl. `crate::`/`super::`/`self::`), Java/C#/Kotlin/Swift/Scala dotted imports, C/C++ `<…>` vs `"…"`, Ruby `require(_relative)`/`load`, PHP `require`/`include`/`namespace use`, GDScript `extends "res://…"` + `preload`/`load`. Bare specifiers (`node:fs`, external crates, go modules, stdlib) are classified `external`; local includes resolve to **indexed files only**; `res://` paths resolve against the project root (extension may be omitted; `uid://` specifiers are skipped).
  - **Resolution is index-validated** — every resolved edge points at a real indexed file (exact, extension/index variants, then a path-segment suffix fallback), so there are no phantom edges; on-disk-but-unindexed files are `unresolved`.
  - **Reverse ("imported by"):** built **on demand** and cached **in-memory, keyed by file mtimes** — so it reflects watcher changes on the next call **without a reindex**, and the first call is the only costly one. `project` is inferred from the file path or passed explicitly; `scannedFiles` + `truncated` report the scan size and the reverse-list cap.
- **Dead-code detection** (`find_dead_code` / `cidx deadcode`) — surfaces **potential dead code**: indexed symbols (function / method / class / interface / enum / struct / trait / record) that have **zero whole-identifier references anywhere** in the project, each scored with a conservative confidence so the tool is reluctant to cry dead.
  - **Conservative multi-signal scoring.** Because the index has no `exported`/visibility flag, "exported" is recovered from the chunk text per-language (`export …` / `pub …` / Go capitalization / `public …` / GDScript `class_name`). Each signal that could mean "used despite no static reference" **demotes** confidence: `exported`, polymorphism (`@Override`/virtual/trait/interface), dynamic-hook-name (`toString`, `init`, `handle*`, lifecycle…, and Godot's engine-invoked virtuals `_ready`/`_init`/`_process`/…), constructor-like, owner-class-referenced, common-name (collision risk), and GDScript `_on_*` signal handlers (wired in scenes via the editor). Python `_private` names get a small **bump** (GDScript deliberately does not — its `_` prefix marks virtuals, not privacy).
  - **Definition-aware counting.** References are counted in one combined-regex pass over all chunk content; only a symbol's exact **declaration line** is excluded — so a recursive call in the body still counts (no false-dead on recursion). Names are scanned in groups so no symbol is silently dropped past the regex cap.
  - **Results are sectioned** `likely dead` (≥70) → `uncertain` (40–69) → `review` (<40), each with `file:start-end [lang]`, its signals, and a derived signature. Test files (`*.test.*`, `*_test.*`, `test_*`, `tests/`, `__tests__`) and entry points (`main`/`index`/`app`…) are pre-excluded. `scannedSymbols`/`scannedChunks` + `truncated` report coverage; filter with `--min-confidence`, `--language`, `--type`.
  - **Limitation:** this is pragmatic whole-identifier matching, not full LSP — same-named symbols across scopes share a count, so high-precision results live in the top confidence band. Treat output as a review queue, not a deletion list.
- **Call graph** (`get_call_graph` / `cidx callgraph`) — the call-flow picture around a symbol and/or file: **who calls it** and **what it calls**, rendered as bounded, cycle-safe trees (the "call stack / roadmap").
  - **Anchor by symbol, file, or both.** Give a symbol name, a file path (every callable in it), or both (that symbol within that file — for disambiguating same-named symbols). At least one is required. Name matching mirrors `find_symbol`, so a bare method name (`getDependencies`) resolves to its qualified form (`IndexManager.getDependencies`).
  - **Both directions, depth 3 by default.** `direction` picks `callers` (▲ who calls it), `callees` (▼ what it calls), or `both` (default). `depth` (default 3) bounds how many levels the tree descends; `limit` (default 100/direction) caps nodes, with a `truncated` flag + `⚠` line when hit.
  - **Cycle-safe trees.** A cyclic call is shown as a `↻` leaf rather than expanded forever, so recursion and mutual recursion are visible without blowing the budget. Paths can repeat (it's a tree, not a DAG) so a shared callee shows under each caller.
  - **Same adjacency engine as the rest of code intelligence.** Caller→callee edges come from whole-identifier matching over chunk content — the same scan + definition rule as dead-code counting — so a recursive call in a body is a real self-edge while the declaration isn't. Per-project adjacency is cached and keyed on `lastIndexedAt` (the data lives in LanceDB, which can change on a re-chunk without moving mtimes); the first call per project pays the scan. `scannedSymbols` + `truncated` report coverage. No schema change, no reindex.
  - **Limitation:** pragmatic whole-identifier matching, not call resolution — same-named symbols across scopes share edges, and in-index calls only (framework / stdlib / class-constructor calls aren't shown). Treat as a navigation aid, not ground truth.
- **Git-history / commit-message search** (`search_commits` / `cidx commits`) — the questions code search can't answer: **when / why was feature X added**, and **who changed this file, and when**. A separate search space over the project's git history.
  - **Live `git log`, no indexing.** Runs `git log` directly in the indexed project's directory — no embedding, no LanceDB, no schema change, no reindex (additive, like the rest of code intelligence). `isGitRepo` is checked first, so a non-repo project reports `notARepo` instead of erroring.
  - **Message / file / author / date filters.** `query` is a case-insensitive regex over the commit message (subject + body); `path` restricts to commits that touched a file/dir/glob (its history); `author` matches name/email; `since`/`until` take git date syntax (`"2 weeks ago"`, `"2024-01-01"`). With no filters it returns the most recent commits.
  - **Optional changed files.** `withFiles: true` appends the changed file list per commit — the "what did this change touch" depth.
  - **Safe by construction.** NUL-separated (`-z`), `execFile` with no shell (no injection); the path filter is relativized and passed as a literal argv after `--`. Fields are `\x1f`-separated and a commit header is anchored on a 40-hex SHA + `\x1f`, so a changed-file name can't be mistaken for a new commit. `limit` (default 50) with a `truncated` flag + `⚠` line when hit.

## Chunking

- **Smart (AST) chunking** — `web-tree-sitter`; splits at function / class / method boundaries, descending into namespace / module / mod so nested symbols are extracted per-language.
- **16 languages** with embedded grammars: JS / TS / TSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Kotlin, Swift, Scala, GDScript.
- **Godot/GDScript** — `class_name`, inner classes, `signal` declarations (as their own `signal` symbol type), `enum`, `func` and the `_init` constructor are extracted as symbols; the grammar is vendored and built by `scripts/build-gdscript-wasm.sh` (see [`architecture.md`](./architecture.md)).
- **Character-based fallback** for languages without a grammar (and for Lua — see [`status.md`](./status.md)); also used for Godot's text formats (`.gdshader`, `.tscn`, `.tres`, `project.godot`) — searchable text, no symbols.
- **Doc formats with language labels** — `.xml` and `.rst` are indexed via the character fallback but carry a `language` label (`xml` / `rst`; `.json` → `json`, `.md` → `markdown`), so the `language` filter works on documentation corpora — e.g. a Godot engine class-reference dump (`godot --doctool`) or a godot-docs tree indexed alongside a game project for version-matched API search.
- **Token-aware cap** — the chunk window also respects an approximate token budget (`min(maxChunkSize, maxChunkTokens·4)`), so a large `maxChunkSize` can't silently overflow the model's token window. Char-limit-binding by default (`maxChunkTokens` 512 · 4 = 2048 > `maxChunkSize` 1500); tune via `indexing.maxChunkTokens` / `MAX_CHUNK_TOKENS` and reindex.

## Efficiency

- **Batch + bounded-parallel embedding** — Ollama batch API; `batchSize` chunks per request, `concurrency` parallel requests.
- **Content-hash embedding cache** — unchanged symbols aren't re-embedded even if the file changes; identical code across files is free.
- **mtime cache** — unchanged files are skipped entirely.
- **ANN vector index** — built automatically when a table exceeds `vectorIndexThreshold` (default 50k) rows.
- **BM25 / FTS index** — on `content`, built alongside the vector index.

## Sync & watching

- **Incremental sync** (`sync`) — indexes only changed / new files and cleans up deleted ones; catches up at startup on offline changes.
- **Live watching** — chokidar + debounce; `atomic` + `awaitWriteFinish` handle editor temp→rename saves and large copies.
- **Deleted-file cleanup** — runs against the cached set so files removed while the daemon was down are pruned.

## Git awareness

- Respects `.gitignore` + `.cidxignore` + global ignores (full-index **and** watcher paths).
- Optional git-tracked-only indexing (`gitTrackedOnly`).
- **Automatic incremental sync on branch change** (watches `.git/HEAD`).

## Per-project configuration (`.cidx.json`)

- A project root can carry a **`.cidx.json`** — the per-project counterpart to the global `~/.cidx/config.yml`. Three optional fields, validated independently (an invalid field is dropped with a warning; a file with no valid fields is ignored; invalid JSON warns and is skipped — indexing never fails because of it):
  ```json
  {
    "languages": ["typescript", "gdscript"],
    "ignore": ["vendor/**", "*.gen.ts"],
    "embedModel": "qwen3-embedding:8b-q8_0"
  }
  ```
- **`languages`** — an allowlist of language labels (the same labels as the `language` search filter: `typescript`, `python`, `gdscript`, `markdown`, …). Files whose extension produces no label are dropped while the filter is active. Filtered-out files are absent from the file list, so the **deleted-file cleanup prunes them on the next sync**; the watcher removes them live on file events.
- **`ignore`** — extra ignore patterns layered on top of `.gitignore` + `.cidxignore` (same `ignore`-package semantics).
- **`embedModel`** — a per-project embedding model. The record's `embedModel` is pinned at `createIndex`, a **`sync` escalates to a full reindex** when the project config's model differs (vectors from two models can't share a table), and the **watcher skips writes** for a project whose model changed until it is reindexed. Queries are embedded with the model the table was built with, so search stays self-consistent. (Caveat: `searchAll` across projects using different models mixes distances from different embedding spaces.)
- Read **fresh on every index job and watcher event** — editing `.cidx.json` takes effect on the next sync/reindex (or immediately for watcher events), no daemon restart.

## Transports

- **Streamable HTTP** (`POST /mcp`, stateless) — recommended.
- **SSE** (`GET /sse`) — legacy, backward compatibility.
- **stdio bridge** (`cidx mcp`) — for clients that expect stdio (Claude Desktop); auto-starts the daemon.
- All servers listen on **`127.0.0.1`** only.

## Distribution

- **Single binary** — `bun build --compile` → `dist/cidx`; grammars embedded, no `node_modules` at runtime.
- Cross-platform release assets (linux / darwin × x64 / arm64), built on native runners.
- `install.sh` / `web-install.sh` install a systemd user service (Linux) → auto-start at boot.

## MCP tools exposed to agents

| Tool | Purpose |
|------|---------|
| `search_codebase(query, project?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?, rerank?, mmr?, maxChars?)` | Hybrid search; all projects if `project` omitted. Each result carries `signature` + `indexedAt`; `contextLines > 0` adds ±N surrounding lines; reranking and MMR diversification are on by default (`rerank: false` / `mmr: false` skip them); `maxChars` caps returned text (results kept whole). |
| `search_codebase_batch(queries, project?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?, rerank?, mmr?, maxChars?)` | Run several queries in one round-trip; results grouped per query. Same options/behavior as `search_codebase`, applied per query. |
| `find_symbol(name, project?, limit?, language?, symbolType?)` | Find a symbol by name (exact + prefix). |
| `find_references(name, project?, limit?, language?, symbolType?)` | Where a symbol is used (call sites + definition). |
| `get_repo_overview(project)` | Structural onboarding summary. |
| `get_file_outline(path)` | Symbol map of a file. |
| `get_dependencies(path, project?, limit?)` | What a file imports (resolved to indexed files + external) and who imports it (reverse). |
| `get_call_graph(symbol?, path?, project?, direction?, depth?, limit?)` | Caller/callee trees around a symbol and/or file (≥1 of symbol/path required). `direction` ∈ `callers`/`callees`/`both` (default `both`); `depth` default 3; cycle-safe, bounded by `limit` (default 100/direction). |
| `find_dead_code(project, language?, symbolType?, minConfidence?, limit?)` | Potential dead code: zero-reference symbols, conservatively scored and sectioned by confidence. |
| `search_commits(project, query?, path?, author?, since?, until?, withFiles?, limit?)` | Git-history / commit-message search ("when/why was X added", file history). Live `git log` — no indexing, no embedding. `withFiles` appends changed files; `notARepo` when the project isn't a git repo. |
| `list_indexes()` | Indexed projects + statuses. |
| `get_index_status(project?)` | Indexing status + live progress. |
| `index_project(path, name?)` | Agent starts indexing a new directory (background). |

## CLI commands (summary)

`start [dir]` · `index <dir> [--name x]` · `list` · `status [name]` · `reindex <name>` · `sync <name>` · `remove <name>` ·
`search "<query>" [flags]` · `open "<query>" [flags]` · `batch "<q1>" "<q2>" ...` · `find <name> [flags]` · `refs <name> [flags]` · `deps <file> [flags]` · `callgraph <symbol|file> [flags]` · `commits <project> [query] [flags]` · `deadcode <name> [flags]` · `overview <name>` · `mcp` · `config [path]` · `stop` · `version` · `help [cmd]`

> Full details: `cidx help` / `cidx help <command>`.
