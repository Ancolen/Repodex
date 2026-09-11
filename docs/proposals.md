# Proposals — Design Notes

> Detailed designs for the 💡 Proposed items tracked in [`status.md`](./status.md). Shipped proposals move to [`changelog.md`](./changelog.md) and [`features.md`](./features.md); this file is where a proposal is fleshed out **before** implementation starts. Each proposal below carries: motivation, design, files touched, risks, impact/effort, and acceptance criteria.
>
> Three short proposals (`recency`, `maxFileSizeBytes`, `search + outline`) live only in `status.md`'s table — everything here is new. IDs (`S1`, `C2`, `A1`, `O3`, …) are stable references used in `status.md`.

| ID | Proposal | Category | Impact | Effort |
|----|----------|----------|--------|--------|
| [S1](#s1-identifier-part-bm25-tokenization) | Identifier-part BM25 tokenization | Search quality | High | Medium |
| [S2](#s2-find_symbol-fuzzy-fallback) | `find_symbol` fuzzy fallback | Search quality | Medium | Low-Medium |
| [S3](#s3-pathsurface-boost) | Path/surface boost | Search quality | Medium | Low |
| [S4](#s4-query-expansion-local-llm) | Query expansion (local LLM) | Search quality | Medium | Low-Medium |
| [C1](#c1-get_change_impact) | `get_change_impact` | Code intelligence | High | Low-Medium |
| [C2](#c2-public-api-diff--breaking-change-detector) | Public API diff / breaking changes | Code intelligence | High | Medium-High |
| [C3](#c3-hotspot--technical-debt-report) | Hotspot / technical-debt report | Code intelligence | Medium | Medium |
| [C4](#c4-ownership-blame-enrichment) | Ownership / blame enrichment | Code intelligence | Medium | Low-Medium |
| [C5](#c5-coupling-metrics) | Coupling metrics | Code intelligence | Low-Medium | Low |
| [A1](#a1-get_context_pack) | `get_context_pack` | Agent UX | High | Medium |
| [A2](#a2-mcp-resources--index-notifications) | MCP resources + index notifications | Agent UX | Medium | Low-Medium |
| [A3](#a3-search-analytics-query-log) | Search analytics / query log | Agent UX | Low-Medium | Low |
| [O1](#o1-cidx-doctor) | `cidx doctor` | Ops | Medium | Low |
| [O2](#o2-zero-downtime-model-migration) | Zero-downtime model migration | Ops | Medium | Medium-High |
| [O3](#o3-table-stats--compact) | Table stats / compact | Ops | Low | Low |
| [O4](#o4-daemon-idle-shutdown) | Daemon idle shutdown | Ops | Low | Low |

**Suggested order** (getiri/efor balance, updated for this set): `O1` doctor (cheapest, most concrete user benefit) → `A1` context pack → `S1` identifier tokenization → `C1` change impact → `C2` API diff. The rest fill in behind: `C4`, `S3`, `A2`, `C5`, `S2`, `A3`, `O3`, `S4`, `C3`, `O4`, `O2`.

---

## Search quality

### S1. Identifier-part BM25 tokenization

**Impact: High · Effort: Medium**

#### Motivation

BM25/FTS indexes `content` verbatim. A query like *"update user name"* never matches `getUserName` as a single token: FTS tokenizes on word boundaries, and `getUserName` is one identifier token. This is the weakest leg of hybrid search — intent-shaped queries ("how do I refresh the cache") only reach code through the vector leg. Splitting identifiers into their parts gives BM25 a real shot at natural-language → code matching, exactly the gap the docstring legs (2.4.0) started to close from the *documentation* side — this closes it from the *code* side.

#### Design

1. **New nullable column `id_terms`** on the fixed row schema (`src/services/db.ts`), exactly the 2.4.0 `doc`/`doc_vector` pattern:
   - Populated at chunk time (indexer): every identifier in the chunk (extracted via tree-sitter identifier nodes when the chunk is AST-parsed, regex fallback otherwise — `countReferences`' combined-regex pass is a precedent) is split into subparts by camelCase / snake_case / kebab-case / dotted boundaries. Written as a space-joined lowercase string: `getUserName` → `get user name`, `user_id` → `user id`. The raw identifier itself is **also** kept in the string (`getusername get user name`) so exact-symbol BM25 matches don't regress.
   - Cap the string (e.g. 2000 chars) so a minified/generated file can't produce a pathological row.
2. **FTS leg.** `ensureFtsIndex` builds BM25 over `id_terms` alongside `content` and `doc` (own try/catch — a failure warns, never fails the index, same as the doc-FTS leg).
3. **Search.** `searchTableText` gains `id_terms` in its default `columns` list when present; `mergeWithDocLegs` → generalize to `mergeWithExtraLegs` (or keep the name and treat this as one more leg). Results that arrived via the `id_terms` leg could carry `_idHit` or simply merge anonymously — prefer anonymous first (fewer new output fields), and only add a marker if demos show agents care.
4. **Legacy gating.** All queries gated on `tableColumns(table)`; pre-2.4.0-style tables (and pre-2.5.0 tables lacking `id_terms`) take the exact legacy paths. `insertChunks` extends `stripUnknownColumns` to the new column. **Byte-for-byte legacy behavior preserved**: when only the original legs yield results, `combine` returns the single non-empty list with native metrics — don't "simplify" into always-RRF.

#### Files touched

`src/services/db.ts` (schema, `stripUnknownColumns`, `tableColumns` gating, FTS), `src/services/indexer.ts` (populate + embed pass order — `id_terms` needs no embedding), `src/chunking/` or a new `src/core/idterms.ts` (pure split function), `src/core/index-manager.ts` (leg merge), `tool-defs.ts` (no new field needed if anonymous), tests.

#### Risks

- **BM25 leg-count growth**: five legs (vector, doc-vector, content, doc, id_terms) dilute RRF ranks individually. Mitigate: `id_terms` leg runs only in `hybrid` mode, and only when the query actually tokenizes into ≥2 parts; demo-tune whether it's additive with doc legs.
- **Reindex required** for existing projects — same migration story as 2.4.0 (`tableColumns` gating makes it seamless).
- **LanceDB FTS column budget**: verify at design time that a third FTS-indexed column is acceptable on the pinned `@lancedb/lancedb@^0.30` (index build time / memory).

#### Acceptance

- Pure splitter in `src/core/idterms.ts` with a table-driven test suite (camelCase, snake_case, SCREAMING_SNAKE, dotted, digits, unicode).
- Interleaved-determinism suite still green (identifier extraction shares the parse recipe).
- Legacy-table test: a table created without `id_terms` returns byte-identical legacy results.
- Live demo: "update user name"-style queries gain code hits vs. 2.4.0 baseline.

---

### S2. `find_symbol` fuzzy fallback

**Impact: Medium · Effort: Low-Medium**

#### Motivation

`find_symbol` is exact + prefix — a typo (`getUserNme`) returns nothing, and the caller usually falls back to a slow vector search. A cheap, model-independent fuzzy tier fixes the miss without touching embeddings.

#### Design

- **Trigger:** when exact + prefix both miss, fall back to a fuzzy pass (opt-out via `fuzzy:false` to keep the current strict contract available).
- **Mechanism:** an FTS index over `symbolName` with an **ngram tokenizer** — LanceDB FTS supports tokenizer configuration; **verify ngram availability/parameters on the pinned `@lancedb/lancedb@^0.30` at design time** (if unsupported, fall back to computing trigrams into a nullable `symbol_trigrams` column at chunk time — the S1 pattern).
- **Scoring:** ngram relevance is approximate; keep results clearly marked (`fuzzy: true` on each hit, `⚠ fuzzy` in CLI) and cap the count (default `limit` applies).
- No new index beyond the FTS one; legacy tables without the index simply never fuzzy-match (gated on `tableColumns`/index presence).

#### Files touched

`src/services/db.ts` (FTS build over `symbolName`, new search helper), `src/core/index-manager.ts` (`findSymbol` fallback), tool-defs (`fuzzy` opt-out), CLI `--fuzzy false`, tests.

#### Risks

- Ngram FTS on a big symbol table is small (symbols are short) — low risk.
- False positives dilute trust: always mark `fuzzy: true`, sort by FTS score.

#### Acceptance

- Test: exact/prefix still byte-identical when they hit; typo query returns the intended symbol with `fuzzy: true`.
- Model-independent (no Ollama call in the fuzzy path).

---

### S3. Path/surface boost

**Impact: Medium · Effort: Low**

#### Motivation

RRF is rank-only — it can't see that one hit is a 300-line generated file in `build/` while another is the same function in `src/`. Small structural signals should nudge, not decide.

#### Design

- A pure post-merge re-scoring pass: `boost(results) → results` in a new `src/utils/boost.ts`, applied **before** `refineAndSlice` (so rerank/MMR still see the adjusted order) and only on RRF-merged (`_score`) results. Single-leg legacy results keep their native metric — untouched, per the invariant.
- Signals (all multiplicative, small, tunable via config `search.boost.*`):
  - shorter project-relative path (log-scale),
  - under a conventional source root (`src/`, `lib/`, `app/` — language-agnostic list),
  - **test-file demotion** (reuse the dead-code detector's test-file patterns — already centralized),
  - generated/artifact-path demotion (`gen`, `dist`, `build`, `vendor`, `.pb.go`, `*.min.*`).
- No index change, no reindex, no Ollama call.

#### Files touched

`src/utils/boost.ts` (new, pure), `src/core/index-manager.ts` (one call site), config (`search.boost`), tests.

#### Risks

- Ranks shifting unexpectedly vs. documented behavior — ship behind a config flag default-on, and document that `rerank` already dominates ordering when its model is present.
- Don't double-penalize: MMR may re-order anyway; boost only adjusts *relevance input*, never the diversity selection.

#### Acceptance

- Pure-function tests over each signal; a table test that `build/`-hit vs `src/`-hit ordering flips only when both have equal RRF scores.
- Legacy single-leg path untouched.

---

### S4. Query expansion (local LLM)

**Impact: Medium · Effort: Low-Medium**

#### Motivation

An agent's first query is often intent-shaped and under-specified ("auth check middleware"). The index already supports batch fan-out; a second "what would this look like as code?" pass multiplies recall for one extra local LLM round-trip.

#### Design

- New `src/services/expand.ts`: one Ollama `/api/generate` call with a tight prompt producing 2–3 query variants (a symbol-name-shaped variant — snake_case/camelCase tokens only — plus a rephrased natural variant). Pure-JSON parsing with a retry-free failure path (any parse failure → expand disabled for that call, transparent).
- **Opt-in per call** (`expand: true` / CLI `--expand`): it costs ~0.5–2 s of local LLM latency; default-on would surprise.
- Mechanics: variants are run through the existing `searchBatch` machinery, results merged with per-variant dedup; the original query's results keep rank dominance (merge weight or RRF with the original listed first). `maxChars` budget applied after the merge.
- The shared query embedding cache means variants re-search cheaply on repeats.

#### Files touched

`src/services/expand.ts` (new), `src/core/index-manager.ts` (orchestration), tool-defs + control-api + stdio-bridge + CLI (the full 8-layer wiring for the `expand` flag), tests (pure prompt-parse tests; no Ollama in unit tests).

#### Risks

- Prompt drift / empty variants — cap variants (≤3), drop empties, never fail the base search.
- Latency on big `limit` values — cap variant searches at a fixed internal `limit` (e.g. `max(limit, 10)`), not the caller's.

#### Acceptance

- Parse tests for the expansion prompt output (malformed → empty variant list, base results returned unchanged).
- Without `expand: true`, the pipeline is byte-identical to today.

---

## Code intelligence

### C1. `get_change_impact`

**Impact: High · Effort: Low-Medium**

#### Motivation

"This function is about to change — what breaks?" is currently answered by the agent in three separate calls (`get_call_graph` callers, `get_dependencies` imported-by, `find_references`) that it then has to reconcile itself. All three data sources exist and are cached; the synthesis is one pure module.

#### Design

- New tool `get_change_impact(path, symbol?, project?, depth?, limit?)` (≥1 of symbol/path, like the call graph) returning **one ranked report**:
  - **Direct callers** (call graph, `callers` direction, bounded depth),
  - **Imported-by** (dependency graph reverse),
  - **Whole-identifier reference count + a few representative `file:line` hits** (`find_references` data, capped),
  - **Per-consumer severity**: a caller that *calls* the symbol scores higher than a file that merely *imports* its module, which scores higher than a loose textual reference. Ranked `direct callers → importers → textual refs`, each section capped by `limit` with `truncated`.
  - Cross-cuts: the symbol's own file's fan-out (how entangled the change site is), test-file callers called out separately ("covered by" vs "consumed by").
- **Anchor resolution** mirrors `get_call_graph` (name matches `find_symbol`'s qualified form; both anchor kinds, ≥1 required).
- **No new scanning** — all three adjacency sources come from their existing caches (`depGraphCache` mtime-keyed, call-graph `lastIndexedAt`-keyed, the dead-code-style reference pass is shared). The only new work is joining them.
- `scannedSymbols`/`scannedFiles`/`truncated` surfaced like its three parents.

#### Files touched

`src/core/impact.ts` (new, pure join logic), `src/core/index-manager.ts` (tool method + cache wiring), the full 8-layer wiring (tool-defs → mcp → control-api → stdio-bridge → cli → format → index-manager), tests.

#### Risks

- Same-name disambiguation: same limitation as the call graph (whole-identifier matching); document it in the tool description — this is a review aid, not proof.

#### Acceptance

- Pure join tests with synthetic adjacency maps (severity ranking, caps, truncation flags).
- Fixture project test: a symbol with a caller, an importer, and a textual mention appears in all three sections, ranked correctly.

---

### C2. Public API diff / breaking-change detector

**Impact: High · Effort: Medium-High**

#### Motivation

"Did this release break anything public?" is the changelog-generation / pre-merge-review question. The index holds the *current* API surface; git holds the *past* — and the chunker's AST extraction can run against both.

#### Design

- New tool `get_api_diff(project, base, head?)` — `base`/`head` are git refs (tags, SHAs, branch names; `head` defaults to the working tree, i.e. the current index).
- **Current surface:** from the index directly (existing symbol rows; "exported" recovered per-language from chunk text exactly as `scoreDeadCode` already does — one recovery function factored out and shared).
- **Historical surface:** `git show <ref>:<path>` (via the existing no-shell `execFile` pattern in `src/services/git.ts`) for the files known at that ref (`git ls-tree -r --name <ref>`, intersected with indexed extensions), then **parse with the same tree-sitter recipe** to extract exported symbols at that ref. No index mutation, no reindex, nothing persisted.
- **Diff output, classified:** `removed` (breaking), `signature-changed` (breaking; compare parameter lists/arity per language), `visibility-narrowed` (breaking), `added` (non-breaking), `unchanged`. Breaking entries carry ref→ref signatures side by side. `notARepo`/unknown-ref reported, not thrown.
- **Scope guard:** only AST languages (16 grammars); files that parse-fail at the old ref are reported as `unparsed` — no silent skips. Cap `scannedFiles`/`truncated`.

#### Files touched

`src/services/git.ts` (`git show` / `ls-tree` helpers), `src/core/apidiff.ts` (new, pure comparator), a factored-out `exportedness` helper shared with `deadcode.ts`, the 8-layer wiring, tests.

#### Risks

- **Effort is the extraction, not the diff**: historical parse needs a batched, bounded-concurrent pass over old-ref file contents (reuse the embedding pipeline's concurrency shape, minus embeddings).
- Signature comparison is per-language and approximate (string-normalized parameter lists); document that structural (name-order/overload) differences need review.
- Large repos: `git ls-tree` at the old ref can be big — bound by the indexed-extension intersection + `scannedFiles` cap.

#### Acceptance

- Fixture repo (scripted `git` history in a temp dir): removed/renamed/signature-changed/added symbols all classified correctly across two tags.
- Non-repo project → `notARepo`; bad ref → reported, not thrown.

---

### C3. Hotspot / technical-debt report

**Impact: Medium · Effort: Medium**

#### Motivation

Dead code says "unused"; hotspots say "over-changed and over-coupled" — the churn×complexity intersection where bugs and refactoring fatigue actually live. All inputs are already available: git history (`search_commits`' engine), chunk counts, symbol sizes, dead-code scores, and (after C5) coupling.

#### Design

- New tool `get_hotspots(project, since?, limit?)`:
  - **Churn**: `git log --since --name-only` (existing `-z`/no-shell machinery) → per-file change counts.
  - **Size/complexity proxies**: chunk count and symbol count per file from table metadata (already aggregated by `get_repo_overview`); optionally a cheap AST complexity proxy (branch-node count) computed on demand for the top-N churn files only.
  - **Debt signals**: dead-code density (from `findDeadCode`'s pass) and coupling (from C5), joined per file.
  - **Score**: churn × size, debt signals demote/promote into ranked bands (same conservative-scoring philosophy as dead code: a hot file that's small and well-tested is not a hotspot). Test files demoted; entry points demoted.
- Sectioned output like dead-code (`critical` → `warm` → `review`), each with churn count, size, signals, and a one-line rationale. `notARepo` when not a git repo; `truncated` always surfaced.

#### Files touched

`src/core/hotspots.ts` (new, pure aggregator over three cached feeds), `src/core/index-manager.ts` (orchestration + caching keyed on `lastIndexedAt`), the 8-layer wiring, tests.

#### Risks

- Churn counting depends on `--since` window choice — default 90 days, documented.
- Complexity proxy is deliberately *not* cyclomatic complexity — call it what it is (a proxy) in output, or the report over-promises.

#### Acceptance

- Pure aggregator tests over synthetic churn/size/debt feeds (ranking, bands, demotions).
- Fixture repo: a file edited 20× with 15 symbols outranks a file edited 20× with 2 symbols.

---

### C4. Ownership / blame enrichment

**Impact: Medium · Effort: Low-Medium**

#### Motivation

`indexedAt` tells the agent *when the index saw it*; it can't say *who last changed this symbol and when* — the first question in any "why is this code like this" investigation. This is the stronger form of the `recency` proposal already in `status.md`.

#### Design

- **Opt-in per result** (`blame: true` on `search_codebase`, `--blame` on the CLI; off by default — it's git-cost per search):
  - One `git blame --porcelain -L <start>,<end> -- <file>` **per file** (not per chunk — adjacent chunks share the file's blame, batched by grouping results per file), no shell, `execFile`.
  - Enrichment fields: `lastAuthor`, `lastCommitDate`, and a small `churn` proxy (distinct commits touching the range, capped).
  - Fresh from disk like `contextLines` — an index-freshness-stale read still reports truth from git.
- **Guardrails:** not a repo → field omitted (`notARepo` surfaced once); blame failure on a file (moved/untracked) → field omitted for that file, never fails the search; per-search git budget (e.g. ≤8 files blamed, rest skipped with `blameSkipped: n` — no silent caps).
- Reuses the porcelain parser shape of `commits.ts` (pure parse function, unit-testable without a repo).

#### Files touched

`src/services/git.ts` (`blameRange`), `src/core/git-blame-parse.ts` or an extension of `src/core/commits.ts` (pure porcelain parser), `src/core/index-manager.ts` (enrichment slot after `applyCharBudget`... **before** it — blame fields shouldn't eat the char budget; slot beside `contextLines`), the 8-layer wiring, tests.

#### Risks

- Blame on heavily-moved files attributes to the move, not the origin (`-C`/`-M` flags cost time; start plain, document the limitation).
- Latency: the per-file cap keeps worst case bounded; skip entirely when `git` is absent.

#### Acceptance

- Porcelain-parser unit tests (boundary splits, `\x00` in porcelain content lines, truncated output).
- Fixture repo: correct last-author/date per range; non-repo → clean omission.

---

### C5. Coupling metrics

**Impact: Low-Medium · Effort: Low**

#### Motivation

`get_dependencies` answers per-file; agents and humans also need the aggregate: which files are entangled with everything (change-magnet), which are orphans. Pure arithmetic over the already-cached dependency graph.

#### Design

- New tool `get_coupling(project, limit?)` (or a `coupling` section in `get_repo_overview` — prefer the dedicated tool, overview stays cheap):
  - Build the full forward+reverse graph (the mtime-keyed cache already computes it), then per **file**: `fanOut` (imports), `fanIn` (imported-by), `instability = fanOut / (fanIn + fanOut)` (0 = stable/attracting, 1 = unstable/depending).
  - Sectioned: most imported (`top fanIn`), most entangled (`high fanIn + high fanOut` — the change-magnet band), unstable leaves.
  - `scannedFiles` + `truncated` (cap by `limit`, default 50).
- External edges excluded from the metrics (they're not indexed files) but counted separately (`externalImports`) so the picture isn't skewed.

#### Files touched

`src/core/coupling.ts` (new, pure), `src/core/index-manager.ts` (graph cache reuse), the 8-layer wiring, tests.

#### Risks

- Package-indexed projects (single flat table) make fan-in/out trivially shallow — metrics are only meaningful for real module structures; note it in the tool description.

#### Acceptance

- Pure graph-metric tests (fanIn/fanOut/instability math, external exclusion, caps).
- Fixture project: known hub file ranks top fan-in.

---

## Agent UX

### A1. `get_context_pack`

**Impact: High · Effort: Medium**

#### Motivation

Today an agent doing "get me up to speed on X" burns 4–6 tool calls (search → outline per hit → deps per hit → context lines), each a full round-trip. The pack assembles the same material server-side in one call — less latency, less context churn, and a consistent shape the agent can rely on.

#### Design

- New tool `get_context_pack(query, project?, limit?, maxChars?, contextLines?)`:
  1. **Search core:** `searchIndex` exactly as today (hybrid + rerank + MMR + doc legs + query cache) → top results.
  2. **Per-hit enrichment, one pass:** `signature`/`indexedAt` as always, plus the file's **outline** (`get_file_outline` data, capped to the hit's neighborhood: outline symbols overlapping/below the hit's chunk), plus **forward deps of the hit's file** (`getDependencies` forward only, resolved-to-indexed only, cap ~10).
  3. **`contextLines`** window as today.
  4. **One budget for the whole pack** (`maxChars`, default ~6000): results are added in ranked order while the *running pack* fits — whole-result discipline like `applyCharBudget`, top result always included; skipped results are reported as `omitted: n` (no silent truncation).
- Output is a structured object (not a flat results list): `pack: { hits: [{ hit, outline, imports }], totalChars, omitted }`. MCP/CLI render it readably; MCP consumers get JSON.
- **All composition, no new engines** — every leg already exists and is cached; the only new logic is assembly + the pack-level budget.

#### Files touched

`src/core/index-manager.ts` (`getContextPack`, reusing `searchIndex` + outline + deps internals), `src/utils/budget.ts` (a pack-level variant of `applyCharBudget` or a parameterized one), tool-defs → mcp → control-api → stdio-bridge → cli (`cidx pack "<query>"`) → format, tests.

#### Risks

- **Response bloat** is the whole risk: the pack-level budget is the design's spine — test it hard (a big `limit` with a small `maxChars` must degrade gracefully, `omitted` counting correct).
- Don't double-bill: internal legs must not run the pack's hits through `searchAll`'s per-hit `maxChars` too — one budget, applied once, at the pack level.

#### Acceptance

- Budget tests: top-1 always present, `omitted` exact, running-budget arithmetic.
- Composition tests: a pack's outline reflects the hit's file, imports resolve to indexed files only.
- Benchmark note in `status.md`: one pack call vs. the equivalent 4-call sequence (latency).

---

### A2. MCP resources + index notifications

**Impact: Medium · Effort: Low-Medium**

#### Motivation

Agents poll `get_index_status` in a loop while a project indexes, and re-fetch `list_indexes` to discover projects. MCP's native vocabulary for both is *resources* (readable, listable state) and *notifications* (`listChanged`); using them removes polling and makes discovery free.

#### Design

- **Resources:** expose `cidx://indexes` (list) and `cidx://indexes/{name}/overview` + `/status` as MCP resources (read-only; handlers map straight onto `listIndexes`/`repoOverview`/job status). `resources.listChanged` announced on project add/remove.
- **Notifications — the stateless-HTTP caveat:** the Streamable HTTP server is stateless, so server-push subscriptions don't map onto it. Phased:
  1. **stdio bridge (stateful)** — full support: when a watched job completes, the bridge emits an MCP logging/notification message on its stdout channel (safe: it's a JSON-RPC channel by design). An agent connected over stdio gets "index finished" without polling.
  2. **HTTP** — resources only (read-on-demand); document that HTTP clients should poll `listChanged`-announced lists cheaply rather than expect push. Do **not** weaken the stateless design to add HTTP push.
- All resource payloads reuse existing serializers (the same JSON the control API returns) — no new formatting surface.

#### Files touched

`src/server/tool-defs.ts` or a sibling `resource-defs.ts` (single source, consumed by both `mcp.ts` and `stdio-bridge.ts` — same pattern as tools), `src/server/mcp.ts`, `src/stdio-bridge.ts`, `src/core/index-manager.ts` (a completion hook the bridge subscribes to), tests (resource listing/reads; stdio notification framing).

#### Risks

- MCP SDK resource-API friction under the maximally-strict tsconfig — expect the same `as unknown as` cast pattern the transport already needs; preserve it deliberately.
- Notification spam on watcher-busy projects: notify on **job completion** (full index/sync), not per-file watcher writes.

#### Acceptance

- `resources/list` + `resources/read` return the control-API-equivalent payloads.
- stdio: a completed job produces exactly one notification; no stdout pollution outside JSON-RPC.

---

### A3. Search analytics / query log

**Impact: Low-Medium · Effort: Low**

#### Motivation

Index quality is invisible: a query that returns 0 hits is either a bad query or a **gap in the index**, and today nothing records which. A tiny local query log turns search behavior into a maintenance signal.

#### Design

- Registry gains a `query_log` table (bun:sqlite, same DB file): `ts, project, query, mode, resultCount, latencyMs` — written from `searchIndex`/`searchAll`'s exit path, fire-and-forget (a log-write failure must never fail a search).
- **Pruning:** keep the last N (config `search.queryLogSize`, default e.g. 10k rows; 0 = off) — a plain `DELETE ts < cutoff` at write time.
- **Surfacing:** `cidx stats` (see also [O3](#o3-table-stats--compact)) prints: top queries, zero-hit queries (the gap signal), average latency, cache-hit estimate (repeated identical queries).
- Local-only data, no embedding of queries persisted — privacy story is simply "never leaves `~/.cidx`".

#### Files touched

`src/core/registry.ts` (table + write + prune), `src/core/index-manager.ts` (instrumentation), `src/cli.ts` (`stats`), config (`search.queryLogSize`), tests (temp-sqlite registry tests already exist as the pattern).

#### Risks

- Write amplification on hot batch searches — one row per *caller-visible* query (batch queries log per query; that's the point), bounded by prune.

#### Acceptance

- Registry tests: insert/prune/off-switch.
- Zero-hit queries surface in `stats` output.

---

## Ops

### O1. `cidx doctor`

**Impact: Medium · Effort: Low**

#### Motivation

Every support conversation starts with the same checklist: is the daemon up, is Ollama reachable, does the embed model exist, is the table schema current, is the config valid. One command that answers all of it turns a back-and-forth into a paste.

#### Design

- New CLI command `cidx doctor` + control-API endpoint `GET /doctor` (CLI keeps its thin-client pattern; the daemon owns the checks that need its state).
- **Checks, each reported `ok` / `warn` / `fail` with a one-line fix hint:**
  1. daemon reachable (`/ping`), version match (CLI ↔ daemon versions differ → warn);
  2. Ollama reachable; configured `OLLAMA_MODEL` present (`/api/show`); reranker probe result (reuse `ensureRerankAvailable`'s cached probe);
  3. per registered project: table exists, **schema freshness** (`tableColumns` — has `doc`/`doc_vector`? → "reindex to enable docstring legs"), ANN/FTS indexes present, file_cache ↔ table row sanity;
  4. orphan tables (`~/.cidx/db/` tables not in the registry) and registry rows without tables;
  5. config files: YAML parses, `.cidx.json` files parse and their fields validate (the same validators `project-config.ts` uses — shared, not duplicated);
  6. disk usage of `~/.cidx/` (per-table sizes from [O3](#o3-table-stats--compact)).
- Exit code 0 unless a `fail` exists (scriptable). Read-only — `doctor` never mutates.

#### Files touched

`src/server/control-api.ts` (`/doctor`), `src/core/doctor.ts` (new, the check registry — pure where possible), `src/cli.ts` (`doctor` + rendering), tests (pure checks: schema-freshness verdict, orphan detection over a temp registry).

#### Risks

- Low. The main discipline is reusing existing probes (`ensureRerankAvailable`, `tableColumns`) instead of forking second implementations.

#### Acceptance

- Every check unit-tested against synthetic state (missing table, stale schema, bad YAML).
- `doctor` on a healthy install prints all-`ok` and exits 0; on a legacy-table project prints the reindex hint.

---

### O2. Zero-downtime model migration

**Impact: Medium · Effort: Medium-High**

#### Motivation

Changing a project's embedding model today means the next `sync` escalates to a full reindex **on the live table** — searches during the reindex mix stale and fresh vectors, and a failed reindex can leave the project half-migrated. The vectors also can't be *translated* — but the *re-embed* can run off to the side and swap atomically.

#### Design

- New job type `migrate` (via the existing `JobQueue.registerHandler`):
  1. Build a **shadow table** `idx_<name>_mig` with the target model: read all chunks (content is model-independent — reuse the table read path), re-embed through `embedTexts` (the cache is mostly cold here — that's the cost), write rows + build ANN/FTS indexes (including doc/doc_vector/`id_terms` when enabled).
  2. On completion: **atomic swap** — prefer LanceDB table rename if available on the pinned `@lancedb/lancedb@^0.30` (**verify `Table.rename`/equivalent at design time**; fallback: write-to-new → drop-old → registry update inside the per-table write lock, with the registry updated *before* the old drop so a crash leaves a consistent registry).
  3. Drop the shadow on any failure; the old table never touched until the new one is complete.
- **Flow integration:** `syncIndex`'s model-change escalation switches from "full reindex in place" to "enqueue `migrate`"; the watcher keeps skipping writes either way. Progress: the job reports per-file progress like `index` (throttled persistence, already exists).
- Disk cost: 2× the table for the migration window — surfaced in job progress + `doctor` ([O1](#o1-cidx-doctor) checks for stale `*_mig` shadows and offers cleanup).

#### Files touched

`src/services/indexer.ts` (`migrateTable`), `src/services/db.ts` (shadow create/swap helpers), `src/core/types.ts` (job type), `src/core/index-manager.ts` (escalation change), `src/core/doctor.ts` (shadow detection), tests (temp-LanceDB: migrate a 3-file table, verify swap, verify failure leaves the original intact).

#### Risks

- The swap is the one irreducible risk — design it around "registry first, table second", and test the crash-mid-swap case explicitly.
- Long migration on big projects with a cold cache — that's inherent (re-embedding is the cost); progress reporting keeps it legible.

#### Acceptance

- Crash/injection test: a forced failure mid-migrate leaves the original table and registry intact, shadow cleaned.
- During migration, search keeps serving from the old table with self-consistent vectors.

---

### O3. Table stats / compact

**Impact: Low · Effort: Low**

#### Motivation

`~/.cidx/` grows silently (LanceDB tables, embedding cache, query log) and nothing reports it. Also, LanceDB tables accumulate fragments after thousands of watcher writes; a maintenance hook keeps ANN/FTS healthy.

#### Design

- **Stats** (feeds [O1](#o1-cidx-doctor) and [A3](#a3-search-analytics)): `cidx stats` + `GET /stats` — per project: row count (already tracked in the registry post-2.3.0), disk size of the table directory, index presence/age (ANN/FTS built-at), `lastIndexedAt`, file_cache count; global: `~/.cidx/` total, `embedding_cache` row count/size, meta.db size.
- **Compact:** `cidx compact <name>` → `Table.optimize(...)` equivalent on the pinned LanceDB version (**verify availability/semantics of `optimize`/compaction on `@lancedb/lancedb@^0.30` at design time**; if the version lacks it, drop the compact command and keep stats only — never hand-roll a compactor). Runs inside the per-table write lock; skips if a job is active on the table (`isBusy` check, same as the watcher deferral).

#### Files touched

`src/services/db.ts` (stats/optimize helpers), `src/server/control-api.ts` (`/stats`, `/compact`), `src/cli.ts`, tests (temp-LanceDB stats; compact no-op safety on a small table).

#### Risks

- Minimal, provided "verify the native API first; if absent, cut the feature" holds.

#### Acceptance

- `stats` output matches reality on a live install (spot-check `du`).
- `compact` on an actively-indexing project refuses cleanly.

---

### O4. Daemon idle shutdown

**Impact: Low · Effort: Low**

#### Motivation

A daemon that idles for days between indexing bursts holds memory (watchers, parser, LanceDB handles) for nothing. Every entry point already auto-starts it (`cidx mcp`, CLI commands), so shutting down when idle is safe — the next touch brings it back.

#### Design

- Config `daemon.idleTimeoutMinutes` (default **0 = off**; opt-in). When > 0: the daemon tracks *activity* = any control-API request or running job; after N idle minutes it runs the existing graceful-shutdown path (`abortAll` + `registry.close`).
- **Do not shut down while:** any job is queued/running, any project is mid-`restore()`, or the stdio bridge has an open session (the bridge's auto-start would fight a daemon that keeps exiting under it — treat "an MCP session is open" as activity).
- systemd interplay: the `install.sh` service must be `Restart=no` (or the idle exit must be distinguished from a crash — exit code 0 + a log line) so the service manager doesn't resurrect an intentionally-idle daemon.

#### Files touched

`src/config.ts` (`daemon.idleTimeoutMinutes`, `DEFAULT_CONFIG_YAML`), `src/index.ts` (idle timer + activity hooks), `install.sh` (Restart policy note), tests (timer logic as a pure interval-decision function).

#### Risks

- Restart storms if the policy gets the bridge interplay wrong — the open-session-as-activity rule is the guardrail; test it explicitly.

#### Acceptance

- Pure decision-function tests (activity events → shutdown or not).
- With `idleTimeout=0` (default), behavior is byte-identical to today.

---

## How a proposal ships

1. Pick an ID here; work lands in a feature branch with the design consulted (and updated where reality disagrees with the plan).
2. On implementation: entry in [`changelog.md`](./changelog.md) (version bump per the five-place version rule), behavior documented in [`features.md`](./features.md), the item moved from 💡 Proposed to ✅ Done in [`status.md`](./status.md), and this section trimmed to a one-line "shipped in X.Y.Z — see changelog" tombstone.
3. New grammars/config surface follow their existing acceptance bars (`tests/tree-sitter.test.ts` determinism suite; `DEFAULT_CONFIG_YAML` documentation).