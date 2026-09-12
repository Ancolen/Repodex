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
| [C3](#c3-hotspot--technical-debt-report) | Hotspot / technical-debt report | Code intelligence | Medium | Medium |
| [C4](#c4-ownership-blame-enrichment) | Ownership / blame enrichment | Code intelligence | Medium | Low-Medium |
| [C5](#c5-coupling-metrics) | Coupling metrics | Code intelligence | Low-Medium | Low |
| [D1](#d1-check_docs--deterministic-doccode-conformance-checker) | `check_docs` — doc–code conformance | Documentation | High | Medium |
| [A2](#a2-mcp-resources--index-notifications) | MCP resources + index notifications | Agent UX | Medium | Low-Medium |
| [A3](#a3-search-analytics-query-log) | Search analytics / query log | Agent UX | Low-Medium | Low |
| [O2](#o2-zero-downtime-model-migration) | Zero-downtime model migration | Ops | Medium | Medium-High |
| [O3](#o3-table-stats--compact) | Table stats / compact | Ops | Low | Low |
| [O4](#o4-daemon-idle-shutdown) | Daemon idle shutdown | Ops | Low | Low |

**Suggested order** (getiri/efor balance, updated for this set): `C4`, `S3`, `A2`, `C5`, `S2`, `A3`, `O3`, `S4`, `C3`, `O4`, `O2`. (`C1` change impact, `C2` API diff and `D1` `check_docs` shipped — see their tombstones below.)

---

## Search quality

### S1. Identifier-part BM25 tokenization

**Impact: High · Effort: Medium**

> Shipped in Unreleased (2.5.0) — see [changelog](./changelog.md) and [features](./features.md). Two design deviations from the text below: identifiers are extracted with a **combined-regex pass over the chunk text** (the `countReferences` precedent) instead of tree-sitter identifier nodes — no second parse per file, the shared-parser determinism surface stays untouched, and character-fallback chunks (json/md/xml/rst) are covered too; and the `id_terms` leg is its **own single-column FTS query** rather than being appended to `searchTableText`'s default `columns`, because `@lancedb/lancedb` 0.30 searches only the first column of a list (verified against 0.30.0).

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

> Shipped in Unreleased — see [changelog](./changelog.md) and [features](./features.md). One design deviation from the text below: a **file anchor resolves to the file's single callable, or is refused with the candidate list** — a ranked report needs *one* change site, whereas the call graph can render a tree per root (a path-only report over several symbols would have ranked an undefined merge of them).

---

### C2. Public API diff / breaking-change detector

**Impact: High · Effort: Medium-High**

> Shipped in Unreleased — see [changelog](./changelog.md) and [features](./features.md). As designed (git refs compared as exported-symbol surfaces, historical side re-parsed with the same tree-sitter recipe, `detectExported` factored out of `scoreDeadCode`, `unparsed`/`notARepo`/unknown-ref reported, AST-only scope guard, caps surfaced). Three small deviations: `unchanged` symbols are always **counted** but only *listed* with `includeUnchanged` (`--all`) so they don't drown the verdict; `exportedOnly` filters on "exported on **at least one** side" (a pure both-sides filter would hide a `visibility-narrowed` symbol); and a parse-failure check (`rootNode.hasError`) runs only for AST files that yield no symbols, so the common path stays single-parse.

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

## Documentation

### D1. `check_docs` — deterministic doc–code conformance checker

**Impact: High · Effort: Medium**

> Shipped in Unreleased — see [changelog](./changelog.md) and [features](./features.md). As designed (pure engine over injected state, 13 span classes, the ≥90-confidence drift rule, three-layer intent shield, reverse coverage, drift window, `docChunks` cache on `lastIndexedAt`, eight surfaces). Deviations and the full live calibration ("drift 38 → 0", what each false positive taught) are in the changelog entry.

#### Motivation

Docs drift silently: code is renamed, defaults change, routes are added — and `CLAUDE.md`/`README.md` keep describing the old world until someone notices. Today the only check is a full Claude session (subagents, hundreds of thousands of tokens per sweep). A calibration prototype run against this very repo settled both questions:

- **Reach**: 8 doc files, 3,038 backticked references, **58% mechanically checkable** with deterministic gates — no model, ~1 s of CPU, zero Claude tokens.
- **Yield**: **5 real drifts, 0 false positives after adjudication** — a phantom symbol (`mergeWithDocLegs`, really `IndexManager.mergeWithExtraLegs`), four shipped control-API routes missing from CLAUDE.md's list (`/pack /apidiff /impact /doctor`), four shipped MCP tools unnamed in CLAUDE.md and three missing from README's tool list, plus the `docs/` file list. All fixed in the commit that precedes this proposal's implementation.

The two adjudicated non-findings taught as much as the findings: CLAUDE's "16 embedded grammars" was **correct** (a prototype regex missed `c_sharp`), and "index is the only registered job type" was **true** (registered behind the `INDEX_JOB` constant) — so the tool needs constant resolution, conservative gates, and an adjudication-friendly output, or it trains users to ignore it.

#### Design

**Layering** (the `doctor.ts` contract): a **pure engine** `src/core/doccheck.ts` — every input is injected plain data, a check never turns its own read failure into a crash (it reports `skipped`) — plus fs helpers `src/services/docfiles.ts` (doc discovery, root listing, `package.json` manifest) and one orchestration method `IndexManager.checkDocs(opts)`. No Ollama call anywhere; byte-for-byte reproducible. Wired through the full 8 layers as `check_docs` (MCP) / `POST /doccheck` / `cidx doccheck`.

**Anchor**: `project`/`path` optional, at least one required (the `get_call_graph` resolution: explicit `project` → `getIndex`; a `path` → `resolveProjectForFile` most-specific-prefix; neither → single-project inference, 0/2+ → explanatory throw).

**Doc discovery** (`docfiles.ts`): fs walk reusing `buildIgnore`/`isPathIgnored` (never forked), `.md`/`.mdx` only, default root-anchored `["*.md", "docs/**/*.md"]`, capped (depth 6, 200 files, `truncated` surfaced). `package.json` → `{deps, devDeps, scripts}` manifest; root basenames (LICENSE, NOTICE, …). Per-project `.cidx.json → doccheck: { files?, ignore? }` narrows the set (independent-field validation, same pattern as `languages`/`ignore`/`embedModel`).

**Spans and classes**: every backticked span is classified, then checked against injected state:

| Class | Check | Drift confidence |
|---|---|---|
| `identifier` | symbol-definition set ∪ whole-identifier occurrence ∪ **constants table** (`INDEX_JOB = "index"` lesson); dotted `a.b` → whole → bare last segment → all segments; miss → fuzzy nearest neighbor ("renamed?" + similarity) | 95 (92 with suggestion) |
| `path` | root-rel → `src/` prefix → doc-relative → unique suffix over the indexed file set; glob ≥1 hit ok, 0 hits → suspected (aspirational); `./config.yml` → config-literal skip; `dist/…` → artifact skip | 95; ambiguous suffix → suspected 70 |
| `env` | root file → external list/prefixes → occurrence → constants | 95 |
| `endpoint` | `VERB /route`: every literal route segment must occur (`:param` skipped) | 93 |
| `cmd`/`flag` | `bun run X` → manifest scripts; `bun run src/cli.ts <cmd>` → path + cmd occurrence; `cidx <cmd>` → occurrence; `--flag` → occurrence (external list skipped) | 95 / 92 |
| `dep` | `@scope/pkg[@ver]` → package.json (version-prefix compare when pinned; mismatch → suspected 80, never drift) | 95 |
| `kv` / `model-tag` / `config-path` | key/segment occurrence; `config-path` miss → suspected 85 (the FP-est class — deliberately not drift) | — |
| `composite` | `path → symbol`: resolve path, then whole-word symbol membership in that file | 94 |

**Evidence source is the index itself**: one `tableSymbolsWithContent` read per project, cached on `lastIndexedAt` (the call-graph cache precedent, invalidated in `removeIndex`), with `.md`/`.json`/`.xml`/`.rst` character-fallback chunks **dropped** (a doc claim must never be proven by another doc). The name lookup is the `countReferences` recipe — `buildNameRegex` group-scanned combined whole-identifier regexes (`NAME_REGEX_CAP`), so no token is silently dropped past the cap.

**Intent classification — the FP lesson**: `changelog*`-shaped files are `historical` (spans counted, findings never emitted); lines under headings matching proposed/planned/not-yet-built/🚧 are `planned`; fenced code blocks and prose-example tokens (`getUserNme`, `_private`, `a/b.py`) are `example`; `<subdir>/` shorthands like `db/` are skipped as unresolvable-without-context. Inline `<!-- cidx-doccheck-ignore -->` (own + next line) is the escape hatch. **Hard rule**: only `missing` from a total-resolution class becomes `drift` (confidence ≥ 90); every uncertainty is demoted to `needsReview` (< 90). When in doubt, don't emit a finding.

**Reverse coverage (generic)**: exported-looking symbols (the `detectExported` + `findDeadCode` pre-filter recipe — test files and entry points excluded) that appear **nowhere** in the checked corpus → an `undocumented` section (`review`, confidence 40, capped at 25, `noUndocumented` opt-out). Not a hard finding — docs may intentionally omit internals — but it is exactly the check that would have caught four shipped tools being absent from CLAUDE.md.

**Drift window**: `since` (a git ref — `safeGitRef` + a new `gitCommitTimeAt` — or a date) or `window: true` (anchor = the most recent commit touching any checked doc). Findings are filtered to those whose doc file or evidence file changed since the anchor; `checked.window` surfaces the set; every degrade (non-repo, unresolvable ref, no doc history) lands in `notes[]` — never a silent full sweep.

**Report**: `{ checked: {docs[], spans, claims, indexFreshness, window?, skipped?}, verdict: {consistent, findings, needsReview, undocumented}, findings, needsReview, undocumented, omitted, maxChars, notes }`, budgeted via a new size-generic `applyBudgetBySize` (`applyCharBudget` stays untouched) with `maxChars` default 12000. Stable `D-<n>` ids in doc order; `indexFreshness` + the FRESHNESS caveat in the tool description cover the just-renamed-symbol race. Exit code mirrors `cidx doctor`: 1 only when `findings.length > 0`.

**Later phases (out of D1a scope)**: D1b adds a local instruct-model semantic judge (`doccheck.judgeModel`) over the claims deterministic checks cannot reach, reusing the `rerank.ts` logprob machinery, with low-confidence verdicts flowing into `needsReview`; D1c adds a watch/loop mode via a `doccheck` job type. The report schema already carries both hooks.

#### Files touched

`src/core/doccheck.ts` (new, pure), `src/services/docfiles.ts` (new), `src/core/index-manager.ts` (`checkDocs` + chunk cache + invalidation), `src/core/project-config.ts` (`doccheck` block + the two `doctor.ts` hint strings that enumerate the fields), `src/config.ts` (`doccheck.maxChars`/`undocumentedLimit`), `src/utils/budget.ts` (`applyBudgetBySize`), `src/services/git.ts` (`gitCommitTimeAt`), the 8-layer wiring (`tool-defs.ts`, `mcp.ts`, `control-api.ts`, `stdio-bridge.ts`, `cli.ts`, `format.ts`), `tests/doccheck.test.ts` (new).

#### Risks

- False positives are the whole product — a wrong historical/planned/example classification trains users to ignore the tool. Mitigated by the prototype-validated gates, the drift⇒≥90 rule, and the ignore marker.
- Index freshness reads as drift (~1-2 s lag): `indexFreshness` surfaced, FRESHNESS caveat in the tool description, drift window as the cheap remedy.
- Path resolution runs over the indexed-file set + root listing (not a full walk): an ignored/untracked source file reads as missing — ambiguous suffix matches demote to `suspected`, limitation documented.
- `lastIndexedAt` is null mid-index: the cache key degenerates; `indexFreshness: null` is surfaced, indexing status does not block (call-graph semantics).

#### Acceptance

- `bun run typecheck` clean; `bun test` green with the new suite (`tests/doccheck.test.ts`, ~30 tests: classification table, per-class gates, intent filtering, budget, reverse coverage, doc walk mkdtemp fixture, engine tests over a temp table).
- Live run on this repo after the drift-fix commit: **0 `drift` findings** (`verdict.consistent`), `needsReview`/`undocumented` populated; exit 1 when drift findings exist (doctor convention).
- MCP smoke: `tools/list` shows 17 tools; `tools/call check_docs` returns the formatted report; `POST /doccheck` returns the JSON.
- No schema change, no reindex, no Ollama call anywhere in the path.

---

## Agent UX

### A1. `get_context_pack`

**Impact: High · Effort: Medium**

Shipped (unreleased) — see [`changelog.md`](./changelog.md) ("Unreleased" → *`get_context_pack` — one call for "get me up to speed on X"*): `get_context_pack` / `cidx pack`, one call assembling the search core + per-hit file outline + forward imports + context lines under a single pack-level char budget.

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

Shipped (unreleased) — see [`changelog.md`](./changelog.md) ("Unreleased" → *`cidx doctor` — one read-only diagnostic pass*) and [features](./features.md) ("Ops & diagnostics"): `cidx doctor` / `GET /doctor`, every check `ok`/`warn`/`fail` with a one-line fix hint (daemon + version match, Ollama + the configured model, the cached reranker probe, per-project table/schema-freshness/ANN/FTS/file-cache state, orphan tables, config validity via the shared `parseProjectConfig`, data-root disk usage). As designed, the checks live in `src/core/doctor.ts` as pure functions over injected state.

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