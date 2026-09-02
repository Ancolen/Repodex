# Status — Done / Proposed / Roadmap

> The living tracker. **When you finish, start, or decide on something, edit this file.** Pair each change with an entry in [`changelog.md`](./changelog.md) and (for behavior) [`features.md`](./features.md).
>
> Current release: **2.4.0** (docstring / comment embedding + doc search legs). Test suite: **296/296** passing (790 expectations).

## Legend

- ✅ **Done** — implemented, tested, shipped.
- 🚧 **In progress** — actively being worked on.
- 💡 **Proposed** — designed / brainstormed, not yet built (with impact / effort).
- ⏸️ **Deferred / by-design** — intentionally not done (with reason).

---

## ✅ Done

### Core architecture
- ✅ Asynchronous daemon + job queue (server opens instantly).
- ✅ Multi-project isolation (one LanceDB table per project) + central registry.
- ✅ Worker pool (`jobConcurrency`) — parallel indexing, a stuck job doesn't block others.
- ✅ Persistent registry / job state; resumes + incremental sync on restart.
- ✅ Extensible job system (`JobQueue.registerHandler`).

### Search
- ✅ Hybrid search (vector + BM25 + RRF, k=60); `hybrid` / `vector` / `text` modes.
- ✅ Filters: `language` / `symbolType` / `pathGlob` (project-relative globs match anywhere in the absolute stored path).
- ✅ `search_codebase_batch` — several queries in one round-trip, results grouped per query.
- ✅ `find_symbol` (exact + prefix, model-independent).
- ✅ `find_references` (call sites + definition, whole-identifier match).
- ✅ `get_repo_overview` (structural, no LLM).
- ✅ `get_file_outline`.
- ✅ Second-stage **reranker** (Qwen3-Reranker via Ollama, on by default) — re-ranks the top `RERANK_TOP_K` candidates after retrieval, scored via `/api/generate` yes/no-token logprobs; one-time availability probe auto-disables it when the model is absent; transparent fallback to RRF order; `_rerankScore` on results.
- ✅ **MMR diversification** (Maximal Marginal Relevance, on by default) — after reranking, re-orders the top `MMR_TOP_K` candidates so the top results aren't near-duplicates (e.g. copies of the same function). `selectMMR` (λ relevance/diversity tradeoff, default **0.5**; relevance min-max normalized to the [0,1] cosine scale); per-call `mmr` option skips it. Slots after rerank, before enrichment; needs only the doc vectors (always present on LanceDB rows). Default λ tuned to 0.5 from live-embedding demos (0.7 kept near-duplicates, 0.3 over-diversified; 0.5 pushes duplicates down while keeping distinct relevant results).
- ✅ **Query embedding cache** — the query is embedded through the content-hash cache (`cachedEmbed`, shared with the indexing cache, keyed by `(model, sha256(query))`), so repeated searches skip the Ollama round-trip and a query matching an indexed chunk reuses that row.
- ✅ **`maxChars` token budget** — per-call `maxChars` caps the returned text: results are kept whole in ranked order while they fit (never truncated mid-chunk), so a high `limit` can be used for recall without bloating the agent's context. Applied server-side (`applyCharBudget`, after enrichment) so it's consistent across HTTP/MCP/stdio/CLI; the top result is always returned.
- ✅ **Multi-query batch search** (`search_codebase_batch` / `cidx batch`) — runs several queries concurrently in one round-trip, results grouped per query; each query reuses `searchIndex`/`searchAll` (so rerank/MMR/maxChars + the shared query cache apply per query). Duplicate/blank queries are de-duped.
- ✅ **Git-history / commit-message search** (`search_commits` / `cidx commits`) — the "when / why was feature X added" and "who changed this file" questions that code search can't answer: a separate search space over the project's git history. Runs `git log` **live** in the indexed project's directory (`src/services/git.ts → searchGitLog`: `-z` NUL-safe, `-i` case-insensitive, `execFile` no-shell → no injection; path filter relativized + passed after `--`); **no embedding, no LanceDB, no schema change, no reindex** (additive, like the other code-intelligence tools). Pure parser in `src/core/commits.ts` (`parseCommitLog`) — fields are `\x1f`-separated, and a commit header is anchored on a 40-hex SHA + `\x1f` so a changed-file name can't be mistaken for a new commit (lets `--name-only` files be split out in one pass, surviving multi-line bodies). Filters: message `query`, file/path history, `author`, `since`/`until` (git date syntax), `limit` (default 50), `withFiles` (changed files per commit); no filters → most recent commits. `notARepo` is reported when the project isn't a git working tree.
- ✅ **Docstring / doc-comment embedding + doc search legs** (2.4.0) — a symbol's docstring (Python) or contiguous preceding doc-comment run (JSDoc, Rust `///`, Go `//`, …) is extracted at chunk time (`src/chunking/docstring.ts → extractDoc`, capped 1200 chars, attached to the first chunk of split symbols) and stored in new **`doc` / `doc_vector` columns on the same row** — the doc is embedded with the same model as the code. Hybrid search merges up to **four RRF legs**: code-vector, doc-vector ANN, content BM25, doc BM25 — all gated on actual table columns (`tableColumns`), so **pre-2.4.0 legacy tables take the exact legacy paths** until reindexed (`insertChunks` strips the unknown columns via `stripUnknownColumns`). Doc-contribution results carry `_docHit: true` → rendered as `[doc hit]` in CLI/MCP output. Gated globally by `indexing.docstrings` (default true) and per-call by `doc:false` (search_codebase, /search, stdio bridge, CLI `--doc false`). ANN + BM25 indexes built over `doc`/`doc_vector` at full-index time; apply to existing projects with a full reindex.

### Chunking & languages
- ✅ AST-based smart chunking (web-tree-sitter); namespace / module / mod descent.
- ✅ 16 languages: JS / TS / TSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Kotlin, Swift, Scala, GDScript.
- ✅ **Godot / GDScript** (2.2.0) — `.gd` with full AST chunking (`class_name`, inner classes, `signal` as its own symbol type, `enum`, `func`, the nameless `_init` constructor); `extends "res://…"` / `preload` / `load` extraction with project-root resolution (extension may be omitted, `uid://` skipped); dead-code scoring knows Godot's engine virtuals (`_ready`/`_init`/`_process`/… — never dead on 0 refs) and demotes `_on_*` handlers wired via the editor; `class_name` counts as exported. Godot text formats (`.gdshader`/`.tscn`/`.tres`/`project.godot`) index via character fallback; `.godot/` cache dir ignored. The grammar wasm is **vendored** (built by `scripts/build-gdscript-wasm.sh`, ABI-guarded) because `tree-sitter-wasms@0.1.13` has no gdscript — see [`architecture.md`](./architecture.md).
- ✅ **Interleaved-grammar determinism suite** (2.2.0) — codifies the Lua lesson as a test: a GDScript outline must stay byte-stable across 5 rounds of TS/Python/Go/Rust/Ruby parses on the shared parser, and vice versa (no reverse corruption). Runs with every `bun test`.
- ✅ Character-based fallback for unknown extensions.
- ✅ **Doc formats with language labels** — `.xml` / `.rst` (plus `.json` / `.md`) indexed via the character fallback with a `language` label so the `language` filter works on doc corpora (e.g. `godot --doctool` class-reference dumps).
- ✅ **Token-based chunk-boundary guard** — the chunk window also respects an approximate token budget (`effectiveChunkChars = min(maxChunkSize, maxChunkTokens·charsPerToken)`), so a large `maxChunkSize` can't silently overflow the embedding model's token window. Approximate (chars/4, no tokenizer bundled); **char-limit-binding by default** (`maxChunkTokens=512` · 4 = 2048 > default `maxChunkSize` 1500), so existing indexes are unchanged unless you raise `maxChunkSize` or lower the cap. Tunable via `indexing.maxChunkTokens` / `MAX_CHUNK_TOKENS`; apply to existing projects with a reindex.

### Efficiency
- ✅ Batch + bounded-parallel embedding.
- ✅ Content-hash embedding cache (+ prune at `cacheMax`).
- ✅ mtime file cache.
- ✅ ANN vector index + BM25 / FTS index (auto above threshold).
- ✅ Embedding-model compatibility check (reindex warning on model change).

### Sync, watching, git
- ✅ Incremental sync (changed / new + deleted cleanup).
- ✅ Deleted-file cleanup on restore (offline removals pruned).
- ✅ Live watcher with debounce + atomic / awaitWriteFinish rename handling.
- ✅ `.gitignore` / `.cidxignore` / global ignore (full-index **and** watcher paths).
- ✅ `gitTrackedOnly` (full-index).
- ✅ Auto sync on branch change (`.git/HEAD` watcher).

### Result enrichment & agent UX
- ✅ `signature` + `indexedAt` on every result.
- ✅ `contextLines` (±N lines read live from disk).
- ✅ Index-freshness documentation on tool descriptions (the index is a discovery tool; ~1–2s lag).

### Code intelligence
- ✅ **Import / dependency graph** (`get_dependencies`, `cidx deps`) — "what does a file import?" + "who imports it?". Forward: tree-sitter AST extracts import specifiers per language (`src/chunking/imports.ts`, same parse recipe as `chunkCode`), resolved to **indexed files only** (`src/core/resolve.ts`, every resolved path validated against the index → no phantom edges; relative/external/system classified, with a suffix-match fallback for languages whose source root is unknown like Java/Kotlin). Reverse ("imported by"): built **on demand** and **mtime-keyed in-memory** (`IndexManager.depGraphCache`), reflecting watcher changes on the next call without a reindex; invalidated on `removeIndex`. `project` inferred from the file path (prefix match) or passed explicitly; `scannedFiles` + `truncated` surface the first-call cost and the reverse cap. No schema change, no reindex.
- ✅ **Dead-code detection** (`find_dead_code`, `cidx deadcode`) — flags **potential dead code**: indexed symbols (function / method / class / interface / enum / struct / trait / record) that have **zero whole-identifier references anywhere**, with a conservative multi-signal confidence score so it's reluctant to cry dead. Reference counting is one combined-regex pass over all chunk content (`src/core/deadcode.ts → countReferences`); the **definition rule** excludes only a symbol's exact declaration line (so a recursive call in the body still counts — no false-dead on recursion), and the index is scanned in name-groups so no symbol is silently dropped past the regex cap. Because the index has no `exported`/visibility flag, "exported" is recovered from the chunk text per-language; polymorphic (`@Override`/virtual/trait), dynamic-hook-name (`toString`, `init`, `handle*`…), constructor-like, owner-class-referenced, and common-name signals each **demote** confidence, while Python `_private` names get a small **bump**. Results sectioned `likely dead` (≥70) → `uncertain` (40–69) → `review` (<40); test files and entry points are pre-excluded. `scannedSymbols`/`scannedChunks` + `truncated` surface partial coverage (the table cap). No schema change, no reindex.
- ✅ **Call graph** (`get_call_graph`, `cidx callgraph`) — caller/callee trees around a symbol and/or file: who calls it and what it calls, as bounded, cycle-safe trees (the "call stack / roadmap"). Adjacency comes from whole-identifier matching over chunk content (`src/core/callgraph.ts → buildCallEdges`, the same scan + definition rule as `countReferences`, emitting a caller→callee map instead of a flat counter), so a recursive call is a real self-edge while the declaration isn't. Anchor by symbol name (function-centric), by file (all callables in it), or both (disambiguate). `traverseCallGraph` bounds by `depth` (default 3) + a node `limit` (default 100/direction), with cycles shown as `↻` leaves. The per-project adjacency is cached and keyed on `lastIndexedAt` (not file mtime — the data lives in LanceDB, which can change on a re-chunk without moving mtimes); the first call per project pays the scan. `scannedSymbols` + `truncated` surface coverage. No schema change, no reindex.

### Robustness & security (v3)
- ✅ Shrinking-file stale-chunk fix (delete by `filePath`, not `id`).
- ✅ Directory-access guard (inaccessible `baseDir` fails the job, never wipes the table).
- ✅ Watcher↔full-index race protection (`isBusy` deferral).
- ✅ `remove` → `dropTable` race fix (`waitForJob`).
- ✅ Per-table write lock.
- ✅ LIKE wildcard escaping (`\ % _` with `ESCAPE '\'`).
- ✅ Throttled progress persistence.
- ✅ Graceful shutdown (`abortAll` + `registry.close`).
- ✅ Localhost-only binding + localhost CORS + DNS-rebinding protection.

### Mid-file cancellation (v3.1)
- ✅ `indexFile` honors the abort signal at batch boundaries (bounded cancel delay).

### Distribution
- ✅ Single binary (`bun build --compile`, grammars embedded).
- ✅ Streamable HTTP + SSE (legacy) + stdio bridge.
- ✅ systemd user service via `install.sh` (auto-start at boot with linger).
- ✅ Cross-platform release assets + one-line `web-install.sh`.

---

## 🚧 In progress

_(Nothing actively in flight — the docstring / comment embedding proposal is implemented, pending release.)_

---

## 💡 Proposed (not yet built)

> Impact / effort are rough, relative estimates. The "dead-code detection" and "call graph" proposals have since shipped (see Code intelligence in [`features.md`](./features.md)); the "Embed docstring / comment separately" proposal shipped in 2.4.0.

### New capabilities
| Proposal | Description | Impact | Effort |
|----------|-------------|--------|--------|
| **Recency signal** | Slight boost for recently changed code (git mtime). | Medium | Low-Medium |
| **`maxFileSizeBytes` guard** | Skip oversized data files without relying solely on `.cidxignore`. | Low-Medium | Low |
| **Combined `search + outline`** | Return a hit's file outline in the same call; saves a turn. | Low-Medium | Low |

### Suggested order
1. Recency (depth).

---

## ⏸️ Deferred / by-design

| Item | Why it's not done |
|------|-------------------|
| **Lua grammar** | Intentionally **not bundled** — `tree-sitter-lua` is unstable in the shared-WASM-runtime (nondeterministically drops symbols after another grammar parses; shared-WASM-heap corruption; no fix at the chunker layer). `.lua` falls back to character chunking. GDScript passed the same acceptance bar (vendored ABI-14 wasm + the interleaved-determinism suite); any future grammar must too. |
| **Token-based auth** | Optional; localhost binding + origin / host control is sufficient for now. |
| **Structured (JSON) logging** | Left as plain `console.error`; a disproportionate change for current needs. |
| **Parser pool (multi-worker)** | The single shared tree-sitter parser is safe today (no `await` between `setLanguage` and `parse`); a pool is only needed if workers share parser state. |
| **Job priority (search > index)** | Open — the worker pool serves all job types at equal priority. |
| **`gitTrackedOnly` in the watcher** | By design, the watcher still indexes new / untracked files; the filter is full-index only. |
| **Persistent integration tests** | Smoke-tested against real LanceDB each version, then deleted; committing `db` / Control-API integration tests is proposed. |
