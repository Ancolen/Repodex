# D1a — `check_docs`: deterministik doküman–kod uyum denetleyicisi (Tier-1)

## Context

Doküman-kod drift'i fark edilmeden birikiyor; bugün kontrol etmek için tam Claude oturumu + subagent'lar (300k–1M+ token) gerekiyor. Bu repoda yapılan doğrulama (throwaway prototip: 8 doküman, 3.038 backtick span, %58 mekanik kontrol edilebilir) Tier-1'i kanıtladı: **5 gerçek drift, adjuikasyon sonrası 0 FP**, ~1 sn CPU, 0 token. Kullanıcı kararları:
- Kapsam: **yalnız D1a (deterministik)** — Tier-2 (local LLM yargıç) D1b olarak `docs/proposals.md`'de bekleyecek; rapor şeması confidence/needsReview ile ona yer bırakır.
- Kullanım MCP-first; CLI yalnız CI/hook + döngü için. Deterministik = Ollama çağrısı YOK, byte-for-byte tekrarlanabilir.
- Repo'nun kendi proposal akışı: `docs/proposals.md` D1 girişi (doğrulama verisiyle) + status.md + features.md + changelog + CLAUDE.md **aynı iş içinde**.
- Doğrulamada bulunan 5 gerçek drift ilk commit'te düzeltilecek (sonraki "canlı çalıştırmada 0 bulgu" kabul kriterini dürüst kılar).

## Onaylanmış 5 gerçek drift (commit 1)

1. `CLAUDE.md:48` → `mergeWithDocLegs` hayali sembol (src'de yok; birleştirme `searchTable`/`searchTableText` içinde) — cümle gerçek mimariye göre düzeltilecek.
2. `CLAUDE.md:33` control-API listesi → `/pack`, `/apidiff`, `/impact`, `/doctor` (+ yeni `/doccheck` commit 4'te) eklenecek.
3. `README.md` "MCP tools" listesi (323'ten sonrası) → `get_context_pack`, `get_api_diff`, `get_change_impact` eksik (doğrulandı: liste `search_commits`'te bitiyor); CLAUDE.md'de de 10 tool adı geçmiyor.
4. CLAUDE.md docs listesi → `proposals.md` (+ `docs/README.md`) eklenecek.
5. (Prototipin 2 FP'si düzeltildi: grammar sayısı 16 doğru; job tipi yalnız `index` doğru — bulgu değil.)

## Mimari (doctor.ts katmanlama sözleşmesi)

- **`src/core/doccheck.ts` (yeni, pure ~1000-1200 satır)** — tüm deterministik motor. I/O yok; tüm girdi enjekte düz veri (`DocCheckState`); "bir kontrol kendi okuma hatasını asla crash'e çevirmez → `skipped` raporlar". Bölgeler: tipler → sabitler → çıkarım/sınıflandırma → occurrence tarayıcı → sınıf çözücüler → intent → skorlama → reverse coverage → rapor → `runDocCheck`.
- **`src/services/docfiles.ts` (yeni, fs ~130 satır)** — doküman keşfi + root listesi + manifest.
- **`src/core/index-manager.ts`** — `checkDocs(opts)` orkestrasyon + `docChunks` cache (lastIndexedAt-keyed).
- 8 katman: tool-defs → mcp → control-api → stdio-bridge (elle case!) → cli → format → index-manager.

### Proje çözümleme (getCallGraph deseni — kullanıcı MCP-first olduğu için positional değil opts)

`checkDocs(opts: DocCheckOpts)`: `path` verildiyse → `resolveProjectForFile(abs)`; `project` verildiyse → `registry.getIndex` (throw `Index not found:`); ikisi de yoksa tek proje varsa onu kullan, 0/2+ → açıklayıcı throw. MCP şemasında `project`/`path` opsiyonel, ikisinden biri gerekli (callgraph guard'ı).

### Saf modül API'si (özet — tam hali commit 2'deki proposals.md D1'e yazılacak)

```ts
// Tipler
export type SpanClass = "identifier"|"path"|"env"|"endpoint"|"cmd"|"flag"|"dep"|"kv"|"model-tag"|"config-path"|"composite"|"artifact"|"opaque";
export type RegionClass = "current"|"planned"|"historical"|"example";
export interface DocSpan { token; docPath; docRelPath; line; spanClass; region; parts?; skipReason?; example?; }
export interface DocFile { path; relPath; lines; fileClass: "current"|"historical"; suppressed: Set<number>; }
export interface DocCheckChunk { filePath; startLine; content; symbolName?; symbolType?; language?; }   // doc .md/.json satırları DIŞARI
export interface DocManifest { deps; devDeps; scripts; }        // package.json'dan
export interface DocSymbol { symbolName; symbolType; filePath; relativePath; line; content; }  // reverse-coverage adayları (engine filtreli)
export interface DocCheckState { project; projectRoot; docs: DocFile[]; chunks; repoFiles: Set<string>; rootNames: Set<string>; manifest; exportedSymbols: DocSymbol[]; lastIndexedAt; }
export interface DocCheckOpts { project?; path?; files?; ignore?; limit?; maxChars?; undocumentedLimit?; noUndocumented?; since?; window?; }
export interface DocFinding { id: "D-<n>"; kind; confidence; category: "drift"|"suspected"|"review"; doc:{path,line,excerpt}; message; suggestion?; evidence?: DocEvidence[]; }
export interface DocCheckReport { project; checked:{docs[],docsUnreadable,spans,claims,indexFreshness,truncated,window?,skipped?}; verdict:{consistent,findings,needsReview,undocumented}; findings; needsReview; undocumented: UndocumentedEntry[]; omitted; maxChars; notes: string[]; }

// Ana fonksiyonlar
export function buildDocCheckIndex(chunks): DocCheckIndex;   // symbolNames + constants(const X="y") + relPaths + perFileSymbols
export function scanDocTokens(chunks, tokens): Map<string, DocEvidence[]>;  // buildNameRegex tarifi (deadcode.ts:169-246), NAME_REGEX_CAP gruplu TEK geçiş
export function classifySpan(token): { spanClass; skipReason?; parts? };
export function extractDocSpans(file: DocFile): DocSpan[];
export function checkSpan(span, state, hits): SpanVerdict;
export function demoteByIntent(span, verdict): SpanVerdict;
export function toFinding(span, verdict, seq): DocFinding | null;
export function collectUndocumented(state, mentioned, limit): UndocumentedEntry[];
export function runDocCheck(state, opts?): DocCheckReport;   // senkron boru hattı
export function editDistance(a,b); normalizeIdent(s); similarity(a,b); suggestNearest(token, candidates);
```

### Sınıf kapıları (prototipten taşınan, doğrulanmış kurallar)

- **identifier**: skip `/^[a-z]{1,7}$/`, `ACRONYMS`, `/^[A-Z0-9]{1,3}$/`. Varlık = `symbolNames` ∪ whole-identifier occurrence (hits) ∪ **sabit tablosu** (`INDEX_JOB="index"` dersi). Noktalı `a.b`: tam → son segment → tüm segmentler. Yoksa fuzzy komşu (normalize+Levenshtein, sim ≥0.6) → "renamed?" önerisi; önerisiz 95, önerili 92.
- **path**: (a) root-rel, (b) `src/` önek, (c) doc-relatif, (d) relPaths'te benzersiz suffix; çoklu suffix → `suspected` 70 (kanıt: adaylar); glob 0 eşleşme → `suspected` 85 (aspirasyon — asla hard drift); `./cidx.yml` → config-literal skip; `dist|build|...` → artifact skip.
- **env**: root dosyası (LICENSE/NOTICE) → external liste/prefiks (CUDA_*, OLLAMA_…) skip → hits → sabit tablo → drift 95.
- **endpoint** (`VERB /route`): her literal segment hits'te (`:param` hariç) → yoksa drift 93.
- **cmd/flag**: `bun run X` → manifest.scripts; `bun run src/cli.ts <cmd>` → yol repoFiles + cmd hits; `cidx <cmd>` → cmd hits (generic); `--flag` → EXTERNAL_FLAGS skip → hits → drift 92.
- **dep**: `@scope/pkg[@ver]` → package.json; sürüm prefix uyuşmazlığı → `suspected` 80 (asla drift); yok → drift 95.
- **kv/model-tag/config-path**: anahtar/segment occurrence; config-path bulunamazsa `suspected` 85 (en FP'ci sınıf — bilinçli).
- **composite** (`yol → sembol`): yol + `perFileSymbols` üyeliği; sembol yoksa drift 94.
- **Reverse coverage (generic)**: `detectExported` + findDeadCode ön-filtresi (test/entry-point düşümü), 2000 aday cap, doküman korpusunda hiç geçmeyenler → `undocumented` (confidence 40, `review`), cap 25, `noUndocumented` ile kapatılır. Hard bulgu DEĞİL.

### Intent sınıflandırması (FP önleme — doğrulamanın ana dersi; `demoteByIntent`)

- Dosya sınıfı: `HISTORICAL_FILE_RE` (changelog/changes/release-notes/history) → `historical` (span/claim sayılır, bulgu ÜRETMEZ).
- Bölge sınıfı: `PLANNED_HEADING_RE` (proposed|planned|not yet built|in progress|💡|🚧) başlığından sonraki satırlar → `planned` (bulgu değil, `verdict:"planned"`); fenced kod blokları → `example`.
- Prose örnekleri (`getUserNme`, `_private`, `a/b.py` — `isProseExample` heuristiği) → `needsReview`, asla findings.
- Baskılama: satır içi `<!-- cidx-doccheck-ignore -->` (kendi + sonraki satır) + `.cidx.json → doccheck.ignore`.
- **Sert kural (`toFinding` içinde kodlanır):** yalnız total-çözümlü sınıfların (identifier/path/dep/endpoint/cmd/env) `missing`'i `drift` (confidence ≥90) olur; her şüphe → `needsReview` (<90). "Emin değilsen bulgu deme."

### Drift penceresi (engine tarafı — git I/O)

`since` (ref VEYA tarih: `safeGitRef`+`gitRefExists` → yeni `gitCommitTimeAt`; çözülmezse note + tam tarama) veya `window: true` (kontrol edilen dokümanların **max** son-commit zamanı — `searchGitLog(path, limit:1)`). `codeChanged` = `searchGitLog({withFiles:true, since:"@<epoch>", limit:1000})` birleşimi. Filtre: bulgu kalır ise doc dosyası `docsChanged`'da **veya** kanıt dosyası `codeChanged`'da. `checked.window` + degradasyon `notes[]`'a yazılır (sessiz tam tarama yok).

### Doc keşfi (`src/services/docfiles.ts`)

`collectDocFiles(baseDir, {files, ignore})` — fs yürüyüşü + **`buildIgnore`/`isPathIgnored` yeniden kullanımı** (indexer.ts:51/58; fork yok), yalnız `.md/.mdx`; varsayılan `["*.md", "docs/**/*.md"]` (root-anchored); cap: depth 6 / 200 dosya / `truncated` yüzeyde. `listRootFiles` (root basenames), `readProjectManifest` (package.json deps/devDeps/scripts; bozuk → boş kayıt). Path-claim'lerin repo dosya listesi = `registry.listCachedFiles(name)` (absolute) ∪ doc dosyaları ∪ root listesi — ikinci walk yok.

### Config

- `config.ts`: `doccheck: { maxChars: 12000, undocumentedLimit: 25 }` → `DEFAULTS` + `DEFAULT_CONFIG_YAML` + `RESOLVED` (`DOC_CHECK_MAX_CHARS`/`DOC_CHECK_UNDOCUMENTED` env) + `CONFIG`.
- `project-config.ts`: `ProjectConfig.doccheck?: { files?: string[]; ignore?: string[] }` — embedModel dalından sonra **aynı bağımsız doğrulama deseni**; `doctor.ts`'deki iki hint string'i ("languages, ignore, embedModel" sayan) güncellenmeli — kolay kaçan dokunuş.

### `applyBudgetBySize` (`src/utils/budget.ts`)

`applyCharBudget` yalnız content/context ölçtüğü için generic boyutlu bütçe gerekli: `applyBudgetBySize<T>(rows, maxChars, sizeOf): { kept, omitted }` — aynı disiplin (ilk giriş her zaman kalır, kalanlar `omitted`, unset/≤0 → no-op). `applyCharBudget` DOKUNULMAZ (arama davranışı değişmez).

### `gitCommitTimeAt` (`src/services/git.ts`)

`git show -s --format=%at <ref>` → epoch ms; `safeGitRef` guard'lı, 10s, null-dönüş (throw yok) — drift penceresi için tek küçük ekleme.

## Kablolama (dosya-dosya, 7964df9 sırası)

1. **tool-defs.ts**: 17. giriş `check_docs` — `project?`/`path?` (callgraph guard), `since`, `window`, `files[]`, `ignore[]`, `limit`, `maxChars`, `noUndocumented`, `undocumentedLimit`. Açıklamada: deterministik (LLM yok), sınıf listesi, "şüphede needsReview" sözleşmesi, FRESHNESS uyarısı (indeks ~1-2 sn geride — az önce yeniden adlandırılan sembol drift sanılabilir).
2. **mcp.ts**: `if (name === "check_docs")` bloğu (get_change_impact'ten sonra) — arg cast + guard + `typeof`/`Array.isArray` kopya + `formatDocCheck` + `Doc-check error:` catch.
3. **control-api.ts**: `POST /doccheck` (`/impact` ile `/shutdown` arası) — 400 guard'lar, 404 "Index not found" için (/deadcode deseni).
4. **stdio-bridge.ts**: `case "check_docs"` **elle** (`default`'tan önce) — `api("POST","/doccheck",{…her arg…})` + `ok(formatDocCheck(...))`. Arg adları tek tek kopyalanır (sessiz düşme riski).
5. **cli.ts**: `cmdDoccheck(positionals, flags)` (cmdImpact sonrası) — positional `existsSync` → path, değilse project (callgraph deseni); flag'ler `--since --window --files a,b --ignore a,b --limit --max-chars --no-undocumented`; dispatch `doccheck|check-docs|checkdocs`; COMMANDS + printHelp örnekleri; **exit 1 yalnız `findings.length > 0`** (doctor kuralı).
6. **format.ts**: `formatDocCheck(r): string` — başlık (proje, doc/span/claim sayıları, `index: <iso|never>`), `### drift (n)` / `### needs review (n)` / `### undocumented (n)` bölümleri, bulgu satırları (id, `[conf]` kind, `doc:line`, excerpt, message, suggestion, evidence), `(checked …)` footer, `⚠` truncation satırları, boş korpus mesajı. MCP+bridge+CLI ortak (formatImpact deseni).
7. **index-manager.ts**: import'lar + `DocChunkCacheEntry` tipi (CallGraphCacheEntry yanına, ~402) + `docChunkCache` alanı (~539) + `removeIndex` geçersiz kılma (~681) + `docChunks(rec)` özel toplayıcı (`buildImportGraph` sonrası ~1750; anahtar `${name}\0${lastIndexedAt ?? "never"}`, rebuild `tableSymbolsWithContent`, **`.md/.json/.xml/.rst` satırları DÜŞÜR** — doküman iddiası başka dokümanla kanıtlanamaz; `truncated = rows ≥ 200000`) + `checkDocs` metodu (`indexSurface` sonrası ~2110, restore bölgesinden önce) + `export type { DocCheckReport, DocFinding }` re-export. Reverse-coverage envanteri findDeadCode döngüsüyle aynı: `(symbolName, filePath)` dedup, test/entry-point düşümü, `detectExported`.
8. **Not**: `checkDocs` "appended regions only" kuralına uyar; mevcut metotlara dokunmaz.

## Test planı — `tests/doccheck.test.ts` (~32 test)

Kural: factory-with-overrides (`doctor.test.ts` deseni), sentetik chunk/doc fixture, daemon/Ollama yok; tek `mkdtemp` bloğu (doc yürüyüşü, `project-config.test.ts` deseni); engine testleri `tests/apidiff.test.ts` öncüü (dinamik import + `CONFIG.DB_DIR` guard + temp tablo + `setFileMtime`).

- `extractDocSpans / classifySpan`: sınıf sınıflandırma tablosu; kısa/akronym/1-3-ALLCAPS kapıları; satır sırası + line numaraları; fenced-blok `example` bölgesi; `cidx-doccheck-ignore` (kendi + sonraki satır); planned başlık bölgesi; `docFileClass` changelog=historical.
- `buildDocCheckIndex + scanDocTokens`: whole-identifier süperstring vurmaz (getUser ≠ getUserName); bildirim satırı varlık sayar; `.md` chunk'ları kanıt OLMAZ; sabit tablosu (INDEX_JOB); NAME_REGEX_CAP gruplu tarama — cap ötesi sessiz düşmez; evidence cap + file:line.
- `checkSpan` sınıf bazlı: tanım-setinden ve occurrence'dan çözümleme; fuzzy "renamed?" önerisi; yol çözümleme sırası (root/src/relatif/suffix); belirsiz suffix → suspected; glob/artifact/config-literal; env üç kademeli; endpoint segment; cmd (scripts / src/cli.ts alt komut / cidx occurrence); flag external; dep (deps/devDeps/sürüm-prefix); composite ikisi de / yarı.
- `intent + skorlama`: historical dosyadan 0 bulgu; planned bölgesi bulgu değil; prose örneği needsReview'de; drift her zaman ≥90; ID'ler doc-sırası, sıralama karalı; bütçe (ilk bulgu korunur, kalanı omitted).
- `undocumented`: export'lu ama dokümanda geçmeyen → cap'li review; geçen raporlanmaz; noUndocumented kapatır; test/entry-point yok.
- `docfiles` (mkdtemp): varsayılan set kök *.md + docs/**; .github/node_modules/ignored atlanır; `files`/`ignore` etkisi; 200 cap → truncated.
- `IndexManager.checkDocs` (temp LanceDB+Registry): `Index not found` throw; gerçek drift + needsReview + indexFreshness birleşimi; `window:true` filtresi + `checked.window`; .md'siz proje → geçerli boş rapor + note.

## Docs (aynı iş içinde — repo konvansiyonlarıyla)

- **proposals.md**: yeni `## Documentation` bölümü + `### D1. check_docs — deterministik doküman–kod uyum denetleyicisi` (motivation/design/files/risks/acceptance) + tabloya D1 satırı + **doğrulama verisi** (3.038 span, %58, 5 gerçek drift, 0 FP). Ship'te tek satır tombstone'a inceltilir.
- **status.md**: banner (satır 5) Unreleased listesine D1 + yeni test sayısı; `### Code intelligence` altına ✅ Done bullet'ı (C1/C2 yoğunluğunda); 💡 Proposed tablosu iş sırasında D1 satırı taşır, ship'te düşer.
- **features.md**: `## Code intelligence` altına `check_docs` bölümü; `## MCP tools` listesine 17. satır; CLI özetine `doccheck`; `.cidx.json` bölümüne `doccheck` bloğu.
- **changelog.md**: `## Unreleased` üstüne `### check_docs — doc–code conformance checker (proposal D1)` + `####` alt bölümler (checker / docfiles / intent dersi / engine / 8 katman / Tests) + typecheck/test-sayısı açılış cümlesi.
- **CLAUDE.md**: endpoint listesine `/doccheck` (+ drift düzeltmeleri); Code-intelligence paragrafına `check_docs` özeti (saf `src/core/doccheck.ts`, `src/services/docfiles.ts`, `doccheck` bloğu, lastIndexedAt cache'i, "deterministik — Ollama yok", "drift ≥90 / şüpheli → needsReview"); Commands bölümüne `cidx doccheck`.
- **README.md**: MCP tools listesine `check_docs` satırı + CLI komut listesine `doccheck`. **docs/README.md**: test sayısı tazeleme.

## Commit bölünmesi (kullanıcı kuralı: küçük, konu başlıklı)

1. **`docs: fix the doc–code drifts found by the D1 prototype`** — 5 düzeltme (kod yok). Sonraki "0 bulgu" kriterini dürüst kılar.
2. **`docs(proposals): D1 — check_docs design`** — proposals.md D1 (tam tasarım + doğrulama verisi) + status.md 💡 satırı (576292c öncüü).
3. **`feat(doccheck): pure engine — span extraction, classification, per-class gates`** — doccheck.ts, docfiles.ts, project-config.ts (+doctor hint'leri), config.ts, budget.ts, git.ts, testlerin saf+fs kısmı.
4. **`feat(doccheck): wire check_docs through all 8 layers + tests`** — index-manager.ts, tool-defs.ts, mcp.ts, control-api.ts, stdio-bridge.ts, cli.ts, format.ts, kalan testler (7964df9 mesaj stili).
5. **`docs(doccheck): changelog/features/status + D1 tombstone`** — kalan docs + test sayısı tazeleme.

Her commit `Co-Authored-By: Claude Code <noreply@anthropic.com>` ile biter; 3-4 tipcheck+test sayısıyla.

## Doğrulama

1. `bun run typecheck` (strict, clean).
2. `bun test` — yeşil, yeni sayı (~518-528 hedef); status.md:5 + docs/README.md sayıları güncellenir.
3. **Canlı:** `bun run src/cli.ts doccheck .` → drift-fix commit'inden sonra **0 drift bulgusu** (`verdict.consistent === true`), needsReview/undocumented dolu.
4. **MCP smoke:** daemon çalışırken `POST /doccheck` JSON döner; `tools/list` 17 tool; `tools/call check_docs` formatDocCheck metni döner.
5. **Çıkış kodları:** consistent → 0; drift bulgusu → 1 (doctor kuralı, --help'te belgelenir).
6. Yol sınırı: hiçbir yerde Ollama çağrısı yok; şema değişikliği/reindex yok; `tableSymbolsWithContent` cache'i lastIndexedAt'ta.

## Riskler

- **FP'ler ürünün kendisi:** intent katmanı yük taşıyıcı — yanlış historical/planned/example sınıfı UX hatası. Savunma: prototipten doğrulanmış kapılar + drift⇒≥90 kuralı + ignore-marker kaçış kapağı.
- **İndeks tazeliği drift sanılır:** az önce yeniden adlandırılan sembol ~1-2 sn eksik görünür. Savunma: `indexFreshness` + tool açıklamasında FRESHNESS + drift penceresi.
- **Yol çözümleme eksik-yanlı:** çözümleme indexlenmiş dosya seti + root listesi üzerinde; gitignore'lu kaynak dosyası "yok" okur → suffix belirsizliği `suspected`'a düşer, sınırlama tool açıklamasında.
- **lastIndexedAt null** (indekslenirken): cache anahtarı bozunur → `indexFreshness` yüzeylenir; indeksleme-durumu bloklaması yapılmaz (callgraph semantiği).