# Features — Capability Catalog

What the tool **does today** (version 2.4.0). For what's planned, see [`status.md`](./status.md); for how it's built, [`architecture.md`](./architecture.md). For user-facing install & usage, the root [`README.md`](../README.md).

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
- **Docstring search legs** (on by default; 2.4.0) — each symbol's docstring / doc-comment is embedded into a separate `doc_vector` column on the same row, and hybrid search merges up to **four RRF legs**: code-vector, doc-vector, content BM25, doc BM25. So intent queries ("how to do X") can hit the *documentation* even when the *code body* doesn't match. Results that arrived via a doc leg carry a `[doc hit]` marker. Global switch `indexing.docstrings` (default true); per-call `doc: false` / `--doc false` skips the doc legs. Pre-2.4.0 tables take the legacy code paths until reindexed.
- **Identifier-part BM25 (`id_terms`)** (on by default) — the counterpart of the docstring legs on the *code* side. BM25 indexes `content` verbatim, so a query like *"update user name"* never matched `getUserName` (one identifier token). At chunk time every compound identifier of a chunk is split at camelCase / snake_case / kebab-case / dotted boundaries into a nullable `id_terms` column — `getUserName` → `getusername get user name`, `user_id` → `user_id user id` — capped at 2000 chars per chunk, deduplicated, with the raw identifier kept so exact-symbol matches don't regress. Hybrid search adds a fifth RRF leg: BM25 over `id_terms`, running only when the query itself splits into **≥ 2 parts** (a single word is already served by `content`) and merging anonymously (no marker field, no new output field). Pure CPU at index time — **no embedding pass**, unlike `doc_vector`. Only `hybrid` mode uses it; legacy tables (created before the column) take the exact pre-existing paths until a full reindex.
- **Context pack** (`get_context_pack` / `cidx pack`) — one call assembling what an agent otherwise burns 4–6 round-trips on: the search core (the same hybrid + rerank + MMR + doc-leg + query-cache pipeline as `search_codebase`) plus, for every hit, its **file outline** capped to the hit's neighborhood (the symbols overlapping the hit's chunk, plus the next few below it — at most 12), its file's **forward imports** resolved to **indexed files only** (capped at 10, `importsTruncated` when the cap bites), and the optional `contextLines` window — all under **one pack-level char budget** (default 6000). Hits are added whole in ranked order while the pack fits; the top hit is always kept; the rest are counted in `omitted` (dropped whole, never truncated). The internal legs never truncate on top of the pack budget. Returns a structured object: `hits: [{ hit, outline, imports }], totalChars, omitted`.

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
- **Change impact** (`get_change_impact` / `cidx impact`) — one ranked answer to **"if I change X, what breaks?"**: the three adjacency views the other tools expose separately, joined server-side into one report (all three already exist and are cached — the only new work is the join, in `src/core/impact.ts`).
  - **Sections are ranked by severity.** A consumer that *calls* the symbol outranks a file that merely *imports* its module, which outranks a loose textual mention: **▲ direct callers** (the cached call graph, reverse, `depth` 3 by default) → **→ importers** (the cached dependency graph, reverse; one that also mentions the symbol ranks first) → **≈ textual references** (an exact count of distinct lines mentioning the symbol, plus a few representative `file:line` hits). Each section carries `total` + `truncated`.
  - **Covered by, not consumed by.** Test files are pulled out of the production sections and listed separately with how they reach the symbol (`via: call / import / reference`) — a test that exercises a symbol is a different fact from a production consumer.
  - **The change site itself is reported.** `fanOut` shows how entangled the anchor is: distinct indexed files its file imports, distinct in-index symbols it calls, and the imported paths.
  - **Anchor by symbol, file, or both** (≥1 required), exactly like `get_call_graph` — but a ranked report needs **one** change site, so a file with several callables (or an ambiguous name) is refused with the candidate list. `scannedSymbols` / `scannedChunks` / `truncated` / `scanTruncated` surface coverage. No schema change, no reindex.
  - **Limitation:** whole-identifier matching, not LSP — same-named symbols in different scopes are indistinguishable, and only in-index edges exist. A review aid, not proof.
- **Git-history / commit-message search** (`search_commits` / `cidx commits`) — the questions code search can't answer: **when / why was feature X added**, and **who changed this file, and when**. A separate search space over the project's git history.
  - **Live `git log`, no indexing.** Runs `git log` directly in the indexed project's directory — no embedding, no LanceDB, no schema change, no reindex (additive, like the rest of code intelligence). `isGitRepo` is checked first, so a non-repo project reports `notARepo` instead of erroring.
  - **Message / file / author / date filters.** `query` is a case-insensitive regex over the commit message (subject + body); `path` restricts to commits that touched a file/dir/glob (its history); `author` matches name/email; `since`/`until` take git date syntax (`"2 weeks ago"`, `"2024-01-01"`). With no filters it returns the most recent commits.
  - **Optional changed files.** `withFiles: true` appends the changed file list per commit — the "what did this change touch" depth.
  - **Safe by construction.** NUL-separated (`-z`), `execFile` with no shell (no injection); the path filter is relativized and passed as a literal argv after `--`. Fields are `\x1f`-separated and a commit header is anchored on a 40-hex SHA + `\x1f`, so a changed-file name can't be mistaken for a new commit. `limit` (default 50) with a `truncated` flag + `⚠` line when hit.
- **Public API diff / breaking-change detector** (`get_api_diff` / `cidx apidiff`) — the changelog-generation / pre-merge-review question: **"did this release break anything public?"** `get_api_diff(project, base, head?)` compares two git refs as **exported-symbol surfaces** and classifies every symbol.
  - **The base side is re-parsed from git.** `git ls-tree -r --name-only -z <ref>` intersected with the AST extensions (the **scope guard**: only the 16 bundled grammars have a surface), then `git show <ref>:<path>` per file (literal argv, **no shell**, NUL-safe) parsed with the **same `chunkCode` recipe** as indexing, in bounded concurrency (the embedding pipeline's shape, minus embeddings). No index mutation, no reindex, nothing persisted, no embedding.
  - **The head side defaults to the working tree = the index** (no re-parse at all); pass `head` (tag / SHA / branch) to compare two historical points instead.
  - **Classification.** `removed`, `signature-changed` and `visibility-narrowed` are **BREAKING** and carry the `was:` / `now:` signatures side by side; `added` is non-breaking; `unchanged` is always counted and only listed with `includeUnchanged` / `--all`. A **rename is an honest `removed` + `added` pair** — there is no rename inference, so nothing is silently paired up. "Exported" is recovered from chunk text per language with the same `detectExported` recipe the dead-code scorer uses (factored into `src/core/exported.ts`), which is what makes `visibility-narrowed` (export dropped) detectable.
  - **Signature comparison is per-language and approximate by design**: arity, parameter order and *normalized* parameter names (defaults, type annotations, `&`/`*`/`...` decoration and Python's `self` are cut; Go keeps the first token of `name Type`, Java/C++ the last). Structural differences — type-only changes, overloads, reordered defaults — need review; a side with no comparable parameter list never counts as changed.
  - **Nothing fails silently.** A non-repo project reports `notARepo`; a ref that doesn't resolve reports `unknownRef`; a ref git can't safely be given reports `invalidRef`; a file that can't be read or parsed at a ref is listed in `unparsedFiles` (it contributes **no** symbols — you see the gap). `scannedFiles` + `truncated` surface the file cap (default 1000/side) and the entry cap. `exportedOnly` keeps everything exported on at least one side, so a narrowed symbol is still visible.
- **Doc–code conformance checker** (`check_docs` / `cidx doccheck`) — "do the docs still tell the truth about the code?" answered **deterministically**: every backtick span in the project's markdown docs is classified and resolved against the index. **No Ollama, no LLM** — byte-for-byte reproducible, ~1 s of CPU on a whole docs corpus.
  - **Only a total-resolution miss is a finding.** Each span is classified into one of 13 classes (identifier / path / env / endpoint / cmd / flag / dep / kv / model-tag / config-path / composite / artifact / opaque) and resolved against the symbol set, whole-identifier occurrences (with `file:line` evidence), a constant-literal table (`const INDEX_JOB = "index"` — a doc can name a literal *value*), the file universe (indexed files ∪ **every walked file** — the index is an under-approximation of the repo), package.json deps/devDeps/scripts, and per-file symbol membership. Only when a total-resolution class misses outright does it become a **drift** finding at confidence ≥ 90; every shade of doubt lands in the separate **`needsReview`** list (fuzzy near-misses become `did you mean …? (possible rename)`).
  - **The intent shield.** Changelog / release-notes / **proposals / roadmap** files are `historical` (counted, never findings); fenced code examples and lines under a planned heading (`## 💡 Proposed`, roadmap, todo) never produce findings; prose examples (`e.g. a/b.py`, single-char path segments, same-line twin tokens) demote to review; a vocabulary of things a doc may name without claiming they exist here is skipped — bare extensions (`.md`), `.git/…`, URI paths (`/ping`), `owner/repo:tag` refs, `<placeholders>`, CI labels (`ubuntu-24.04-arm`), other projects' convention files (`project.godot`), `~`-rooted / `../` paths, and `OLLAMA_*` variables that occur nowhere in code. Escape hatch: `<!-- cidx-doccheck-ignore -->` suppresses its own line + the next.
  - **Reverse coverage.** Exported symbols (`detectExported`; test files / entry points excluded) that **no doc span mentions** are listed as advisory `undocumented` entries (confidence 40, capped, `noUndocumented` opts out) — the check that catches a shipped tool missing from the README.
  - **Drift window.** `since <ref>` (resolved via `git show -s --format=%at`) or `window: true` (the docs' own last commit) post-filters findings to those whose doc or code side actually changed; every degradation (non-repo, unresolvable ref) is a note, never a silent full scan.
  - **Freshness is surfaced, not hidden.** The evidence snapshot is one `tableSymbolsWithContent` pass per index version (cached on `lastIndexedAt`), and `checked.indexFreshness` says what the report was built from — the index lags edits by ~1–2 s, so a symbol renamed moments ago can read as drift.
  - **Per-project tuning.** `.cidx.json` `doccheck` `{ files, ignore }` restricts the doc set or skips files; daemon-side budgets live in `config.yml` `doccheck.maxChars` (default 12000) / `doccheck.undocumentedLimit` (default 25). Exit code: 0 when consistent, **1 only when drift findings exist** (CI-able).

## Chunking

- **Smart (AST) chunking** — `web-tree-sitter`; splits at function / class / method boundaries, descending into namespace / module / mod so nested symbols are extracted per-language.
- **16 languages** with embedded grammars: JS / TS / TSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Kotlin, Swift, Scala, GDScript.
- **Godot/GDScript** — `class_name`, inner classes, `signal` declarations (as their own `signal` symbol type), `enum`, `func` and the `_init` constructor are extracted as symbols; the grammar is vendored and built by `scripts/build-gdscript-wasm.sh` (see [`architecture.md`](./architecture.md)).
- **Character-based fallback** for languages without a grammar (and for Lua — see [`status.md`](./status.md)); also used for Godot's text formats (`.gdshader`, `.tscn`, `.tres`, `project.godot`) — searchable text, no symbols.
- **Doc formats with language labels** — `.xml` and `.rst` are indexed via the character fallback but carry a `language` label (`xml` / `rst`; `.json` → `json`, `.md` → `markdown`), so the `language` filter works on documentation corpora — e.g. a Godot engine class-reference dump (`godot --doctool`) or a godot-docs tree indexed alongside a game project for version-matched API search.
- **Token-aware cap** — the chunk window also respects an approximate token budget (`min(maxChunkSize, maxChunkTokens·4)`), so a large `maxChunkSize` can't silently overflow the model's token window. Char-limit-binding by default (`maxChunkTokens` 512 · 4 = 2048 > `maxChunkSize` 1500); tune via `indexing.maxChunkTokens` / `MAX_CHUNK_TOKENS` and reindex.
- **Docstring / doc-comment extraction** (2.4.0) — each emitted chunk carries an optional `doc`: the Python docstring (or, failing that, preceding comments), or for every other AST language the **contiguous run of comment nodes directly preceding the symbol** (JSDoc, Rust `///`, Go `//`, JavaDoc, …), capped at 1200 chars and attached only to the first chunk of a split symbol. Controlled by `indexing.docstrings` (default true).

## Efficiency

- **Batch + bounded-parallel embedding** — Ollama batch API; `batchSize` chunks per request, `concurrency` parallel requests. Default model `qwen3-embedding:0.6b` — the bare `qwen3-embedding` tag resolves to the **8B** variant in Ollama, which is 4.6 GB and no better for chunks that are at most ~512 tokens; override with `ollama.model` / `OLLAMA_MODEL`, or per project with `.cidx.json` `embedModel`.
- **Right-sized Ollama context** — every model call carries an explicit `num_ctx` (Ollama otherwise allocates **4096** for any loaded model, ~8× oversized for ~512-token chunks, and holds that context buffer for as long as the model stays resident). `ollama.numCtx` / `OLLAMA_NUM_CTX` (default **1024**) covers the embed calls — `num_ctx` applies to each input item of a batch individually, and chunks are capped at `maxChunkTokens` tokens, so the default leaves 2× headroom — and `search.rerank.numCtx` / `RERANK_NUM_CTX` (default **1024**) covers the rerank judge prompt (query + one chunk + the Qwen3-Reranker template ≈ 500 tokens). Measured on `qwen3-embedding:0.6b`: residency drops 2.4 GB → 1.4 GB, embeddings bit-identical for inputs up to ~3000 chars. Raise both if you raise `maxChunkSize` past ~4000 chars.
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

- A project root can carry a **`.cidx.json`** — the per-project counterpart to the global `~/.cidx/config.yml`. Four optional fields, validated independently (an invalid field is dropped with a warning; a file with no valid fields is ignored; invalid JSON warns and is skipped — indexing never fails because of it):
  ```json
  {
    "languages": ["typescript", "gdscript"],
    "ignore": ["vendor/**", "*.gen.ts"],
    "embedModel": "qwen3-embedding:8b-q8_0",
    "doccheck": {
      "files": ["docs/**/*.md"],
      "ignore": ["docs/drafts/**"]
    }
  }
  ```
- **`languages`** — an allowlist of language labels (the same labels as the `language` search filter: `typescript`, `python`, `gdscript`, `markdown`, …). Files whose extension produces no label are dropped while the filter is active. Filtered-out files are absent from the file list, so the **deleted-file cleanup prunes them on the next sync**; the watcher removes them live on file events.
- **`ignore`** — extra ignore patterns layered on top of `.gitignore` + `.cidxignore` (same `ignore`-package semantics).
- **`embedModel`** — a per-project embedding model. The record's `embedModel` is pinned at `createIndex`, a **`sync` escalates to a full reindex** when the project config's model differs (vectors from two models can't share a table), and the **watcher skips writes** for a project whose model changed until it is reindexed. Queries are embedded with the model the table was built with, so search stays self-consistent. (Caveat: `searchAll` across projects using different models mixes distances from different embedding spaces.)
- **`doccheck`** — `{ files: string[], ignore: string[] }` tuning for `check_docs` / `cidx doccheck`: `files` replaces the default doc set (`*.md` + `docs/**/*.md`, root-anchored globs), `ignore` skips extra doc files/globs on top of `.gitignore`/`.cidxignore`. Read fresh on every check, same as the rest of the file.
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

## Ops & diagnostics

- **`cidx doctor`** — one **read-only** diagnostic pass over the whole install: the support checklist (daemon up? Ollama reachable? model installed? schema current? config valid?) answered in a single command. Every check reports **`ok` / `warn` / `fail`** plus a one-line fix hint; exit 0 unless a check **fails** (warnings still exit 0), so it is scriptable. Nothing is ever mutated.
  - **Daemon (CLI-side)** — reachable via `/ping`, and the CLI ↔ daemon **version match** (a mismatch is a `warn`: restart the daemon).
  - **Ollama** — reachable + the configured `ollama.model` installed (one `/api/tags` call; a bare name matches its `:latest`/tagged form). Unreachable or missing model → `fail`.
  - **Reranker** — the result of the same **cached** probe search uses (`IndexManager.ensureRerankAvailable`); a missing model is a `warn` (search falls back to RRF order).
  - **Per project** — table exists (`fail` if the registry row has no table), **schema freshness** (a pre-2.4.0 table without `doc`/`doc_vector` gets the *reindex to enable the docstring legs* hint), **ANN/FTS presence** (no ANN below `vectorIndexThreshold` is by design; a non-empty table without a `content` BM25 index is a `warn`), and registry ↔ table sanity (chunk-count drift, empty file cache over a non-empty table — skipped while a job runs). A project whose pinned `embedModel` is missing from Ollama is a `fail`.
  - **Orphan tables** — `~/.cidx/db` directories no registry row references (`warn`: never searched, only disk). A registry row without a table is reported by that project's check.
  - **Config** — the global YAML parses; every project's `.cidx.json` is validated by the **same validator the indexer uses** (`parseProjectConfig`). Broken files are `warn`s (cidx silently ignores them today — doctor makes that visible).
  - **Disk usage** — total + per-table directory sizes of the data root (`CIDX_HOME`, default `~/.cidx`), computed inline (read-only walk).
  - **Layering** — the checks live in `src/core/doctor.ts` as pure functions over injected state (unit-tested without a daemon/Ollama/LanceDB); `GET /doctor` (Control API) gathers the live state and returns the aggregated report; the CLI renders it.

## MCP tools exposed to agents

Every tool that takes a `project` also takes a **`path`** — a file/dir inside the project, whose owning project is inferred (an explicit `project` wins). Nothing given: the search family searches **all projects**; the per-project report tools use the single indexed project or error naming them. An unknown project name is reported with the available projects (and the likeliest intended one), so the caller can self-correct in one turn.

| Tool | Purpose |
|------|---------|
| `search_codebase(query, project?, path?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?, rerank?, mmr?, maxChars?, doc?)` | Hybrid search; all projects if `project` omitted. Each result carries `signature` + `indexedAt`; `contextLines > 0` adds ±N surrounding lines; reranking and MMR diversification are on by default (`rerank: false` / `mmr: false` skip them); `maxChars` caps returned text (results kept whole); doc legs add a docstring/doc-comment search (`doc: false` skips; doc-hit results carry `[doc hit]`). |
| `search_codebase_batch(queries, project?, path?, limit?, mode?, language?, symbolType?, pathGlob?, contextLines?, rerank?, mmr?, maxChars?, doc?)` | Run several queries in one round-trip; results grouped per query. Same options/behavior as `search_codebase`, applied per query. |
| `find_symbol(name, project?, path?, limit?, language?, symbolType?)` | Find a symbol by name (exact + prefix). |
| `get_context_pack(query, project?, path?, limit?, maxChars?, contextLines?)` | One call = search hits + per-hit file outline (capped to the hit's neighborhood) + forward imports (indexed files only) + context lines, under a single pack-level char budget (default 6000). Returns `{ hits: [{ hit, outline, imports }], totalChars, omitted }`; the top hit is always present and `omitted` counts the hits that didn't fit. |
| `find_references(name, project?, path?, limit?, language?, symbolType?)` | Where a symbol is used (call sites + definition). |
| `get_repo_overview(project?, path?)` | Structural onboarding summary. |
| `get_file_outline(path)` | Symbol map of a file. |
| `get_dependencies(path, project?, limit?)` | What a file imports (resolved to indexed files + external) and who imports it (reverse). |
| `get_call_graph(symbol?, path?, project?, direction?, depth?, limit?)` | Caller/callee trees around a symbol and/or file (≥1 of symbol/path required). `direction` ∈ `callers`/`callees`/`both` (default `both`); `depth` default 3; cycle-safe, bounded by `limit` (default 100/direction). |
| `find_dead_code(project?, path?, language?, symbolType?, minConfidence?, limit?)` | Potential dead code: zero-reference symbols, conservatively scored and sectioned by confidence. |
| `get_change_impact(symbol?, path?, project?, depth?, limit?)` | One ranked answer to "if I change X, what breaks?": direct callers → module importers → textual references, each section capped with `total`/`truncated`; test files reported separately as "covered by"; `fanOut` shows the change site's own entanglement. ≥1 of symbol/path required. |
| `search_commits(project?, query?, path?, author?, since?, until?, withFiles?, limit?)` | Git-history / commit-message search ("when/why was X added", file history). Live `git log` — no indexing, no embedding. `withFiles` appends changed files; `notARepo` when the project isn't a git repo. |
| `get_api_diff(project?, path?, base, head?, limit?, maxFiles?, exportedOnly?, includeUnchanged?)` | Public-API diff between two git refs: `removed` / `signature-changed` / `visibility-narrowed` (BREAKING, with `was:`/`now:` signatures) / `added` / `unchanged`. The base ref is re-parsed from git; `head` defaults to the working tree as indexed. `notARepo` / `unknownRef` / `unparsedFiles` are reported, never thrown or skipped. |
| `check_docs(project?, path?, files?, ignore?, limit?, maxChars?, undocumentedLimit?, noUndocumented?, since?, window?)` | Doc–code conformance: every backtick span in the project's markdown docs is classified and resolved against the index — deterministically, no Ollama. `findings` are drift (confidence ≥ 90, only total-resolution misses); `needsReview` holds everything uncertain; `undocumented` lists exported symbols no doc mentions (advisory). `since` / `window` limit the report to docs or code that changed; `checked.indexFreshness` surfaces the snapshot age. Exit 1 (CLI) only on drift. |
| `list_indexes()` | Indexed projects + statuses. |
| `get_index_status(project?)` | Indexing status + live progress. |
| `index_project(path, name?)` | Agent starts indexing a new directory (background). |

## CLI commands (summary)

`start [dir]` · `index <dir> [--name x]` · `list` · `status [name]` · `reindex <name>` · `sync <name>` · `remove <name>` ·
`search "<query>" [flags]` · `open "<query>" [flags]` · `batch "<q1>" "<q2>" ...` · `pack "<query>" [flags]` · `find <name> [flags]` · `refs <name> [flags]` · `deps <file> [flags]` · `callgraph <symbol|file> [flags]` · `impact <symbol|file> [flags]` · `apidiff <project|dir> <base> [--head x] [flags]` · `commits <project|dir> [query] [flags]` · `deadcode [name|dir] [flags]` · `doccheck <project|path> [flags]` · `overview [name|dir]` · `doctor` · `mcp` · `config [path]` · `stop` · `version` · `help [cmd]`

> Full details: `cidx help` / `cidx help <command>`.
