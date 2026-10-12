/**
 * Doc–code conformance checking (proposal D1) — the PURE engine.
 *
 * Deterministic by contract: no Ollama, no LLM, no wall-clock, no fs/path
 * imports — every input is injected plain data (`DocCheckState`) and the same
 * input produces byte-for-byte the same report. The fs half (doc discovery,
 * root listing, manifest) lives in `src/services/docfiles.ts`; the daemon
 * orchestration (`IndexManager.checkDocs`) assembles the state.
 *
 * Semantics (the hard rule): a doc reference that a TOTAL-resolution class
 * (identifier, path, dep, endpoint, cmd, env) fails to resolve with confidence
 * ≥ 90 is reported as a `drift` finding; every residual doubt is demoted below
 * 90 and lands in `needsReview` instead. "Emin değilsen bulgu deme."
 *
 * Intent classification is the FP shield validated on this repo's own docs:
 * historical files (changelog), planned regions (proposals/roadmap headings)
 * and fenced examples never produce findings, only counters.
 *
 * Semantic judge (D1b): an optional judge is INJECTED as an async function
 * (`opts.judge`) — the engine itself still performs no I/O and never talks to a
 * model. With the judge undefined the report is byte-for-byte identical to the
 * deterministic run; with a fixed judge the run is deterministic too (verdicts
 * are applied per claim, keyed by input order). The judge only ever RESOLVES
 * uncertain claims: a high-confidence "consistent" verdict drops a claim out of
 * `needsReview` into `checked.judge.resolved`. It can never create a `drift`
 * finding, never fabricates evidence, and never touches the ≥ 90 drift rule.
 */
import { escapeRegExp } from "../utils/text";
import { detectExported } from "./exported";
import { DYNAMIC_HOOK_NAMES, NAME_REGEX_CAP } from "./deadcode";
import { DEAD_CANDIDATE_TYPES, isTestFile, isEntryPointFile } from "./filekinds";
import { applyBudgetBySize } from "../utils/budget";
import { mapWithConcurrency } from "../utils/concurrency";

// ------------------------------------------------------------------ types

/** What kind of claim a backtick span makes (drives the resolver). */
export type SpanClass =
  | "identifier"
  | "path"
  | "env"
  | "endpoint"
  | "cmd"
  | "flag"
  | "dep"
  | "kv"
  | "model-tag"
  | "config-path"
  | "composite"
  | "artifact"
  | "opaque";

/** Why a span was excluded from checking (all counted, none reported as a finding). */
export type SkipKind =
  | "artifact"
  | "external"
  | "historical"
  | "planned"
  | "example"
  | "generic";

/** Which region of a doc a span sits in. Only `current` spans can produce findings. */
export type RegionClass = "current" | "planned" | "example" | "historical";

/** Verdict of one checked span. `missing` with confidence ≥ 90 becomes a drift finding. */
export type VerdictStatus = "ok" | "missing" | "skipped" | "review";

/** One documentation file, split into lines (engine input — no fs in the engine). */
export interface DocFile {
  /** Project-relative posix path. */
  relPath: string;
  lines: string[];
  /** Historical files (changelog/release notes) are counted but never produce findings. */
  fileClass: "current" | "historical";
  /** 1-based line numbers carrying an inline suppression marker (and the line after). */
  suppressed: Set<number>;
}

/** A code chunk handed to the engine. `filePath` is project-relative posix — the engine does no path/fs work. */
export interface DocCheckChunk {
  filePath: string;
  /** 1-based line number of the chunk's first line. */
  startLine: number;
  content: string;
  symbolName?: string;
  symbolType?: string;
}

/** package.json facts the cmd/dep resolvers check against. */
export interface DocManifest {
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  scripts: Record<string, string>;
}

/** Reverse-coverage inventory entry (one candidate symbol). */
export interface DocSymbol {
  symbolName: string;
  symbolType: string;
  language: string;
  /** Project-relative posix path. */
  relativePath: string;
  /** 1-based declaration line. */
  line: number;
  content: string;
}

/** Where a doc token was seen in the indexed code (capped per token). */
export interface DocEvidence {
  /** Project-relative posix path. */
  path: string;
  /** 1-based line; omitted for set-membership evidence (e.g. a resolved path). */
  line?: number;
  /** The symbol/constant name that justifies the hit, when known. */
  symbol?: string;
}

/** Everything the engine needs, pre-assembled. Doc chunks must NOT be included in `chunks`. */
export interface DocCheckState {
  project: string;
  /** Absolute project root (informational only — the engine never touches it). */
  projectRoot: string;
  docs: DocFile[];
  chunks: DocCheckChunk[];
  /** Indexed source files, project-relative posix (the path-claim universe). */
  repoFiles: Set<string>;
  /** Basenames of files directly in the project root (package.json, LICENSE, …). */
  rootNames: Set<string>;
  manifest: DocManifest;
  /** Candidate symbols for reverse coverage (already (name,file)-deduped by the caller). */
  exportedSymbols: DocSymbol[];
  /** `IndexRecord.lastIndexedAt` (epoch ms), surfaced as `checked.indexFreshness`. */
  lastIndexedAt: number | null;
}

/** Options for the pure engine run (the caller fills daemon-side defaults). */
export interface DocCheckOpts {
  /** Max drift findings kept (they are confidence-sorted, not silently truncated). */
  limit?: number | undefined;
  /** Char budget over rendered findings (kept whole, first always kept). */
  maxChars?: number | undefined;
  /** Max `undocumented` entries. */
  undocumentedLimit?: number | undefined;
  /** Disable reverse coverage entirely. */
  noUndocumented?: boolean | undefined;
  /**
   * The injected semantic judge (D1b). Undefined → the deterministic run, no
   * `checked.judge` block, byte-identical output. Deterministic per claim with
   * a fixed judge; a throwing judge leaves its claim in `needsReview`.
   */
  judge?: DocJudge | undefined;
  /**
   * Model label surfaced in `checked.judge.model` (informational — the engine
   * never resolves a model itself). A non-empty value with NO injected judge
   * emits the block with `available: false` and zero counters, so a
   * configured-but-unavailable session stays honest in the report.
   */
  judgeModel?: string | undefined;
}

/**
 * The engine's verdict on one claim handed to the semantic judge: the claim,
 * what the deterministic pass concluded, and where it sits (all plain data).
 */
export interface DocJudgeClaim {
  /** The backticked token, trimmed. */
  token: string;
  spanClass: SpanClass;
  /** Class-specific decomposition when meaningful (endpoint [verb, route], kv [key, value], composite [path, symbol]). */
  parts?: string[];
  /** The deterministic verdict that left the claim unresolved. */
  status: "review" | "missing";
  /** The deterministic verdict's confidence (0–100). */
  confidence: number;
  /** Why the deterministic pass could not resolve it. */
  message?: string;
  /** A fuzzy rename suggestion, when one was found. */
  suggestion?: string;
  /** The partial evidence the deterministic pass did find (never fabricated by the judge). */
  evidence?: DocEvidence[];
  doc: { path: string; line: number; excerpt: string };
}

/** The judge's framing context: the project and the claim's own prose (±2 lines, each capped). */
export interface DocJudgeContext {
  project: string;
  surrounding: string[];
}

/** The judge's verdict on one claim. `null` = no opinion — the claim stays in `needsReview`. */
export interface JudgeVerdict {
  consistent: boolean;
  /** 0–1. `consistent` with ≥ `JUDGE_CONFIRM_MIN` resolves the claim. */
  confidence: number;
}

/**
 * The injected semantic judge (D1b). Must be side-effect-light, tolerate any
 * claim, and resolve honestly: the engine treats every outcome except
 * `{ consistent: true, confidence ≥ JUDGE_CONFIRM_MIN }` as "stays in
 * `needsReview` exactly as today".
 */
export type DocJudge = (
  claim: DocJudgeClaim,
  context: DocJudgeContext,
) => Promise<JudgeVerdict | null>;

/** One resolved span verdict (internal, before findings are materialized). */
export interface SpanVerdict {
  status: VerdictStatus;
  /** 0–100. Only `missing` with ≥ 90 becomes a drift finding. */
  confidence: number;
  message?: string | undefined;
  suggestion?: string | undefined;
  evidence?: DocEvidence[] | undefined;
  skipReason?: SkipKind | undefined;
  /** A prose-example guess — always routed to needsReview, never a finding. */
  proseExample?: boolean | undefined;
}

/** One extracted doc claim. */
export interface DocSpan {
  /** The backtick span, trimmed. */
  token: string;
  docRelPath: string;
  /** 1-based line in the doc. */
  line: number;
  spanClass: SpanClass;
  region: RegionClass;
  /** Class-specific decomposition (endpoint [verb, route], composite [path, symbol], kv [key, value]). */
  parts?: string[];
  /** Classification-level exclusion (artifact/external) — never checked. */
  skipReason?: SkipKind;
  /** The trimmed source line, capped (excerpt for the report). */
  excerpt: string;
}

/** A reported problem. `findings` (category drift) are the hard claims; everything else is advisory. */
export interface DocFinding {
  id: string;
  kind: SpanClass;
  confidence: number;
  category: "drift" | "suspected" | "review";
  doc: { path: string; line: number; excerpt: string };
  message: string;
  suggestion?: string;
  evidence?: DocEvidence[];
}

/** An exported symbol never mentioned anywhere in the checked docs (advisory, capped). */
export interface UndocumentedEntry {
  symbolName: string;
  symbolType: string;
  relativePath: string;
  line: number;
  confidence: number;
}

export interface DocCheckReport {
  project: string;
  checked: {
    /** Doc files inspected (readable ones). */
    docs: number;
    /** Doc files listed but unreadable (reported in `notes`). */
    docsUnreadable: number;
    /** All extracted spans (including skipped ones). */
    spans: number;
    /** Spans actually resolved against the index (ok or missing). */
    claims: number;
    /** Epoch ms of the index the evidence came from (null = never indexed). */
    indexFreshness: number | null;
    /** True when the doc set was capped (DOC_MAX_FILES) or rows hit the scan cap. */
    truncated: boolean;
    /** Present when a drift window was applied (set by the caller post-filter). */
    window?: { since: string; docsChanged: number; codeChanged: number };
    skipped: Record<SkipKind, number>;
    /**
     * The semantic judge (D1b) — present whenever the judge RAN or was
     * configured (`judgeModel` non-empty). Absent on the pure deterministic
     * path, so old reports stay byte-identical.
     */
    judge?: {
      /** The model label the caller configured ("" when the caller passed none). */
      model: string;
      /** False = configured but not available/injected this run — nothing was judged. */
      available: boolean;
      /** Claims the judge was asked about. */
      judged: number;
      /** Claims resolved as consistent with high confidence — dropped from `needsReview`. */
      resolved: number;
      /** Judge calls that threw — those claims stay in `needsReview` (also noted). */
      failed: number;
    };
  };
  verdict: {
    /** True iff there are zero drift findings. */
    consistent: boolean;
    findings: number;
    needsReview: number;
    undocumented: number;
  };
  /** Hard drift findings (confidence ≥ 90, total-resolution classes only). */
  findings: DocFinding[];
  /** Everything the engine is unsure about — explicitly NOT failures. */
  needsReview: DocFinding[];
  undocumented: UndocumentedEntry[];
  /** Items dropped whole by the char budget (never truncated mid-item). */
  omitted: number;
  maxChars: number | null;
  /** True when reverse coverage was turned off (`noUndocumented`) — the empty list means nothing then. */
  undocumentedDisabled?: boolean | undefined;
  notes: string[];
}

// --------------------------------------------------------------- constants

/** Evidence occurrences recorded per token (enough to point at the code). */
const MAX_EVIDENCE = 3;

/** Module-level constant literals extracted per run (the `const INDEX_JOB = "index"` lesson). */
const MAX_CONSTANTS = 2000;

/** Reverse-coverage candidate cap — beyond this the corpus is too big to advise on. */
const MAX_UNDOC_CANDIDATES = 2000;

/** Fuzzy "renamed?" suggestions require at least this similarity. */
const FUZZY_MIN_SIM = 0.6;

/** Max length of a token considered for fuzzy matching (DP cost guard). */
const FUZZY_MAX_LEN = 64;

/** Excerpt cap in characters. */
const EXCERPT_MAX = 160;

/** All-caps tokens ≤ this length are prose acronyms — skipped, not judged. */
const SHORT_ACRONYM_MAX = 3;

/** All-caps tokens up to this length that resolve nowhere are review, not drift. */
const PROSE_ACRONYM_MAX = 6;

// --------------------------------------------------- semantic judge (D1b)

/**
 * A judge verdict of `{ consistent: true }` needs at least this confidence to
 * RESOLVE a claim (drop it from `needsReview`). Anything lower — including a
 * high-confidence "inconsistent" — leaves the claim exactly as the
 * deterministic pass reported it: the judge refines advice, never accusations.
 * The ≥ 90 drift rule is untouched by construction.
 */
export const JUDGE_CONFIRM_MIN = 0.8;

/** Bounded parallelism for judge calls (local instruct model; rerank uses the same magnitude). */
const JUDGE_CONCURRENCY = 4;

/** How many doc lines the judge sees around a claim (±N, each capped). */
const JUDGE_CONTEXT_LINES = 2;

/** Per-line cap for the judge's surrounding context (a prose fragment, not the doc). */
const JUDGE_CONTEXT_LINE_MAX = 240;

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Build/dir artifacts a doc can reference without it being a source claim. */
const ARTIFACT_DIR_RE =
  /(^|\/)(node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.cache|\.venv|__pycache__|vendor)(\/|$)/;
const ARTIFACT_EXT_RE =
  /\.(min\.js|min\.css|map|lock|log|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp[34]|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|class|pyc|o|so|dll|exe|bin)$/i;

/** URLs (and any scheme) point outside the repo — external, never checked. */
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** npm-style dependency specifiers. */
const DEP_RE = /^(@[\w.-]+\/[\w.-]+|[\w][\w.-]*)@([\w.^~><=*+,-]+)$/;

/** CLI flags. */
const FLAG_RE = /^(-{1,2})([a-zA-Z][\w-]*)$/;

/** ALL-CAPS with an underscore → environment variable shape. */
const ENV_RE = /^[A-Z][A-Z0-9_]*$/;

/** Semantic versions are opaque claims (release docs bump them out of band). */
const SEMVER_RE = /^v?\d+(\.\d+)+$/;

/** `composite` claims: `path → symbol` (also plain `->`). */
const COMPOSITE_RE = /^(\S+)\s*(?:→|->)\s*(\S+)$/;

/** Binaries a doc's command lines are allowed to start with (everything else is prose). */
const CMD_BINS = new Set([
  "bun", "bunx", "npm", "npx", "pnpm", "yarn", "node", "deno", "tsx",
  "cidx", "repodex", "git", "godot", "ollama", "curl", "wget", "docker",
  "python", "python3", "pip", "pip3", "uv", "cargo", "go", "make", "cmake",
  "brew", "apt", "apt-get", "pacman", "systemctl", "ssh", "scp", "rsync",
  "tar", "jq", "yq", "grep", "sed", "awk", "find",
]);

/** Flags of external tools / generic CLI conventions — never a code claim. */
const EXTERNAL_FLAG_NAMES = new Set([
  "help", "version", "verbose", "quiet", "silent", "force", "yes", "dry-run",
  "watch", "all", "json", "no-color", "color",
]);

/** Environment variables that belong to the platform, not to the checked code. */
const EXTERNAL_ENV_PREFIXES = [
  "CUDA_", "NV_", "VK_", "GL_", "DISPLAY", "XDG_", "GIO_", "GTK_", "QT_",
  "DBUS_", "LC_", "LANG", "TERM", "SHELL", "USER", "LOGNAME", "PWD", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSH_", "GPG_", "WSL_", "WINDOWID",
  "PATH", "HOME", "EDITOR", "VISUAL", "PAGER", "MANPAGER", "BROWSER",
  // Ollama's own runtime knobs (OLLAMA_NUM_GPU, OLLAMA_GPU_LAYERS, …) — the
  // variables cidx itself reads always occur in code, so any OLLAMA_* name that
  // occurs NOWHERE is Ollama's, not ours.
  "OLLAMA_",
];

/** Files whose existence is optional by design — an absent config is not drift. */
const CONFIG_LITERALS = new Set([
  "cidx.yml", ".cidx.yml", "cidx.yaml", "config.yml", "config.yaml",
  ".env", ".npmrc", "tsconfig.json", "bunfig.toml",
]);

/**
 * Convention files a doc can name without it being a claim about THIS repo
 * (they belong to the projects the tool supports — e.g. every Godot project's
 * manifest, not this repo's).
 */
const CONVENTION_FILES = new Set(["project.godot"]);

/** A bare file-extension mention (`.md`, `.tscn`) is vocabulary, not an existence claim. */
const BARE_EXT_RE = /^\.[a-z0-9]{1,6}$/i;

/** Headings that open a `planned` region (spans under them are not claims yet). */
const PLANNED_HEADING_RE =
  /\b(proposal|proposals|proposed|planned|roadmap|not yet|in progress|todo|draft|wip|future)\b|💡|🚧|🏗/i;

/**
 * Historical files: everything in them already happened — never a current claim.
 * Proposal/roadmap files are the mirror image (everything in them is INTENDED, not
 * yet real), so they share the file class. Exported for the daemon-side DocFile
 * builder.
 */
export const HISTORICAL_FILE_RE = /(^|\/)(changelog|changes|release-?notes|history|proposals?|roadmap|drafts?)(\.|$)/i;

const IGNORE_MARKER = "<!-- cidx-doccheck-ignore -->";

/**
 * Prose doc artifacts are never EVIDENCE — a doc claim cannot prove another doc
 * claim. NOTE: `.json` is deliberately NOT here: tsconfig.json/package.json are
 * machine config whose keys are legitimate evidence (tsconfig compiler flags),
 * unlike the prose formats.
 */
const DOC_PATH_RE = /\.(md|mdx|xml|rst)$/i;

/** Known single-segment file extensions (path class without a slash). */
const KNOWN_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "kts",
  "swift", "scala", "sc", "rb", "php", "cs", "c", "cc", "cpp", "h", "hpp", "gd",
  "gdshader", "md", "mdx", "json", "yml", "yaml", "toml", "xml", "rst", "txt",
  "sh", "bash", "zsh", "bat", "ps1", "sql", "html", "css", "scss", "vue",
  "svelte", "tscn", "tres", "godot", "wasm", "lockb",
]);

const ACRONYMS = new Set([
  "MCP", "RRF", "FTS", "ANN", "LSP", "API", "CLI", "HTTP", "HTTPS", "JSON",
  "YAML", "TOML", "XML", "SQL", "SSE", "URI", "URL", "SDK", "NPM", "GIT",
  "CPU", "GPU", "RAM", "VRAM", "MMR", "TTL", "UTC", "PID", "WASM", "AST",
  "DOM", "IDE", "UI", "UX", "AI", "LLM", "MCP", "SSH", "SSL", "TLS", "TCP",
  "UDP", "DNS", "RPC", "CRUD", "IEEE", "ASCII", "UTF", "POSIX", "EOF", "TODO",
]);

// ------------------------------------------------------------ tiny helpers

/** Lowercase and drop separator characters, so `getUser_name` ≈ `getUserName` ≈ `get-user-name`. */
export function normalizeIdent(s: string): string {
  return s.toLowerCase().replace(/[_$-]/g, "");
}

/** Bounded Levenshtein edit distance (bails out to Infinity beyond FUZZY_MAX_LEN). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > FUZZY_MAX_LEN || b.length > FUZZY_MAX_LEN) return Number.POSITIVE_INFINITY;
  const m = a.length;
  const n = b.length;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    const ca = a[i - 1]!;
    for (let j = 1; j <= n; j++) {
      const cost = ca === b[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** 0–1 similarity (1 = identical), computed on the raw strings. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - editDistance(a, b) / max;
}

/** Nearest candidate by similarity ≥ FUZZY_MIN_SIM (ties → first in candidate order). */
export function suggestNearest(token: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestScore = FUZZY_MIN_SIM;
  for (const c of candidates) {
    if (Math.abs(c.length - token.length) > 3) continue;
    const s = similarity(token, c);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}

/** kebab/snake → camel (`max-chars` → `maxChars`). */
function toCamel(slug: string): string {
  return slug.replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Posix dirname of a project-relative path ("" when there is no directory part). */
function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/**
 * Root-anchored glob → RegExp. `*` matches within a segment, `**` across
 * segments (a leading double-star followed by a slash also matches zero
 * directories). Deterministic and shared with `src/services/docfiles.ts`
 * (doc-set include/ignore matching).
 */
export function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may match zero directories; a bare `**` spans segments.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += escapeRegExp(ch);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** Is this path a doc artifact (never usable as evidence)? */
export function isDocPath(p: string): boolean {
  return DOC_PATH_RE.test(p);
}

// ------------------------------------------------- the doc-check code index

/** A module-level constant literal (`const NAME = "value"`), used as identifier evidence. */
export interface DocConstant {
  name: string;
  value: string;
  path: string;
  line: number;
}

/** Precomputed lookup structures over the project's code chunks. */
export interface DocCheckIndex {
  /** Every indexed symbol name (incl. dotted `Class.method`). */
  symbolNames: Set<string>;
  /** Sorted symbol names (fuzzy suggestions scan this). */
  symbolNameList: string[];
  /** Constant literals by name. */
  constantsByName: Map<string, DocConstant>;
  /** Constant literals by value — the `INDEX_JOB = "index"` evidence path. */
  constantsByValue: Map<string, DocConstant[]>;
  /** file (project-relative) → symbol names defined in it (full + bare segments). */
  perFileSymbols: Map<string, Set<string>>;
  /** symbol name → files defining it. */
  symbolFiles: Map<string, string[]>;
}

const CONST_JS_RE = /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(["'])((?:(?!\2)[^\n]){1,100}?)\2/g;
const CONST_TOPLEVEL_RE = /(?:^|\n)([A-Z][A-Z0-9_]{1,63})\s*=\s*(["'])((?:(?!\2)[^\n]){1,100}?)\2/g;

/** Extract (name, value, line) constant literals from one chunk's content. */
export function extractConstants(
  content: string,
  startLine: number,
): { name: string; value: string; line: number }[] {
  const out: { name: string; value: string; line: number }[] = [];
  for (const re of [CONST_JS_RE, CONST_TOPLEVEL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null && out.length < MAX_CONSTANTS) {
      const before = content.slice(0, m.index);
      const line = startLine + (before ? (before.match(/\n/g) ?? []).length : 0);
      const name = m[1]!;
      const value = m[3] ?? "";
      if (name && value) out.push({ name, value, line });
    }
    if (out.length >= MAX_CONSTANTS) break;
  }
  return out;
}

/**
 * Build the lookup index over code chunks. Doc-artifact chunks (md/json/xml/rst)
 * are skipped everywhere — a documentation claim must be proven by code, never
 * by another document.
 */
export function buildDocCheckIndex(chunks: readonly DocCheckChunk[]): DocCheckIndex {
  const symbolNames = new Set<string>();
  const constantsByName = new Map<string, DocConstant>();
  const constantsByValue = new Map<string, DocConstant[]>();
  const perFileSymbols = new Map<string, Set<string>>();
  const symbolFiles = new Map<string, string[]>();

  for (const c of chunks) {
    if (isDocPath(c.filePath)) continue;
    if (c.symbolName) {
      symbolNames.add(c.symbolName);
      let set = perFileSymbols.get(c.filePath);
      if (!set) {
        set = new Set();
        perFileSymbols.set(c.filePath, set);
      }
      set.add(c.symbolName);
      const bare = c.symbolName.split(".").pop();
      if (bare && bare !== c.symbolName) set.add(bare);
      let files = symbolFiles.get(c.symbolName);
      if (!files) {
        files = [];
        symbolFiles.set(c.symbolName, files);
      }
      if (!files.includes(c.filePath)) files.push(c.filePath);
    }
    if (constantsByName.size < MAX_CONSTANTS) {
      for (const k of extractConstants(c.content, c.startLine)) {
        if (constantsByName.size >= MAX_CONSTANTS) break;
        if (constantsByName.has(k.name)) continue;
        const entry: DocConstant = { name: k.name, value: k.value, path: c.filePath, line: k.line };
        constantsByName.set(k.name, entry);
        let list = constantsByValue.get(k.value);
        if (!list) {
          list = [];
          constantsByValue.set(k.value, list);
        }
        if (list.length < 5) list.push(entry);
      }
    }
  }
  return {
    symbolNames,
    symbolNameList: [...symbolNames].sort(),
    constantsByName,
    constantsByValue,
    perFileSymbols,
    symbolFiles,
  };
}

// ------------------------------------------------------------ token scans

/**
 * Find where each token occurs in the code chunks. `style` picks the boundary:
 * `ident` = whole-identifier lookaround (the `countReferences` recipe), so
 * `getUser` never matches inside `getUserName`; `literal` = looser boundaries
 * for tokens that contain `. / @ : -` (dotted names, flags, deps, model tags).
 * Batches tokens in NAME_REGEX_CAP-sized groups so nothing is silently dropped.
 */
export function scanDocTokens(
  chunks: readonly DocCheckChunk[],
  tokens: readonly string[],
  style: "ident" | "literal",
): Map<string, DocEvidence[]> {
  const result = new Map<string, DocEvidence[]>();
  const uniq = [...new Set(tokens)].filter((t) => t.length > 0);
  if (uniq.length === 0) return result;
  const sorted = uniq.sort((a, b) => b.length - a.length).filter((t) => t.length <= 200);
  const left = style === "ident" ? "(?<![A-Za-z0-9_$])" : "(?<![\\w$.@/-])";
  const right = style === "ident" ? "(?![A-Za-z0-9_$])" : "(?![\\w$-])";

  for (let gi = 0; gi < sorted.length; gi += NAME_REGEX_CAP) {
    const batch = sorted.slice(gi, gi + NAME_REGEX_CAP);
    const re = new RegExp(`${left}(${batch.map(escapeRegExp).join("|")})${right}`, "g");
    for (const chunk of chunks) {
      if (isDocPath(chunk.filePath)) continue;
      if (!chunk.content) continue;
      const lines = chunk.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.length === 0) continue;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const matched = m[1]!;
          let list = result.get(matched);
          if (!list) {
            list = [];
            result.set(matched, list);
          }
          if (list.length < MAX_EVIDENCE && !list.some((e) => e.path === chunk.filePath && e.line === chunk.startLine + i)) {
            list.push({ path: chunk.filePath, line: chunk.startLine + i });
          }
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      }
    }
  }
  return result;
}

// ------------------------------------------------------- span classification

export interface ClassifiedSpan {
  spanClass: SpanClass;
  parts?: string[];
  skipReason?: SkipKind;
}

/**
 * Classify one backtick span. Purely syntactic — resolution happens later in
 * `checkSpan`. The order encodes the prototype's adjudication lessons: URLs and
 * artifacts out first, then the tightly-shaped classes, then the ambiguous ones.
 */
export function classifySpan(rawToken: string): ClassifiedSpan | null {
  const token = rawToken.trim();
  if (token.length === 0 || token.length > 200) return null;

  if (URL_RE.test(token)) return { spanClass: "artifact", skipReason: "external" };
  if (ARTIFACT_DIR_RE.test(token)) return { spanClass: "artifact", skipReason: "artifact" };
  if (ARTIFACT_EXT_RE.test(token)) return { spanClass: "artifact", skipReason: "artifact" };

  const endpoint = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i.exec(token);
  if (endpoint) {
    // The ROUTE claim is the path — a query string (`?since=<cursor>`) is call
    // syntax, not a route segment, and `<placeholder>` values are vocabulary.
    // Stripping it keeps `/events` resolvable instead of reading the whole
    // `events?since=<cursor>` as one phantom segment.
    const raw = endpoint[2]!;
    const q = raw.indexOf("?");
    const route = q === -1 ? raw : raw.slice(0, q) || raw;
    return { spanClass: "endpoint", parts: [endpoint[1]!.toUpperCase(), route] };
  }

  const dep = DEP_RE.exec(token);
  if (dep) return { spanClass: "dep" };

  const flag = FLAG_RE.exec(token);
  if (flag) return { spanClass: "flag" };

  if (ENV_RE.test(token) && token.includes("_") && token.length >= 6) {
    return { spanClass: "env" };
  }

  const composite = COMPOSITE_RE.exec(token);
  if (composite) return { spanClass: "composite", parts: [composite[1]!, composite[2]!] };

  // kv: `key=value` or `key: value` (colon WITH a space). A colon without a
  // space is an ollama-style model tag, handled further below.
  const kv = /^([A-Za-z_$][\w.$-]*)\s*=\s*(\S.{0,120})$/.exec(token) ??
    /^([A-Za-z_$][\w.$-]*)\s*:\s+(\S.{0,120})$/.exec(token);
  if (kv) return { spanClass: "kv", parts: [kv[1]!, kv[2]!] };

  if (/\s/.test(token)) {
    const words = token.split(/\s+/);
    const bin = words[0]!.toLowerCase();
    if (CMD_BINS.has(bin)) return { spanClass: "cmd", parts: words };
    return { spanClass: "opaque" };
  }

  if (SEMVER_RE.test(token) || /^\d/.test(token)) return { spanClass: "opaque" };

  // Repo/tool references and meta-variables: `emscripten/emsdk:3.1.61` (owner/repo:tag),
  // `<home>/config.yml` (a placeholder the reader substitutes), and lowercase
  // version-y labels with both a hyphen and a dot (`ubuntu-24.04-arm`, a CI
  // runner label) — all vocabulary, none of them claims about this repo.
  if (token.includes("/") && token.includes(":")) return { spanClass: "artifact", skipReason: "external" };
  if (/[<>]/.test(token)) return { spanClass: "artifact", skipReason: "external" };
  if (!token.includes(":") && /\d/.test(token) && token.includes("-") && token.includes(".") && !/[A-Z]/.test(token)) {
    return { spanClass: "opaque" };
  }

  // Single colon, no slash/space → an ollama-style model tag.
  const modelTag = /^[A-Za-z][\w.-]*:[\w.-]+$/.exec(token);
  if (modelTag && !token.includes("/")) return { spanClass: "model-tag" };

  const hasSlash = token.includes("/");
  const extMatch = /\.([a-z0-9]{1,6})$/i.exec(token);
  if (hasSlash || (extMatch && KNOWN_EXTS.has((extMatch[1] ?? "").toLowerCase()))) {
    return { spanClass: "path" };
  }

  if (token.includes(".")) {
    if (/^[a-z][\w-]*(\.[a-z][\w-]*)+$/.test(token)) return { spanClass: "config-path" };
    return { spanClass: "identifier" };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(token)) return { spanClass: "identifier" };
  return { spanClass: "opaque" };
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * Extract backtick spans from one doc file, in order, with region/skip labels.
 * Inline `<!-- cidx-doccheck-ignore -->` suppresses its own line and the next.
 */
export function extractDocSpans(file: DocFile): DocSpan[] {
  const spans: DocSpan[] = [];
  let inFence = false;
  let fenceMarker = "```";
  let plannedOpen = false;
  for (let i = 0; i < file.lines.length; i++) {
    const raw = file.lines[i] ?? "";
    const lineNo = i + 1;
    if (file.suppressed.has(lineNo)) continue;
    if (raw.includes(IGNORE_MARKER)) {
      // Inline suppression: the marker's own line and the line after it.
      file.suppressed.add(lineNo + 1);
      continue;
    }
    if (file.fileClass !== "historical") {
      const fence = FENCE_RE.exec(raw);
      if (fence) {
        const marker = fence[1]!;
        if (!inFence) {
          inFence = true;
          fenceMarker = marker;
        } else if (marker === fenceMarker) {
          inFence = false;
        }
        continue;
      }
    }
    const heading = /^(\s*)(#{1,6})\s+(.*)$/.exec(raw);
    if (heading && !inFence) {
      plannedOpen = PLANNED_HEADING_RE.test(heading[3] ?? "");
      continue;
    }
    const region: RegionClass =
      file.fileClass === "historical" ? "historical" : inFence ? "example" : plannedOpen ? "planned" : "current";
    const excerpt = raw.trim().slice(0, EXCERPT_MAX);
    const backtick = /`([^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = backtick.exec(raw)) !== null) {
      const token = (m[1] ?? "").trim();
      if (!token) continue;
      const cls = classifySpan(token);
      if (!cls) continue;
      const span: DocSpan = {
        token,
        docRelPath: file.relPath,
        line: lineNo,
        spanClass: cls.spanClass,
        region,
        excerpt,
      };
      if (cls.parts !== undefined) span.parts = cls.parts;
      if (cls.skipReason !== undefined) span.skipReason = cls.skipReason;
      spans.push(span);
    }
  }
  return spans;
}
// ---------------------------------------------------------- span resolvers

/** Context handed to the per-class resolvers (all precomputed, none re-scanned). */
interface ResolveCtx {
  state: DocCheckState;
  idx: DocCheckIndex;
  /** Indexed files ∪ root names — the universe a path claim can resolve into. */
  allPaths: Set<string>;
  identHits: Map<string, DocEvidence[]>;
  literalHits: Map<string, DocEvidence[]>;
  scriptNames: Set<string>;
}

function evOf(hits: Map<string, DocEvidence[]>, token: string): DocEvidence[] | undefined {
  const list = hits.get(token);
  return list && list.length > 0 ? list : undefined;
}

/** Does one dotted-name segment resolve as an identifier anywhere in the code? */
function resolveIdentPart(part: string, ctx: ResolveCtx): boolean {
  if (ctx.idx.symbolNames.has(part)) return true;
  const h = ctx.identHits.get(part);
  return h !== undefined && h.length > 0;
}

function checkIdentifier(token: string, ctx: ResolveCtx, excerpt = ""): SpanVerdict {
  const { idx } = ctx;
  // A call-shaped doc mention (`os.homedir()`, `IndexManager.checkDocs()`) is
  // resolved by the identifier it names, not by the call syntax.
  const bare = token.replace(/\(\)$/, "");
  // The `const INDEX_JOB = "index"` lesson: a doc can name a literal VALUE whose
  // only code presence is a constant binding — the constant table proves it.
  const constHits = idx.constantsByValue.get(bare);
  if (constHits && constHits.length > 0) {
    return {
      status: "ok",
      confidence: 100,
      evidence: constHits.map((c) => ({ path: c.path, line: c.line, symbol: c.name })),
    };
  }
  if (idx.symbolNames.has(bare)) {
    return { status: "ok", confidence: 100, evidence: evOf(ctx.identHits, bare) };
  }
  const direct = evOf(ctx.identHits, bare);
  if (direct) return { status: "ok", confidence: 100, evidence: direct };

  if (bare.includes(".")) {
    const lit = evOf(ctx.literalHits, bare);
    if (lit) return { status: "ok", confidence: 100, evidence: lit };
    const parts = bare.split(".");
    const last = parts[parts.length - 1] ?? bare;
    if (resolveIdentPart(last, ctx)) {
      return { status: "ok", confidence: 95, evidence: evOf(ctx.identHits, last) };
    }
    if (parts.length >= 2 && parts.every((p) => resolveIdentPart(p, ctx))) {
      return { status: "ok", confidence: 90 };
    }
  }

  const suggestion = suggestNearest(bare, ctx.idx.symbolNameList);
  if (suggestion) {
    return {
      status: "missing",
      confidence: 92,
      suggestion,
      message: `'${bare}' is not defined by the index and never occurs in indexed code; did you mean '${suggestion}'? (possible rename)`,
    };
  }

  // Dependency-context shield (live-run lesson): an identifier that occurs
  // nowhere but is named on a line discussing a KNOWN dependency is most likely
  // that dependency's API (`getDylinkMetadata` on a web-tree-sitter line) —
  // suspected, never a drift accusation.
  for (const dep of Object.keys(ctx.state.manifest.deps).concat(Object.keys(ctx.state.manifest.devDeps))) {
    const short = dep.includes("/") ? (dep.split("/")[1] ?? dep) : dep;
    if (excerpt.includes(dep) || excerpt.includes(short)) {
      return {
        status: "missing",
        confidence: 70,
        message: `'${bare}' occurs nowhere in the indexed code; the line discusses '${dep}', so it may be that package's API`,
      };
    }
  }

  // Unresolved gates — these tokens are too generic to accuse.
  if (/^[a-z]{1,7}$/.test(token)) {
    return { status: "skipped", confidence: 0, skipReason: "generic" };
  }
  if (token.length <= SHORT_ACRONYM_MAX || ACRONYMS.has(token)) {
    return { status: "skipped", confidence: 0, skipReason: "generic" };
  }
  if (/^[A-Z0-9]{4,6}$/.test(token)) {
    return {
      status: "review",
      confidence: 50,
      message: `all-caps token '${token}' occurs nowhere in the indexed code — possibly a prose acronym, possibly a removed constant`,
    };
  }
  return {
    status: "missing",
    confidence: 95,
    message: `'${bare}' is not defined by the index and never occurs in indexed code`,
  };
}

function checkPath(token: string, ctx: ResolveCtx, docRelPath: string): SpanVerdict {
  let t = token;
  let isDir = false;
  if (t.endsWith("/")) {
    isDir = true;
    t = t.slice(0, -1);
  }
  if (t.startsWith("./")) t = t.slice(2);
  if (t === "~" || t.startsWith("~/") || t.startsWith("../")) {
    return { status: "skipped", confidence: 0, skipReason: "external" };
  }
  // Vocabulary, not existence claims: a bare extension mention (`.md`), a
  // `.git/...` path (the index never covers the git dir), an unresolved
  // dot-file (hidden files are optional/convention-heavy: `.cidx.json`,
  // `.gitignore`), a URI-style path (`/ping`, `/api/generate`), and the
  // supported projects' own convention files.
  if (BARE_EXT_RE.test(t) || t === ".git" || t.startsWith(".git/")) {
    return { status: "skipped", confidence: 0, skipReason: "external" };
  }
  if (CONFIG_LITERALS.has(t) || CONVENTION_FILES.has(t)) {
    return { status: "skipped", confidence: 0, skipReason: "external" };
  }
  const { allPaths } = ctx;

  if (t.includes("*") || t.includes("?")) {
    const re = globToRegex(t);
    let count = 0;
    const evidence: DocEvidence[] = [];
    for (const p of allPaths) {
      if (re.test(p)) {
        count++;
        if (evidence.length < MAX_EVIDENCE) evidence.push({ path: p });
        if (count > 50) break;
      }
    }
    if (count > 0) return { status: "ok", confidence: 90, evidence };
    return {
      status: "missing",
      confidence: 85,
      message: `glob '${token}' matches no file in the indexed file set (an aspiration, not yet reality)`,
      evidence,
    };
  }

  if (allPaths.has(t)) return { status: "ok", confidence: 100, evidence: [{ path: t }] };
  if (allPaths.has(`src/${t}`)) {
    return { status: "ok", confidence: 95, evidence: [{ path: `src/${t}` }] };
  }
  const dir = posixDirname(docRelPath);
  if (dir.length > 0 && allPaths.has(`${dir}/${t}`)) {
    return { status: "ok", confidence: 95, evidence: [{ path: `${dir}/${t}` }] };
  }

  // Unique-suffix fallback: `doctor.ts` → `src/core/doctor.ts`.
  const suffixMatches: string[] = [];
  for (const p of allPaths) {
    if (p.endsWith(`/${t}`)) {
      suffixMatches.push(p);
      if (suffixMatches.length > 1) break;
    }
  }
  if (suffixMatches.length === 1) {
    return { status: "ok", confidence: 90, evidence: [{ path: suffixMatches[0]! }] };
  }
  if (suffixMatches.length > 1) {
    return {
      status: "missing",
      confidence: 70,
      message: `path '${token}' is ambiguous — ${suffixMatches.length} indexed files end with it`,
      evidence: suffixMatches.slice(0, MAX_EVIDENCE).map((p) => ({ path: p })),
    };
  }
  if (isDir) {
    let prefixed = false;
    for (const p of allPaths) {
      if (p.startsWith(`${t}/`)) {
        prefixed = true;
        break;
      }
    }
    if (prefixed) return { status: "ok", confidence: 90 };
    return {
      status: "missing",
      confidence: 70,
      message: `directory '${token}' does not exist in the indexed file set`,
    };
  }
  // Unresolved absolutes are URI paths in practice (`/ping`, `/api/generate`);
  // unresolved hidden files are convention/optional (` .cidx.json`); unresolved
  // extension-less lowercase `a/b` shapes are protocol vocabulary as often as
  // paths — all of them stay below the drift line.
  if (t.startsWith("/") || t.startsWith(".")) {
    return { status: "skipped", confidence: 0, skipReason: "external" };
  }
  if (!/\.[a-z0-9]{1,6}$/i.test(t)) {
    return {
      status: "missing",
      confidence: 70,
      message: `path '${token}' does not exist in the indexed file set (no file extension — may just be vocabulary)`,
    };
  }
  // An extension the repo never uses suggests the file belongs to ANOTHER
  // project the doc is describing (live-run lesson: `src/parser.c` in the
  // vendored-grammar notes) — suspected, not a drift accusation.
  const ext = (t.match(/\.([a-z0-9]{1,6})$/i)?.[1] ?? "").toLowerCase();
  let extSeen = false;
  for (const p of allPaths) {
    if (p.toLowerCase().endsWith(`.${ext}`)) {
      extSeen = true;
      break;
    }
  }
  if (!extSeen) {
    return {
      status: "missing",
      confidence: 85,
      message: `path '${token}' does not exist here, and no '.${ext}' file exists in this repo — it may belong to a described external project`,
    };
  }
  return {
    status: "missing",
    confidence: 95,
    message: `path '${token}' does not exist in the indexed file set`,
  };
}

function checkEnv(token: string, ctx: ResolveCtx): SpanVerdict {
  const direct = evOf(ctx.identHits, token);
  if (direct) return { status: "ok", confidence: 100, evidence: direct };
  if (ctx.idx.constantsByName.has(token)) {
    const c = ctx.idx.constantsByName.get(token)!;
    return { status: "ok", confidence: 100, evidence: [{ path: c.path, line: c.line, symbol: c.name }] };
  }
  for (const p of EXTERNAL_ENV_PREFIXES) {
    if (token === p || token.startsWith(p)) {
      return { status: "skipped", confidence: 0, skipReason: "external" };
    }
  }
  return {
    status: "missing",
    confidence: 95,
    message: `environment variable '${token}' does not occur in indexed code and is not a known external variable`,
  };
}

function checkEndpoint(token: string, parts: string[], ctx: ResolveCtx): SpanVerdict {
  const route = parts[1] ?? "";
  const segments = route.split("/").filter((s) => s.length > 0 && !/^[{:*]/.test(s));
  if (segments.length === 0) return { status: "skipped", confidence: 0, skipReason: "generic" };
  // A route segment resolves as an identifier (`events`, `doccheck`) OR as a
  // ROUTE LITERAL: Express-style routes are quoted strings, so a hyphenated
  // segment (`bridge-session`) is never a whole identifier — the `"/<seg>"`
  // string in the code is the thing the doc claim actually names.
  const routeLit = (s: string): DocEvidence[] | undefined => ctx.literalHits.get(`/${s}`);
  const unresolved = segments.filter((s) => !resolveIdentPart(s, ctx) && (routeLit(s)?.length ?? 0) === 0);
  if (unresolved.length > 0) {
    return {
      status: "missing",
      confidence: 93,
      message: `route segment(s) '${unresolved.join("', '")}' of '${token}' do not occur in indexed code`,
      evidence: evOf(ctx.identHits, segments[0]!),
    };
  }
  const first = segments[0]!;
  return { status: "ok", confidence: 100, evidence: evOf(ctx.identHits, first) ?? routeLit(first) };
}

function checkCmd(parts: string[], ctx: ResolveCtx): SpanVerdict {
  const rest = parts.slice(1);
  // `bun run <script>` / `npm run <script>` — checked against package.json scripts.
  if (rest[0] === "run" && rest.length >= 2) {
    const target = rest[1]!;
    if (target.includes("/") || target.includes(".")) {
      const words = rest.slice(2).filter((w) => !w.startsWith("-"));
      const unresolved = words.filter((w) => !resolveIdentPart(w, ctx));
      const pv = checkPath(target, ctx, "");
      if (pv.status === "ok") {
        if (unresolved.length > 0) {
          return {
            status: "missing",
            confidence: 92,
            message: `command argument(s) '${unresolved.join("', '")}' do not occur in indexed code`,
          };
        }
        return { status: "ok", confidence: 90, evidence: pv.evidence };
      }
      if (pv.status === "skipped") return { status: "skipped", confidence: 0, skipReason: "external" };
      return {
        status: "missing",
        confidence: 92,
        message: `command path '${target}' does not resolve in the indexed file set`,
      };
    }
    if (ctx.scriptNames.has(target)) return { status: "ok", confidence: 100 };
    return {
      status: "missing",
      confidence: 92,
      message: `script '${target}' is not defined in package.json scripts`,
    };
  }
  const checkable = rest.filter((w) => !w.startsWith("-") && /^[A-Za-z0-9_./:-]+$/.test(w) && w.length > 1);
  if (checkable.length === 0) return { status: "skipped", confidence: 0, skipReason: "generic" };
  const unresolved = checkable.filter((w) => {
    const bare = w.replace(/\.+$/, "");
    return !resolveIdentPart(bare, ctx) && (ctx.literalHits.get(bare)?.length ?? 0) === 0;
  });
  if (unresolved.length > 0) {
    return {
      status: "missing",
      confidence: 92,
      message: `command argument(s) '${unresolved.join("', '")}' do not occur in indexed code`,
    };
  }
  return { status: "ok", confidence: 90 };
}

function checkFlag(token: string, ctx: ResolveCtx): SpanVerdict {
  const m = FLAG_RE.exec(token);
  if (!m) return { status: "skipped", confidence: 0, skipReason: "generic" };
  const name = m[2] ?? "";
  if (name.length === 1 || EXTERNAL_FLAG_NAMES.has(name)) {
    return { status: "skipped", confidence: 0, skipReason: "external" };
  }
  if (evOf(ctx.literalHits, token)) return { status: "ok", confidence: 100, evidence: evOf(ctx.literalHits, token) };
  if (evOf(ctx.literalHits, name)) return { status: "ok", confidence: 95, evidence: evOf(ctx.literalHits, name) };
  const camel = toCamel(name);
  if (ctx.idx.symbolNames.has(camel) || evOf(ctx.identHits, camel)) {
    return { status: "ok", confidence: 90, evidence: evOf(ctx.identHits, camel) };
  }
  const slugParts = name.split("-").filter((p) => p.length > 0);
  if (slugParts.length > 1 && slugParts.every((p) => resolveIdentPart(p, ctx))) {
    return { status: "ok", confidence: 85 };
  }
  return {
    status: "missing",
    confidence: 92,
    message: `flag '${token}' does not occur in indexed code (neither as written, as a flag key, nor by parts)`,
  };
}

function checkDep(token: string, ctx: ResolveCtx): SpanVerdict {
  const m = DEP_RE.exec(token);
  if (!m) return { status: "skipped", confidence: 0, skipReason: "generic" };
  const name = m[1] ?? token;
  const ver = m[2] ?? "";
  const have = ctx.state.manifest.deps[name] ?? ctx.state.manifest.devDeps[name];
  if (have === undefined) {
    // Docs legitimately name packages that are build tools or related projects,
    // not dependencies of THIS repo (live-run lesson: tree-sitter-cli) — so a
    // missing dep is suspected, never a hard drift.
    return {
      status: "missing",
      confidence: 80,
      message: `dependency '${name}' is not in package.json dependencies/devDependencies`,
    };
  }
  const want = ver.replace(/[^0-9.].*$/, "");
  // A caret/tilde range satisfies the pinned version it ranges over
  // (`^0.1.13` in package.json satisfies a documented `0.1.13`).
  const haveClean = have.replace(/^[v^~>=\s]+/, "");
  if (want.length > 0 && !haveClean.startsWith(want)) {
    return {
      status: "missing",
      confidence: 80,
      message: `documented dependency version '${ver}' does not match installed '${have}'`,
    };
  }
  return { status: "ok", confidence: 100 };
}

function checkKv(token: string, parts: string[], spanClass: SpanClass, ctx: ResolveCtx): SpanVerdict {
  const key = parts[0] ?? "";
  // An ALL-CAPS assignment (`CUDA_VISIBLE_DEVICES=""`) is an environment
  // variable, not a config key — the env resolver knows the platform prefixes.
  if (ENV_RE.test(key) && key.includes("_")) return checkEnv(key, ctx);
  const segs = key.split(/[.:]/).filter((s) => s.length > 0);
  if (segs.length === 0) return { status: "skipped", confidence: 0, skipReason: "generic" };
  const unresolved = segs.filter((s) => !resolveIdentPart(s, ctx));
  if (unresolved.length === 0) {
    return { status: "ok", confidence: 90, evidence: evOf(ctx.identHits, segs[segs.length - 1]!) };
  }
  return {
    status: "missing",
    confidence: 85,
    message: `key segment(s) '${unresolved.join("', '")}' of '${key}' do not occur in indexed code`,
  };
}

function checkModelTag(token: string, ctx: ResolveCtx): SpanVerdict {
  const left = token.split(":")[0] ?? token;
  if (
    evOf(ctx.literalHits, token) ||
    evOf(ctx.literalHits, left) ||
    evOf(ctx.identHits, left) ||
    ctx.idx.symbolNames.has(left)
  ) {
    return { status: "ok", confidence: 95, evidence: evOf(ctx.literalHits, token) ?? evOf(ctx.identHits, left) };
  }
  return {
    status: "review",
    confidence: 60,
    message: `model tag '${token}' does not occur in indexed code — may be an external model name`,
  };
}

function checkComposite(token: string, parts: string[], ctx: ResolveCtx, docRelPath: string): SpanVerdict {
  const left = parts[0] ?? "";
  const right = (parts[1] ?? "").replace(/\(\)$/, "");
  const pv = checkPath(left, ctx, docRelPath);
  if (pv.status === "skipped") return pv;
  if (pv.status === "missing" && pv.confidence >= 90) {
    return {
      status: "missing",
      confidence: 93,
      message: `composite claim '${token}': the path does not resolve — ${pv.message}`,
      evidence: pv.evidence,
    };
  }
  if (pv.status === "missing") return pv;
  const resolved = pv.evidence?.[0]?.path ?? "";
  const perFile = resolved.length > 0 ? ctx.idx.perFileSymbols.get(resolved) : undefined;
  const bare = right.split(".").pop() ?? right;
  if (perFile && (perFile.has(right) || perFile.has(bare))) {
    return { status: "ok", confidence: 100, evidence: [{ path: resolved, symbol: right }] };
  }
  const files = ctx.idx.symbolFiles.get(right);
  if (files && files.length > 0) {
    return {
      status: "missing",
      confidence: 94,
      message: `symbol '${right}' is defined in '${files[0]}'${files.length > 1 ? ` (+${files.length - 1} more)` : ""}, not in '${left}'`,
      evidence: files.slice(0, MAX_EVIDENCE).map((p) => ({ path: p, symbol: right })),
    };
  }
  return {
    status: "missing",
    confidence: 94,
    message: `symbol '${right}' of composite claim '${token}' is not defined in the indexed code`,
  };
}

/**
 * Resolve one span against the precomputed context. Region/shape exclusions are
 * handled first; every real resolver returns ok / missing (with confidence) /
 * skipped / review.
 */
export function checkSpan(span: DocSpan, ctx: ResolveCtx): SpanVerdict {
  if (span.region !== "current") {
    return { status: "skipped", confidence: 0, skipReason: span.region as SkipKind };
  }
  if (span.spanClass === "artifact" || span.spanClass === "opaque") {
    return { status: "skipped", confidence: 0, skipReason: span.skipReason };
  }
  const parts = span.parts ?? [];
  switch (span.spanClass) {
    case "identifier":
      return checkIdentifier(span.token, ctx, span.excerpt);
    case "path":
      return checkPath(span.token, ctx, span.docRelPath);
    case "env":
      return checkEnv(span.token, ctx);
    case "endpoint":
      return checkEndpoint(span.token, parts, ctx);
    case "cmd":
      return checkCmd(parts, ctx);
    case "flag":
      return checkFlag(span.token, ctx);
    case "dep":
      return checkDep(span.token, ctx);
    case "kv":
    case "config-path":
      return checkKv(span.token, parts, span.spanClass, ctx);
    case "model-tag":
      return checkModelTag(span.token, ctx);
    case "composite":
      return checkComposite(span.token, parts, ctx, span.docRelPath);
    default:
      return { status: "skipped", confidence: 0, skipReason: "generic" };
  }
}

// ------------------------------------------------------------ intent demotion

const EXAMPLE_LINE_RE =
  /(^|[(\s])(e\.g\.|i\.e\.|for example|for instance|such as|sample:|example:|örneğin|örnek)/i;

/**
 * Prose-example heuristics (the prototype's FP lessons): a single-character path
 * segment (`a/b.py`), an example-marker on the line, or a same-line sibling token
 * that normalizes to the same identifier (`_private` next to `private`) — all
 * demote a missing verdict to `review`, never a finding.
 */
export function isProseExample(span: DocSpan, lineMates: readonly DocSpan[]): boolean {
  if (span.spanClass === "path" && span.token.split("/").some((seg) => seg.length <= 1)) return true;
  if (EXAMPLE_LINE_RE.test(span.excerpt)) return true;
  const norm = normalizeIdent(span.token);
  for (const other of lineMates) {
    if (other === span) continue;
    if (other.token !== span.token && normalizeIdent(other.token) === norm) return true;
  }
  return false;
}

export function demoteByIntent(span: DocSpan, verdict: SpanVerdict, lineMates: readonly DocSpan[]): SpanVerdict {
  if (verdict.status !== "missing" && verdict.status !== "review") return verdict;
  if (isProseExample(span, lineMates)) {
    return {
      status: "review",
      confidence: 50,
      proseExample: true,
      message: `looks like a prose example: ${verdict.message ?? span.token}`,
    };
  }
  return verdict;
}

// --------------------------------------------------------------- findings

/** Materialize a finding; the caller routes it by `verdict.status`/confidence. */
export function toFinding(span: DocSpan, verdict: SpanVerdict, seq: number): DocFinding {
  const f: DocFinding = {
    id: `D-${seq}`,
    kind: span.spanClass,
    confidence: verdict.confidence,
    category: "review",
    doc: { path: span.docRelPath, line: span.line, excerpt: span.excerpt },
    message: verdict.message ?? `'${span.token}' could not be resolved`,
  };
  if (verdict.suggestion !== undefined) f.suggestion = verdict.suggestion;
  if (verdict.evidence !== undefined && verdict.evidence.length > 0) f.evidence = verdict.evidence;
  return f;
}

// ------------------------------------------------------- reverse coverage

/**
 * Exported symbols that no doc span (any region — a changelog mention still
 * documents a symbol) references. Advisory only: confidence 40, capped, and
 * every cap is surfaced (`truncated` comes from the caller's doc-set cap).
 */
export function collectUndocumented(
  state: DocCheckState,
  idx: DocCheckIndex,
  mentioned: ReadonlySet<string>,
  limit: number,
): UndocumentedEntry[] {
  if (limit <= 0) return [];
  const candidates: DocSymbol[] = [];
  for (const s of state.exportedSymbols) {
    if (candidates.length >= MAX_UNDOC_CANDIDATES) break;
    if (!DEAD_CANDIDATE_TYPES.has(s.symbolType)) continue;
    if (isTestFile(s.relativePath) || isEntryPointFile(s.relativePath)) continue;
    const bare = s.symbolName.split(".").pop() ?? s.symbolName;
    if (DYNAMIC_HOOK_NAMES.has(bare)) continue;
    if (!detectExported(s.symbolName, s.symbolType, s.language, s.content)) continue;
    if (mentioned.has(s.symbolName) || mentioned.has(bare)) continue;
    candidates.push(s);
  }
  candidates.sort((a, b) =>
    a.relativePath === b.relativePath
      ? a.line === b.line
        ? a.symbolName.localeCompare(b.symbolName)
        : a.line - b.line
      : a.relativePath.localeCompare(b.relativePath),
  );
  void idx;
  return candidates.slice(0, limit).map((c) => ({
    symbolName: c.symbolName,
    symbolType: c.symbolType,
    relativePath: c.relativePath,
    line: c.line,
    confidence: 40,
  }));
}

// -------------------------------------------------------------- the pipeline

/** Which tokens the occurrence scan must look for (per boundary style). Exported for tests. */
export function collectScanTokens(
  spans: readonly DocSpan[],
  identSet: Set<string>,
  literalSet: Set<string>,
): void {
  const addIdent = (t: string) => {
    if (t.length > 0) identSet.add(t);
  };
  const addToken = (t: string) => {
    const clean = t.replace(/\(\)$/, "");
    if (clean.length === 0) return;
    if (clean.includes(".")) {
      literalSet.add(clean);
      for (const seg of clean.split(".")) addIdent(seg);
    } else {
      addIdent(clean);
    }
  };
  for (const span of spans) {
    switch (span.spanClass) {
      case "identifier":
      case "env":
        addToken(span.token);
        break;
      case "endpoint": {
        const route = span.parts?.[1] ?? "";
        for (const seg of route.split("/")) {
          if (seg.length === 0 || /^[{:*]/.test(seg)) continue;
          if (/^[A-Za-z][\w$]*$/.test(seg)) addIdent(seg);
          // Route-literal evidence: every segment is also scanned as the
          // quoted `"/<seg>"` string — the form Express-style route
          // registrations actually write, and the only resolvable form for a
          // hyphenated segment (`bridge-session`).
          literalSet.add(`/${seg}`);
        }
        break;
      }
      case "cmd": {
        const words = (span.parts ?? []).slice(1);
        for (const w of words) {
          if (w.startsWith("-")) continue;
          if (w.includes("/") || w.includes(".")) continue; // path-like targets go through checkPath
          addToken(w);
        }
        break;
      }
      case "flag": {
        const m = FLAG_RE.exec(span.token);
        if (m) {
          const name = m[2] ?? "";
          literalSet.add(span.token);
          literalSet.add(name);
          addIdent(toCamel(name));
        }
        break;
      }
      case "dep": {
        const m = DEP_RE.exec(span.token);
        if (m) {
          literalSet.add(span.token);
          literalSet.add(m[1] ?? "");
        }
        break;
      }
      case "kv":
      case "config-path": {
        const key = span.parts?.[0] ?? "";
        if (key.length > 0) {
          literalSet.add(key);
          for (const seg of key.split(/[.:]/)) addIdent(seg);
        }
        break;
      }
      case "model-tag": {
        literalSet.add(span.token);
        literalSet.add(span.token.split(":")[0] ?? "");
        break;
      }
      case "composite": {
        const right = span.parts?.[1] ?? "";
        addToken(right.replace(/\(\)$/, ""));
        break;
      }
      default:
        break;
    }
  }
}

function findingSize(f: DocFinding): number {
  return f.doc.excerpt.length + f.message.length + (f.suggestion?.length ?? 0) + 100;
}

// --------------------------------------------- semantic judge pass (D1b)

/** A `needsReview` candidate kept with its span + verdict so the judge can be handed the claim as-is. */
interface ReviewPending {
  span: DocSpan;
  verdict: SpanVerdict;
  finding: DocFinding;
}

/** Flattens one pending entry into the plain-data claim the injected judge receives. */
function judgeClaimOf(entry: ReviewPending): DocJudgeClaim {
  const { span, verdict } = entry;
  const claim: DocJudgeClaim = {
    token: span.token,
    spanClass: span.spanClass,
    // Pending entries are only ever created for non-ok, non-skipped verdicts
    // with sub-90 confidence — i.e. exactly "review" | "missing" (<90).
    status: verdict.status === "missing" ? "missing" : "review",
    confidence: verdict.confidence,
    doc: { path: span.docRelPath, line: span.line, excerpt: span.excerpt },
  };
  if (span.parts !== undefined) claim.parts = span.parts;
  if (verdict.message !== undefined) claim.message = verdict.message;
  if (verdict.suggestion !== undefined) claim.suggestion = verdict.suggestion;
  if (verdict.evidence !== undefined && verdict.evidence.length > 0) claim.evidence = verdict.evidence;
  return claim;
}

/** The claim's own prose (±`JUDGE_CONTEXT_LINES` lines, each capped) — the engine never touches fs for this. */
function judgeContextOf(span: DocSpan, state: DocCheckState): DocJudgeContext {
  const surrounding: string[] = [];
  const file = state.docs.find((d) => d.relPath === span.docRelPath);
  if (file) {
    const lo = Math.max(0, span.line - 1 - JUDGE_CONTEXT_LINES);
    const hi = Math.min(file.lines.length, span.line - 1 + JUDGE_CONTEXT_LINES + 1);
    for (let i = lo; i < hi; i++) {
      const line = file.lines[i] ?? "";
      surrounding.push(line.length > JUDGE_CONTEXT_LINE_MAX ? `${line.slice(0, JUDGE_CONTEXT_LINE_MAX)}…` : line);
    }
  }
  return { project: state.project, surrounding };
}

type JudgeOutcome = "resolved" | "stayed" | "failed";

/**
 * Runs the injected judge over the claims the deterministic checks could not
 * reach (`review` / sub-90 `missing` verdicts — the same set that lands in
 * `needsReview`). Bounded concurrency, input-ordered results, so a fixed judge
 * keeps the whole run deterministic. Per-claim failures degrade to "stayed" —
 * one bad model response never fails the report.
 */
async function adjudicateByJudge(
  candidates: readonly ReviewPending[],
  judge: DocJudge,
  state: DocCheckState,
): Promise<{ resolvedIds: Set<string>; judged: number; resolved: number; failed: number }> {
  if (candidates.length === 0) return { resolvedIds: new Set(), judged: 0, resolved: 0, failed: 0 };
  const outcomes = await mapWithConcurrency(
    candidates,
    JUDGE_CONCURRENCY,
    async (entry): Promise<JudgeOutcome> => {
      try {
        const v = await judge(judgeClaimOf(entry), judgeContextOf(entry.span, state));
        // Only a high-confidence "consistent" resolves a claim; `null` (no
        // opinion), low confidence and "inconsistent" all keep it in review —
        // the judge never accuses, so it can never create a drift finding.
        if (v && v.consistent && v.confidence >= JUDGE_CONFIRM_MIN) return "resolved";
        return "stayed";
      } catch {
        return "failed";
      }
    },
  );
  const resolvedIds = new Set<string>();
  let failed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const outcome = outcomes[i];
    if (outcome === "resolved") resolvedIds.add(candidates[i]!.finding.id);
    else if (outcome === "failed") failed++;
  }
  return { resolvedIds, judged: candidates.length, resolved: resolvedIds.size, failed };
}

/**
 * Run the deterministic check over an assembled state, then — only when a
 * semantic judge is injected (D1b) — adjudicate the uncertain claims. Pure:
 * same state (and same fixed judge) → same report (except nothing time-based —
 * `indexFreshness` is copied, not measured).
 */
export async function runDocCheck(state: DocCheckState, opts: DocCheckOpts = {}): Promise<DocCheckReport> {
  const limit = Math.max(1, opts.limit ?? 100);
  const maxChars = opts.maxChars;
  const undocLimit = Math.max(0, opts.undocumentedLimit ?? 25);

  const idx = buildDocCheckIndex(state.chunks);
  const allPaths = new Set<string>([...state.repoFiles, ...state.rootNames]);
  const scriptNames = new Set(Object.keys(state.manifest.scripts));

  const allSpans: DocSpan[] = [];
  for (const d of state.docs) allSpans.push(...extractDocSpans(d));

  const identTokens = new Set<string>();
  const literalTokens = new Set<string>();
  collectScanTokens(allSpans, identTokens, literalTokens);
  const identHits = scanDocTokens(state.chunks, [...identTokens], "ident");
  const literalHits = scanDocTokens(state.chunks, [...literalTokens], "literal");

  const ctx: ResolveCtx = { state, idx, allPaths, identHits, literalHits, scriptNames };

  // Same-line span groups (the normalized-neighbor prose-example heuristic).
  const lineSpans = new Map<string, DocSpan[]>();
  for (const s of allSpans) {
    const key = `${s.docRelPath}:${s.line}`;
    let list = lineSpans.get(key);
    if (!list) {
      list = [];
      lineSpans.set(key, list);
    }
    list.push(s);
  }

  const emptySkipped: Record<SkipKind, number> = {
    artifact: 0,
    external: 0,
    historical: 0,
    planned: 0,
    example: 0,
    generic: 0,
  };
  const skipped = { ...emptySkipped };
  let claims = 0;
  let seq = 0;
  const findings: DocFinding[] = [];
  const needsReview: DocFinding[] = [];
  /** `needsReview` candidates, kept pending until the optional judge (D1b) has had its say. */
  const pending: ReviewPending[] = [];

  for (const span of allSpans) {
    const mates = lineSpans.get(`${span.docRelPath}:${span.line}`) ?? [];
    const verdict = demoteByIntent(span, checkSpan(span, ctx), mates);
    if (verdict.status === "skipped") {
      if (verdict.skipReason) skipped[verdict.skipReason]++;
      continue;
    }
    claims++;
    if (verdict.status === "ok") continue;
    seq++;
    const f = toFinding(span, verdict, seq);
    if (verdict.status === "missing" && verdict.confidence >= 90) {
      f.category = "drift";
      findings.push(f);
    } else {
      f.category = verdict.status === "review" ? "review" : "suspected";
      pending.push({ span, verdict, finding: f });
    }
  }

  // Semantic judge (D1b): resolves only what the deterministic pass could not.
  // Prose-example-shielded claims are never judged — the engine already decided
  // they are examples, not claims about this repo (the intent shield stays on).
  let judged = 0;
  let judgeResolved = 0;
  let judgeFailed = 0;
  const judgeResolvedIds = new Set<string>();
  if (opts.judge !== undefined) {
    const judgeable = pending.filter((e) => e.verdict.proseExample !== true);
    const pass = await adjudicateByJudge(judgeable, opts.judge, state);
    judged = pass.judged;
    judgeResolved = pass.resolved;
    judgeFailed = pass.failed;
    for (const id of pass.resolvedIds) judgeResolvedIds.add(id);
  }
  for (const e of pending) {
    // Resolved claims drop out of `needsReview` entirely (counted in
    // `checked.judge.resolved`); everything else stays exactly as today.
    if (judgeResolvedIds.has(e.finding.id)) continue;
    needsReview.push(e.finding);
  }

  findings.sort((a, b) => (b.confidence === a.confidence ? a.id.localeCompare(b.id) : b.confidence - a.confidence));
  needsReview.sort((a, b) => (b.confidence === a.confidence ? a.id.localeCompare(b.id) : b.confidence - a.confidence));

  const notes: string[] = [];
  if (judgeFailed > 0) {
    notes.push(`${judgeFailed} semantic judge call(s) failed; those claim(s) stay in needsReview`);
  }
  const findingsKept = applyBudgetBySize(findings.slice(0, limit), maxChars, findingSize);
  const reviewKept = applyBudgetBySize(needsReview.slice(0, limit), maxChars, findingSize);
  if (findings.length > limit) notes.push(`findings truncated at limit ${limit} (${findings.length} found)`);
  if (needsReview.length > limit) notes.push(`needsReview truncated at limit ${limit} (${needsReview.length} found)`);
  const omitted = findingsKept.omitted + reviewKept.omitted;
  if (omitted > 0) notes.push(`${omitted} item(s) omitted by the ${maxChars} char budget (kept whole, never truncated)`);

  const mentioned = new Set<string>([...identTokens, ...literalTokens]);
  const undocumented = opts.noUndocumented
    ? []
    : collectUndocumented(state, idx, mentioned, undocLimit);

  const judgeModel = opts.judgeModel ?? "";
  const checked: DocCheckReport["checked"] = {
    docs: state.docs.length,
    docsUnreadable: 0,
    spans: allSpans.length,
    claims,
    indexFreshness: state.lastIndexedAt,
    truncated: false,
    skipped,
  };
  if (opts.judge !== undefined || judgeModel.length > 0) {
    checked.judge = {
      model: judgeModel,
      available: opts.judge !== undefined,
      judged,
      resolved: judgeResolved,
      failed: judgeFailed,
    };
  }

  return {
    project: state.project,
    checked,
    verdict: {
      consistent: findingsKept.kept.length === 0 && findings.length === 0,
      findings: findingsKept.kept.length,
      needsReview: reviewKept.kept.length,
      undocumented: undocumented.length,
    },
    findings: findingsKept.kept,
    needsReview: reviewKept.kept,
    undocumented,
    omitted,
    maxChars: maxChars === undefined ? null : maxChars,
    undocumentedDisabled: opts.noUndocumented === true,
    notes,
  };
}
