# Status — Done / Proposed / Roadmap

> The living tracker. **When you finish, start, or decide on something, edit this file.** Pair each change with an entry in [`changelog.md`](./changelog.md) and (for behavior) [`features.md`](./features.md); a proposal that earns a real design gets fleshed out in [`proposals.md`](./proposals.md) and referenced from here by ID.
>
> Current release: **2.4.0** (docstring / comment embedding + doc search legs). Unreleased: **S1** (identifier-part BM25 tokenization), **A1** (`get_context_pack`), **O1** (`cidx doctor`), **C1** (`get_change_impact`). Test suite: **455/455** passing (1198 expectations).

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
- ✅ **Identifier-part BM25 tokenization** (`id_terms` leg, proposal [S1](./proposals.md)) — the docstring legs' counterpart on the **code** side: BM25 indexes `content` verbatim, so *"update user name"* could never match `getUserName` as text. At chunk time every compound identifier of a chunk is split at camelCase / snake_case / kebab-case / dotted boundaries (`src/core/idterms.ts`, pure — `splitIdentifier` / `extractIdTerms`, Unicode- and acronym-aware, digits kept with the word they follow) into a new nullable **`id_terms` column** — `getUserName` → `getusername get user name`, `user_id` → `user_id user id` — deduplicated, capped at 2000 chars per chunk at a term boundary, raw identifier kept so exact-symbol BM25 doesn't regress. Hybrid search gains a **fifth RRF leg** (BM25 over `id_terms`, its own FTS index with its own try/catch), gated on the table having the column (`tableColumns`), on **`hybrid` mode only**, and on the query tokenizing into **≥ 2 parts**; it merges **anonymously** (no marker field, no tool-def change). Extraction is a combined-regex pass over the chunk text (the `countReferences` precedent), not an AST walk — no second parse, the shared-parser determinism surface stays untouched, and character-fallback chunks (json/md/xml/rst) are covered too. **Pure CPU, no embedding pass** (unlike `doc_vector`). Legacy tables take the exact pre-S1 paths (`stripUnknownColumns` covers the new column; the single-leg native-metric `combine` behavior is unchanged) — apply with a full reindex.

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
- ✅ **Context pack** ([A1](./proposals.md#a1-get_context_pack)) (`get_context_pack`, `cidx pack`) — one call assembling what an agent otherwise burns 4–6 round-trips on: the search core **exactly as `search_codebase` runs it** (hybrid + rerank + MMR + the docstring legs + the shared query cache — reused, not reimplemented), plus per hit and in one pass: its file's **outline** capped to the hit's neighborhood (`sliceOutlineForHit` — the symbols overlapping the hit's chunk range, then up to 4 below it, at most 12 entries; parsed once per file per call), its file's **forward imports** resolved to **indexed files only** (`extractImports` → `resolveImports`, capped at 10 with `importsTruncated`; the reverse graph is deliberately *not* triggered), and the `contextLines` window. **ONE budget for the whole pack** (`applyPackBudget` in `src/utils/budget.ts`, `maxChars` default 6000): hits are added whole in ranked order while the running total fits, the **top hit is always kept**, and the rest are counted in `omitted` — dropped whole, never truncated; the inner search runs **without** `maxChars`, so a pack has exactly one budget (no double billing). Output is a structured object, `pack: { hits: [{ hit, outline, imports }], totalChars, omitted }` — rendered readably by `formatContextPack` (shared by MCP + stdio + CLI) and attached as `structuredContent` for MCP JSON consumers. Wired through all 8 layers (tool-defs → mcp → control-api `POST /pack` → stdio bridge → cli `pack` → format → index-manager). All composition, no new engines — no schema change, no reindex. *(Still to measure on a live install: the one-call vs. 4-call latency benchmark.)*

### Code intelligence
- ✅ **Import / dependency graph** (`get_dependencies`, `cidx deps`) — "what does a file import?" + "who imports it?". Forward: tree-sitter AST extracts import specifiers per language (`src/chunking/imports.ts`, same parse recipe as `chunkCode`), resolved to **indexed files only** (`src/core/resolve.ts`, every resolved path validated against the index → no phantom edges; relative/external/system classified, with a suffix-match fallback for languages whose source root is unknown like Java/Kotlin). Reverse ("imported by"): built **on demand** and **mtime-keyed in-memory** (`IndexManager.depGraphCache`), reflecting watcher changes on the next call without a reindex; invalidated on `removeIndex`. `project` inferred from the file path (prefix match) or passed explicitly; `scannedFiles` + `truncated` surface the first-call cost and the reverse cap. No schema change, no reindex.
- ✅ **Dead-code detection** (`find_dead_code`, `cidx deadcode`) — flags **potential dead code**: indexed symbols (function / method / class / interface / enum / struct / trait / record) that have **zero whole-identifier references anywhere**, with a conservative multi-signal confidence score so it's reluctant to cry dead. Reference counting is one combined-regex pass over all chunk content (`src/core/deadcode.ts → countReferences`); the **definition rule** excludes only a symbol's exact declaration line (so a recursive call in the body still counts — no false-dead on recursion), and the index is scanned in name-groups so no symbol is silently dropped past the regex cap. Because the index has no `exported`/visibility flag, "exported" is recovered from the chunk text per-language; polymorphic (`@Override`/virtual/trait), dynamic-hook-name (`toString`, `init`, `handle*`…), constructor-like, owner-class-referenced, and common-name signals each **demote** confidence, while Python `_private` names get a small **bump**. Results sectioned `likely dead` (≥70) → `uncertain` (40–69) → `review` (<40); test files and entry points are pre-excluded. `scannedSymbols`/`scannedChunks` + `truncated` surface partial coverage (the table cap). No schema change, no reindex.
- ✅ **Call graph** (`get_call_graph`, `cidx callgraph`) — caller/callee trees around a symbol and/or file: who calls it and what it calls, as bounded, cycle-safe trees (the "call stack / roadmap"). Adjacency comes from whole-identifier matching over chunk content (`src/core/callgraph.ts → buildCallEdges`, the same scan + definition rule as `countReferences`, emitting a caller→callee map instead of a flat counter), so a recursive call is a real self-edge while the declaration isn't. Anchor by symbol name (function-centric), by file (all callables in it), or both (disambiguate). `traverseCallGraph` bounds by `depth` (default 3) + a node `limit` (default 100/direction), with cycles shown as `↻` leaves. The per-project adjacency is cached and keyed on `lastIndexedAt` (not file mtime — the data lives in LanceDB, which can change on a re-chunk without moving mtimes); the first call per project pays the scan. `scannedSymbols` + `truncated` surface coverage. No schema change, no reindex.
- ✅ **Change impact** (`get_change_impact`, `cidx impact`, proposal [C1](./proposals.md#c1-get_change_impact)) — one ranked answer to **"if I change X, what breaks?"**: the three adjacency views the other tools expose separately, joined server-side into one report (`src/core/impact.ts`, pure — a sibling of `callgraph.ts` / `deadcode.ts`; **all three sources are already cached, the only new work is the join**). Sections are ranked by **severity**: a consumer that *calls* the symbol over a file that merely *imports* its module over a loose textual mention — **▲ direct callers** (the cached call graph, reverse: breadth-first, cycle-safe `flattenCallers`, each consumer once at its minimum depth, `depth` default 3) → **→ importers** (the cached dependency graph, reverse; one that also mentions the symbol ranks first via `alsoReferences`) → **≈ textual references** (an exact count of **distinct lines** mentioning the symbol — the dead-code definition rule, overlapping chunks deduped — plus a few representative `file:line` hits). **Test files are split into `coveredBy`** ("covered by a test", with `via: call/import/reference`) instead of counting as production consumers, and `fanOut` reports how entangled the change site itself is (its file's indexed imports + the symbol's in-index calls). Anchors mirror `get_call_graph` (symbol / path / both, ≥1 required) but a ranked report needs **one** change site, so several candidates are refused with their names (`selectAnchor`). Each section carries `total` + `truncated`; `scannedSymbols`/`scannedChunks`/`scanTruncated` surface coverage. Same-name limitation as its parents (whole-identifier matching, not LSP) — documented in the tool description: a review aid, not proof. No schema change, no reindex.

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

### Ops & diagnostics
- ✅ **`cidx doctor`** (proposal `O1`) — one **read-only** diagnostic pass; every check reports `ok`/`warn`/`fail` with a one-line fix hint, exit 0 unless a check fails. CLI-side: daemon reachability + **CLI ↔ daemon version match** (mismatch → warn). Daemon-side via `GET /doctor` (`src/core/doctor.ts`, the check registry — pure checks over injected state, one `runDoctor(ports)` gatherer): Ollama reachable + configured model installed (`/api/tags`); the reranker verdict from `IndexManager.ensureRerankAvailable`'s **cached** probe (missing model → warn, RRF fallback); per project — table exists (`fail` when missing), **schema freshness** through `tableColumns` (pre-2.4.0 table → the *"reindex to enable the docstring search legs"* hint), ANN/FTS index presence (no ANN below `vectorIndexThreshold` is by design; non-empty table without a `content` BM25 index → warn), registry ↔ table sanity (chunk-count drift, empty file cache over a non-empty table, skipped while a job runs), and a `fail` when the project's pinned `embedModel` is absent from Ollama; orphan tables under `~/.cidx/db` (warn); config validity via the **same `parseProjectConfig` the indexer uses** (unparseable YAML / `.cidx.json` → warn); disk usage of the data root with per-table sizes (inline read-only walk — the O3 `stats` command is not built). Tests: `tests/doctor.test.ts` — every check against synthetic state (missing table, legacy schema, broken YAML/JSON, orphan tables) + a healthy synthetic install that comes out all-`ok`.

---

## 🚧 In progress

_(Nothing actively in flight — the docstring / comment embedding proposal is implemented, pending release.)_

---

## 💡 Proposed (not yet built)

> Impact / effort are rough, relative estimates. The "dead-code detection" and "call graph" proposals have since shipped (see Code intelligence in [`features.md`](./features.md)); the "Embed docstring / comment separately" proposal shipped in 2.4.0; [S1](./proposals.md#s1-identifier-part-bm25-tokenization) identifier-part BM25 tokenization, [A1](./proposals.md#a1-get_context_pack) `get_context_pack` and [C1](./proposals.md#c1-get_change_impact) `get_change_impact` shipped in Unreleased. **Detailed designs** (motivation, mechanics, files touched, risks, acceptance criteria) for the items marked with an ID live in [`proposals.md`](./proposals.md) — read it before starting any of them.

### New capabilities (detailed designs in [`proposals.md`](./proposals.md))
| ID | Proposal | Description | Impact | Effort |
|----|----------|-------------|--------|--------|
| [S2](./proposals.md#s2-find_symbol-fuzzy-fallback) | **`find_symbol` fuzzy fallback** | Ngram-FTS tier when exact/prefix misses (typos resolve, `fuzzy: true` marked, opt-out). Model-independent. | Medium | Low-Medium |
| [S3](./proposals.md#s3-pathsurface-boost) | **Path/surface boost** | Small multiplicative post-RRF adjustments (source-root, short-path, test/generated demotion) before rerank. Pure logic, no reindex. | Medium | Low |
| [S4](./proposals.md#s4-query-expansion-local-llm) | **Query expansion (local LLM)** | Opt-in `expand:true`: Ollama rewrites the query into 2–3 variants (symbol-shaped + rephrased), run through `searchBatch` and merged. | Medium | Low-Medium |
| [C2](./proposals.md#c2-public-api-diff--breaking-change-detector) | **Public API diff / breaking changes** | Compare exported symbols between git refs (historical surface re-parsed from `git show`, no index mutation); classified removed/signature-changed/added. | High | Medium-High |
| [C3](./proposals.md#c3-hotspot--technical-debt-report) | **Hotspot / tech-debt report** | Git churn × size × dead-code/coupling density → ranked hotspot bands ("over-changed and over-coupled"). | Medium | Medium |
| [C4](./proposals.md#c4-ownership-blame-enrichment) | **Ownership / blame enrichment** | Opt-in per-search `git blame` enrichment: `lastAuthor`/`lastCommitDate`/range churn per result (the stronger form of the recency proposal). | Medium | Low-Medium |
| [C5](./proposals.md#c5-coupling-metrics) | **Coupling metrics** | fanIn/fanOut/instability per file from the existing dependency-graph cache; hub and change-magnet bands. | Low-Medium | Low |
| [A2](./proposals.md#a2-mcp-resources--index-notifications) | **MCP resources + index notifications** | Expose indexes/overview/status as MCP resources; job-completion notifications over stdio (HTTP stays stateless — read-on-demand resources only). | Medium | Low-Medium |
| [A3](./proposals.md#a3-search-analytics-query-log) | **Search analytics / query log** | Bounded `query_log` in the registry; `cidx stats` surfaces zero-hit queries (index-gap signal) and latency. | Low-Medium | Low |
| [O2](./proposals.md#o2-zero-downtime-model-migration) | **Zero-downtime model migration** | Model change → `migrate` job builds a shadow table off to the side and swaps atomically; search keeps serving self-consistent vectors throughout. | Medium | Medium-High |
| [O3](./proposals.md#o3-table-stats--compact) | **Table stats / compact** | Per-table disk/row/index-age report (`cidx stats`); `cidx compact` via the native optimize API (only if the pinned LanceDB has it). | Low | Low |
| [O4](./proposals.md#o4-daemon-idle-shutdown) | **Daemon idle shutdown** | Opt-in `daemon.idleTimeoutMinutes`: graceful shutdown after N idle minutes (no jobs, no open MCP session); auto-start covers the next touch. | Low | Low |

### Small capabilities (short proposals, no detailed design yet)
| Proposal | Description | Impact | Effort |
|----------|-------------|--------|--------|
| **Recency signal** | Slight boost for recently changed code (git mtime). Superseded in spirit by [C4](./proposals.md#c4-ownership-blame-enrichment) — reconcile when one ships. | Medium | Low-Medium |
| **`maxFileSizeBytes` guard** | Skip oversized data files without relying solely on `.cidxignore`. | Low-Medium | Low |
| **Combined `search + outline`** | Return a hit's file outline in the same call; saves a turn. **Covered** — [A1](./proposals.md#a1-get_context_pack) shipped as `get_context_pack` (outline + imports + a pack budget). | Low-Medium | Low |

### Suggested order
1. `C2` public API diff (highest effort of the five; schedule after the cheap wins).
2. The rest per `proposals.md`'s table: `C4`, `S3`, `A2`, `C5`, `S2`, `A3`, `O3`, `S4`, `C3`, `O4`, `O2`.

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
