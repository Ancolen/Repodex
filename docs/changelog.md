# Changelog

Version-by-version implementation history, **newest first**. For the current done / proposed picture, see [`status.md`](./status.md); for what the tools do, [`features.md`](./features.md).

> **How this repo versions:** the design uses informal "waves" (v1 → v4); the **release version** in `package.json` is bumped per wave (currently `2.7.0`). The version string lives in **five** places that must be bumped together on release: `package.json`, `src/server/mcp.ts` (`Server` info), `src/server/control-api.ts` (`/ping`), `src/stdio-bridge.ts`, and `src/cli.ts` (`CLI_VERSION`). The `web-install.sh` / Release workflow fires on a pushed `v*` git tag.

---

## 2.7.0 (2026-10-14)

Agent-UX and observability wave driven by a week of real MCP-usage review.

### Added

- **Zero-file index transparency**: an index job that collects 0 files is a
  legitimate outcome but was previously silent — a `ready` record with an empty
  table and no explanation (first seen when indexing a directory whose only
  candidates were outside the extension allowlist). `collectFiles` now gathers
  `CollectStats` (ignored / disallowedExt / untracked / langFiltered / oversized
  counters), `indexDirectory` logs a loud explanation when the collection is
  empty, and the reason is persisted in a new lazy-migrated `indexes.note`
  column, surfaced on `get_index_status` / `list_indexes` / `GET /indexes` /
  `cidx status` (`note: collected 0 files — …`). The note is cleared as soon as
  a job leaves the table non-empty again.

- **`get_repo_overview` / `GET /overview` pick-one response (agent UX)**: with
  no `project`/`path` anchor and several projects indexed, `/overview` now
  answers with a graceful `200 { pickOne: true, note }` payload (and the MCP
  tool renders the same listing) instead of a hard 404 ambiguity error. Real
  usage showed agents in a not-indexed session directory losing a round-trip
  on the error, re-issuing the identical call, and only then falling back to
  `list_indexes`. The single-project and anchored paths are unchanged.

- **`index_project` / `/index`+`/reindex`+`/sync` got a `wait` option** — with
  `wait: true` the call blocks up to `INDEX_WAIT_MS` (120 s) for the final
  status instead of returning immediately (`timedOut: true` past the budget,
  poll as before). HTTP-attached MCP agents cannot receive job-completion
  notifications (only the stdio bridge sees `/events`), so real usage boiled
  down to one `index_project` + one-or-three `get_index_status` polls per
  index; `wait: true` collapses that to one round-trip. The tool description
  recommends it. `cidx index --wait` on the CLI.
- **Overlapping-scope warning at index start**: `index_project` responds with
  a `⚠` note when the target path lies inside (or contains) an
  already-indexed project — observed live with `~robot/server/src` indexed as
  its own project next to `~robot/server`, doubling disk work and splitting
  `find_symbol` results across two scopes. Pure helper `utils/pathtools.ts`;
  Control-API responses carry `warning`.

### Changed

- **`check_docs` requested refs are no longer silent drops** — with an
  explicit `files` list (the tool arg or `.cidx.json` `doccheck.files`), the
  report now carries `requestedDocs` (per-ref `matched` / `missing` /
  `filtered` / `outsideRoot`) and a rendered `⚠ requested docs — NOT included:`
  section. Real usage observed an agent issuing nine `check_docs` calls
  probing doc refs the discovery silently ignored (docs outside the project
  root) with `docsUnreadable: 0` and no explanation each time.

- **`[index] 'X' ready:` log line is now honest about deltas** — it reports the
  table's true state (`N files, M chunks in table`) plus what *this* run did
  (`processed / written / deleted cleaned up`); previously the bare per-run
  chunk count read as if the table had shrunk to it.

### Fixed

- **The reranker availability probe is a no-op when reranking is off by
  config.** `IndexManager.ensureRerankAvailable` (reached via the `/doctor`
  `rerankerAvailable()` port even with the tool-level gates closed) used to
  probe the backend while `search.rerank.enabled=false` and print
  `reranker model '…' not found … set search.rerank.enabled=false` — telling
  the user to do the thing they had already done (observed with that setting
  literally false). Config-off is now a hard off: no probe, no console line,
  and doctor reports "disabled by config" straight from the setting.

---

## 2.6.1 (2026-10-13)

A production bug found the day 2.6.0 shipped, healing a silent indexing failure as old as the llama.cpp backend: any file whose 4-byte emoji straddled the 1500-char chunk-window boundary had failed to index on **every sync** (Ollama's lenient JSON parser had masked the whole class). Test suite: **1066/1066** passing (12 new tests, 3471 expectations); `bun run typecheck` clean.

### Fixed

- **Astral-character-safe chunk boundaries** (found in production the day
  2.6.0 shipped): `splitLarge`'s overlapping window cut at UTF-16 code-unit
  positions, so a 4-byte emoji straddling the 1500-char boundary was split in
  half — a chunk ended (or the next one started) on a lone surrogate,
  `JSON.stringify` escaped it to `\ud83d`, and llama.cpp's strict JSON parser
  rejected the whole embed request. The file then **failed to index on every
  sync** (first seen with Turkish emoji in print strings and winston
  error-payload logs; Ollama's lenient Go parser had silently masked the whole
  class before the llama.cpp backend). Both cut edges now slide one code unit
  to stay on character boundaries
  (`alignStartToCodePoint` / `alignEndToCodePoint`, `src/utils/text.ts`);
  the docstring `MAX_DOC_CHARS` cap and the signature cap cut through the same
  helpers. Files affected this way are not in the mtime cache (they never
  indexed), so the next sync retries and heals them — no reindex needed.
- **Wire-level surrogate guard**: the raw backend clients
  (`llamacpp.ts` embeddings + rerank prompt, `ollama.ts` embeddings) and the
  hand-rolled rerank / expand prompt bodies pass text through
  `sanitizeLoneSurrogates` before `JSON.stringify`, so a lone surrogate in any
  input (e.g. a malformed query, or a legacy pre-fix row) degrades to U+FFFD
  instead of a hard HTTP 400. Valid pairs pass through untouched and clean
  text is byte-identical, so embed cache keys never drift.

---

## 2.6.0 (2026-10-13)

Seventeen items — the **entire remaining [`proposals.md`](./proposals.md) backlog** (S2, S3, S4, C3, C4, C5, A2, A3, O2, O3, O4, D1b, D1c) plus the deferred list (`maxFileSizeBytes` guard, job priority, persistent integration tests) and one measured lever (per-model task framing) — implemented in three parallel waves and merged sequentially. Test suite: 618 → **1052/1052** passing (3434 expectations, ~9 s); `bun run typecheck` clean. Everything is additive — no reindex is required unless a feature is explicitly opted into (framing, fuzzy tier). **One wire change to know about:** the search endpoints now return a small **envelope** instead of a bare array — see the C4 entry below.

### Search quality

- **feat(search): path/surface boost (proposal [S3](./proposals.md#s3-pathsurface-boost)).** RRF is rank-only: it cannot see that one hit is a 300-line generated file in `build/` while another is the same function in `src/`. A pure post-merge re-scoring pass (`src/utils/boost.ts → applyPathBoost`) nudges the merged ranking toward source-y surfaces with **multiplicative factors**: a short-path bonus (fades in below ~160 chars on a log scale, max `shortPath: 0.10`), a conventional source-root bonus (`sourceRoot: 0.05`, segment-wise match on `sourceRoots: ["src", "lib", "app"]` — `src` matches `src/a.ts` but not `nested/src/a.ts`), a test-file demotion (`testDemotion: 0.85`), and a generated-file demotion (`generatedDemotion: 0.80`; `gen|dist|build|vendor|node_modules` path segments, `*.pb.go` / `*.min.*` suffixes). It runs right after the RRF merge and **before `refineAndSlice`** — the reranker and MMR see the adjusted order, and the boost never decides on its own. Invariants: only **RRF-merged** lists are re-scored (a single-leg list carries its native metric — a LanceDB text leg surfaces raw BM25 under the same `_score` — and re-scaling it would silently change its meaning; the manager gates on `rrfMerged`), a list containing any row without a numeric `_score` is returned untouched, and `enabled: false` returns the input byte-identical. Config: `search.boost` block (`enabled` default true + the four weights + `sourceRoots`), env `BOOST_ENABLED` / `BOOST_SHORT_PATH` / `BOOST_SOURCE_ROOT` / `BOOST_TEST_DEMOTION` / `BOOST_GENERATED_DEMOTION` / `BOOST_SOURCE_ROOTS`; per-call `boost: false` / `--boost false` opts out. Pure logic, no reindex. *(Interaction fixed during the merge: `boostByProject` applies per project with the record's own root, so `searchAll` boost is per-project, not global.)*

- **feat(search): `find_symbol` fuzzy fallback (proposal [S2](./proposals.md#s2-find_symbol-fuzzy-fallback)).** `find_symbol` was exact + prefix — a typo (`getUserNme`) returned nothing. A third **fuzzy tier** (n-gram BM25 over `symbolName`, 3-grams — model-independent, no embedding) now recovers near misses: it runs only when exact AND prefix both find nothing and the caller didn't pass `fuzzy: false`; every fuzzy hit carries `fuzzy: true` (CLI renders a `[⚠ fuzzy]` marker) and the tier respects `limit`. Built as a second FTS index over `symbolName` via the native n-gram tokenizer in `@lancedb/lancedb` 0.30 (no extra column needed), created at index time; **tables indexed before this release never fuzzy-match** — the next index job or a reindex creates the index. Tests: n-gram overlap ranking (typo → original name), tier gating (exact hit suppresses fuzzy), opt-out, and the legacy-table path.

- **feat(search): query expansion (proposal [S4](./proposals.md#s4-query-expansion-local-llm)).** Opt-in `expand: true` / `--expand` asks a local expansion LLM to rewrite the query into up to `maxVariants` (default 3) variants (symbol-shaped + rephrased), runs each through the same per-project pipeline (framing, rerank, MMR all apply per variant), and merges the variant rankings into the base ranking with RRF. The envelope reports what happened: `expanded` (variant count) and, when expansion could not contribute, an `expandNote` reason (no model configured / backend unreachable / malformed response / no usable variants) — degradation is reported, never silent. **Variants are NOT query-logged** (the log records the user's query, not the machine's rewrites — zero-hit analytics stay meaningful). Config: `search.expand` (`model` default `""` = off, `url` follows the embedding backend unless overridden, `maxVariants` 3, `timeoutMs`), env `EXPAND_MODEL` / `EXPAND_URL` / `EXPAND_MAX_VARIANTS` / `EXPAND_TIMEOUT_MS`. Off by default — zero behavior change until configured. Implementation note: the search path was restructured around it (`tableRows` / `finishSingleProject` / `gatherExpansion` / `crossTableRows` / `plainSearchAll`), and a merge-time fix threads **framing** through `tableRows` so base and variant queries embed with the record's framing (the original shape embedded the raw query, which would have regressed framed projects).

- **feat(search): blame enrichment + the SearchEnvelope (proposal [C4](./proposals.md#c4-ownership-blame-enrichment)).** Opt-in per-search `blame: true` / `--blame` stamps each result with **`lastAuthor` / `lastCommitDate` (UTC) / `churnCommits`** — the most recent commit touching the chunk's line range and how many commits touched it — read fresh from git per search (one `git blame --porcelain` per hit **file** — not per chunk — memoized per SHA within the call, capped at **8 files**; extras are reported, never silently dropped). New pure core: `src/core/blame.ts` (porcelain parser + `summarizeBlameRange`) and `services/git.ts → blameRange`. Honesty rules: a project whose files aren't in a git working tree sets `blameNotARepo: true` (nothing stamped), files skipped by the cap are counted in `blameSkipped`. **The envelope:** `searchIndex` / `searchAll` — and every surface riding them: `POST /search`, the MCP `search_codebase` payload, the stdio bridge, `cidx search` — now return `{ results, blameNotARepo?, blameSkipped?, expanded?, expandNote? }` instead of the bare array (**a wire change**: clients that consumed the array must read `results`). `search_codebase_batch` carries the same notes **per query group** (`{ query, results, blameNotARepo?, … }`); the pack and `find_symbol` keep their existing shapes (packs are deliberately blame-free — their legs are already enriched; `find_symbol` gains only the per-row `fuzzy: true` from S2). The blame stamping happens before the `maxChars` budget (so the budget never stamps half a result set), and the envelope degrades to exactly `{results}` when nothing was requested — the plain search payload stays small. The old **recency** small-proposal is superseded by this (per-search, opt-in, and carries strictly more information).

- **feat(embedding): per-model task framing.** Retrieval-tuned embedding models reach their best quality when each input carries the task framing the model was trained with (**measured on this repo's corpus: +0.06–0.08 MRR** for both qwen3-embedding and EmbeddingGemma 2). The embedding backends cidx talks to embed RAW text, so cidx adds the prefixes itself (`src/core/framing.ts`, pure — no I/O): **documents** (indexed chunk content and its docstring `doc_vector` leg) get the preset's `docPrefix` at the indexer **before** the embed call — "hash what you embed", so the cache keys stay correct; **queries** (the vector leg of `searchIndex`/`searchAll`) get the `queryPrefix` per record, exactly like the model pin; the raw query keeps its other roles (BM25 legs, query log, reranker prompt) untouched. Presets (`FRAMING_PRESETS`, model-prefix matched): `embeddinggemma-2*` → docs `title: none\n\ntext: `, queries `task: search result\n\nquery: `; `qwen3-embedding*` → queries get the documented retrieval instruction, docs unframed. Resolution: `embedding.framing` (env `EMBEDDING_FRAMING`) or a per-project `.cidx.json` `framing`, values `none` (default — byte-identical legacy behavior, zero new wire bytes) or `auto` (first preset whose lowercased model prefix matches the record's model; unknown models stay unframed). The resolved identity is **pinned into `IndexRecord.framing`** at `createIndex` and re-pinned after every index job — the `embedModel` precedent — and a framing change escalates through the same zero-downtime **migrate** machinery as a model change, so two framings never share a table (the watcher skips writes on a divergence until the migrate runs).

### Code intelligence

- **feat(code-intel): coupling metrics — `get_coupling` (proposal [C5](./proposals.md#c5-coupling-metrics); 18th MCP tool).** Per indexed file: **fanIn** (internal importers), **fanOut** (internal imports), **instability = fanOut / (fanIn + fanOut)** (0 = stable/attracting, 1 = unstable/depending; null when a file has no internal edges), and **externalImports** (external/unresolved specifiers — deliberately excluded from the fan metrics and counted separately, so package noise can't skew the internal picture). Sectioned into three ranked bands: **topFanIn** (most imported), **changeMagnets** (fanIn ≥ 2 AND fanOut ≥ 2 — the entangled files where one change ripples), **unstableLeaves** (imported by nothing, importing others); files in no band are counted (`unclassified`), not listed; every band is capped by `limit` (default 50) with totals + `truncated` flags. Built over the existing mtime-keyed dependency-graph cache (first call parses every indexed file's imports, later calls instant until a file changes) — **no reindex, no schema change**. CAVEAT surfaced in the tool description: package-indexed projects give trivially shallow metrics. `src/core/coupling.ts` (pure) + `cidx coupling`.

- **feat(code-intel): hotspot / technical-debt report — `get_hotspots` (proposal [C3](./proposals.md#c3-hotspot--technical-debt-report); 19th MCP tool).** The churn × size intersection where bugs and refactoring fatigue live. Score = **churn × size, log-scaled** — a deliberate **proxy** (size = chunk count + distinct symbol count per file, NOT cyclomatic complexity; the tool never claims otherwise). Debt signals adjust the score: **dead-code density** (zero-reference symbols at `uncertain`-or-better confidence — the `find_dead_code` scoring) and **coupling** (fanIn + fanOut from the dependency graph) promote a file; **test files and entry points are demoted into `review`** (a hot, well-exercised test file is not a hotspot). Bands: **critical** (score ≥ 50, address first), **warm** (≥ 25), **review** (below, incl. demoted files) — each capped by `limit` (default 20) with honest totals + `truncated`; zero-score files with no debt signal are counted (`notListed`), not listed. Churn window: `since` (git date syntax, default `"90 days ago"`); a non-repo is **reported** (`notARepo` — churn degrades to empty, the report still renders). FRESHNESS is surfaced, not hidden: the table-derived feeds (size, dead-code density) come from a snapshot cached on the last index (`hotspotFeedCache`, keyed on `lastIndexedAt` — stale by design until a reindex, `snapshotTruncated` when the row cap hit), while churn runs `git log` **live** on every call and coupling rides the mtime-keyed graph — a file edited moments ago already shows its churn but not its new size. `src/core/hotspots.ts` (pure) + `cidx hotspots`. No reindex, no schema change.

### Agent UX

- **feat(agent-ux): MCP resources + index notifications (proposal [A2](./proposals.md#a2-mcp-resources--index-notifications)).** Two additions to the MCP surface: (1) **Resources** — `cidx://indexes` (the index list), `cidx://indexes/{name}/overview` (the `get_repo_overview` payload), `cidx://indexes/{name}/status` (job status/progress), defined in `src/server/resource-defs.ts` (single source consumed by the MCP server; read-on-demand, no state). (2) **A daemon event stream** — an in-memory ring (`DaemonEventRing`, capacity 512, restart-detected via a monotonically increasing `nextEventCursor` — a client paging with an old cursor learns the ring restarted) publishing **`job-completed` / `index-added` / `index-removed`** events; consumed over the Control API as `GET /events?since=<cursor>` (JSON page + next cursor) and by the **stdio bridge**, which polls every 3 s and forwards `notifications/message` to the MCP client + `resources/list_changed` when an index is added/removed — so an agent sitting on a stdio connection learns that indexing finished without polling. The publication hook is `IndexManager.onIndexEvent` (a listener set, exactly one consumer pattern, a throwing listener is reported and skipped — never fatal). The bridge also registers a **session** (`POST /bridge-session` open/close) so the daemon knows an MCP client is attached — which feeds O4's idle rule.

- **feat(agent-ux): search analytics / query log (proposal [A3](./proposals.md#a3-search-analytics-query-log)).** A bounded `query_log` table in the registry (one row per **`searchIndex`** call — `ts, project, query, mode, result_count, latency_ms`; expansion variants are deliberately NOT logged, so zero-hit analytics reflect the user's queries), pruned to the newest `search.queryLogSize` rows at write time (**0 = off**; env `QUERY_LOG_SIZE`); default 10000. Read via `GET /querylog` (bounded, filters) and the `cidx stats` report, which surfaces **zero-hit queries** (the index-gap signal: what agents asked for and found nothing) and **latency** (mean/p95), plus per-mode counts. Pure analytics — nothing feeds back into ranking.

### Ops

- **feat(ops): zero-downtime model migration (proposal [O2](./proposals.md#o2-zero-downtime-model-migration)).** A model change used to escalate the next `sync` to a full reindex — wiping the table and re-embedding everything while search served nothing. Now it escalates to a **`migrate` job** instead: the indexer re-embeds the project's content into a **shadow table** off to the side (search keeps serving the old table's self-consistent vectors the whole time) and, when the shadow is complete, swaps the registry's pointer in a **single sqlite transaction** (the commit point) and drops the old table. Plumbing: the registry's `indexes` rows now carry an explicit **`table_name`** column (lazy ALTER migration for existing DBs; `tableNameFor(record)` is the single accessor — the watcher, blame, and every per-table path follow a mid-flight swap), `migrateTable` in the indexer, a new job type wired like `index`, and doctor detects **stale migration leftovers** (shadow tables from a crashed migrate — the interrupted-job path drops them at restore). The embedding cache makes the shadow pass cheap when content didn't change (content-hash + model keys). The same escalation now also covers **framing changes** (above), and **boot restore** re-enqueues interrupted migrates like interrupted indexes.

- **feat(ops): table stats + compact (proposal [O3](./proposals.md#o3-table-stats--compact)).** `cidx stats` / `GET /stats` (`src/core/stats.ts`): per-project table report — row/chunk counts, on-disk size of the table directory, index presence (ANN/FTS), age of the last index — plus the embedding-cache and query-log summaries (A3) and the data-root total. `cidx compact` / `POST /compact` runs the native LanceDB `Table.optimize` (present in the pinned 0.30.0 — verified before building) once per project to reclaim space after big deletes/reindexes; **409 when a job is running** for that project (never races a writer — `compactBusyMessage`), and the report says what ran and what it freed. Both ride the existing report-tool pattern (rendered text + `structuredContent`).

- **feat(ops): daemon idle shutdown (proposal [O4](./proposals.md#o4-daemon-idle-shutdown)).** Opt-in `daemon.idleTimeoutMinutes` (env `DAEMON_IDLE_TIMEOUT_MINUTES`, default **0 = off** — existing installs behave byte-identically): after N minutes without activity the daemon runs its **existing graceful-shutdown path**. Activity = any Control-API request, any MCP request, or any running/queued job; **never shuts down while a job is queued/running or while a stdio bridge session is open** (the bridge's auto-start would fight a daemon that keeps exiting under it — an open session is activity, enforced via the A2 `/bridge-session` registration). The decision is a pure interval function (`src/core/idle.ts → shouldIdleShutdown`, unit-tested) fed by activity timestamps from the servers + queue; the exit is code 0 with a log line so a service manager can tell an intentional idle exit from a crash.

- **feat(queue): job priority ordering + reindex help fix.** The `jobs` table gains **`priority INTEGER NOT NULL DEFAULT 0`** (lazy ALTER for existing DBs — the `table_name` precedent), `JobQueue.enqueue` takes an optional `priority` (default 0), and the claim rule becomes **priority DESC, FIFO within equal priority** (a fused `claimNext()` — no scheduler, no preemption, one ordering rule). Policy: user-initiated `createIndex` / `reindex` / `sync` stay at 0; **boot-time `restore()` re-enqueues all three catch-up paths at `JOB_PRIORITY_BACKGROUND = -5`** — half-finished resumes, offline-change syncs, and boot-escalated model/framing migrations — so background catch-up can't starve an interactive click that arrives during a big restore. Also fixed: the `cidx reindex` help text claimed a full reindex clears the embedding cache — it doesn't and shouldn't (the cache is **content-hash + model keyed**, so a reindex legitimately serves 100% cache hits and finishes in seconds when content is unchanged); the help now says the table + file cache are cleared and the embedding cache is **kept**, pinned end-to-end by a test proving a routed reindex performs **zero new embed wire calls** and leaves the cache row count unchanged.

### Indexing & doccheck

- **feat(indexing): `maxFileSizeBytes` guard.** Generated/oversized data files (HuggingFace `tokenizer.json` dumps, fixture blobs) previously had to be excluded via `.cidxignore` per project — and `.json` is an allowed extension, so a missed exclusion meant thousands of chunks and a polluted index. New bound: **`indexing.maxFileSizeBytes`** (env `MAX_FILE_SIZE_BYTES`, default **0 = off**) and a per-project **`.cidx.json` `maxFileSizeBytes`** override (like `languages`/`ignore`, it takes effect on the next sync — files newly over the limit are absent from the collection list, so the deleted-file cleanup prunes them, mirroring the `languages` semantics). The guard runs in **two places**: `collectFiles` filters files strictly larger than the limit before any work, and `indexFile` re-checks before chunking (the watcher path — a file that grew past the limit stays out of the table, logged as a skip with `skippedOversized`, never an error). The rule is strictly-larger (a file exactly at the limit is kept).

- **feat(doccheck): semantic judge for uncertain claims (proposal [D1b](./proposals.md#d1-check_docs--deterministic-doccode-conformance-checker)).** The deterministic checker's `needsReview` list held everything the rules couldn't reach; now an optional **local instruct-model judge** re-judges those claims: with `doccheck.judgeModel` set (env `DOC_CHECK_JUDGE_MODEL`; default `""` = **off** — the checker stays fully deterministic), each `needsReview` item is sent to a small local model (Ollama-style generation, or `doccheck.judgeUrl` / `DOC_CHECK_JUDGE_URL` to point elsewhere — the rerank logprob machinery reused, e.g. yes/no verdicts) with a strict prompt; a confident "this claim is fine" **resolves the item out of `needsReview`** (it moves to a `resolvedByJudge` count), everything else stays. **The judge never produces drift findings** — it can only clear doubts, never create accusations (the hard rule "only a total-resolution miss at ≥ 90 is drift" is untouched); availability is probed once and cached (absent model → the checker runs judge-free with a note). The report carries a `checked.judge` block (model / available / judged / resolved); per-call `judge: false` skips it. `runDocCheck` became async with the judge injected as `opts.judge` (`src/services/docjudge.ts`), so the pure engine in `src/core/doccheck.ts` stays byte-for-byte deterministic and testable without a backend.

- **feat(doccheck): watch/loop mode via a `doccheck` job type (proposal [D1c](./proposals.md#d1-check_docs--deterministic-doccode-conformance-checker)).** `cidx doccheck` used to be a purely on-demand report. With **`doccheck.watch`** (env `DOC_CHECK_WATCH`, default **false**) enabled, the daemon enqueues a **`doccheck` job after every successful index/sync/migrate job** on a project (via the A2 event machinery — the `IndexManager` constructor subscribes to `job-completed` and enqueues through `maybeEnqueueDocCheckJob`, guarded against double-enqueue while one is queued/running; the flag is read at event time; a `doccheck` completion never re-triggers itself; the enqueue failure path logs and moves on — the watch chain never takes the watched job down). The handler re-runs the deterministic check for the project (judge included only if configured) and **UPSERTs the latest report** into a new registry table **`doccheck_reports`** (`project` PK, `ts`, `consistent`, `findings`, `needs_review`, `report_json`; latest-per-project; cleaned by `removeIndexDeep`); an abort before the store keeps the old snapshot untouched; failures land in the job error like every handler. The read side is wired through all eight layers: **`cidx doccheck <project> --last`** / `GET /doccheck/last?project=` / `check_docs { last: true }` print the **stored snapshot with its timestamp** and a shared *"snapshot from <ts> … NOT a fresh check"* header — a stale snapshot can never pose as a fresh run; 404 with an enable-watch hint when nothing is stored; the CLI's drift exit rule is unchanged (exit 1 only on drift findings).

### Tests

- **test: persistent daemon / Control-API integration battery (`tests/integration/`).** The db + Control-API smoke pass that used to be run by hand each release is now **committed and runs with plain `bun test`** (adds ~1 s to the suite; ~1.3 s standalone; verified green 4× consecutively with no leaked temp dirs or processes). Fully self-contained: `helpers.ts` serves a **fake Ollama backend** on an ephemeral port (`GET /api/tags`, `POST /api/embed` batching, `POST /api/embeddings`, `POST /api/show` 404 so rerank session-disables) returning deterministic sha256-derived fixed-dim vectors, and spawns the **real daemon as a subprocess** (`bun src/index.ts`) with a `mkdtemp` `CIDX_HOME` and free `MCP_PORT`/`CONTROL_PORT` (bind-conflict retry, bounded `/ping` boot poll); the production daemon on 9371/9372 is never contacted. `control-api.test.ts` runs **19 ordered scenarios** end to end: boot/ping identity → create index → await job → text-mode search (envelope is exactly `{results}`, embedding columns absent) → zero-hit search → `/find` exact + fuzzy-marked fallback → vector-mode search asserting **cosine distance 0 for byte-identical chunk content** + an uncached query proving the single-embed wire call → `/outline` → `/dependencies` (forward resolved edges + reverse importedBy) → `/querylog` rows → `/stats` shape → `/doctor` (all check ids, warn tolerated) → `/events` since-paging → incremental sync after an edit and after a file deletion (deleted-file cleanup polled to empty) → `/coupling` report smoke → `POST /shutdown` asserting graceful exit code 0. afterAll SIGTERM→SIGKILL with death asserted + temp cleanup. Zero source changes — tests only.

---

## 2.5.0 (2026-10-12)

- **feat(embed): pluggable embedding backends — Ollama or llama.cpp (`llama-server`).** All model traffic routes through a new dispatch layer, `src/services/embed.ts`: `getEmbedding` / `getEmbeddings` / `cachedEmbed` resolve a backend once per process and fan out to the Ollama wire client (`src/services/ollama.ts`, unchanged semantics incl. per-request `num_ctx`) or a new llama.cpp wire client (`src/services/llamacpp.ts`). **Auto-selection** (`embedding.provider: auto`, the default) probes both backends — Ollama `GET /api/tags`, llama-server `GET /v1/models` — and picks: an Ollama that actually serves the configured `ollama.model` (tag or `name:*` prefix) wins over a live llama-server; a live llama-server wins over an Ollama that lacks the model (whose own error is more informative); nothing reachable → an actionable error naming both servers and `embedding.provider`. Explicit `provider: ollama | llamacpp` skips probing. New config: `embedding.provider` / `EMBED_PROVIDER`, `embedding.llamacppUrl` (default `http://127.0.0.1:8080`, llama-server's own default) / `LLAMACPP_URL`, and `search.rerank.url` / `RERANK_URL` (empty = follow the embedding backend). **llama.cpp specifics:** `POST /v1/embeddings` takes the batch as an array input and re-sorts by the `index` field; the model string must equal the server's `-a` alias (one llama-server serves one model, no `/api/show`-style model management); the context is fixed at launch (`--ctx-size` AND `--ubatch-size` headroom — no per-request `num_ctx`; a chunk capped at `maxChunkSize` chars can tokenize beyond `maxChunkTokens` under the real tokenizer, and llama-server rejects inputs above the physical ubatch with *"input is too large to process. increase the physical batch size"*); and a llama.cpp **reranker** cannot run on the same server (an `--embedding` server cannot compute logits) — its own llama-server is pointed to via `search.rerank.url` and scored through `/v1/completions` `logprobs` (the parser accepts both llama.cpp's flat `{logprob, top_logprobs}` and the OpenAI `{content: [...]}` wrapper shapes). **Doctor** (`backendCheck`, check id `backend`) replaced `ollamaCheck`: it reports the resolved backend, provider-specific hints ("ollama pull X", "restart llama-server with that model"), and per-project `modelInOllama` became `modelOnBackend`. Switching backends changes embeddings only if the served model differs — cidx keys vectors by `IndexRecord.embedModel`, so serve the same identifier (`-a` must match) to keep cache/table hits, or reindex per project. Tests: `tests/embed-backend.test.ts` (selection rules, tag matching, dispatch memoization, `/v1/embeddings` payload, both logprobs shapes, non-ok degradation); `tests/doctor.test.ts` + `tests/rerank.test.ts` reworked for the injected backend; `bun run typecheck` clean, **618/618** (1674 expect).

- **feat(config): default embedding model → `qwen3-embedding:0.6b`.** The bare `qwen3-embedding` tag resolves to the **8B** variant in Ollama (4.6 GB at Q4_K_M, 4096-dim vectors), so every fresh install silently pulled a 7.6B-parameter model to embed chunks that are capped at ~512 tokens by design (`min(maxChunkSize, maxChunkTokens·4)` = 1500 chars). The default is now the explicit `:0.6b` tag (595M params, 639 MB at Q8_0, 1024-dim, native 32k context) — ~7× smaller on disk and in VRAM, and proportionally faster on CPU. Changed: `DEFAULTS.ollama.model` + the `DEFAULT_CONFIG_YAML` template (`src/config.ts`), both installers (`install.sh` / `web-install.sh`, which also had their model-present check rewritten to compare **full names per line** — `awk 'NR>1 {print $1}' | sed 's/:latest$//' | grep -qx -- "$MODEL"` — instead of interpolating the model name into a regex, which silently treated metacharacters in an `OLLAMA_MODEL` override as patterns), and every doc that stated the default (`README.md`, `docs/features.md`, `docs/architecture.md`, `docs/cpu-only-ops.md`, `docs/README.md`, root `CLAUDE.md`, `CONTRIBUTING.md`). **Existing installs are unaffected**: an already-written `config.yml` pins its own `model:` line, and vector compatibility is tracked per record (`IndexRecord.embedModel`), so nothing needs a reindex. Per-project overrides (`.cidx.json` `embedModel`) are unchanged.

- **perf(ollama): right-size the Ollama context — `num_ctx` is now sent on every model call.** Ollama allocates its context buffer from `num_ctx` and **defaults to 4096** when a request doesn't say otherwise — and it holds that buffer for as long as the model stays resident. cidx's inputs are ≤512 tokens by design (`min(maxChunkSize, maxChunkTokens·4)`), so every loaded model carried ~8× the context it needed, permanently, in VRAM/RAM. Two new config keys, wired through the usual defaults < YAML < env chain: **`ollama.numCtx`** / `OLLAMA_NUM_CTX` (default **1024**) passed as `options: { num_ctx }` on **both** embed calls in `src/services/ollama.ts` (`ollama.embed` batch + `ollama.embeddings` single — the SDK's `EmbedRequest`/`EmbeddingsRequest` both accept `options`, so no raw-fetch fallback was needed), and **`search.rerank.numCtx`** / `RERANK_NUM_CTX` (default **1024**) added to `scoreOne`'s existing `options` in `src/services/rerank.ts`. Measured live against Ollama 0.33.2 on `qwen3-embedding:0.6b` (`ollama ps`): **CONTEXT 4096 / 2.4 GB resident** without the option → **CONTEXT 1024 / 1.4 GB** with it, and embeddings are **bit-identical** for any input that fits — `cos = 1.000000000` at 2048 and 3072 chars, with the ~1024-token knee between 3072 and 4096 chars, where truncation does start (`cos` 0.9975 at 4096 chars). Two semantics worth knowing: `num_ctx` applies to **each input of a batch individually**, not to the concatenated batch (verified: 8 × ~430-token chunks embedded alone vs. in one `batchSize: 8` request — identical vectors), and below the knee the remaining difference is kernel/allocation rounding only. Defaults leave 2× headroom over `maxChunkTokens`; raise both keys if you raise `maxChunkSize` past ~4000 chars. New tests: `OLLAMA_NUM_CTX` / `RERANK_NUM_CTX` defaults + env overrides + invalid-value fallback + a guard that the generated `config.yml` template carries both `numCtx` keys, and a fake-`fetch` rerank test asserting the request body pins `options.num_ctx` alongside `num_predict`/`temperature`.


### Agent-facing tool ergonomics (post-D1 tool audit)

`bun run typecheck` clean, `bun test` **603/603** (1644 expect). A full audit of every MCP tool — definition and live payload — drove one pass of ergonomics fixes: the toolset now speaks the agent's language end to end (anchor by the path you know, self-correct from the error you get, never a silent cap, never a wasted kilobyte).

#### One-anchor project resolution: `project?` / `path?` everywhere

Eight tools that previously demanded the daemon's registered project NAME accept a **`path` anchor** — `search_codebase`, `search_codebase_batch`, `find_symbol`, `find_references`, `get_context_pack`, `get_repo_overview`, `find_dead_code`, `get_api_diff` — plus the search family's `path` on the control API and stdio bridge. A path anchors to the project that contains it (prefix match, most-specific wins — the `get_dependencies` semantics, factored into `IndexManager.resolveProjectScope`). An explicit `project` always wins. Nothing given: the search family searches **all projects** (unchanged); the per-project report tools fall back to **the single indexed project** or error naming them. `get_repo_overview`'s `project` is optional, `find_dead_code`'s and `get_api_diff`'s no longer required, and `search_commits` gets the single-project fallback (its `path` stays the file-history filter — no project anchor by path, deliberately). The CLI follows the `callgraph` convention: a positional that is an existing directory anchors by path (`cidx deadcode .`, `cidx commits . "msg"`, `cidx apidiff . v1.2.0`, `cidx overview .`), and `cidx deadcode` with no anchor resolves the lone project.

#### `find_references` honesty: no silent caps

The reference scan now returns an honest envelope — `{ refs, total, truncated }` — where `total` counts **every distinct occurrence found before the limit cut** (the candidate scan uses the same bounded row cap the dead-code/impact passes pay, instead of a `limit*4` chunk pool that could under-count) and `truncated` says when the limit bit. The rendered text says *"50 of 132 reference(s) (limit reached …)"* instead of a bare "50" that looked complete. Doc artifacts (.md/.mdx/.xml/.rst) — which are indexed chunks, so a changelog mention IS a real occurrence — remain evidence **by default**, and `includeDocs: false` / `--no-docs` answers the code-only "who calls X" question (the gate is wired through every layer — MCP → control API → stdio bridge → CLI — cross-checked so no arg is silently dropped).

#### Search results stop shipping embeddings

`searchIndex` / `searchAll` / `findSymbol` (and every payload that flows from them — `/search`, `/search/batch`, `/find`, `/pack`, the MCP `structuredContent`, the stdio bridge's HTTP hop) now drop the `vector` and `doc_vector` columns at the public boundary (`IndexManager.stripEmbeddings`). Those are ~20 KB of floats per row that only the in-daemon rerank/MMR/doc-leg machinery consumes — a 3-result search goes from ~70 KB of JSON to a few KB. `doc` and `id_terms` stay (they carry real information); the raw rows inside `searchTable*` are untouched, so nothing about retrieval changes.

#### Self-healing errors: the error message carries the fix

Every "unknown project" failure is produced by one shared builder (`indexNotFoundMessage`) that names **the available projects and the likeliest intended one** — `Index not found: repodex-wrong (available: Repodex, projects) — did you mean 'Repodex'?` — so an agent corrects itself in the same turn instead of paying a `list_indexes` round-trip. The ambiguity errors say the same thing in tool-neutral words: *"pass the 'project' (or 'path') argument to disambiguate"* replaces the old CLI-flavored *"pass --project"* that made no sense over MCP. Control-API 404s for `/indexes/:name` reuse the same builder.

#### `get_context_pack` gains the search filters

The pack's underlying search now accepts the same narrowing filters as `search_codebase` — `language`, `symbolType`, `pathGlob` — through every surface (MCP, control API `/pack`, stdio bridge, `cidx pack --language/--type/--path`). Same pack budget, same assembly; the filters just decide which hits are considered before the outline/imports/context legs run.

#### Report tools return `structuredContent`

The five report tools (`find_dead_code`, `search_commits`, `get_api_diff`, `get_change_impact`, `check_docs`) plus `get_dependencies` now return **both** content types: the rendered text (for the model) and the raw JSON report under `structuredContent` (for anything that wants to consume the payload programmatically). The pack already did this (`{ pack }`); the reports follow. `get_context_pack` also gains `language`/`symbolType`/`pathGlob` filters — same schema as `search_codebase`, applied to the pack's underlying search.

#### `deriveSignature` no longer cuts at an object-type brace

The signature enrichment used to break a declaration head at **any** `{` — so `async checkDocs(opts: {` rendered as a half-cut `async checkDocs(opts: …`. Now a `{` that follows `:`/`,`/`(`/`=` opens an inline object **type**, not the body: the collector keeps gathering lines until the real body brace (Allman-style lone `{` on its own line still ends the head), and the final cut skips type-literal braces. Head cap raised 3 → 6 lines so multi-line parameter lists survive intact.

The signature is also no longer the **doc comment sitting above the declaration**: a chunk spans its preceding doc comment too, so the first line of e.g. `applyBudgetBySize` rendered the whole JSDoc. `deriveSignature` now takes the chunk's `language` and skips leading comments, docstrings and decorator/attribute lines per a per-language style table (`COMMENT_STYLES` — `//` + block comments for the C family, `#` for Python/Ruby/GDScript, `"""` docstrings, `@`-decorators for Python/Java/Kotlin/Swift/Scala/GDScript, `#[…]` for Rust, `[…]` for C#). Languages without a style (markdown — where `#` is a heading, not a comment — and unknown labels) keep the exact legacy first-line behavior; all four consumers (enrichment, dead-code, call graph, api diff) pass the language through.

#### Description touch-ups (the agent-readable contract)

- `get_file_outline` now says it reads the file **live from disk** — instant, not index-lagged; the companion rescue when the ~1–2 s freshness lag would show stale content.
- `search_codebase` / `search_codebase_batch` say that `mode: 'text'` (pure BM25) works **without the embedding model** — the fallback when embedding is unavailable.
- `language` / `symbolType` filters point at `get_repo_overview`'s `languageDistribution` / `symbolTypeBreakdown` as the source of valid labels, instead of leaving the agent guessing.
- `formatOverview`'s stray same-line `{` (a formatting slip, no behavior change).

### `check_docs` — doc–code conformance checker (proposal D1)

`bun run typecheck` clean, `bun test` **573/573** (1596 expect). Ships proposal [D1 — `check_docs`](./proposals.md#d1-check_docs--deterministic-doccode-conformance-checker): "do the docs still tell the truth about the code?" answered **deterministically** — no Ollama, no LLM, no wall clock, byte-for-byte reproducible, ~1 s CPU on 11 docs / 3203 spans. Every backtick span in the markdown docs is classified and resolved against the index; only a total-resolution miss at confidence ≥ 90 is a **drift** finding, everything else lands in `needsReview` ("emin değilsen bulgu deme"). Validated live on this repo (the docs corpus it was designed for): 3203 spans → 1170 claims resolved, **drift 0**, 17 advisory review items, 25 capped `undocumented` entries; a planted drift exits 1.

#### The pure engine (`src/core/doccheck.ts`, new)

No I/O of any kind — every input is injected plain data (`DocCheckState`), so the same state produces the same report. Pipeline: `extractDocSpans` (region-tagged: `historical` file > fenced `example` > `planned` heading > `current`, with inline `<!-- cidx-doccheck-ignore -->` covering its own line + the next) → `classifySpan` (13 classes: identifier / path / env / endpoint / cmd / flag / dep / kv / model-tag / config-path / composite / artifact / opaque, in the order the live adjudication taught) → occurrence scans over the code chunks (`scanDocTokens`, the `countReferences` recipe in NAME_REGEX_CAP batches, whole-identifier and literal boundary styles) → per-class resolvers → intent demotion → findings. Resolution assets: the symbol set, whole-identifier occurrences with `file:line` evidence, a **constant-literal table** (`const INDEX_JOB = "index"` — a doc can name a literal *value* whose only code presence is a constant binding), the file universe (indexed files ∪ **every walked file** — the index is an under-approximation of the repo: `.sh`, `.wasm`, LICENSE — ∪ root names ∪ the checked docs), package.json deps/devDeps/scripts, per-file symbol membership for `file → symbol` composites. Fuzzy near-misses become `did you mean …? (possible rename)` findings at 92.

#### The intent lesson (the FP shield)

Three layers, each driven by a live adjudication:

- **Regions**: historical files (changelog, release notes — **and proposals/roadmap**, where everything is by definition intended, not yet real), fenced code examples, and `planned` headings (`## 💡 Proposed`, roadmap, todo) produce counters, never findings.
- **Prose examples**: an example marker anywhere on the line (`e.g. HuggingFace `tokenizer.json``), a single-character path segment (`a/b.py`), or a same-line sibling token that normalizes to the same identifier demote to review at 50.
- **Vocabulary gates** (things a doc can name without claiming they exist here): bare extension mentions (`.md`, `.tscn`), `.git/…` (never indexed), unresolved hidden files (`.cidx.json` is optional by design), URI-style paths (`/ping`, `/api/generate`), owner/repo:tag refs, `<placeholder>` tokens, lowercase version-y labels (`ubuntu-24.04-arm`), the supported projects' convention files (`project.godot`), and `~`-rooted or `../` paths.

More calibration lessons, each now a gate with a test: a **caret/tilde range satisfies the pinned version it documents** (`^0.1.13` ⊇ `0.1.13`); a **missing dep is suspected 80**, because docs legitimately name build tools and related packages (`tree-sitter-cli`); an **ALL-CAPS assignment** (`CUDA_VISIBLE_DEVICES=""`) is an env var, not a config key; a **call-shaped mention** (`os.homedir()`) resolves by the identifier it names; an identifier named on a line **discussing a known dependency** is probably that dependency's API (`getDylinkMetadata` on a web-tree-sitter line); an **extension the repo never uses** marks a described external project (`src/parser.c` in the vendored-grammar notes); and `OLLAMA_*` names occurring nowhere in code are Ollama's own runtime variables. `.json` chunks are **evidence-capable** (tsconfig/package.json keys are machine config, not prose) while `.md/.mdx/.xml/.rst` remain excluded — a doc claim cannot prove another doc claim.

#### Reverse coverage

`undocumented`: exported symbols (`detectExported`, the shared per-language recipe; test files / entry points / dynamic-hook names pre-excluded) that **no doc span mentions** — full or bare name, any region (a changelog mention still documents). Advisory only: confidence 40, candidate cap 2000, output cap `undocumentedLimit` (default 25), `noUndocumented` turns it off.

#### The engine (`IndexManager.checkDocs`) + cache

Opts-anchored project resolution (path / project / the single indexed project — the `getCallGraph` pattern), per-project `.cidx.json` `doccheck` `{ files, ignore }` on top of the CLI flags, doc discovery + manifest + chunk snapshot in parallel, then the pure run with daemon-side defaults (`doccheck.maxChars` 12000 / `doccheck.undocumentedLimit` 25, env `DOC_CHECK_MAX_CHARS` / `DOC_CHECK_UNDOCUMENTED`). The evidence snapshot (`docChunks`) is **one `tableSymbolsWithContent` pass per index version**, keyed on `lastIndexedAt` (the `buildCallGraph` discipline; `json` included as evidence, prose formats dropped); `checked.indexFreshness` surfaces what the report was built from — the index lags edits by ~1–2 s, and the tool description says so. The **drift window** (`since <ref>` resolved via the new `gitCommitTimeAt`, or `window: true` = the docs' own last commit) post-filters findings to those whose doc or code side actually changed; every degradation (non-repo, unresolvable ref) is a note, never a silent full scan. Optional fields follow the config convention; `applyBudgetBySize` (`src/utils/budget.ts`) is the generic size-keyed budget sibling of `applyCharBudget` (first item always kept, dropped items counted, never truncated mid-item).

#### File kinds, factored out (`src/core/filekinds.ts`, new)

`isTestFile` / `isEntryPointFile` / `ENTRY_POINT_NAMES` / `DEAD_CANDIDATE_TYPES` moved verbatim out of `index-manager.ts` so dead-code scoring and reverse doc coverage share one recipe (behavior unchanged, existing dead-code tests untouched).

#### Eight surfaces

`tool-defs.ts` (the 17th MCP tool, with the drift/needsReview contract and the freshness caveat in the description) → `mcp.ts` → `control-api.ts` `POST /doccheck` (unknown project → 404) → `stdio-bridge.ts` (hand-maintained case, every arg copied) → `cli.ts` `cmdDoccheck` (`cidx doccheck [project|path]`, aliases `check-docs`/`checkdocs`, exit 1 **only** on drift findings) → `format.ts` `formatDocCheck` (drift → needs review → undocumented, skipped counters, truncation warnings) → `index-manager.ts`. Config: `doccheck.maxChars` / `doccheck.undocumentedLimit` in `DEFAULTS` + the YAML template + env overrides.

#### Tests (`tests/doccheck.test.ts`, 80)

Pure engine (classification table, regions, suppression, the INDEX_JOB constant path, whole-identifier no-superstring, NAME_REGEX_CAP group batching with nothing dropped, per-class resolvers, intent demotion, budget/limit honesty, reverse coverage), the doc walk (mkdtemp: default set, options, the 200-cap surfaced, the walked-file universe), and `IndexManager.checkDocs` over a **real** fixture project (planted drift found, `src/lib.ts` path claim resolved via the cached file set, freshness surfaced, unknown project throws, doc-less project yields a valid empty report, non-repo window degrades with a note) — no Ollama anywhere.

### `get_api_diff` — public API diff / breaking-change detector (proposal C2)

`bun run typecheck` clean, `bun test` **489/489** (1347 expect). Ships proposal [C2 — Public API diff / breaking-change detector](./proposals.md): "did this release break anything public?" answered by comparing two git refs as **exported-symbol surfaces**. The base ref's surface is re-parsed from git (`git ls-tree -r` ∩ AST extensions → `git show <ref>:<path>` → the **same `chunkCode` recipe** the indexer uses) in bounded concurrency; the head defaults to the **working tree as currently indexed** (no reindex), or another ref to compare two historical points. Every symbol is classified `removed` / `signature-changed` / `visibility-narrowed` (all **breaking**) / `added` / `unchanged`, with the before → after signatures side by side on the breaking ones. No embedding, no LanceDB write, no schema change, nothing persisted; `notARepo`, `unknownRef` and `invalidRef` are **reported, not thrown**, and files that fail to read or parse at a ref are listed as `unparsed` instead of silently contributing nothing.

#### The comparator (`src/core/apidiff.ts`, new)

Pure module (no I/O in the comparator itself), like `deadcode.ts` / `commits.ts`:

- `compareSurfaces(base, head)` joins the two surfaces on `(path, type, name)` and classifies: absent at head → `removed`; present but no longer exported → `visibility-narrowed`; declaration head changed and its parameter list differs → `signature-changed`; absent at base → `added`; otherwise `unchanged`. A rename is an honest `removed` **+** `added` pair — there is no rename inference, so nothing is silently paired up.
- `paramList` / `paramsDiffer` implement the **per-language, deliberately approximate** signature comparison: arity, parameter order and *normalized* parameter names. Normalization cuts default values (`b = 2` → `b`) and type annotations after a single top-level `:` (C++'s `std::string` survives — `::` is a scope separator, not an annotation), strips `...`/`&`/`*`/`?`/`mut`/`const` decoration and Python's keyword-only `*` marker, drops Python's implicit `self`/`cls`, and picks the name token per language (Go's `name Type` keeps the **first** token, Java/C++'s `Type name` the **last**). A side with no comparable parameter list never counts as changed — no breaking claim without evidence.
- `unchanged` symbols are always **counted**; they are only *listed* with `includeUnchanged` (`--all`), because on a real repo they drown the verdict. `exportedOnly` keeps everything that is exported on **at least one** side — so a `visibility-narrowed` symbol is still visible while a private-on-both-sides helper is filtered out.
- `extractRefSurface` is the one impure helper here (git + tree-sitter, colocated so the engine and the tests share it): `git ls-tree -r --name-only -z` ∩ `EXT_TO_GRAMMAR` (the **scope guard** — only the 16 bundled grammars have a surface), then a `mapWithConcurrency` pass over `git show` → `fileSurface` — the embedding pipeline's concurrency shape, minus embeddings. `fileSurface` re-runs `chunkCode` so a symbol is named/typed/ranged identically on both sides, and confirms a symbol-less file with `rootNode.hasError` before calling it `parse-error` (a legitimately symbol-less file is just empty).

#### Exportedness, factored out (`src/core/exported.ts`, new)

`detectExported` moved verbatim out of `deadcode.ts` into its own module and is re-exported from there, so dead-code scoring and the API surface recover "exported" from chunk text with **one** per-language recipe (`export …`, `pub …`, Go capitalization, `public …`, GDScript `class_name`/`@export`). Existing dead-code tests are unchanged.

#### Git (`src/services/git.ts`)

`safeGitRef` (a whitelist — refnames, SHAs, `~`/`^` revisions; rejects anything option-, glob-, `object:path`- or reflog-shaped before it reaches an argv), `gitRefExists` (`rev-parse --verify --quiet`), `gitLsTreeFiles` (`ls-tree -r --name-only -z`, NUL-safe) and `gitShowFile` (`show <ref>:<path>`, literal argv, no shell). Every helper reports failure (`null`/`false`) rather than throwing, in the `searchGitLog` tradition.

#### Engine (`src/core/index-manager.ts` → `getApiDiff`)

Checks `isGitRepo` → `notARepo`, validates/resolves both refs → `invalidRef` / `unknownRef`, extracts the base (and head, when a ref was given) surface from git, projects the index rows for the default head (`surfaceFromIndexRows`), and compares. Report: `entries` (breaking first, capped by `limit`), `counts` (never capped, including `unchanged`), `breaking`, `unparsedFiles` (with the side that failed), `scannedFiles` + `truncated` (file cap *and* entry cap both flag it).

#### Surfaces (the full 8 layers)

Tool `get_api_diff` (`tool-defs.ts`) → MCP handler (`mcp.ts`) → `POST /apidiff` (control API) → **stdio bridge `case "get_api_diff"`** → CLI `cidx apidiff <project> <base> [--head x] [--limit n] [--max-files n] [--exported-only] [--all]` (alias `api-diff`) → `formatApiDiff` (`src/server/format.ts`, shared by MCP + stdio + CLI) → `IndexManager.getApiDiff`.

#### Tests

New suite `tests/apidiff.test.ts` (34 tests), no Ollama and a throw-away `CIDX_HOME`: the comparator (all five kinds, the breaking-first ordering, the honest rename pair, `exportedOnly`), the parameter normalizer table (TS/Rust/Go/Java/C++/Python — defaults, annotations, `::`, variadics, `self`, the no-comparable-list conservative case), the git helpers and **the scripted fixture repo across two tags `v1`→`v2`**: a removed, a renamed, a signature-changed, a default-value-only, a body-only, a visibility-narrowed, an added and two unchanged symbols are all classified correctly, `unparsed` is reported for the file that does not parse at `v1`, and the engine is exercised on both head sides (a ref, and the working tree through a real temp LanceDB table) plus `notARepo` / unknown-ref / invalid-ref. The tree-sitter interleaved-determinism suite stays green.

### `get_change_impact` — one ranked answer to "if I change X, what breaks?" (proposal C1)

An agent answering that question today burns three calls (`get_call_graph` callers, `get_dependencies` imported-by, `find_references`) and then has to reconcile them itself. `get_change_impact` does the reconciliation **server-side** and returns one ranked report: **all three adjacency views already exist and are cached — the only new work is the join** (`src/core/impact.ts`, pure, a sibling of `callgraph.ts` / `deadcode.ts`). No schema change, no reindex, no embedding.

#### One ranked report, sections in severity order

A consumer that *calls* the symbol outranks a file that merely *imports* its module, which outranks a loose textual mention:

- **▲ Direct callers** — the cached call graph, reverse direction, breadth-first and cycle-safe (`flattenCallers`): every consumer within `depth` (default 3) is listed **once, at its minimum depth** (`depth 1` = calls the anchor directly, `2` = calls a caller, …), sorted by depth then path; the anchor itself is never its own consumer.
- **→ Importers** — the cached dependency graph, reverse. An importer whose own body also mentions the symbol ranks first inside the section (`alsoReferences: true`) — a stronger signal than a bare side-effect import.
- **≈ Textual references** — the whole-identifier reference pass: an exact count of **distinct source lines** mentioning the symbol (the definition line excluded, overlapping chunks deduped) plus a few representative `file:line` hits with their containing symbol. `count` and the per-file set always cover every match; only the sample list is capped.
- **✓ Covered by** — test files are pulled **out** of the production sections and reported separately with how they reach the symbol (`via: call / import / reference`): "covered by a test" is a different fact from "consumed by production".
- **Change site (fan-out)** — how entangled the anchor itself is: distinct indexed files its file imports, distinct in-index symbols it calls, and the imported paths.

Each section carries `total` (the true count before the cap) + `truncated`, and the report surfaces `scannedSymbols` / `scannedChunks` / `truncated` / `scanTruncated` like its three parents — no silent caps.

#### Anchor, cost, and the same-name limitation

Anchors mirror `get_call_graph`: `symbol` (exact / prefix / dotted-suffix, so a bare method name resolves to its qualified form), `path`, or both; ≥1 required. Unlike the call graph — a tree per root — a ranked report needs **one** change site, so a file with several callables (or an ambiguous name) is refused with the candidate list (`selectAnchor`). Cost: the call graph and import graph come from their `lastIndexedAt` / mtime caches; the reference pass is one `tableSymbolsWithContent` read, the same pass `find_dead_code` pays. Same-name disambiguation is whole-identifier matching, **not** LSP — documented in the tool description; this is a review aid, not proof.

#### Surfaces (the full 8 layers)

Tool `get_change_impact` (`tool-defs.ts`) → MCP handler (`mcp.ts`, ≥1 of symbol/path) → `POST /impact` (control API) → **stdio bridge `case "get_change_impact"`** (the hand-maintained, easy-to-miss layer) → CLI `cidx impact <symbol|file> [--project x] [--depth n] [--limit n]` (alias `change-impact`; the positional auto-detects an existing path, like `callgraph`) → `formatImpact` (`src/server/format.ts`, sections in severity order + the fan-out line + `⚠` truncation lines).

#### Tests

New suite `tests/impact.test.ts` (20) — pure join over synthetic adjacency: the caller traversal (depth bounding, minimum-depth dedup, cycles, work cap), the reference scan (definition rule, overlap dedup, exact counts under a sample cap), severity ordering, per-section caps/totals/truncation, the test-file split, and the fan-out. `tests/impact-fixture.test.ts` (16) — a real fixture project (a symbol with a caller, a side-effect importer and a comment mention, plus a test file) parsed with the **real** engines (`chunkCode`, `extractImports` → `resolveImports`, `buildCallEdges`) and joined; the symbol appears in all three sections ranked correctly, its test file lands in `coveredBy`, and the engine's anchor/project-resolution contract is pinned. `bun run typecheck` clean; `bun test` **489/489** (1347 expect).

### `get_context_pack` — one call for "get me up to speed on X" (proposal A1)

An agent doing "get me up to speed on X" burns 4–6 round-trips (search → outline per hit → deps per hit → context lines), each a full round-trip. `get_context_pack` assembles the same material **server-side in one call** — less latency, less context churn, and a shape the agent can rely on. **All composition, no new engines**: every leg already exists and is cached; the only new logic is assembly + the pack-level budget. No schema change, no reindex.

#### What one call returns

`pack: { hits: [{ hit, outline, imports }], totalChars, omitted, maxChars }` — a structured object, not a flat results list:

- **Search core (reused, never reimplemented).** `getContextPack` calls `searchIndex`/`searchAll` **exactly as today** — hybrid + rerank + MMR + the docstring legs + the shared query cache all apply unchanged.
- **Per-hit enrichment, one pass.** The usual `signature` / `indexedAt` / `contextLines` enrichment, plus two new legs per hit:
  - **`outline`** — the hit file's `get_file_outline` data (`chunker.ts → fileOutline`), capped to the hit's **neighborhood** (`sliceOutlineForHit`): the symbols overlapping the hit's chunk range, then up to 4 symbols below it ("what comes next in the file"), at most 12 entries. Symbols wholly above the chunk are dropped. Parsed **once per file per call** (hits can share a file); a missing/unreadable file drops its leg, never the hit.
  - **`imports`** — the forward leg of `getDependencies` only (relative specifiers → `extractImports` → `resolveImports`, **resolved to indexed files only**, so there are no phantom edges), capped at 10 with `importsTruncated: true` when the cap bites. The reverse graph is deliberately **not** triggered (its first build parses every indexed file); external/unresolved specifiers are not pack legs.
- **ONE budget for the whole pack.** `applyPackBudget` (`src/utils/budget.ts`, the pack-level variant of `applyCharBudget`) runs **once** over the assembled pack: hits are added whole in ranked order while the running total fits (`packEntrySize` = hit content + context lines + outline lines + import lines + framing), the **top hit is always kept** even when it alone exceeds the budget, and everything after the first non-fitting hit is counted in **`omitted`** — dropped whole, never truncated, never silently lost. The inner search deliberately runs **without** `maxChars`: a pack has a single budget, so the internal legs never double-bill. Default `maxChars` **6000**; a big `limit` with a small budget degrades gracefully (top-1 + an honest `omitted` count).

#### Surfaces (the full 8 layers)

Tool `get_context_pack` (`tool-defs.ts` — the single source consumed by both transports) → MCP handler (`mcp.ts`, returns the readable text **and** `structuredContent: { pack }` so JSON consumers get the object) → `POST /pack` (control API) → **stdio bridge `case "get_context_pack"`** (the hand-maintained, easy-to-miss layer) → CLI `cidx pack "<query>" [--project x] [--limit n] [--max-chars n] [--context n]` → `formatContextPack` (`src/server/format.ts`, shared by MCP + stdio + the CLI, which prints it rather than forking a second renderer).

#### Tests

New suites `tests/pack-budget.test.ts` (14) — `packEntrySize` / `outlineSize` / `importsSize` arithmetic, no-op cases, top-1-always-kept, exact boundary, running-budget arithmetic, ranked order, big-limit/small-budget degradation, legs counting against the same budget, all-or-nothing inclusion — and `tests/pack-composition.test.ts` (12) — the neighborhood slice (overlap + below-window + caps + file order + above-dropped) and the import leg against a real fixture (`fileOutline` reflects the hit's file; every resolved edge points at a file in the indexed set; cap + `truncated`). `bun run typecheck` clean; `bun test` **322/322** (871 expect).

### Identifier-part BM25 tokenization (proposal S1)

Ships proposal [S1 — Identifier-part BM25 tokenization](./proposals.md) (Impact: High · Effort: Medium): compound identifiers are split into their subparts into a new nullable **`id_terms`** column and BM25-searched as an extra hybrid-search leg, so a natural-language query like *"update user name"* can reach `getUserName` through text and not only through the vector leg. Reuses the 2.4.0 doc-leg pattern end to end (nullable column, explicit Arrow schema, `tableColumns` gating, per-leg try/catch FTS, legacy tables untouched). `bun run typecheck` clean, `bun test` **341/341** (865 expect). Version bump deferred to the central release commit.

### Identifier tokenization (`src/core/idterms.ts`, new)

Pure module (no I/O, no LanceDB), like `src/utils/text.ts` / `src/core/deadcode.ts`:

- `splitIdentifier` breaks an identifier at camelCase / snake_case / kebab-case / dotted / `$` boundaries — Unicode-aware, acronym-run aware (`HTTPServer` → `HTTP` `Server`), digits stay attached to the word they follow (`md5Hash` → `md5 hash`, `sha256sum` stays one part).
- `extractIdTerms(content)` scans the chunk with one combined identifier regex (the `countReferences` precedent) and emits, per distinct compound identifier, `<raw> <part> <part> …` lowercased and space-joined: `getUserName` → `getusername get user name`, `user_id` → `user_id user id`. Single-word tokens are skipped (the `content` leg already indexes them verbatim) and identifiers are deduplicated in first-seen order.
- The string is **capped at 2000 chars** at a term boundary, so a minified/generated file cannot produce a pathological row; a lone oversized identifier is truncated.
- `idTermsQueryParts` / `wantIdTermsLeg` tokenize a query the same way and gate the leg (see Search below).

**Design deviation from the proposal:** identifiers are extracted with the regex pass, not tree-sitter identifier nodes. The chunker is untouched, no second parse per file, the shared-parser determinism surface (see the Lua precedent) stays out of scope, and character-fallback chunks (json/md/xml/rst) — which have no identifier nodes — are covered as well.

### Schema (`src/services/db.ts`)

One new **nullable** column on the fixed row schema: `id_terms` (string|null). No embedding, no vector index — BM25 only.

- The **explicit Arrow schema** used at table creation (`arrowSchemaFor`) gains the column. It must be explicit for the same reason `doc` is: inference cannot type an all-null field, and `id_terms` is null on every chunk without a compound identifier.
- `stripUnknownColumns` now strips any optional column the target table predates (`doc`/`doc_vector` from before 2.4.0, `id_terms` from before this change), so writes keep working on both legacy shapes. A full reindex recreates the table with the full schema.
- `ensureFtsIndex` builds BM25 over `id_terms` alongside `content` and `doc`, in its **own try/catch** — a failure warns and never fails the index.
- `searchTableText` keeps single-column calls: `@lancedb/lancedb` 0.30 searches only the first column of a `columns` list ("For now, only one column can be searched" — verified against 0.30.0), so the `id_terms` leg is a separate query, exactly like the `doc` leg. The doc note in `searchTableText` spells this out.

### Indexing (`src/services/indexer.ts`)

`indexFile` populates `id_terms` in the record loop, straight from the chunk text (`extractIdTerms(...) || null` — null when the chunk has no compound identifier). Pure CPU, **no embedding pass**: unlike `doc_vector`, this leg adds no Ollama calls.

### Search (`src/core/index-manager.ts`)

`mergeWithDocLegs` → `mergeWithExtraLegs` (same role, one more leg, plus the search `mode`):

- **Gating.** The `id_terms` leg runs only (a) in `hybrid` mode, (b) when the table has the column (`tableColumns` — legacy tables never pay the query), and (c) when the query itself tokenizes into **≥ 2 parts** (`wantIdTermsLeg`) — a single-word query is already served by `content`, and skipping keeps the RRF rank pool undiluted for queries the leg cannot help. It is **not** tied to the `doc` opt-out: it is a code-side leg, not a docstring leg.
- **Merging.** Anonymous: `id_terms` hits join the RRF merge without a marker field (no new output field, no tool-def change). `_docHit` still marks doc-contribution results only.
- **Legacy invariant preserved byte-for-byte.** When no extra leg yields results, `combine` still returns the single non-empty list sliced with its native metric (vector legs keep `_distance` and no `_score`); nothing is "simplified" into always-RRF.

### Surfaces & tests

No new tool, CLI flag, or output field. New suite `tests/idterms.test.ts` (45 tests): the table-driven splitter (camelCase, snake_case, kebab-case, SCREAMING_SNAKE, dotted, acronym runs, digits, unicode), extraction (dedup, single-word skip, lowercasing, the 2000-char cap at a term boundary), the query gate, and — against a real temp LanceDB — the fresh-table column + FTS behavior, `ensureFtsIndex`'s three indexes, writes into a legacy table (stripped, not rejected), and the legacy table's byte-identical pre-S1 result shape (native BM25 `_score` well above the RRF maximum of 1/60, vector `_distance` with no `_score`, no `id_terms` on rows).

### `cidx doctor` — one read-only diagnostic pass (proposal O1)

`bun run typecheck` clean, `bun test` **348/348** (917 expect). Ships the "O1 `cidx doctor`" design from [`status.md`](./status.md): the support checklist — is the daemon up, is Ollama reachable, is the embed model installed, is the table schema current, is the config valid — answered by one command. Every check reports `ok` / `warn` / `fail` with a one-line fix hint; **doctor never mutates anything**, and the exit code is scriptable (0 unless a check fails, warnings still 0).

#### CLI (`cidx doctor`)

Thin client, like the other subcommands: it evaluates the one check the daemon cannot report itself (daemon reachability + the **CLI ↔ daemon version match** → warn on mismatch), fetches `GET /doctor`, and renders every check with its fix hint. Exits 1 only when a check is `fail`.

#### Control API (`GET /doctor`) and the check registry (`src/core/doctor.ts`, new)

The daemon owns the checks that need its state. `src/core/doctor.ts` is the check registry and is **pure where possible**: each check takes injected, already-measured state (plain data) and returns a verdict, so checks are unit-testable without a daemon, Ollama or LanceDB. `runDoctor(ports)` is the single state gatherer, wired in `control-api.ts` from `IndexManager` + `services/db` + `CONFIG`; `GET /doctor` returns the aggregated report (`status` = worst verdict, `checks[]`, `home`).

- **Ollama** — reachable + the configured `OLLAMA_MODEL` installed, from one `/api/tags` call (a bare model name matches its `:latest`/tagged form). Unreachable or missing model → `fail`.
- **Reranker** — reuses `IndexManager.ensureRerankAvailable`'s **cached** probe (no second implementation); a missing model is a `warn` (search falls back to RRF order).
- **Per registered project** — table exists (`fail` when the registry row has no table), **schema freshness** via `tableColumns` (a pre-2.4.0 table → *"reindex to enable the docstring search legs"*), ANN/FTS index presence (no ANN below `vectorIndexThreshold` is by design; a non-empty table without a `content` FTS index is a `warn` — text/hybrid finds nothing), and registry ↔ table sanity (registry chunk count vs live rows, empty file cache over a non-empty table — both skipped while a job is running). A project whose pinned `embedModel` is not installed in Ollama is a `fail` (search in that project fails).
- **Orphan tables** — directories under `~/.cidx/db` the registry does not know → `warn` (never searched, only disk). The mirror case (a registry row without a table) is the project check's `fail`, so each problem is reported once.
- **Config validity** — the global YAML parses, and each project's `.cidx.json` is validated by the **same `parseProjectConfig` the indexer uses** (shared, not duplicated). Unparseable/invalid files are `warn`s: cidx ignores them and runs on defaults, which is exactly what doctor makes visible.
- **Disk usage** — total + per-table directory sizes of `~/.cidx/`, computed inline with a read-only fs walk (the O3 `stats` command is *not* part of this).

#### Tests

New suite `tests/doctor.test.ts` (52 tests): every check against synthetic state (missing table, legacy schema, missing FTS/ANN, chunk-count drift, orphan tables, broken YAML/JSON config, version mismatch), a healthy synthetic install that yields all-`ok`, and the collector `runDoctor` over fake ports (including a degraded table read). `measureDiskUsage` is exercised against a real temp directory.

---

## 2.4.0 — docstring / comment embedding + doc search legs

Version bumped 2.3.0 → **2.4.0**; `bun run typecheck` clean, `bun test` **296/296** (790 expect). Ships the "Embed docstring / comment separately" proposal from [`status.md`](./status.md) — a symbol's docstring / doc-comment is extracted at chunk time, embedded into a **separate `doc_vector` column on the same row**, and searched as its own retrieval legs, so intent queries ("how to do X") hit the *documentation* even when the *code body* doesn't semantically match.

### Extraction (`src/chunking/docstring.ts`, new)

`extractDoc(top, inner, language)` runs inside `chunkCode` and attaches a `doc?: string` to the chunk (capped at 1200 chars):

- **Python** — the module/class/function docstring (first `string` statement of the body, via the `string_content` child). Falls back to preceding comments when there is no docstring.
- **All other AST languages** — the **contiguous run of comment nodes directly preceding the symbol** (`precedingComments`: comment-typed named siblings, identity-checked by `node.id`, so a detached comment two lines up doesn't leak in). This covers JSDoc, Rust `///`, Go `//`, JavaDoc, C#/Kotlin/Swift/Scala/GDScript comments uniformly.
- The doc is attached **only to the first chunk** of a split symbol (a large function split into `#1..#n` carries the doc once, on `#1`).

### Schema (`src/services/db.ts`)

Two new **nullable** columns on the fixed row schema: `doc` (string|null, the extracted text) and `doc_vector` (number[]|null, its embedding, from the same model as the code vectors).

- **Legacy tables are not broken.** Tables created before 2.4.0 lack the columns; `insertChunks` runs the records through `stripUnknownColumns(table, records)` which drops `doc`/`doc_vector` for those tables (LanceDB rejects unknown fields on `add`). Existing indexes keep working — they just have no doc leg until **reindexed**.
- Column presence is checked per-table via the new `tableColumns(table)` (schema columns, empty set when the table is absent); all doc-leg queries are gated on it, so pre-2.4.0 tables take the exact legacy code paths (including the native single-leg metrics — no `_score` when only one leg produced results).
- `searchTable` gains an explicit `column` (default `"vector"`); `searchTableText` gains a `columns` list (default `["content"]`) — the doc legs query the same helpers against `doc_vector` / `doc`. `ensureVectorIndex` builds the ANN index over `doc_vector` at the end of a full index (schema-guarded, skipped when absent); `ensureFtsIndex` builds BM25 over `doc` alongside `content` (its own try/catch — a doc-FTS failure warns and doesn't fail the index).

### Indexing (`src/services/indexer.ts`)

New `embedTexts(texts, model, …)` — the shared batched/bounded-concurrent embed (cache read → Ollama for misses → cache write) factored out of the content path; the content leg and the doc leg both go through it. When `indexing.docstrings` is on (see below) and a chunk carries a doc, the doc texts are embedded in a second pass and written to `doc_vector`. Nullability invariants: `doc` is always written (null when absent), `doc_vector` only when the embed succeeded.

### Config

`indexing.docstrings` (default **true**) — turns doc extraction + doc-vector embedding off entirely for deployments that don't want the extra embed calls. Priority unchanged (defaults < YAML < env); the generated `DEFAULT_CONFIG_YAML` documents it. Live `~/.cidx/config.yml` files don't need edits (boolean default applies); apply to existing projects with a **full reindex**.

### Search (`src/core/index-manager.ts`)

`searchOnTable` can now merge up to **four RRF legs**: code-vector ANN, `doc_vector` ANN, `content` BM25, `doc` BM25.

- **Gating.** The doc legs run only when (a) the caller didn't pass `doc:false`, (b) the table actually has the columns (`tableColumns` — legacy tables never pay the extra queries), and (c) the leg has a vector/query to run (`doc_vector` ANN needs a query embedding; `text` mode skips the vector leg entirely).
- **Merging.** New `combine(lists)` / `mergeWithDocLegs(...)` keep the legacy behavior byte-for-byte when no doc leg yields results: a single non-empty list is returned sliced **with its native metric intact** (`_distance` for vector legs, no `_score`), and multiple lists RRF-merge into `_score`. Only when a doc leg actually contributes rows do the results carry `_score` (RRF) and a `_docHit: true` marker — surfaced as `[doc hit]` in CLI/MCP output (`formatResults`).
- **Per-call opt-out.** `doc` option on `search_codebase` (MCP), POST `/search` + `/search/batch` (control API), the **stdio bridge** (field-by-field forwarding), and CLI `cidx search|open|batch --doc false`; `doc:false` skips the doc legs even on fresh tables (useful for a fast pure-code lookup).
- **Filters apply to doc legs too** (`buildWhere` `where` is shared by all four legs), and `searchAll`/`searchBatch` inherit everything since they fan out over `searchIndex`.

### Surfaces

MCP tool schemas (`tool-defs.ts`) gained the `doc` boolean on both search tools; `formatResults` renders the `[doc hit]` marker; CLI help/usage updated. No new tools — this is a search-quality upgrade inside the existing `search_codebase` / `search_codebase_batch` / `cidx search`.

### Tests

New suite `tests/docstring.test.ts` (9 tests): Python docstring + fallback to preceding comments, contiguous-comment-run extraction per language shape, the 1200-char cap, doc-on-first-chunk-only for split symbols, class + method doc attachment, and Go type-decl docs.

---

## 2.3.0 — cidx identity + per-project config + `cidx open`

Version bumped 2.2.0 → **2.3.0**; `bun run typecheck` clean, `bun test` **287/287** (763 expect). Shipped together: the user-facing rename sweep (below), per-project `.cidx.json` configuration, and the `cidx open` search→editor handoff.

### Fixes found on the live instance

- **Rerank was silently dead on live indexes.** Rows returned by LanceDB arrive as non-extensible Proxy objects (Bun interop), so `refineAndSlice`'s in-place `result._rerankScore = …` assignment always threw and fell back to RRF order — rerank never actually applied, and every search logged the failure. Candidates are now shallow-copied before scoring; `_rerankScore` verified live.
- **Honest post-sync stats.** `list`/`status` showed the **last job's** write counts after an incremental sync (mtime-skips + deletions made "107 files, 3 chunks" look like data loss when the table actually held 596 chunks). The registry now records the table's true row count (`countTableRows`) and the cached file count after every job.

### `cidx open` — search, then open the result in your editor

The "search found it, now jump into it" step, end-to-end from the shell:

- `cidx open "<query>" [flags]` runs the same search pipeline as `search` (project/mode/language/type/path/rerank/mmr flags; default `--limit 10` so there's a list worth picking from), prints the full result list, then opens the picked result (`--pick n`, 1-based, default 1) in `$VISUAL` → `$EDITOR` → `vi` at the chunk's start line.
- **Per-editor line conventions** (`src/utils/editor.ts → buildEditorArgs`): `+<line>` for terminal editors (vim/nvim/nano/emacs and the POSIX default), `--goto <file>:<line>` for the VS Code family (`code`/`code-insiders`/`codium`/`code-oss`), `<file>:<line>` for Helix (`hx`). `$VISUAL` may carry its own flags (`VISUAL='code -w'`).
- Guardrails: the file must still exist on disk (stale index → `cidx sync` hint), an out-of-range `--pick` errors with the valid range, and the CLI exits with the editor's exit code. Tests: 8 new (`tests/editor.test.ts`) → **287/287** (763 expect).

### Per-project configuration (`.cidx.json`)

A project root can carry a **`.cidx.json`** — the per-project counterpart to the global config — with three independently-validated optional fields:

- **`languages`** — a language-label allowlist (same labels as the `language` search filter). Files whose extension produces no label are dropped while the filter is active; filtered-out files are absent from the file list, so the deleted-file cleanup prunes them on the next sync, and the watcher removes them live on file events.
- **`ignore`** — extra ignore patterns layered over `.gitignore` + `.cidxignore`.
- **`embedModel`** — a per-project embedding model. Pinned to the record at `createIndex`; a `sync` **escalates to a full reindex** when the configured model differs (vectors from two models can't share a table); the **watcher skips writes** for a changed model until the reindex runs. Queries are embedded with the model the table was built with.

The file is read fresh on every index job and watcher event (no daemon restart). Invalid fields are dropped with warnings; invalid JSON warns and is skipped — indexing never fails because of the file.

**Behavior change (model compatibility):** `searchIndex`/`searchAll` no longer throw when the global `OLLAMA_MODEL` differs from what a table was built with — the query is now embedded with the **record's pinned model** (`rec.embedModel ?? CONFIG.OLLAMA_MODEL`). This makes per-project model overrides self-consistent; the old global-mismatch throw is gone. Caveat: `searchAll` across projects using different models mixes distances from different embedding spaces.

Wired through the full stack (`indexer` full-index + `watcher` live writes + `index-manager` create/sync/search + `ollama.ts` model-parameterized embeds). New module `src/core/project-config.ts`; `extToLanguage` unifies grammar labels (`EXT_TO_GRAMMAR`) and text labels (`TEXT_LANG_BY_EXT`). Tests: 13 new (`tests/project-config.test.ts`) → **281/281** (751 expect); `bun run typecheck` clean.

### cidx identity — every user-facing name now says "cidx"

The old generic names (`.mcpignore`, `indexer.yml`, `~/.mcp-indexer`, `MCP_INDEXER_HOME`, the `mcp-code-indexer` product name and systemd unit) made it hard to tell what a file or setting belonged to. **Clean break** — old names are no longer read:

- **Ignore file:** `.mcpignore` → **`.cidxignore`** (project-root extra ignore rules, layered over `.gitignore`).
- **Config file:** `$INDEXER_CONFIG` → `$CIDX_CONFIG`; `./indexer.yml` / `.indexer.yml` / `indexer.yaml` → `./cidx.yml` / `.cidx.yml` / `cidx.yaml`.
- **Data home:** `~/.mcp-indexer` → **`~/.cidx`**; env `MCP_INDEXER_HOME` → `$CIDX_HOME`; the global `ignoredDirs` entry updated to match.
- **Product name:** `mcp-code-indexer` → `cidx` everywhere — `package.json`, MCP `Server` info, stdio-bridge identity, CLI banner, and the **systemd user unit** (`mcp-code-indexer.service` → `cidx.service`).
- **Auto-migration.** On boot, if the new default home (`~/.cidx`) does not exist yet and the legacy `~/.mcp-indexer` does, the daemon **renames the old directory into place** and patches the carried-over `config.yml` in place (the pinned absolute `home:` path and the stale `ignoredDirs` entry). Skipped when `$CIDX_CONFIG` is set (an explicitly provided config means the caller manages their own setup) and under test runs (`bun test` sets `NODE_ENV=test`) so tests never touch real user data. `install.sh` stops/removes the legacy `mcp-code-indexer.service` unit when present; `uninstall.sh` removes both.
- **Upgrading:** rename `.mcpignore` → `.cidxignore` in your projects (the old file is no longer read); everything under `~/.mcp-indexer` moves automatically on the first daemon start. Tests: 3 new sandboxed migration tests (move + config patch, no-op when the fresh home exists, skip when `CIDX_CONFIG` is set).

## 2.2.0 — Godot / GDScript + doc-format indexing

Full Godot support at the same depth as the other languages: AST chunking, dependency graph, dead-code scoring, config, docs, and a new grammar-acceptance test suite. Version bumped 2.1.0 → **2.2.0**; `bun run typecheck` clean, `bun test` **260/260** (700 expect).

### Doc-format indexing (XML / reST) + pathGlob fix

Motivated by a Godot game project: index a version-matched engine class reference (`godot --doctool` dumps per-class `.xml`) next to the game code so API questions ("does this method exist in 4.7? what are the params?") are answerable by hybrid search without leaving the machine. `bun run typecheck` clean; `bun test` green (chunker + config suites extended).

- `allowedExtensions` += `.xml`, `.rst` (defaults in `src/config.ts`, so the generated `DEFAULT_CONFIG_YAML` picks them up; **live `~/.cidx/config.yml` overrides defaults — update it too**).
- `src/chunking/chunker.ts`: new exported `TEXT_LANG_BY_EXT` (`.xml`→`xml`, `.rst`→`rst`, `.json`→`json`, `.md`→`markdown`); `chunkCode` derives the language label as `EXT_TO_GRAMMAR[ext] ?? TEXT_LANG_BY_EXT[ext]` so fallback-chunked doc formats carry a meaningful `language` column and the `language` search filter works on them (grammar extensions unchanged; `.tscn`/`.tres`/`.gdshader`/`.godot` deliberately stay unlabeled).
- No grammar added by design: any new grammar must pass the interleaved-determinism suite (see [`architecture.md`](./architecture.md)), and docs need search, not symbols — character fallback plus a label is the right weight here. Consequence: `find_symbol`/outline/deps return nothing for these files (expected).
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
- **Upgrade caveat:** the YAML `allowedExtensions` list **replaces** the default wholesale — an existing `~/.cidx/config.yml` must gain the new entries by hand, then the project reindexed, or Godot files are silently not collected.

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
- Solved via `.cidxignore` (excludes e.g. `tokenizers/`); a persistent `maxFileSizeBytes` guard is proposed later.

---

## v3 — Robustness & security review

End-to-end review after v2. Two serious data-consistency issues + several medium / low items fixed. `bun test` **31/31**; verified with temporary real-LanceDB smoke tests.

- 🔴 **Shrinking files left stale chunks** — `insertChunks` deleted by `id` (`${file}#${i}`); when a file shrank, high-index chunks lingered. Fixed: delete by **`filePath`**.
- 🔴 **Inaccessible directory wiped the index** — `indexDirectory` didn't guard `baseDir`; an empty file list triggered full cleanup. Fixed: `stat(baseDir)` guard → job errors, no cleanup.
- 🟠 **Watcher ignored `.gitignore` / `.cidxignore`** — `indexFile` checked only ext + mtime → flapping inconsistency. Fixed: watcher sets up the ignore matcher once.
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
- **`.gitignore` awareness** — `buildIgnore` applies `.gitignore` + `.cidxignore` + global (pulled forward from v2).
- **Test suite** — first working `bun test` suite (concurrency, registry, job-queue, chunker).

---

## v1 — clean rewrite on Bun

Phases 0–6 of the original design, all done: clean Bun skeleton + `bun:sqlite` meta store; async job queue (handler registry); index registry + project isolation; Control API + thin CLI; web-tree-sitter smart chunking + rich metadata + line numbers; batch / parallel embedding + content-hash cache + model metadata; extended MCP tool set; secure localhost binding.

> **What existed before (and was replaced):** a flat, single-threaded, blocking design — the server didn't open until the first index finished; the CLI only took a directory at startup (no work sent to a running server); no project / index concept (one mixed table); flat character-window chunking (split functions mid-way); sequential one-by-one embeddings. The old `src/` was removed entirely; only the proven logic (LanceDB flow, Ollama call, chokidar, ignore handling, mtime cache) carried over.
