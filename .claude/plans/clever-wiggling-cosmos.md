# Repodex 2.10.0 — Denetim Bulgularının Uygulama Planı

## Bağlam

2026‑11‑22 tarihli oturum denetimi (111 oturum, 1.010 MCP çağrısı, 124 CLI komutu) şu açık sorunları gösterdi:

- Artımlı sync/watcher yazmaları mevcut FTS/ANN indekslerine girmiyor; canlıda `llm-lab` BM25 **0/41.574**, `llm-lab-1` 375/9.258, `hackerai` 0/160, `Repodex` 2.089/2.804, `unsloth` %66, `horizon` %81 kapsam. Hibrit arama sessizce vektör‑only'ye düşüyor.
- Otomatik bakım yok: compact/VACUUM manuel; `meta.db` 957,5 MB, ~741 MB'ı boş sayfa.
- Embedding backend koptuğunda cidx dosya dosya deniyor; 27 saatlik sessiz kesinti ve yüzlerce "failed file" yaşandı.
- `check_docs` şeması "project opsiyonel" diyor, kod her durumda anchor istiyor.
- `search_codebase` girdi doğrulaması yok (`queries` verilince `query.trim` çökmesi).
- `INDEX_WAIT_MS = 120 sn` istemci timeout'uyla aynı; `get_index_status` polling'i 14 ardışık çağrıya çıkıyor.
- Aynı path iki adla indexlenebiliyor; iç içe indeksler içeriği duplike ediyor.
- Proje taşınınca index sessizce küçülüp "ready" kalıyor.
- `check_docs` `maxChars` iki ayrı bütçe olarak uygulanıyor (12k istenip 37k dönebiliyor).
- `cidx --help` / `-h` "Unknown command" + exit 1.
- `stats` Yuxor'da `vector` satırını iki kez basıyor (gerçekten iki native indeks var).
- Kullanıcının 25 Ekim'deki kullanım/token‑tasarruf analitiği isteği karşılanmadı.

**Hedef:** Bunların tamamını öncelik sırasıyla düzeltmek; her mantıksal birimde test + doküman + commit; sonunda tek `v2.10.0` release.

## Alınan ürün kararları

1. **İç içe indeksler:** Üst indeks, altında kayıtlı proje köklerini otomatik dışlar (umbrella indeksler çalışır, duplike yok).
2. **Otomatik bakım:** Varsayılan **açık**, eşikli. Sync sonrası unindexed oran > %5 veya küçük fragment eşiği aşılırsa `optimize()`; açılışta boş sayfa oranı > %30 ise `VACUUM`.
3. **Taşınan proje:** Yalnızca tespit + `note`/uyarı; `cidx move` komutu yok.
4. **Kullanım analitiği:** Minimal — tüm MCP/Control‑API araç çağrıları, tahmini dönen token ve "tam dosya okumaya karşı" tasarruf tahmini; `cidx stats --usage` + `GET /usage`.

## Uygulama disiplini (her faz için)

1. Kodu yaz → `bun run typecheck`.
2. İlgili testleri ekle/güncelle → hedefli `bun test`, gerekirse integration.
3. `docs/changelog.md` (Unreleased), `docs/features.md`, `docs/status.md`, gerekiyorsa `CLAUDE.md`/`README.md` güncelle.
4. Tek mantıksal commit at (Conventional Commits, code+tests+docs birlikte).
5. Ancak testler yeşilse sonraki faza geç.

---

## Faz 1 — Registry sertleştirme + boot VACUUM

**Amaç:** `SQLITE_BUSY` sınıfını kapatmak ve `meta.db` şişkinliğini otomatik geri kazanmak.

**Değişiklikler**
- `src/core/registry.ts`
  - Constructor (`:203-211`): `PRAGMA busy_timeout = 5000` ekle; `migrate()` sonrası `maybeVacuum()` çağır.
  - `RegistryOptions` ikinci argüman: `{ vacuum?: boolean; vacuumFreeRatio?: number; vacuumMinBytes?: number }`; mevcut `new Registry(path)` çağrıları değişmez.
  - `metaStats()` → `pageCount`, `freelistCount`, `pageSize`, `freeRatio`, `fileBytes`.
  - `maybeVacuum()`: `fileBytes < vacuumMinBytes` ise atla; `freeRatio < vacuumFreeRatio` ise atla; `statfsSync` ile boş disk kontrolü; `wal_checkpoint(TRUNCATE)` → `VACUUM` → `wal_checkpoint(TRUNCATE)`; hata boot'u düşürmez, loglanır.
  - `close()` öncesi `wal_checkpoint(TRUNCATE)` (try/catch).
- `src/config.ts`: `maintenance.vacuumFreeRatio` (0.30), `maintenance.vacuumMinBytes` (50 MB); env `META_VACUUM_FREE_RATIO`, `META_VACUUM_MIN_BYTES`; `DEFAULT_CONFIG_YAML` yorumları.

**Testler**
- `tests/registry.test.ts`: büyüt + sil → freelist oluştur; `vacuumFreeRatio: 0.1, vacuumMinBytes: 0` ile yeniden aç → `freelistCount` düşer; `vacuum:false` atlar; küçük DB varsayılanla atlanır.
- `tests/config.test.ts`: env parse.

**Doküman:** changelog/features/status + `CLAUDE.md` "VACUUM runs at boot, before servers, with ratio/disk guards".

**Commit:** `feat(registry): vacuum meta.db at boot when free pages dominate`

**Kabul:** `bun test tests/registry.test.ts tests/config.test.ts`; canlıda `du -h ~/.cidx/meta.db` restart öncesi/sonrası.

---

## Faz 2 — FTS/ANN kapsam onarımı + otomatik maintenance

**Amaç:** Her başarılı index/sync sonunda indeksler tüm satırları kapsasın; tamamen ölü indeks (0 indexed row) yeniden kurulsun.

**Değişiklikler**
- `src/services/db.ts`
  - `IndexCoverageReport` + `indexCoverage(table)`: `tableStats` desenini kullan; `indexStats().numIndexedRows / numUnindexedRows` (metadata; satır taraması yok).
  - Aynı kolonda birden fazla indeks varsa **en iyi kapsamı** al, toplama yapma.
  - Gerekli kolonlar: `content`; `vector`/`doc_vector` yalnızca `rows >= VECTOR_INDEX_THRESHOLD` ve kolon varsa. Opsiyonel `doc`, `id_terms`, `symbolName` yalnızca indeks varsa.
  - `ensureVectorIndex` (`:867`): mevcut indeks varsa erken dönme; `indexStats().numIndexedRows === 0 && rows > 0` ise `t.createIndex(column, { replace: true })` ile yeniden kur (`replace` LanceDB 0.30'da mevcut; node_modules'te doğrulandı).
  - `ensureFtsIndex` (`:909`): aynı "0 indexed row" onarımı `content` + opsiyonel `doc`/`id_terms`/`symbolName` için; opsiyonel ayakların try/catch'i korunur.
- `src/core/index-manager.ts`
  - `runIndexJob` (`:3760-3812`): `indexDirectory` döndükten ve sayaç/model pinleri yazıldıktan **sonra, `setIndexStatus("ready")`'den ÖNCE** `maybeAutoMaintain(table, ctx)` çağır (watcher `isIndexing` boyunca defer'da kalsın).
  - `maybeAutoMaintain`: `CONFIG.AUTO_MAINTENANCE` kapalıysa çık; `indexCoverage` al; `gapRatio > CONFIG.AUTO_MAINTENANCE_UNINDEXED_RATIO` veya `numSmallFragments >= CONFIG.AUTO_MAINTENANCE_MIN_SMALL_FRAGMENTS` ise `ctx.updateProgress(total,total,"optimizing indexes")` + `compactTable(table)` **doğrudan**. `compactIndex` kullanma (busy guard kendi işini reddeder). `cleanupOlderThan` verme (native 7 gün korunur). Hata job'u düşürmez, loglanır.
  - İptal (`ctx.signal.aborted`) ise maintenance atlanır.
- `src/config.ts`: `maintenance.auto` (true), `maintenance.unindexedRatio` (0.05), `maintenance.minSmallFragments` (20); env `AUTO_MAINTENANCE`, `AUTO_COMPACT_UNINDEXED_RATIO`, `AUTO_COMPACT_MIN_SMALL_FRAGMENTS`.

**Testler**
- Yeni `tests/db-coverage.test.ts` (temp LanceDB, `tests/stats.test.ts` fixture deseni): indeks kur → indeksin arkasına satır ekle → `gapRatio > 0`; `compactTable` sonrası kapsam 0; 0 indexed row simülasyonunda `ensureFtsIndex` yeniden kurar.
- Yeni `tests/index-auto-maintain.test.ts` (Registry + JobQueue + stub embed, `tests/index-batch.test.ts` deseni): gap'li tabloda no-op sync sonrası kapsam düzelir; `AUTO_MAINTENANCE=false` atlar.
- `tests/config.test.ts`.

**Doküman:** changelog/features/status + `CLAUDE.md` invariant: "auto-maintenance runs inside the job, after ensure, via `compactTable`; never `compactIndex`; optimize after `indexDirectory` returns (no lock held)".

**Commit:** `feat(maintenance): auto-repair ANN/FTS coverage after index jobs`

**Kabul:** `bun run typecheck && bun test tests/db-coverage.test.ts tests/index-auto-maintain.test.ts tests/config.test.ts`; canlı `cidx sync llm-lab && cidx stats`.

---

## Faz 3 — Doctor ve stats kapsam uyarıları

**Amaç:** Mevcut boşluklar sync beklemeden görünsün; duplike/eksik indeksler net fix önerisiyle raporlansın.

**Değişiklikler**
- `src/core/doctor.ts`
  - `TableIndexInfo` (`:60-64`): `name?`, `indexedRows?`, `unindexedRows?`.
  - `projectFindings` (`:300-413`): gerekli kolonlarda en iyi kapsamı hesapla; `unindexedRatio > eşik` → `warn` ("run cidx compact / next sync auto-repairs"); aynı kolonda >1 indeks → ayrı `warn` (otomatik drop yok).
  - `DoctorPorts.settings` (`:776-813`): `autoMaintenanceUnindexedRatio`.
  - `status === "indexing"` iken kapsam uyarısı üretme.
- `src/server/control-api.ts` `doctorPorts` (`:57-110`): `tableIndices` çağrısı `indexStats` ile zenginleştirilsin.
- `src/core/stats.ts`: proje notlarına kapsam + duplike bilgisi; `StatsOpts` eşiği control-api'den `CONFIG.AUTO_MAINTENANCE_UNINDEXED_RATIO` alsın.

**Testler**
- `tests/doctor.test.ts`: `content 375/9258` → warn; duplike indeks → warn; `indexing` durumunda uyarı yok; kapsamsız indexStats → uyarı yok.
- `tests/stats.test.ts`: `>%5` gap → not; %4,7 gap → not yok.

**Doküman:** features/status/changelog.

**Commit:** `feat(doctor): warn about uncovered ANN/FTS indexes`

**Kabul:** `bun test tests/doctor.test.ts tests/stats.test.ts`; `cidx doctor`, `cidx stats`.

---

## Faz 4 — Embedding backend fail-fast

**Amaç:** Backend yokken dosya dosya saatlerce denemek yerine tek, eyleme dönük hata; tablo korunur.

**Değişiklikler**
- `src/services/embed.ts`: `isBackendUnavailableError(err)` — `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `fetch failed`, connect timeout. HTTP 503/"Loading model" **dahil değil** (mevcut şeffaf retry sınıfı).
- `src/services/indexer.ts`
  - Readiness bloğunu (`:664-682`) deleted-file cleanup'ın (`:638`) **önüne** taşı (collect sonrası, cleanup öncesi).
  - Backend down + `hasFilesToEmbed` + `failFast` → cleanup/write yapmadan eyleme dönük hata fırlat ("embedding backend unreachable at <url> after Ns; index preserved; run cidx doctor").
  - Ana döngüde art arda 3 connection-level hata → yeni dosya planlamayı durdur, hazır slice'ları commit et (cache sadece commit sonrası), sonra hata fırlat.
  - Backend down bilinirken retry pass'i atla.
- `src/config.ts`: `embedding.failFast` (true); env `EMBED_FAIL_FAST`.
- `install.sh` + `web-install.sh`: opsiyonel `EMBED_SERVICE` env'i; doluysa unit'e `Wants=$EMBED_SERVICE.service` + `After=$EMBED_SERVICE.service` ekle (varsayılan boş; başka kullanıcılara `llamacpp-eg2` hardcode edilmez).
- `docs/cpu-only-ops.md` + README install bölümü: knob dokümantasyonu.

**Testler**
- `tests/embed-backend.test.ts`: sınıflandırma.
- `tests/index-failures.test.ts`: ölü backend + failFast hızlı reddeder, cache yazmaz; mid-run circuit breaker; `EMBED_FAIL_FAST=false` eski davranış.
- `tests/config.test.ts`.

**Doküman:** features/changelog/status/README.

**Commit:** `fix(indexer): fail fast when the embedding backend is unreachable`

**Kabul:** `bun test tests/embed-backend.test.ts tests/index-failures.test.ts tests/config.test.ts`; manuel: llama-server durdur → `cidx sync <küçük proje>` hızlı hata → başlat → ready.

---

## Faz 5 — `check_docs` anchor guard'ının kaldırılması

**Amaç:** Tek indexli kurulumda `check_docs {}` şemadaki gibi çalışsın; çok projede mevcut anlaşılır hata korunsun.

**Değişiklikler**
- `src/core/index-manager.ts`: public `resolveDocCheckProject(project?, path?)` (mevcut private `resolveDocCheckTarget`'ı sarar).
- `src/server/mcp.ts:689-694`: guard'ı sil.
- `src/server/control-api.ts`: POST `/doccheck` (`:709-712`) ve GET `/doccheck/last` (`:759-762`) guard'larını sil; 404 etiketi için hedefi çöz (`opts.project ?? opts.path` yerine çözülen ad).
- `src/stdio-bridge.ts:586`: `if (!q) return fail(...)` kaldır; sorgusuz `GET /doccheck/last` gönder.

**Testler**
- `tests/project-scope.test.ts` veya yeni `tests/doccheck-scope.test.ts`: 0/1/2+/path.
- `tests/doccheck-watch.test.ts`: tek projede `lastDocCheckReport({})`.
- `tests/integration/control-api.test.ts`: POST `/doccheck` ve GET `/doccheck/last` anchor'sız.

**Doküman:** features/changelog/status.

**Commit:** `fix(doccheck): resolve the single indexed project when no anchor is given`

---

## Faz 6 — Arama girdisi doğrulaması

**Amaç:** `queries`'in tekli araca verilmesi veya string olmayan elemanlar açık hata döndürsün; `query.trim` çökmesi bitsin.

**Değişiklikler**
- `src/core/index-manager.ts`: `searchIndex`, `searchAll`, `getContextPack` → `typeof query !== "string"` guard'ı; `searchBatch` (`:1645`) → dizi ve her eleman string doğrulaması.
- `src/server/mcp.ts`: `search_codebase` (`:131-181`) eksik/boş string `query` reddi; `queries` varsa "use search_codebase_batch" mesajı. `search_codebase_batch` (`:202`) her eleman string.
- `src/server/control-api.ts`: POST `/search` (`:244`) tekli query guard'ı; batch (`:333-336`) zaten doğru.
- `src/stdio-bridge.ts`: iki MCP guard'ının aynısı (HTTP öncesi hızlı hata).
- `src/server/tool-defs.ts`: `query` ve batch `items` için `minLength: 1`; tekli aracın açıklamasına batch yönlendirmesi.

**Testler**
- Yeni `tests/search-validation.test.ts`: `undefined as any`, `42 as any`, `{queries:[...]}`; batch `["ok", 5]`.
- Integration: POST `/search` eksik → 400; MCP `search_codebase {queries}` → `isError`.

**Doküman:** features/changelog/status.

**Commit:** `fix(search): validate query strings instead of crashing`

---

## Faz 7 — Wait bütçesi + `get_index_status` wait

**Amaç:** Sunucu beklemesi istemci 120 sn timeout'unun altında kalsın; ajanlar polling yerine tek çağrıda sonucu alabilsin.

**Değişiklikler**
- `src/core/types.ts`: `INDEX_WAIT_MS = 90_000`; `INDEX_WAIT_MAX_MS = 110_000`.
- `src/core/index-manager.ts`: `waitForIndexSettle(name, wait?, timeoutMs = INDEX_WAIT_MS)` (clamp); `waitForAllSettle(timeoutMs)` tek deadline.
- `src/server/tool-defs.ts`: `get_index_status` → `wait`, `waitMs`.
- `src/server/mcp.ts` (`:327-361`): proje varsa `waitForIndexSettle`; yoksa `waitForAllSettle`; timeout notu.
- `src/server/control-api.ts`: GET `/indexes/:name` ve `/indexes` → `wait`/`waitMs`; `IndexView & { timedOut?: boolean }`.
- `src/stdio-bridge.ts` (`:436-446`): `wait`/`waitMs` forward.
- `src/cli.ts`: `cmdStatus(positionals, flags)`; `cidx status [name] --wait [--wait-ms n]`; help catalog.

**Testler**
- Yeni `tests/index-wait.test.ts`: settle, timeout, clamp, silinmiş proje, all-settle.
- Integration: `get_index_status {project, wait:true}`.

**Doküman:** features/changelog/status/README CLI tablosu.

**Commit:** `feat(mcp): add wait to get_index_status and keep waits under the client timeout`

---

## Faz 8 — Aynı path'in iki adla indexlenmesi

**Amaç:** Aynı path farklı adla indexlenince ikinci kayıt/tablo oluşmasın; mevcut proje yeniden kullanılsın.

**Değişiklikler**
- `src/core/registry.ts`: `getIndexByPath(dir)` (resolve edilmiş path eşleşmesi; birden fazlaysa en yeni); `listDuplicatePaths()` veya doctor'da gruplama.
- `src/core/index-manager.ts` `createIndex` (`:1042`): isim kontrolünden **önce** `getIndexByPath`; bulunursa logla ve `return this.reindex(existing.name)`.
- `pathOverlapWarning(baseDir, requestedName?)`: aynı path başka adla kayıtlıysa "path already indexed as 'x'; requested name 'y' ignored" uyarısı.
- `src/server/mcp.ts:375`, `src/server/control-api.ts:186-189`: `name` geçir.
- `src/core/doctor.ts`: global `duplicatePathCheck(indexes)`.
- `src/core/stats.ts`: proje notu.
- **UNIQUE constraint ekleme** — mevcut duplike kayıtlar migration'ı düşürür; temizlik sonrası ayrı iş.

**Testler**
- `tests/registry.test.ts`: `getIndexByPath`.
- Yeni `tests/duplicate-path.test.ts`: aynı path/farklı ad → tek kayıt, mevcut ad döner; uyarı metni.
- `tests/doctor.test.ts`, `tests/stats.test.ts`.

**Doküman:** features/changelog/status + `CLAUDE.md` invariant.

**Commit:** `fix(index): reuse an existing project for a duplicate path`

---

## Faz 9 — İç içe kayıtlı proje köklerinin dışlanması

**Amaç:** Üst/umbrella indeks, altında kayıtlı proje köklerini taramasın; ilk sync eski duplike satırları temizlesin.

**Değişiklikler**
- `src/utils/pathtools.ts`: `nestedRegisteredRoots(parent, records)` — kesinlikle içerideki, kendisi/aynı path olmayan resolve edilmiş kökler; `pathOverlapNote` metni güncellenir ("nested scopes are automatically excluded").
- `src/services/indexer.ts`
  - `IndexOptions.excludeRoots?: readonly string[]`.
  - `collectFiles(..., excludeRoots?)`: resolve edilmiş `Set`; kök dizinlere girme; `CollectStats.nestedExcluded`.
  - `indexDirectory`: `excludeRoots` geçir; deleted-file cleanup'ta bu kökler altındaki cache yollarını `nestedRemoved` say (shrink uyarısını yanlış tetiklemesin); `IndexResult.excludedRoots`/`nestedRemoved`.
- `src/core/index-manager.ts`
  - `nestedRootsFor(indexName, baseDir)` + cache; index-add/remove'da invalidate.
  - `runIndexJob`: bir kez hesapla, `indexDirectory`'ye geçir.
  - `ensureWatcher`: `excludeRoots: () => this.nestedRootsFor(...)`.
- `src/services/watcher.ts`: `WatchOptions.excludeRoots?: () => readonly string[]`; chokidar `ignored` predicate'inde diğer kontrollerden önce reddet.
- `buildIgnore`'a **dokunma** (yapısal dışlama, ignore deseni değil).

**Testler**
- `tests/pathtools.test.ts`: `nestedRegisteredRoots` + yeni uyarı metni.
- `tests/indexer.test.ts`: `collectFiles` excludeRoots.
- `tests/watcher-ignore.test.ts`: dışlanan alt kökte yazma yok sayılır, dışında indekslenir.
- Yeni `tests/nested-index.test.ts`: üst + alt kayıtlı; üst sync alt dosyaları tablodan/cache'ten temizler; not/log `nestedRemoved` bildirir.

**Doküman:** features/architecture/changelog/status + `CLAUDE.md` invariant.

**Commit:** `feat(indexing): exclude nested registered project roots from parent indexes`

---

## Faz 10 — Tek paylaşımlı `check_docs` `maxChars` bütçesi

**Amaç:** `maxChars` tüm rapor için üst sınır olsun; findings + needsReview + undocumented ayrı ayrı bütçelenmesin.

**Değişiklikler**
- `src/core/doccheck.ts` (`:2029-2041`): findings (limit'li) + needsReview (limit'li) tek `applyBudgetBySize` ile bütçele (findings önce); split; kalan bütçeyle undocumented; `undocSize` tahmini; tek "omitted by budget" notu; `verdict.undocumented` = kept sayısı.
- `src/server/tool-defs.ts`: `maxChars` açıklaması "shared across findings, needsReview, undocumented".
- `src/utils/budget.ts`: gerekiyorsa "remaining budget" yardımcısı (mevcut top-1-her-zaman-korunur davranışı korunur).

**Testler**
- `tests/doccheck.test.ts`: mevcut bütçe testi korunur; findings+needsReview+undocumented toplamı ≤ maxChars; omission notu üçünü sayar.
- `tests/budget.test.ts`.

**Doküman:** features/changelog/status.

**Commit:** `fix(doccheck): enforce one shared maxChars budget`

---

## Faz 11 — CLI help düzeltmeleri

**Amaç:** `cidx --help`, `cidx -h`, `<cmd> -h`, `cidx hotspot --help` çalışsın; alias'lar dispatch'ten kopmasın.

**Değişiklikler**
- `src/cli.ts`
  - `parseArgs` (`:18-37`): `-h`, `-v`, `-x value` tek dash flag'leri.
  - `main` (`:1844-1899`): `command === "--help" || "-h"` → `printHelp()`; unknown default'tan önce.
  - `COMMANDS.aliases`'tan `ALIAS_TO_COMMAND` map'i; `printCommandHelp` (`:1556-1569`) hardcoded ternary yerine map; `hotspots` alias'ına `hotspot` ekle; switch'teki tüm alias'lar map'te.

**Testler**
- `tests/cli-help.test.ts` (subprocess): `--help`, `-h`, `hotspot --help`, `help hotspot`, `ls --help`, exit 0.

**Doküman:** README CLI tablosu/changelog/status.

**Commit:** `fix(cli): handle --help/-h and hotspot aliases`

---

## Faz 12 — Taşınan/küçülen proje notu

**Amaç:** Beklenmedik dosya düşüşü sessizce sayıları ezmesin; kalıcı, eyleme dönük `note` yazılsın.

**Değişiklikler**
- Yeni `src/utils/shrink.ts`: saf `detectShrink({ beforeFiles, afterFiles, nestedRemoved, ratio, minFiles })`.
- `src/core/index-manager.ts` `runIndexJob`: başta `before = registry.getIndex(name)`; başarı dalında `adjustedBefore = max(0, before.fileCount - result.nestedRemoved)`; `noteParts`'a taşınma ipucu; `fileCount === 0` durumundaki sıfır-dosya açıklamasına da taşınma ipucu.
- `src/config.ts`: `indexing.shrinkWarnRatio` (0.5), `indexing.shrinkWarnMinFiles` (10); env.

**Testler**
- Yeni `tests/shrink-note.test.ts` (saf eşikler).
- `tests/index-batch.test.ts`: 20 dosya → çoğunu sil → sync → not; yalnız nested temizliği uyarı üretmez; temiz run notu siler.

**Doküman:** features/changelog/status + `CLAUDE.md` note semantiği.

**Commit:** `feat(index): warn when a sync shrinks a project unexpectedly`

---

## Faz 13 — Minimal kullanım/token analitiği

**Amaç:** Her araç çağrısını say; tahmini dönen token ve "dosyaları tam okumaya karşı" tasarrufu `cidx stats --usage` + `GET /usage` ile göster.

**Değişiklikler**
- `src/core/registry.ts`: `usage_log` tablosu (`ts, tool, project, ok, returned_chars, est_returned_tokens, est_avoided_tokens, latency_ms`), `recordUsage`, `countUsageLog`, `pruneUsageLog`, `usageStats` — `query_log` sözleşmesinin aynısı (asla throw etmez; `logSize <= 0` kapalı).
- Yeni `src/core/usage.ts`: `estimatePayloadChars` (text + structured, 200k cap), `estimateReturnedTokens` (chars/4), `uniqueFilePaths`, `estimateAvoidedTokens` (içerik döndüren araçlarda, ≤50 dosya, `stat(size)/4 - returned`, clamp ≥0).
- `src/core/index-manager.ts`: `recordToolUsage(...)`, `usageStats(opts)`.
- `src/server/mcp.ts`: mevcut `CallTool` gövdesini `dispatchTool(name, rawArgs)`'a çıkar; tek sarmalayıcıda başlangıç zamanı + `recordToolUsage`.
- `src/server/control-api.ts`: `express.json()` sonrası, yalnızca tool karşılığı route'lar için `CONTROL_ROUTE_TO_TOOL` map'li `res.json` sarmalayıcı (CLI + stdio bridge bir kez sayılır; MCP HTTP ayrı sunucu olduğu için çift sayım yok). `GET /usage?project=&days=`.
- `src/server/format.ts`: `formatUsageStats`.
- `src/cli.ts`: `cmdStats(positionals, flags)` + `--usage`, `--days`; `COMMANDS.stats` güncelle.
- `src/config.ts`: `usage.logSize` (20000), `usage.charsPerToken` (4); env.

**Testler**
- Yeni `tests/usage.test.ts`: estimator saf vakalar; registry record/prune/aggregate; kapalı mod.
- `tests/integration/control-api.test.ts`: arama sonrası `GET /usage`; batch → tek satır; MCP endpoint → `/usage` satırı (helpers'a `mcpUrl` ekle).

**Doküman:** features/changelog/status/README CLI + `CLAUDE.md` "local-only" invariant.

**Commit:** `feat(usage): record per-tool call analytics with token estimates`

---

## Faz 14 — `stats` duplike indeks satırlarının tekilleştirilmesi

**Amaç:** Yuxor'da `vector` iki kez basılmasın; çokluk `×2` ile açıkça gösterilsin.

**Değişiklikler**
- `src/services/db.ts`: `TableIndexStat` → `count?`, `indexNames?`; `tableStats` `listIndices()`'ı `columns.join("+")` ile grupla; en iyi kapsam; `count++`; duplike notu. Hiçbir indeks drop edilmez.
- `src/server/format.ts`: `formatIndexStat` `×${count}`.

**Testler**
- `tests/stats.test.ts`: iki vector indeksli fake native → tek satır `×2` + not; `tests/db-coverage.test.ts`.

**Doküman:** features/changelog/status.

**Commit:** `fix(stats): dedupe duplicate per-column index lines`

---

## Operasyonel faz — canlı veriyi onar, restart, doğrula

Repo değişikliği yok; tüm feature commit'leri yeşil olduktan sonra:

1. `bun run typecheck && bun test` (tam suite).
2. `cidx stop` → `systemctl --user restart cidx.service`; `cidx version`. Boot VACUUM sonrası `du -h ~/.cidx/meta.db` düştü mü?
3. Kapsam onarımı, tek tek (job bitişini bekle):
   ```bash
   for p in llm-lab llm-lab-1 hackerai Repodex unsloth horizon; do
     cidx sync "$p"; cidx status "$p"
   done
   cidx stats
   ```
   Gerekirse boşta `cidx compact <ad>`.
4. Umbrella/nested dışlama: `cidx sync projects` (varsa), `cidx stats`; `idx_projects`'ten nested worktree satırları düştü mü, `screen-companion`/`unsloth` duplikesi bitti mi?
5. Mevcut duplike path kayıtları (gamepad/gamepad-wt) varsa: `cidx list`, `cidx doctor`, kanonik olmayanı `cidx remove`, tekrar `doctor`.
6. Smoke: `cidx --help`, `cidx -h`, `cidx hotspot --help`, `cidx doccheck`, `cidx stats --usage`.
7. MCP smoke: `search_codebase {queries:[...]}` → açık hata; `get_index_status {project, wait:true}` → final/timeout notu; tek projede `check_docs {}`.
8. Outage drill: llama-server durdur → `cidx sync <küçük>` hızlı hata; başlat → `cidx sync` ready.
9. Canlı unit (repo dışı): `~/.config/systemd/user/cidx.service`'e `Wants=llamacpp-eg2.service` + `After=llamacpp-eg2.service` ekle (installer'lardaki `EMBED_SERVICE` knob'u belgeler).
10. `cidx doctor` fail/warn yok; test suite yeşil.

## Release fazı — v2.10.0 (tek commit)

- 5 sürüm taşıyıcısı: `package.json`, `src/server/mcp.ts`, `src/server/control-api.ts`, `src/stdio-bridge.ts`, `src/cli.ts` (`CLI_VERSION`).
- `docs/changelog.md`: `## Unreleased (2.10.0)` → `## 2.10.0 (tarih)`, Fixed/Added/Performance grupları + ölçülen canlı sonuçlar.
- `docs/status.md`: current release 2.10.0, Done'a taşı, test sayısını güncelle.
- `docs/README.md`, `README.md` (CLI tablosu: `stats --usage`, `status --wait`, help, `EMBED_SERVICE`), `CLAUDE.md` invariantları.
- Commit: `chore(release): v2.10.0`. Kullanıcı istemeden tag/push yok.

---

## Korunacak invariantlar (her fazda kontrol)

- **Lock:** tüm tablo yazmaları `lockTable`'dan; auto-maintenance `indexDirectory` döndükten sonra, lock tutulmuyorken `compactTable` çağırır. Lock callback'i içinden çağırma (deadlock).
- **İptal:** `signal.aborted` ise maintenance/cleanup yapılmaz; optimize iptal edilemez, veri geçerli kalır.
- **Idempotency:** kapsam onarımı ve optimize temiz tabloda no-op; VACUUM oran/disk guard'lı; nested dışlama deterministik.
- **exactOptionalPropertyTypes:** yeni opsiyonel alanlar koşullu atanır; `undefined` atanmaz.
- **Back-compat:** LanceDB şema değişikliği yok; mevcut duplike kayıtlar silinmez; mevcut YAML ezilmez; yeni config anahtarları kodda varsayılanlı.
- **Sürüm taşıyıcıları:** release commit'ine kadar dokunulmaz.
- **Gözlemlenebilirlik:** atlanan/başarısız maintenance tek satır log; sessiz başarısızlık yok.

## Doğrulama komutları

```bash
cd /home/duldul/Repodex
bun run typecheck
bun test
bun test tests/integration/control-api.test.ts
cidx doctor
cidx stats
cidx stats --usage
cidx --help; cidx -h; cidx hotspot --help
```
