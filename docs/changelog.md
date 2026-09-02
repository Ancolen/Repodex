# Changelog

Version-by-version implementation history, **newest first**. For the current done / proposed picture, see [`status.md`](./status.md); for what the tools do, [`features.md`](./features.md).

> **How this repo versions:** the design uses informal "waves" (v1 → v4); the **release version** in `package.json` is bumped per wave (currently `2.2.0`). The version string lives in **five** places that must be bumped together on release: `package.json`, `src/server/mcp.ts` (`Server` info), `src/server/control-api.ts` (`/ping`), `src/stdio-bridge.ts`, and `src/cli.ts` (`CLI_VERSION`). The `web-install.sh` / Release workflow fires on a pushed `v*` git tag.

---

## 2.2.0 — Godot / GDScript + doc-format indexing

Full Godot support at the same depth as the other languages: AST chunking, dependency graph, dead-code scoring, config, docs, and a new grammar-acceptance test suite. Version bumped 2.1.0 → **2.2.0**; `bun run typecheck` clean, `bun test` **260/260** (700 expect).

### Doc-format indexing (XML / reST) + pathGlob fix

Motivated by a Godot game project: index a version-matched engine class reference (`godot --doctool` dumps per-class `.xml`) next to the game code so API questions ("does this method exist in 4.7? what are the params?") are answerable by hybrid search without leaving the machine. `bun run typecheck` clean; `bun test` green (chunker + config suites extended).

- `allowedExtensions` += `.xml`, `.rst` (defaults in `src/config.ts`, so the generated `DEFAULT_CONFIG_YAML` picks them up; **live `~/.mcp-indexer/config.yml` overrides defaults — update it too**).
- `src/chunking/chunker.ts`: new exported `TEXT_LANG_BY_EXT` (`.xml`→`xml`, `.rst`→`rst`, `.json`→`json`, `.md`→`markdown`); `chunkCode` derives the language label as `EXT_TO_GRAMMAR[ext] ?? TEXT_LANG_BY_EXT[ext]` so fallback-chunked doc formats carry a meaningful `language` column and the `language` search filter works on them (grammar extensions unchanged; `.tscn`/`.tres`/`.gdshader`/`.godot` deliberately stay unlabeled).
- No grammar added by design: per `CLAUDE.md`, any new grammar must pass the interleaved-determinism suite, and docs need search, not symbols — character fallback plus a label is the right weight here. Consequence: `find_symbol`/outline/deps return nothing for these files (expected).
- Tests: `tests/chunker.test.ts` gains a "doc formats (xml/rst)" describe (fallback chunking + label propagation via `buildMeta`, Godot class-XML fixture, `.rst` fixture, `.md` retro-label); `tests/config.test.ts` asserts the new extensions.

#### pathGlob: project-relative patterns actually match now

`buildWhere`'s glob→LIKE conversion start-anchored every wildcard pattern (`src/*` → `LIKE 'src/%'`), but indexed `filePath` values are **absolute** — so the documented project-relative usage (`src/*`, and the new docs-driven `docs/*`) could never match anything. Now: patterns starting with `/` stay absolutely anchored; anything else gets a leading `%` (match anywhere); `**` collapses to `*` (`%` spans `/`, so this is purely cosmetic). No schema/reindex impact — pure query-time. Assertions updated in `tests/db-where.test.ts` + `tests/hybrid.test.ts`; new anchor + `**` cases added.

### Vendored grammar wasm (the enabler)

- `tree-sitter-wasms@0.1.13` (frozen) has no gdscript and the npm `tree-sitter-gdscript` ships native prebuilds only — so the wasm is **built and vendored**: new `scripts/build-gdscript-wasm.sh` fetches `tree-sitter-gdscript@2.0.0`, hard-fails unless its `src/parser.c` still declares `LANGUAGE_VERSION 14` (web-tree-sitter 0.22.6 accepts 13–14), and compiles it **as shipped** (`tree-sitter-cli@0.20.8 build-wasm` — no `generate`, which could shift the ABI) inside `emscripten/emsdk:3.1.61` docker. Result lives at `src/chunking/wasm/tree-sitter-gdscript.wasm` (~200 KB, sha256 `33e7de5db98e…`), imported like the other 15 with `with { type: "file" }` so `bun build --compile` embeds it.

### Chunking (`src/chunking/`)

- `EXT_TO_GRAMMAR` += `.gd → gdscript`; grammar node types mapped onto the generic sets: `class_name_statement` + `enum_definition` → CLASS_LIKE, `constructor_definition` + `signal_statement` → FUNCTION_LIKE. `symbolTypeOf` gains a `signal` type (GDScript signals are API surface; deliberately outside `DEAD_CANDIDATE_TYPES`/`CALLABLE_TYPES` since `emit_signal("x")`/`connect` string indirection makes reference counts unreliable).
- `nameOf` learns two generic steps: `constructor_definition` → `"_init"` (the grammar's constructor is a literal `func _init` token — no name node at all) and a `name`-typed bare child fallback (covers `class_name_statement`/`signal_statement`, which carry no `name` field; inert for the other 15 grammars — verified).
- Node shapes were verified live by dumping `rootNode.toString()` per the `imports.ts` convention before finalizing the extractor/tests. Known grammar gap, locked down by a `[LIMITATION]` test: `match` patterns with dotted attributes (`State.IDLE:`) produce ERROR nodes that stay inside the enclosing function chunk.

### Dependencies (`src/chunking/imports.ts`, `src/core/resolve.ts`)

- New `extractGdscript`: `extends "res://…"` (string child — engine-class `extends Node2D` is skipped) and `preload`/`load` calls inside top-level const/var/expression statements (the `call` node has no fields — the callee is the first non-`arguments` child). `uid://` specifiers are skipped. GDScript has no import statements; top-level scan is exact since `source` is a flat statement list.
- New `resolveGdscript`: strips `res://`, resolves against the project root then the importing file's dir, appends `.gd` when the extension is omitted, suffix match as last resort — index-validated like every other resolver (previously gdscript fell to `external/unsupported`, so Godot projects had no dep graph at all).

### Dead code (`src/core/deadcode.ts`)

- `DYNAMIC_HOOK_NAMES` += ~21 Godot engine virtuals (`_ready`, `_init`, `_process`, `_physics_process`, `_input`, `_draw`, …) — zero-reference by design, never dead. `detectExported` gains a gdscript case (`class_name` registers globally; `@export` exposes to the editor). New `signal-handler-convention` demotion (−25) for `_on_*` handlers wired via the editor. Deliberately **not** copied: Python's `_`-prefix +10 (in GDScript the underscore marks virtuals, not privacy) — regression-locked by a test.

### Config + watcher

- `allowedExtensions` += `.gd` (grammar) and `.gdshader` / `.tscn` / `.tres` / `.godot` (character-fallback text formats — Godot shaders, scenes, resources, `project.godot`; searchable but symbol-less, like `.json`/`.md`). `ignoredDirs` + watcher `IGNORE_RE` += `.godot` (the cache dir; `project.godot` the file is unaffected — segment-bounded match).
- **Upgrade caveat:** the YAML `allowedExtensions` list **replaces** the default wholesale — an existing `~/.mcp-indexer/config.yml` must gain the new entries by hand, then the project reindexed, or Godot files are silently not collected.

### Determinism suite (codifies the Lua lesson)

- New interleaved-grammar tests in `tests/tree-sitter.test.ts`: a GDScript outline must stay byte-stable across 5 rounds of TS/Python/Go/Rust/Ruby parses on the single shared parser, and the reverse direction (other grammars stable after gdscript parses). The grammar ships a heap-allocating external scanner — exactly the Lua risk profile — and passed 3× repeated full runs.

### Also shipping in 2.2.0 (previously held under Unreleased)

#### Git-history / commit-message search — `search_commits` / `cidx commits`

The "when / why was feature X added" and "who changed this file, and when" questions that code search can't answer — a separate search space over the project's git history. Built **additive** (mirrors `get_call_graph` end-to-end through all 8 layers) and **requiring no schema change and no reindex**: it runs `git log` live in the indexed project's directory — no embedding, no LanceDB.

- **Live git-log engine.** New `src/core/commits.ts` (pure parser + types) + `src/services/git.ts → searchGitLog` (the exec). `git log -z -i -n <limit> --format=<COMMIT_FORMAT>` with optional `--grep` / `--author` / `--since` / `--until` / `--name-only` / `-- <pathspec>`. `-z` (NUL-separated) + `execFile` (no shell) make it safe for any path/message; the path filter is relativized to the repo root and passed as a literal argv after `--` → no injection. `isGitRepo` is checked first, so a non-repo project returns `notARepo` instead of throwing. Timeout 15 s, maxBuffer 32 MB.
- **Unambiguous format.** `COMMIT_FORMAT` separates the 8 fields (hash, abbreviated, author name/email, ISO date, epoch-seconds date, subject, body) with the unit separator `\x1f`; `-z` makes the inter-commit and inter-filename separator a NUL. A commit header ALWAYS begins with a 40-hex SHA followed by `\x1f`, so a changed-file name (which never contains `\x1f`) can't be mistaken for a new commit — that anchor is what lets `--name-only` files be told apart from headers in one split pass, and it survives a multi-line commit body.
- **Engine + surfaces.** `IndexManager.searchCommits(project, opts)` resolves the project (throws if unknown, like `findDeadCode`), checks `isGitRepo`, runs the log, and wraps a `CommitSearchResult` (`project`, echoed `query`, `count`, `commits[]`, `truncated`, `notARepo`). Filters: message `query` (case-insensitive regex), `path` (file / dir / glob history), `author`, `since` / `until` (git date syntax), `limit` (default 50), `withFiles` (changed files per commit). No filters → the most recent commits (a free "recent history").
- **Surfaces.** Tool `search_commits` (`tool-defs`), `POST /commits` (control API, `project` required), stdio bridge case, CLI `cidx commits <project> [query] [--path|--author|--since|--until|--limit|--files]` (aliases `git-log` / `gitlog`); `formatCommits` (header + one block per commit: abbreviated hash · date · author · subject, optional indented body, optional changed-files list, a `⚠` truncation line).
- **Verification.** `bun run typecheck` clean, `bun test` **241/241** (624 expect); new suite `tests/commits.test.ts` (pure `parseCommitLog`: field/record separators, the 40-hex+SEP anchor vs a 40-hex *filename*, multi-line body, withFiles interleaving, empty / trailing-NUL, non-numeric timestamp). The git↔parser contract was also smoke-tested live against this repo's own history (a `query=callgraph` search returned the code-intelligence feature commit with its 14 changed files). See [`status.md`](./status.md) → *Search*.

#### Code intelligence — import/dependency graph + dead-code detection

Two new discovery tools, both built on the existing tree-sitter parse recipe and the `find_references` whole-identifier foundation, both **additive** (new MCP tools + Control-API endpoints + CLI commands + formatters, mirroring `find_references` end-to-end through all 8 layers) and **requiring no schema change and no reindex**.

##### Import / dependency graph — `get_dependencies` / `cidx deps`

"What does this file import?" and "who imports it?" — the module-level picture.

- **Per-language AST extraction.** New `src/chunking/imports.ts` (`extractImports`) walks a file's **top-level** AST nodes and pulls import specifiers per language, reusing `chunkCode`'s exact parse recipe (shared parser, `languageForExt` → `setLanguage` → `parse`, **no `await` between setLanguage and parse** — shared-parser safety). Dispatch sets were verified live against the pinned grammars. JS/TS `import_statement` (field `source`), Python `import_statement` / `import_from_statement` (dotted name + relative dots + imported names), Go import blocks (`import_spec`/`import_spec_list`), Rust `use_declaration` (`crate::`/`super::`/`self::` + brace lists), Java/C#/Kotlin/Swift/Scala dotted forms, C/C++ `preproc_include` (`<system>` vs `"local"`), Ruby `require(_relative)`/`load`, PHP `require`/`include` + `namespace use`.
- **Index-validated resolution.** New `src/core/resolve.ts` (`resolveImports`, `buildFileIndex`) turns raw specifiers into real indexed files — **every resolved path is checked against the index**, so there are no phantom edges. Language-aware: JS relative ext + `index.*` variants, Python `a.b`→`a/b.py` / `__init__.py` + dot-ascend, Rust `crate::`/`super::`/`self::` + `mod.rs`, C/C++ local includes, PHP/Ruby local requires. Bare specifiers (node_modules, external crates, go modules, stdlib, namespaces) → `external`; on-disk-but-unindexed → `unresolved`; a path-segment **suffix match** is the last resort for languages whose source root is unknown (Java/Kotlin simple names).
- **Reverse graph on demand + mtime cache.** `IndexManager.getDependencies` builds the reverse ("imported by") graph **on first call** and caches it in-memory (`depGraphCache`), keyed by the join of the indexed-file set + per-file mtimes — so a watcher change is picked up **on the next call with no reindex**. Forward edges are computed fresh from disk each call. `project` is inferred by `IndexRecord.path` prefix (most-specific wins; throws on none/ambiguous) or passed explicitly. `scannedFiles` + `truncated` surface the first-call cost and the reverse cap (default `limit` 200). Cache is invalidated in `removeIndex`.
- **Surfaces.** Tool `get_dependencies` (`tool-defs`), `POST /dependencies` (control API, guards `existsSync`+isFile), stdio bridge case, CLI `cidx deps <file> [--name x] [--limit n]`; `formatDependencies` (resolved / external / unresolved grouped + imported-by + scannedFiles + a `⚠` truncation line).

#### Dead-code detection — `find_dead_code` / `cidx deadcode`

Surfaces **potential dead code**: indexed symbols (function / method / class / interface / enum / struct / trait / record) with **zero whole-identifier references anywhere**, each tagged with a conservative confidence so the tool is reluctant to cry dead.

- **Conservative multi-signal scoring.** New `src/core/deadcode.ts` (`scoreDeadCode`) starts at confidence 80 and **demotes** for every signal that could mean "used despite no static reference": `exported` (−30, recovered from chunk text per-language: JS/TS `export`, Rust `pub`, Go uppercase-first, Java/C# `public`), polymorphism (`@Override`/virtual/trait/interface, −35), dynamic-hook-name (`toString`, `main`, `__init__`, `handle*`, `get*`…, −25), constructor-like (−30, mutually exclusive with the hook signal), method + owner-class-referenced (−20), common-name / collision (−15). Python `_private` names get a +10 **bump**. Clamped to [0,100]; band ≥70 `likely dead`, 40–69 `uncertain`, <40 `review`.
- **Definition-aware, single-pass counting.** `countReferences` runs one whole-identifier regex over **all** chunk content. The **definition rule** excludes only a symbol's exact declaration line in its own file — so a recursive call inside the body still counts (no false-dead on recursive functions) while the declaration isn't double-counted. The index is scanned in **name-groups** (`NAME_REGEX_CAP` 5000) with a global name→keys + declaration-line index, so no symbol is silently dropped past the regex cap and def-line exclusion stays correct across groups. Identical names across files share a count (collision → conservative: neither is flagged).
- **Engine + pre-filter.** `IndexManager.findDeadCode` is single-pass over `db.tableSymbolsWithContent` (new: like `tableMetadata` but keeps `content`, drops `vector`); candidates are deduped by `(name, file)` keeping the min `startLine` (declaration) and merged `[min startLine, max endLine]`; **test files** (`*.test.*`/`*.spec.*`/`test_*`/`*_test.*`/`tests/`/`__tests__`) and **entry points** (`main`/`index`/`app`…) are pre-excluded entirely; results sorted by confidence desc, sliced by `limit` (default 200).
- **No silent caps.** Both helpers cap coverage and flag it: `scannedSymbols`/`scannedChunks` + `truncated` (table row cap 200k) on the dead-code report, `scannedFiles`/`truncated` on the dependency result — following the project's "no silent caps" convention.
- **Surfaces.** Tool `find_dead_code` (`tool-defs`), `POST /deadcode` (control API, takes `project`), stdio bridge case, CLI `cidx deadcode <name> [--language] [--type] [--min-confidence] [--limit n]`; `formatDeadCode` (header + `likely dead`→`uncertain`→`review` sections, `[conf] type  name` + `file:start-end [lang]` + signals + a `⚠` truncation line).
- **Limitation.** Pragmatic whole-identifier matching, not full LSP — same-named symbols across scopes share a count; results are a review queue, not a deletion list.
- **Verification.** `bun run typecheck` clean, `bun test` **207/207** (555 expect); new suites `tests/imports.test.ts` + `tests/resolve.test.ts` (pure resolution), `tests/deadcode.test.ts` (`detectExported` per language, scoring scenarios, definition-rule counting), and `tests/deps-engine.test.ts` (integration: `getDependencies` against the repo's own `src/`, incl. the mtime-cache stability + no-project throw). See also [`status.md`](./status.md) → *Code intelligence*.

#### Call graph — `get_call_graph` / `cidx callgraph`

The call-flow picture around a symbol and/or file: **who calls it** and **what it calls**, as bounded, cycle-safe trees — the "call stack / roadmap" proposal from `status.md`, now built.

- **Same adjacency engine as dead-code, emitting a graph instead of a counter.** New `src/core/callgraph.ts` (`buildCallEdges`) reuses `deadcode.ts`'s `matchNamesFor` / `buildNameRegex` / `NAME_REGEX_CAP` grouping and the **definition rule** — it walks every callable chunk body line-by-line with one grouped whole-identifier regex, skips a match on the callee's own declaration line (so a recursive call in the body is a real self-edge while the declaration isn't), and emits a caller→callee adjacency instead of a flat count. Caller key = `${symbolName}\0${filePath}`; reverse (callee→caller) is derived from forward. Scanning **every** callable chunk (not the deduped inventory) gives full coverage of multi-chunk functions. Calls to names not in the callable inventory yield no edge (in-index calls only).
- **Cycle-safe, bounded traversal.** `traverseCallGraph(roots, adj, meta, maxDepth, maxNodes)` does a DFS with an `onPath` cycle-detection set: a node already on the current path becomes a `↻` **cyclic leaf** (flagged, not expanded), so recursion and mutual recursion are visible without looping forever. It's a tree, not a DAG — a shared callee can appear under each of its callers. Bounded by `depth` (default 3) and a `limit` node budget (default 100/direction); a `truncated` flag + `⚠` line fire when the budget is hit (cyclic leaves don't count against the budget).
- **Anchor by symbol, file, or both.** `IndexManager.getCallGraph(opts)` requires ≥1 of `symbol` / `path` (else a clear error). `symbol` only → name match across the project; `path` only → every callable in that file; both → that symbol within that file (disambiguation). Name matching (`callgraph.ts → matchRootSymbols`) **mirrors `find_symbol`**, so a BARE method name (`getDependencies`) resolves to its qualified indexed form (`IndexManager.getDependencies`) — exact, prefix, dotted-suffix (`Class.query`), and dotted-substring (`Outer.Inner.query`) clauses. `CALLABLE_TYPES = { function, method, constructor }`; loose (anonymous) chunks are filtered out. `direction` ∈ `callers` / `callees` / `both` (default `both`), so one call returns the ▲ callers and ▼ callees trees. Test files and entry points are **kept** (tests-as-callers are useful here, unlike dead-code).
- **Cache keyed on `lastIndexedAt`, not mtime.** The call graph reads from **LanceDB** (`tableSymbolsWithContent`), not source files — so file mtime is the wrong freshness signal (a chunker change or an embedding-only reindex rewrites rows without moving mtimes). The per-project adjacency (`callGraphCache`) is keyed on `IndexRecord.lastIndexedAt` and rebuilt only when it changes; the first call per project pays the single `tableSymbolsWithContent` scan + inventory dedup (mirroring `findDeadCode`'s dedup, keeping min decl-line / max end-line / longest content). Cache is invalidated in `removeIndex`. `scannedSymbols` + `truncated` surface coverage.
- **Surfaces (mirrors `get_dependencies` end-to-end through all 8 layers).** Tool `get_call_graph` (`tool-defs`), MCP handler (`mcp.ts`, validates ≥1 of symbol/path), `POST /callgraph` (control API, `existsSync` only when `path` is given), **stdio-bridge `case "get_call_graph"`** (the hand-maintained, easy-to-miss layer), CLI `cidx callgraph <symbol|file> [--project] [--direction callers|callees|both] [--depth n] [--limit n]` (alias `call-graph`; positional auto-detects: an existing path → `path`, else → `symbol`), and `formatCallGraph` (header + `Anchor:` + ▲ Callers / ▼ Callees indented trees + `(scanned N …)` footer + a `⚠` truncation line).
- **Additive; no schema change, no reindex.** Reuses the tree-sitter parse recipe + the `find_references` whole-identifier foundation; nothing is written back to the index. Like `find_references` / dead-code, this is a navigation aid, not ground truth (same-named symbols across scopes share edges; framework / stdlib / class-constructor calls aren't shown).
- **Verification.** `bun run typecheck` clean, `bun test` **231/231** (598 expect); new suites `tests/callgraph.test.ts` (pure: caller→callee adjacency incl. the definition-rule self-edge distinction, recursive self-edge, dotted `Class.method`, multi-chunk scanning, in-inventory-only edges; traversal depth bounding, cycle-as-leaf, diamond-duplication, budget truncation, reverse callers tree; `matchRootSymbols` anchor resolution incl. the bare-→-`Class.method` clause), and `tests/callgraph-engine.test.ts` (LanceDB-free: the anchor + project-resolution contract — ≥1 anchor, inferred-vs-explicit-vs-ambiguous-vs-not-found). The LanceDB-backed happy path is covered by the pure suite + the live smoke. See also [`status.md`](./status.md) → *Code intelligence*.

### Search quality — second-stage reranker (Qwen3-Reranker via Ollama)

After RRF / vector / BM25 retrieval, the top `RERANK_TOP_K` candidates are re-scored by a small causal-LM reranker and re-sorted. Scored through Ollama `/api/generate` + yes/no-token logprobs (Ollama has no `/api/rerank`); the relevance score is the softmax of the `yes` vs `no` token logprobs.

- **On by default.** Config `search.rerank { enabled=true, model, topK, concurrency }`; per-call `rerank` option on `search_codebase` (MCP), POST `/search` (control API), the stdio bridge, and CLI `cidx search [--rerank true|false]`. Pass `rerank:false` for faster lookups.
- **One-time availability probe.** Because reranking is on by default, `IndexManager.ensureRerankAvailable()` probes Ollama `/api/show` once (cached for the session) and silently disables reranking when the model is absent — users without the reranker model pay one probe, then zero overhead, with no log spam.
- **Transparent fallback.** Reranking is a refinement, never a hard dependency — on by default but silently no-op when no reranker model is configured (probed once), per-doc neutral score on a single failure, and pre-rerank (RRF) order preserved on a whole-batch error. The fetch limit is widened to `max(limit, RERANK_TOP_K)` before rerank so the cut is decided *after* re-scoring.
- **Wiring.** New service `src/services/rerank.ts` (`rerankScores`, bounded concurrency via the existing pool); `IndexManager.rerankAndSlice` slots between retrieval/ranking and enrichment; `_rerankScore` on `SearchResult`.
- **Verification.** `bun run typecheck` clean, `bun test` **109/109** (334 expect); `scoreFromLogprobs` softmax/normalization/fallback unit-tested; rerank verified live against Ollama (relevant doc 0.999 vs irrelevant 0.000). No model is bundled — needs the causal-LM reranker (e.g. `qwen3-reranker-q8`) present in Ollama. See also [`status.md`](./status.md).

### Search quality — MMR diversification (Maximal Marginal Relevance)

After reranking, the top `MMR_TOP_K` candidates are re-ordered with MMR so the top results aren't near-duplicates — e.g. two copies of the same function no longer both occupy the top slots. MMR selects greedily to maximize `λ·rel(d) − (1−λ)·max_{d'∈selected} cos(d,d')`.

- **On by default.** Config `search.mmr { enabled=true, lambda, topK }`; per-call `mmr` option on `search_codebase` (MCP), POST `/search` (control API), the stdio bridge, and CLI `cidx search [--mmr true|false]`. Pass `mmr:false` for a pure relevance order.
- **λ = 0.5 (data-driven).** Relevance is min-max normalized to the [0,1] cosine scale so the tradeoff is meaningful at any score scale. λ tuned from live-embedding demos: 0.7 left near-duplicates (cos ≈ 0.9) in the top slots; 0.3 over-diversified and pulled in less-relevant docs; **0.5** pushes duplicates down to rank ~4 while keeping distinct, relevant results in the top 3 (crossover ≈ 0.585 for dup cosine 0.9).
- **Composes after rerank, before enrichment.** Relevance term = reranker `_rerankScore` when available, else mode-dependent (`vector` → negated distance, BM25/hybrid → `_score`). Needs only the doc vectors, which are always present on LanceDB rows (no `.select()` projection strips them), so it works in every mode. Widens the fetch to `max(limit, RERANK_TOP_K, MMR_TOP_K)` once.
- **Transparent fallback.** A pure-logic, no-IO step — if any candidate is missing a vector it silently keeps pre-MMR order; no model dependency.
- **Wiring.** New pure util `src/utils/mmr.ts` (`cosine`, `selectMMR`); `IndexManager.selectDiverse` slots after rerank; `tests/mmr.test.ts`.
- **Verification.** `bun run typecheck` clean, `bun test` **119/119** (up from 109); `selectMMR` scale-invariance / dedup / clamping unit-tested; dedup behavior confirmed on real Ollama `qwen3-embedding` vectors. See also [`status.md`](./status.md).

### Search quality — query embedding cache

The query is now embedded through the content-hash cache instead of hitting Ollama on every search. Reuses the same `(model, sha256(text))` cache the indexer writes, so a repeated query is an instant cache hit, and a query whose text matches an already-indexed chunk shares that row (`ON CONFLICT DO NOTHING`).

- **Wiring.** New `cachedEmbed(text, model, cache, embed = getEmbedding)` in `src/services/ollama.ts` (small structural `EmbedCache` interface keeps it decoupled from `Registry` and fakeable in tests); `searchIndex`/`searchAll` now call `cachedEmbed(query, CONFIG.OLLAMA_MODEL, this.registry)` at the two former `getEmbedding(query)` sites. Cache write is best-effort.
- **Verification.** `bun run typecheck` clean, `bun test` **124/124** (5 new in `tests/query-cache.test.ts`); covers miss-then-hit, distinct-text / distinct-model cache keys, and Float32-BLOB round-trip. See also [`status.md`](./status.md).

### Search quality — `maxChars` token budget

A per-call `maxChars` caps how much text a search returns. Results are kept whole, in ranked order, while they fit — code is never truncated mid-chunk — so a high `limit` can be used for recall without bloating the caller's context. The top result is always returned (a small budget yields one complete result, not zero).

- **Server-side.** Applied in `searchIndex`/`searchAll` right after enrichment via `applyCharBudget` (`src/utils/budget.ts`, pure), so the budget is consistent across HTTP JSON / MCP / stdio / CLI (and batch search). Per-result size ≈ content + surrounding context + a fixed framing overhead.
- **Surfaces.** `maxChars` on `search_codebase` (MCP `tool-defs`), POST `/search` (control API), the stdio bridge, and CLI `cidx search --max-chars <n>`.
- **Verification.** `bun run typecheck` clean, `bun test` **133/133** (9 new in `tests/budget.test.ts`): no-op cases, top-1-always-kept, trailing-drop-to-fit, exact boundary, missing-content. See also [`status.md`](./status.md).

### Search quality — multi-query batch search

`search_codebase_batch` runs several queries in a single round-trip and returns results grouped per query (`## Query: "…"` sections) — fewer turns when exploring several angles at once.

- **Concurrency + reuse.** `IndexManager.searchBatch(queries, project?, limit, opts)` de-dupes blank/duplicate queries, then `Promise.all`-fans out over the existing `searchIndex`/`searchAll`, so every query gets rerank/MMR/`maxChars` and the shared query cache for free (identical query strings share one embedding). `ensureRerankAvailable` is session-cached, so only one probe fires across the batch.
- **Surfaces.** New tool `search_codebase_batch` (`tool-defs`), `POST /search/batch` (control API), stdio bridge case, and CLI `cidx batch "<q1>" "<q2>" …` (each positional is a separate query). New `formatBatchResults` (`src/server/format.ts`) renders the grouped output for both MCP transports.
- **Verification.** `bun run typecheck` clean, `bun test` **138/138** (5 new in `tests/batch.test.ts`): empty-groups message, header + per-query body, pluralization, multi-group join, zero-result group. See also [`status.md`](./status.md).

### Search quality — token-based chunk-boundary guard

The chunk window now also respects an approximate token budget, so a large `maxChunkSize` can't silently overflow the embedding model's token window and get truncated. The mechanics of `splitLarge` / `emitNode` / `emitClass` are unchanged — only the module `MAX`/`STEP` consts are redefined.

- **Approximate, char-binding by default.** `effectiveChunkChars = min(maxChunkSize, maxChunkTokens · charsPerToken)` with `charsPerToken = 4` (chars/4 heuristic; no tokenizer is bundled). Default `maxChunkTokens = 512` → effective cap 2048, which is above the default `maxChunkSize` of 1500, so the char limit still binds and **existing indexes are unchanged**. The token cap only engages when you raise `maxChunkSize` above 2048 or lower `maxChunkTokens`.
- **Config.** New `indexing.maxChunkTokens` (default 512), overridable with `MAX_CHUNK_TOKENS`, threaded through all five config layers. The `MAX_CHUNK_SIZE` vs `MAX_CHUNK_TOKENS` min is applied once at module load in the chunker.
- **Apply to existing projects.** Lowering the cap (or raising `maxChunkSize`) only changes *new* writes; existing projects need a reindex to be re-chunked under the new effective limit.
- **Wiring.** New exported pure helpers `estimateTokens` / `effectiveChunkChars` in `src/chunking/chunker.ts` (`MAX`/`STEP` now derived from them); config in `src/config.ts`.
- **Verification.** `bun run typecheck` clean, `bun test` **150/150** (11 new in `tests/chunk-tokens.test.ts` + 1 config case): `estimateTokens` rounding/scale, `effectiveChunkChars` char-binding / token-binding / floor / custom-ratio, and a subprocess integration test proving a tiny `MAX_CHUNK_TOKENS` splits a long function into >1 chunk while the default keeps it as one. See also [`status.md`](./status.md).

---

## v4 — Usability (release 2.1.0)

The first wave of the usability proposals: result enrichment, `get_repo_overview`, `find_references`, and three more languages. `bun run typecheck` clean, `bun test` **100/100** (323 expect); new tools verified end-to-end against real LanceDB; the single binary compiles and runs. Version bumped 2.0.0 → **2.1.0**.

### Result enrichment — `indexedAt` + `signature` + context lines
- **`signature`** — best-effort declaration line derived from chunk content (`utils/text.ts → deriveSignature`): skips blanks, collects the declaration head up to the body opener (`{` / trailing `:` / `=>`), capped at 3 lines / 200 chars.
- **`indexedAt`** — every result carries the owning project's `lastIndexedAt` (a freshness hint).
- **Context lines** — `contextLines` (CLI `--context`); when > 0, up to N lines before / after the chunk are read **live from disk** after ranking + slicing. Missing / changed files are skipped silently.

### `get_repo_overview`
- `IndexManager.repoOverview(name)` aggregates, with no LLM and no re-indexing, from registry + `file_cache` + chunk metadata (`db.tableMetadata` selects only metadata columns): language distribution, symbol-type breakdown, top-level directories, likely entry points, files with the most symbols.

### `find_references`
- `IndexManager.findReferences(...)`: `db.searchContent` fetches candidate chunks containing the token (escaped `LIKE`); `utils/text.matchIdentifierLines` keeps whole-identifier matches (boundary `[A-Za-z0-9_$]`); occurrences expanded to absolute `file:line`, deduped by `project+file+line`, sorted, capped. Each reference carries the containing chunk's symbol. Caveat: may include same-named symbols from other scopes (pragmatic, not full LSP).

### More languages — Kotlin / Swift / Scala (Lua deferred)
- Added Kotlin (`.kt` / `.kts`), Swift (`.swift`), Scala (`.scala` / `.sc`). Chunker node sets gained `protocol_declaration` (Swift → interface), `object_definition` / `trait_definition` (Scala). Verified deterministic across interleaved grammar switches.
- **Lua deferred (root-caused):** `tree-sitter-lua` is unstable in the shared-WASM multi-grammar runtime — after another grammar parses, a subsequent Lua parse drops symbols nondeterministically (shared-WASM-heap corruption). Neither `parser.reset()`, a fresh `Parser`, nor `tree.delete()` fixed it. Lua does **not** corrupt other languages. Not bundled; `.lua` falls back to character chunking.

### Tests
- `tests/text.test.ts` (new) — `deriveSignature`, `matchIdentifierLines`, `escapeRegExp`.
- `tests/languages.test.ts` — Kotlin / Swift / Scala cases.
- `tests/tree-sitter.test.ts` — new ext→grammar mappings.

---

## v3.1 — Multi-language symbols + worker pool + mid-file cancellation

Found while testing on real multi-language codebases. `bun test` **85/85** (288 expect); verified end-to-end on a live daemon (C# `PlanktonService`, Go `OllamaTokenizerService`).

### Multi-language symbol extraction (🔴)
- **Problem:** the chunker classified only root-level nodes and read only direct `name` fields → C# extracted nothing (all in `namespace`), C / C++ free functions unnamed, Ruby nothing, Go structs / interfaces unnamed.
- **Fix:** rewrote around a recursive `walk`: a `CONTAINER` set (`namespace_declaration`, `file_scoped_namespace_declaration`, `namespace_definition`, `linkage_specification`, `module`, `internal_module`, `mod_item`) is descended into recursively; extended `CLASS_LIKE` / `FUNCTION_LIKE` / `WRAPPERS`; robust `nameOf` follows the declarator chain (C / C++ `function_declarator → … → identifier`); `emitGoTypeDecl` emits each `type_spec` separately and inspects the `type` field for struct / interface / type.
- **Result (live):** C# `PlanktonService` `named=58` (was 0); Go structs / interfaces now named.

### Mid-file cancellation (🟠)
- `indexFile(target, filePath, registry?, signal?)` takes an `AbortSignal`, checked (1) at start, (2) before each embedding batch, (3) after embedding. Cancel delay bounded to one in-flight batch.

### Worker pool (🟠)
- `JobQueue` is now a worker pool (`JobQueueOptions.concurrency`, default 1 = backward compatible); `pump()` runs up to `maxWorkers` jobs at once. The daemon passes `indexing.jobConcurrency` (default 2; env `JOB_CONCURRENCY`). Parallel indexing is safe (separate tables + per-table write lock).

### Large data files
- Solved via `.mcpignore` (excludes e.g. `tokenizers/`); a persistent `maxFileSizeBytes` guard is proposed later.

---

## v3 — Robustness & security review

End-to-end review after v2. Two serious data-consistency issues + several medium / low items fixed. `bun test` **31/31**; verified with temporary real-LanceDB smoke tests.

- 🔴 **Shrinking files left stale chunks** — `insertChunks` deleted by `id` (`${file}#${i}`); when a file shrank, high-index chunks lingered. Fixed: delete by **`filePath`**.
- 🔴 **Inaccessible directory wiped the index** — `indexDirectory` didn't guard `baseDir`; an empty file list triggered full cleanup. Fixed: `stat(baseDir)` guard → job errors, no cleanup.
- 🟠 **Watcher ignored `.gitignore` / `.mcpignore`** — `indexFile` checked only ext + mtime → flapping inconsistency. Fixed: watcher sets up the ignore matcher once.
- 🟠 **`remove` → `dropTable` race** — `removeIndex` didn't wait for the job. Fixed: `JobQueue.waitForJob(id)` before `dropTable`.
- 🟠 **Security** — open CORS + no DNS-rebinding protection. Fixed: localhost-only CORS + `enableDnsRebindingProtection` + `allowedHosts`.
- 🟠 **Progress persisted per file** — thousands of sync SQLite writes. Fixed: throttle (`PROGRESS_PERSIST_MS = 1000`); in-memory job stays instant.
- 🟡 **Hardening** — per-table write lock (`lockTable`); LIKE wildcard escaping (`\ % _`, `ESCAPE '\'`); graceful shutdown (`abortAll` + `registry.close`); startup log shows `/mcp`.

Intentionally unchanged: shared `tree-sitter` parser (safe single-threaded); plain `console.error` logging; `gitTrackedOnly` watcher filter.

---

## v2 — Hybrid search + git + stdio + single binary

`bun test` **30/30**; verified with the compiled single-binary end-to-end.

- **Hybrid search** — `ensureFtsIndex` (BM25 on `content`), `searchTableText`, `rrfMerge` (k=60); three modes `hybrid` / `vector` / `text`. Bonus: search filters (`buildWhere`) + `find_symbol`.
- **Git awareness** — `services/git.ts`: `gitTrackedFiles` (`git ls-files -z`) for `gitTrackedOnly`; auto incremental sync on branch change (`.git/HEAD` watcher).
- **Stdio bridge + Streamable HTTP** — `POST /mcp` (stateless); `stdio-bridge.ts` forwards to the Control API and auto-starts the daemon; shared `tool-defs.ts` / `format.ts`.
- **Watcher rename / move hardening** — `atomic: true` + `awaitWriteFinish`; rename = unlink + add, re-embed ~free via content-hash cache.
- **Single-binary** — core + 12 grammars embedded via `import … with { type: "file" }`; `src/main.ts` dispatcher + `src/runtime.ts` compiled / dev detection.

---

## v1.1 — Stabilization

The parts promised in the design but missing / error-prone in v1. `bun test` **21/21**.

- **Parallel embedding (the missing half of Phase 5)** — `ollama.concurrency` existed but `indexFile` embedded sequentially. New `utils/concurrency.ts → mapWithConcurrency` (order-preserving, fail-fast, bounded); batches sent with `EMBED_CONCURRENCY` parallelism.
- **Deleted-file cleanup + incremental sync** — `Registry.listCachedFiles`; `indexDirectory` diffs disk vs `file_cache` and prunes; new `syncIndex` (`fresh=false`); `restore()` now incremental-syncs `ready` projects too. Exposed `POST /sync` + `cidx sync`.
- **ANN vector index** — `ensureVectorIndex(table, minRows)` builds LanceDB's ANN index above `vectorIndexThreshold` (default 50k).
- **Watcher↔full-index race** — `WatchOptions.isBusy` callback; `IndexManager` passes `isBusy = () => isIndexing(name)`; busy events reschedule.
- **`.gitignore` awareness** — `buildIgnore` applies `.gitignore` + `.mcpignore` + global (pulled forward from v2).
- **Test suite** — first working `bun test` suite (concurrency, registry, job-queue, chunker).

---

## v1 — clean rewrite on Bun

Phases 0–6 of the original design, all done: clean Bun skeleton + `bun:sqlite` meta store; async job queue (handler registry); index registry + project isolation; Control API + thin CLI; web-tree-sitter smart chunking + rich metadata + line numbers; batch / parallel embedding + content-hash cache + model metadata; extended MCP tool set; secure localhost binding.

> **What existed before (and was replaced):** a flat, single-threaded, blocking design — the server didn't open until the first index finished; the CLI only took a directory at startup (no work sent to a running server); no project / index concept (one mixed table); flat character-window chunking (split functions mid-way); sequential one-by-one embeddings. The old `src/` was removed entirely; only the proven logic (LanceDB flow, Ollama call, chokidar, ignore handling, mtime cache) carried over.
