import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifySpan,
  extractDocSpans,
  buildDocCheckIndex,
  scanDocTokens,
  scanDocTokensCooperative,
  checkSpan,
  demoteByIntent,
  collectUndocumented,
  runDocCheck,
  collectScanTokens,
  normalizeIdent,
  similarity,
  globToRegex,
  isDocPath,
  HISTORICAL_FILE_RE,
  JUDGE_CONFIRM_MIN,
  type DocCheckState,
  type DocCheckChunk,
  type DocFile,
  type DocJudge,
  type DocJudgeClaim,
  type DocJudgeContext,
  type DocSpan,
} from "../src/core/doccheck";
import {
  collectDocFiles,
  listRootFiles,
  readProjectManifest,
  resolveRequestedDocs,
  DOC_MAX_FILES,
} from "../src/services/docfiles";
import { NAME_REGEX_CAP } from "../src/core/deadcode";

// ---------------------------------------------------------------- fixtures

function chunk(
  filePath: string,
  content: string,
  opts?: { startLine?: number; symbolName?: string; symbolType?: string },
): DocCheckChunk {
  return {
    filePath,
    startLine: opts?.startLine ?? 1,
    content,
    ...(opts?.symbolName !== undefined ? { symbolName: opts.symbolName } : {}),
    ...(opts?.symbolType !== undefined ? { symbolType: opts.symbolType } : {}),
  };
}

function docFile(relPath: string, text: string, fileClass: "current" | "historical" = "current"): DocFile {
  return { relPath, lines: text.split("\n"), fileClass, suppressed: new Set() };
}

function baseState(overrides: Partial<DocCheckState> = {}): DocCheckState {
  return {
    project: "t",
    projectRoot: "/tmp/t",
    docs: [],
    chunks: [],
    repoFiles: new Set<string>(),
    rootNames: new Set<string>(),
    manifest: { deps: {}, devDeps: {}, scripts: {} },
    exportedSymbols: [],
    lastDataChangeAt: 1700000000000,
    ...overrides,
  };
}

function span(token: string, spanClass: DocSpan["spanClass"], extra: Partial<DocSpan> = {}): DocSpan {
  return {
    token,
    docRelPath: "docs/a.md",
    line: 3,
    spanClass,
    region: "current",
    excerpt: "line text",
    ...extra,
  };
}

/** Build the resolve context exactly like `runDocCheck` does (scan tokens from the spans themselves). */
function makeCtx(state: DocCheckState, spans: readonly DocSpan[]) {
  const idx = buildDocCheckIndex(state.chunks);
  const identTokens = new Set<string>();
  const literalTokens = new Set<string>();
  collectScanTokens(spans, identTokens, literalTokens);
  return {
    state,
    idx,
    allPaths: new Set<string>([...state.repoFiles, ...state.rootNames]),
    identHits: scanDocTokens(state.chunks, [...identTokens], "ident"),
    literalHits: scanDocTokens(state.chunks, [...literalTokens], "literal"),
    scriptNames: new Set(Object.keys(state.manifest.scripts)),
  };
}

function checkOne(state: DocCheckState, s: DocSpan) {
  return demoteByIntent(s, checkSpan(s, makeCtx(state, [s])), [s]);
}

// ------------------------------------------------------------- classifySpan

describe("classifySpan", () => {
  const cases: [string, string][] = [
    ["searchIndex", "identifier"],
    ["IndexManager.checkDocs", "identifier"],
    ["_private", "identifier"],
    ["src/core/doctor.ts", "path"],
    ["README.md", "path"],
    ["docs/", "path"],
    ["OLLAMA_NUM_CTX", "env"],
    ["POST /search/batch", "endpoint"],
    ["get /health", "endpoint"],
    ["bun run dev", "cmd"],
    ["cidx sync", "cmd"],
    ["--rerank", "flag"],
    ["typescript@5.1.0", "dep"],
    ["@scope/pkg@^2.0.0", "dep"],
    ["search.mmr.lambda=0.5", "kv"],
    ["qwen3-embedding:0.6b", "model-tag"],
    ["search.mmr.lambda", "config-path"],
    ["src/core/doctor.ts → checkProject", "composite"],
    ["2.4.0", "opaque"],
    ["some random words here", "opaque"],
  ];
  for (const [token, expected] of cases) {
    test(`'${token}' → ${expected}`, () => {
      expect(classifySpan(token)?.spanClass).toBe(expected);
    });
  }

  test("excludes artifacts and external URLs at classification time", () => {
    expect(classifySpan("https://example.com/x")?.skipReason).toBe("external");
    expect(classifySpan("dist/bundle.min.js")?.skipReason).toBe("artifact");
    expect(classifySpan("node_modules/left-pad/index.js")?.skipReason).toBe("artifact");
  });
});

describe("doccheck helpers", () => {
  test("normalizeIdent folds separators and case", () => {
    expect(normalizeIdent("Get-User_Name")).toBe(normalizeIdent("getUserName"));
  });
  test("similarity: 1 for identical, high for typos, low for unrelated", () => {
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("getUserNme", "getUserName")).toBeGreaterThan(0.6);
    expect(similarity("aaa", "zzzzzzz")).toBeLessThan(0.6);
  });
  test("globToRegex: * stays in-segment, ** spans and matches zero dirs", () => {
    expect(globToRegex("*.md").test("README.md")).toBe(true);
    expect(globToRegex("*.md").test("docs/a.md")).toBe(false);
    expect(globToRegex("docs/**/*.md").test("docs/a.md")).toBe(true);
    expect(globToRegex("docs/**/*.md").test("docs/x/y/a.md")).toBe(true);
  });
  test("isDocPath marks prose doc artifacts (json is machine config, not prose)", () => {
    expect(isDocPath("README.md")).toBe(true);
    expect(isDocPath("docs/api.xml")).toBe(true);
    expect(isDocPath("docs/reference.rst")).toBe(true);
    expect(isDocPath("tsconfig.json")).toBe(false);
    expect(isDocPath("src/core/doctor.ts")).toBe(false);
  });
});

// ---------------------------------------------------------- extractDocSpans

describe("extractDocSpans", () => {
  test("keeps order and 1-based line numbers", () => {
    const spans = extractDocSpans(docFile("a.md", "first `alphaToken`\nplain\nsecond `betaToken`"));
    expect(spans.map((s) => s.token)).toEqual(["alphaToken", "betaToken"]);
    expect(spans.map((s) => s.line)).toEqual([1, 3]);
    expect(spans.every((s) => s.region === "current")).toBe(true);
  });

  test("fenced blocks become example regions (never findings)", () => {
    const text = "prose `okToken`\n```ts\nconst x = `fencedToken`;\n```\ntail `tailToken`";
    const spans = extractDocSpans(docFile("a.md", text));
    expect(spans.find((s) => s.token === "fencedToken")?.region).toBe("example");
    expect(spans.find((s) => s.token === "tailToken")?.region).toBe("current");
  });

  test("inline ignore marker suppresses its own line and the next", () => {
    const text =
      "keep `keepToken`\n<!-- cidx-doccheck-ignore -->\nhidden `hiddenToken`\nalso `goneToken`\nback `backToken`";
    const tokens = extractDocSpans(docFile("a.md", text)).map((s) => s.token);
    expect(tokens).toContain("keepToken");
    expect(tokens).not.toContain("hiddenToken");
    expect(tokens).toContain("goneToken");
    expect(tokens).toContain("backToken");
  });

  test("a planned heading opens a planned region until the next heading", () => {
    const text =
      "## Done\nreal `realToken`\n## 💡 Proposed\nwish `wishToken`\nmore `moreToken`\n## Other\nback `backToken`";
    const spans = extractDocSpans(docFile("a.md", text));
    expect(spans.find((s) => s.token === "wishToken")?.region).toBe("planned");
    expect(spans.find((s) => s.token === "moreToken")?.region).toBe("planned");
    expect(spans.find((s) => s.token === "backToken")?.region).toBe("current");
  });

  test("historical files mark every span historical", () => {
    const spans = extractDocSpans(docFile("CHANGELOG.md", "## 2.4.0\nadded `someSymbol`", "historical"));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.region).toBe("historical");
  });
});

// ------------------------------------------------ buildDocCheckIndex + scan

describe("buildDocCheckIndex", () => {
  test("indexes symbols per file (full + bare segments)", () => {
    const idx = buildDocCheckIndex([
      chunk("src/a.ts", "class Foo {}", { symbolName: "IndexManager.checkDocs", symbolType: "method" }),
    ]);
    const set = idx.perFileSymbols.get("src/a.ts");
    expect(set?.has("IndexManager.checkDocs")).toBe(true);
    expect(set?.has("checkDocs")).toBe(true);
    expect(idx.symbolNames.has("IndexManager.checkDocs")).toBe(true);
    expect(idx.symbolFiles.get("IndexManager.checkDocs")).toEqual(["src/a.ts"]);
  });

  test("extracts constant literals by value (the INDEX_JOB lesson)", () => {
    const idx = buildDocCheckIndex([chunk("src/j.ts", 'export const INDEX_JOB = "index";\nexport const N = 3;')]);
    expect(idx.constantsByName.get("INDEX_JOB")?.value).toBe("index");
    const byValue = idx.constantsByValue.get("index");
    expect(byValue?.length).toBe(1);
    expect(byValue?.[0]?.name).toBe("INDEX_JOB");
    expect(byValue?.[0]?.path).toBe("src/j.ts");
    expect(byValue?.[0]?.line).toBe(1);
  });

  test("doc artifacts are never evidence or constants", () => {
    const idx = buildDocCheckIndex([
      chunk("README.md", 'const FAKE_CONST = "docvalue";'),
      chunk("docs/api.xml", 'const OTHER_CONST = "x";'),
    ]);
    expect(idx.constantsByName.size).toBe(0);
    const hits = scanDocTokens([chunk("README.md", "someSymbolCall appears here")], ["someSymbolCall"], "ident");
    expect(hits.size).toBe(0);
  });
});

describe("scanDocTokens", () => {
  test("whole-identifier matching: getUser never matches inside getUserName", () => {
    const chunks = [chunk("src/a.ts", "export function getUserName() {}\ngetUser();")];
    const hits = scanDocTokens(chunks, ["getUser", "getUserName"], "ident");
    const getUser = hits.get("getUser")!;
    expect(getUser.length).toBe(1);
    expect(getUser[0]!.line).toBe(2);
    expect(hits.get("getUserName")![0]!.line).toBe(1);
  });

  test("evidence is capped at 3 occurrences with file:line", () => {
    const hits = scanDocTokens([chunk("src/a.ts", "a1 a2 a3 a4 a5")], ["a1", "a2", "a3", "a4", "a5"], "ident");
    for (const t of ["a1", "a2", "a3", "a4", "a5"]) {
      expect(hits.get(t)!.length).toBeLessThanOrEqual(3);
      expect(hits.get(t)![0]!.path).toBe("src/a.ts");
    }
  });

  test("scans in NAME_REGEX_CAP-sized groups — nothing is silently dropped", () => {
    const total = NAME_REGEX_CAP + 50;
    const tokens: string[] = [];
    for (let i = 0; i < total; i++) tokens.push(`zzToken${i}`);
    const hits = scanDocTokens([chunk("src/a.ts", tokens.join(" "))], tokens, "ident");
    expect(hits.size).toBe(total);
  });

  /**
   * The pre-trie scanner, kept here as the reference the fast one must
   * reproduce: one alternation per `NAME_REGEX_CAP`-sized token group, run
   * over every line. It is the definition of the matching semantics (left
   * boundary, longest alternative first, resume after the match), and it is
   * far too slow to use on a real index — hence the differential tests below.
   */
  function referenceScan(
    chunks: readonly DocCheckChunk[],
    tokens: readonly string[],
    style: "ident" | "literal",
  ): Map<string, { path: string; line: number }[]> {
    const sorted = [...new Set(tokens)]
      .filter((t) => t.length > 0 && t.length <= 200)
      .sort((a, b) => b.length - a.length);
    const result = new Map<string, { path: string; line: number }[]>();
    if (sorted.length === 0) return result;
    const left = style === "ident" ? "(?<![A-Za-z0-9_$])" : "(?<![\\w$.@/-])";
    const right = style === "ident" ? "(?![A-Za-z0-9_$])" : "(?![\\w$-])";
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (let gi = 0; gi < sorted.length; gi += NAME_REGEX_CAP) {
      const re = new RegExp(
        `${left}(${sorted
          .slice(gi, gi + NAME_REGEX_CAP)
          .map(escape)
          .join("|")})${right}`,
        "g",
      );
      for (const c of chunks) {
        if (isDocPath(c.filePath) || !c.content) continue;
        const lines = c.content.split("\n");
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
            const ln = c.startLine + i;
            // MAX_EVIDENCE in the engine.
            if (list.length < 3 && !list.some((e) => e.path === c.filePath && e.line === ln)) {
              list.push({ path: c.filePath, line: ln });
            }
            if (m.index === re.lastIndex) re.lastIndex++;
          }
        }
      }
    }
    return result;
  }

  function sortedEntries(hits: Map<string, { path: string; line: number }[]>) {
    return [...hits.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  test("fast scanner is identical to the regex reference on adversarial tokens", () => {
    const cases: { style: "ident" | "literal"; tokens: string[]; text: string }[] = [
      // Prefix pairs: the longer token must win, the shorter must not also match.
      { style: "ident", tokens: ["getUser", "getUserName"], text: "getUserName getUser getUserNameX" },
      // Impure ident tokens (contain a non-identifier char) outrank the run they start in.
      { style: "ident", tokens: ["foo", "foo=bar", "bar"], text: "foo=bar foo bar=x" },
      // Literal boundaries: '.'/'/'/'@' are left-class, so a match can't start after them,
      // but a token may end right before one.
      {
        style: "literal",
        tokens: ["serde_json", "serde_json.1", "a.b", "a.b.c", "docs/status.md", "qwen3:8b", "--last"],
        text: "serde_json.1 serde_json xa.b.c a.b.c a.b see docs/status.md. model=qwen3:8b --last --lastx",
      },
      // Tokens starting outside the left class ('<', '~') still need their own start position.
      {
        style: "literal",
        tokens: ["<placeholder>", "~/.config/x", "x"],
        text: "a=<placeholder> ~/.config/x x=1",
      },
      // Identifier runs split by '.', and '$' which is an identifier char but not a \w char.
      { style: "ident", tokens: ["$state", "state", "run"], text: "this.$state $state2 run.run" },
    ];
    for (const c of cases) {
      const chunks = [chunk("src/a.ts", c.text)];
      expect(sortedEntries(scanDocTokens(chunks, c.tokens, c.style))).toEqual(
        sortedEntries(referenceScan(chunks, c.tokens, c.style)),
      );
    }
  });

  test("fast scanner matches the regex reference on randomized corpora", () => {
    // Deterministic PRNG so a failing round is reproducible.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const alphabet = "abXZ019_.$-/:@=<>() '";
    const wordChars = "abXZ019_$";
    const pick = (s: string) => s[Math.floor(rnd() * s.length)]!;
    const randWord = (max: number) => {
      let out = "";
      const n = 1 + Math.floor(rnd() * max);
      for (let i = 0; i < n; i++) out += pick(wordChars);
      return out;
    };

    for (let round = 0; round < 20; round++) {
      const lines: string[] = [];
      const tokens = new Set<string>();
      for (let l = 0; l < 8; l++) {
        let line = "";
        const words = 1 + Math.floor(rnd() * 4);
        for (let w = 0; w < words; w++) {
          const word = randWord(4);
          // Sprinkle literal-ish glue so tokens with '.', '/', ':', '@' can occur.
          const glue = rnd() < 0.5 ? pick(".$/:@-") : "";
          line += word + glue + (rnd() < 0.3 ? pick(alphabet) : " ");
          if (rnd() < 0.7) tokens.add(rnd() < 0.5 ? word : word + glue);
        }
        lines.push(line);
      }
      // A few tokens that never occur, plus a long-prefix pair.
      tokens.add("neverAppearsAnywhere");
      tokens.add(randWord(3));
      const chunks = [chunk("src/a.ts", lines.join("\n"))];
      for (const style of ["ident", "literal"] as const) {
        const list = [...tokens];
        expect({ round, style, hits: sortedEntries(scanDocTokens(chunks, list, style)) }).toEqual({
          round,
          style,
          hits: sortedEntries(referenceScan(chunks, list, style)),
        });
      }
    }
  });

  test("the cooperative variant yields but returns the identical hits", async () => {
    const chunks = [
      chunk("src/a.ts", "export function getUserName() {}\ngetUser();\ndocs/status.md"),
      chunk("README.md", "getUser is documented here too"),
      chunk("src/b.ts", "const m = 'qwen3-reranker:q8'; // --last"),
    ];
    const idents = ["getUser", "getUserName"];
    const literals = ["docs/status.md", "qwen3-reranker:q8", "--last"];
    for (const [style, tokens] of [
      ["ident", idents],
      ["literal", literals],
    ] as const) {
      const sync = [...scanDocTokens(chunks, tokens, style).entries()].sort();
      // sliceMs 0 forces a yield between every chunk, exercising the sliced path.
      const cooperative = [
        ...(await scanDocTokensCooperative(chunks, tokens, style, { sliceMs: 0 })).entries(),
      ].sort();
      expect(cooperative).toEqual(sync);
    }
  });
});

// ------------------------------------------------------------- checkSpan

describe("checkSpan — identifier", () => {
  test("resolves from the symbol set", () => {
    const state = baseState({
      chunks: [chunk("src/a.ts", "export function myThing() {}", { symbolName: "myThing", symbolType: "function" })],
    });
    expect(checkOne(state, span("myThing", "identifier")).status).toBe("ok");
  });

  test("resolves from a plain occurrence", () => {
    const state = baseState({ chunks: [chunk("src/a.ts", "const myThing = 1;")] });
    expect(checkOne(state, span("myThing", "identifier")).status).toBe("ok");
  });

  test("an unresolved near-miss suggests a rename at 92 (not drift 95)", () => {
    const state = baseState({
      chunks: [chunk("src/a.ts", "export function getUserName() {}", { symbolName: "getUserName", symbolType: "function" })],
    });
    const v = checkOne(state, span("getUserNme", "identifier"));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(92);
    expect(v.suggestion).toBe("getUserName");
  });

  test("generic gates: short lowercase words and acronyms are skipped", () => {
    const state = baseState();
    expect(checkOne(state, span("return", "identifier")).status).toBe("skipped");
    expect(checkOne(state, span("MCP", "identifier")).status).toBe("skipped");
    const acronym = checkOne(state, span("ABCD", "identifier"));
    expect(acronym.status).toBe("review");
  });
});

describe("checkSpan — path", () => {
  test("resolves root-relative, src/-prefixed, doc-relative and unique-suffix paths", () => {
    const state = baseState({
      repoFiles: new Set(["src/core/doctor.ts", "docs/architecture.md"]),
    });
    expect(checkOne(state, span("src/core/doctor.ts", "path")).status).toBe("ok");
    expect(checkOne(state, span("core/doctor.ts", "path")).status).toBe("ok");
    const rel = span("architecture.md", "path", { docRelPath: "docs/guide.md" });
    expect(checkOne(state, rel).status).toBe("ok");
    expect(checkOne(state, span("doctor.ts", "path")).status).toBe("ok");
  });

  test("an ambiguous suffix is suspected (70), never drift", () => {
    const state = baseState({ repoFiles: new Set(["src/a/util.ts", "src/b/util.ts"]) });
    const v = checkOne(state, span("util.ts", "path"));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(70);
    expect(v.evidence?.length).toBeGreaterThan(0);
  });

  test("globs resolve against the indexed file set; an empty glob is an aspiration", () => {
    const state = baseState({ repoFiles: new Set(["src/a.test.ts", "src/b.ts"]) });
    expect(checkOne(state, span("src/*.test.ts", "path")).status).toBe("ok");
    const v = checkOne(state, span("docs/*.mdx", "path"));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(85);
  });

  test("optional config literals and home paths are skipped, real missing paths drift", () => {
    const state = baseState({ repoFiles: new Set(["src/a.ts"]) });
    expect(checkOne(state, span("cidx.yml", "path")).status).toBe("skipped");
    expect(checkOne(state, span("~/.cidx/config.yml", "path")).status).toBe("skipped");
    const v = checkOne(state, span("src/ghost.ts", "path"));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(95);
  });
});

describe("checkSpan — env, endpoint, cmd", () => {
  test("env: resolves in code, skips platform variables, drifts otherwise", () => {
    const state = baseState({ chunks: [chunk("src/c.ts", "process.env.OLLAMA_NUM_CTX")] });
    expect(checkOne(state, span("OLLAMA_NUM_CTX", "env")).status).toBe("ok");
    expect(checkOne(state, span("DISPLAY", "env")).status).toBe("skipped");
    const v = checkOne(state, span("TOTALLY_MADE_UP_VAR", "env"));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(95);
  });

  test("endpoint: every literal route segment must occur in code", () => {
    const state = baseState({ chunks: [chunk("src/s.ts", 'route("/search/batch")\nconst indexes = [];')] });
    expect(checkOne(state, span("POST /search/batch", "endpoint", { parts: ["POST", "/search/batch"] })).status).toBe("ok");
    const v = checkOne(state, span("POST /search/ghostbatch", "endpoint", { parts: ["POST", "/search/ghostbatch"] }));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(93);
    // parameter-only routes have nothing literal to check
    expect(checkOne(state, span("GET /indexes/:name", "endpoint", { parts: ["GET", "/indexes/:name"] })).status).toBe("ok");
  });

  test("endpoint: a hyphenated segment resolves as the quoted route literal", () => {
    // Express-style routes are quoted strings — `bridge-session` is never a
    // whole identifier, so the only resolvable form is the `"/bridge-session"`
    // string in the code.
    const state = baseState({ chunks: [chunk("src/s.ts", 'app.post("/bridge-session", (_req, res) => {});')] });
    expect(checkOne(state, span("POST /bridge-session", "endpoint", { parts: ["POST", "/bridge-session"] })).status).toBe("ok");
    const ghost = checkOne(state, span("POST /ghost-session", "endpoint", { parts: ["POST", "/ghost-session"] }));
    expect(ghost.status).toBe("missing");
    expect(ghost.confidence).toBe(93);
  });

  test("endpoint: a query string is call syntax, not route segments", () => {
    // `GET /events?since=<cursor>` claims the `/events` route exists — the
    // `?since=<cursor>` part must not become a phantom segment.
    const classified = classifySpan("GET /events?since=<cursor>");
    expect(classified?.spanClass).toBe("endpoint");
    expect(classified?.parts).toEqual(["GET", "/events"]);
    const state = baseState({ chunks: [chunk("src/s.ts", 'app.get("/events", (_req, res) => {});')] });
    expect(checkOne(state, span("GET /events?since=<cursor>", "endpoint", { parts: ["GET", "/events"] })).status).toBe("ok");
    // a query on a route that doesn't exist still drifts
    const ghost = checkOne(state, span("GET /ghost?since=<cursor>", "endpoint", { parts: ["GET", "/ghost"] }));
    expect(ghost.status).toBe("missing");
  });

  test("cmd: scripts come from the manifest, path targets resolve through the file set", () => {
    const state = baseState({
      scripts: undefined,
      manifest: { deps: {}, devDeps: {}, scripts: { dev: "watch" } },
      repoFiles: new Set(["src/cli.ts"]),
      chunks: [chunk("src/cli.ts", "export function doccheckCmd() {}", { symbolName: "doccheckCmd", symbolType: "function" })],
    });
    expect(checkOne(state, span("bun run dev", "cmd", { parts: ["bun", "run", "dev"] })).status).toBe("ok");
    const ghost = checkOne(state, span("bun run deploy", "cmd", { parts: ["bun", "run", "deploy"] }));
    expect(ghost.status).toBe("missing");
    expect(ghost.confidence).toBe(92);
    expect(checkOne(state, span("bun run src/cli.ts", "cmd", { parts: ["bun", "run", "src/cli.ts"] })).status).toBe("ok");
  });

  test("cmd: systemd unit names are external artifacts, not identifiers", () => {
    // Regression: `systemctl --user restart cidx.service` was flagged as a hard
    // drift because `cidx.service` is never a whole identifier (it only occurs
    // inside longer message strings in cli.ts / doctor.ts).
    const state = baseState({
      chunks: [chunk("src/cli.ts", "function restart() {} export function doccheckCmd() {}")],
    });
    const v = checkOne(
      state,
      span("systemctl --user restart cidx.service", "cmd", {
        parts: ["systemctl", "--user", "restart", "cidx.service"],
      }),
    );
    expect(v.status).toBe("ok");
    expect(v.confidence).toBe(90);
  });
});

describe("checkSpan — flag, dep, kv, model-tag, composite", () => {
  test("flag: literal occurrence, flag key, camelCase or slug parts resolve it", () => {
    const state = baseState({ chunks: [chunk("src/c.ts", 'flags["max-chars"]\nconst rerank = 1;')] });
    expect(checkOne(state, span("--max-chars", "flag")).status).toBe("ok");
    expect(checkOne(state, span("--rerank", "flag")).status).toBe("ok");
    expect(checkOne(state, span("--help", "flag")).status).toBe("skipped");
    const ghost = checkOne(state, span("--made-up-flag", "flag"));
    expect(ghost.status).toBe("missing");
    expect(ghost.confidence).toBe(92);
  });

  test("dep: manifest membership and version-prefix mismatch semantics", () => {
    const state = baseState({ manifest: { deps: { typescript: "5.9.2" }, devDeps: {}, scripts: {} } });
    expect(checkOne(state, span("typescript@5.9.2", "dep")).status).toBe("ok");
    const wrongVersion = checkOne(state, span("typescript@4.0.0", "dep"));
    expect(wrongVersion.status).toBe("missing");
    expect(wrongVersion.confidence).toBe(80);
    const missing = checkOne(state, span("left-pad@1.0.0", "dep"));
    expect(missing.status).toBe("missing");
    expect(missing.confidence).toBe(80); // suspected — docs name build tools too
  });

  test("kv/config-path resolve by key segments; unresolved keys are suspected, never drift", () => {
    const state = baseState({ chunks: [chunk("src/c.ts", "search mmr lambda")] });
    expect(checkOne(state, span("search.mmr.lambda=0.5", "kv", { parts: ["search.mmr.lambda", "0.5"] })).status).toBe("ok");
    const v = checkOne(state, span("search.mmr.madeup=1", "config-path", { parts: ["search.mmr.madeup", "1"] }));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(85);
  });

  test("model-tag: resolvable tags are ok, unknown ones stay review", () => {
    const state = baseState({ chunks: [chunk("src/c.ts", 'model = "qwen3-embedding:0.6b"')] });
    expect(checkOne(state, span("qwen3-embedding:0.6b", "model-tag")).status).toBe("ok");
    const v = checkOne(state, span("mystery-model:7b", "model-tag"));
    expect(v.status).toBe("review");
    expect(v.confidence).toBeLessThan(90);
  });

  test("composite: path + per-file symbol membership; wrong file is a hard finding", () => {
    const state = baseState({
      repoFiles: new Set(["src/core/doctor.ts", "src/core/other.ts"]),
      chunks: [
        chunk("src/core/other.ts", "export function checkProject() {}", { symbolName: "checkProject", symbolType: "function" }),
      ],
    });
    const wrongFile = span("src/core/doctor.ts → checkProject", "composite", {
      parts: ["src/core/doctor.ts", "checkProject"],
    });
    const v = checkOne(state, wrongFile);
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(94);
    expect(v.message).toContain("src/core/other.ts");
  });
});

// ------------------------------------------------- runDocCheck integration

describe("runDocCheck", () => {
  const codeChunks = [
    chunk("src/core/engine.ts", "export function realEngine() {}\nexport function ghostEngine() {}", {
      symbolName: "realEngine",
      symbolType: "function",
    }),
    chunk("src/core/engine.ts", "export function ghostEngine() {}", {
      startLine: 2,
      symbolName: "ghostEngine",
      symbolType: "function",
    }),
  ];

  test("historical and planned regions never produce findings, only counters", async () => {
    const state = baseState({
      chunks: codeChunks,
      docs: [
        docFile("CHANGELOG.md", "added `ghostSymbol` and `madeUpThing`", "historical"),
        docFile("IDEAS.md", "## 💡 Proposed\nsoon `madeUpThing`\n## Other\nnow `realEngine`"),
      ],
    });
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(report.findings).toHaveLength(0);
    expect(report.checked.skipped.historical).toBe(2);
    expect(report.checked.skipped.planned).toBe(1);
    expect(report.checked.claims).toBe(1);
  });

  test("a missing identifier becomes a drift finding with doc-order ids", async () => {
    const state = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "uses `realEngine`\nalso `madeUpThing`")],
    });
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(report.verdict.consistent).toBe(false);
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0]!;
    expect(f.kind).toBe("identifier");
    expect(f.confidence).toBe(95);
    expect(f.category).toBe("drift");
    expect(f.id).toBe("D-1"); // doc order: realEngine resolved (no id), madeUpThing is the first reported span
    expect(f.doc.line).toBe(2);
  });

  test("identical spans repeated on one line collapse to one finding", async () => {
    // Regression: `NOTICE` appeared twice on README.md:575 (two backtick spans)
    // and produced two byte-identical review findings (D-6/D-7).
    const state = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "`madeUpThing` then `madeUpThing` and `NOTICE` and `NOTICE`")],
    });
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.message).toContain("madeUpThing");
    expect(report.needsReview).toHaveLength(1);
    expect(report.needsReview[0]!.message).toContain("NOTICE");
    // ids stay contiguous after dedupe
    expect(report.findings[0]!.id).toBe("D-1");
    expect(report.needsReview[0]!.id).toBe("D-2");
  });

  test("prose examples land in needsReview, never in findings", async () => {
    const state = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "For example, write paths like `a/b.py` in your config.")],
    });
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(report.findings).toHaveLength(0);
    expect(report.needsReview.length).toBe(1);
    expect(report.needsReview[0]!.category).toBe("review");
  });

  test("the char budget keeps the first finding whole and reports the omission", async () => {
    const state = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "`madeUpThing` then `anotherGhost` then `thirdGhost`")],
    });
    const report = await runDocCheck(state, { noUndocumented: true, maxChars: 10 });
    expect(report.findings.length).toBe(1); // top-1 always kept
    expect(report.omitted).toBe(2);
    expect(report.notes.some((n) => n.includes("omitted"))).toBe(true);
    expect(report.verdict.consistent).toBe(false);
  });

  test("limit truncates findings with a note; consistent stays true only with zero findings", async () => {
    const state = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "`madeUpThing` then `anotherGhost`")],
    });
    const report = await runDocCheck(state, { noUndocumented: true, limit: 1 });
    expect(report.findings).toHaveLength(1);
    expect(report.notes.some((n) => n.includes("limit 1"))).toBe(true);
    const clean = await runDocCheck(baseState({ chunks: codeChunks, docs: [docFile("docs/a.md", "`realEngine`")] }), {
      noUndocumented: true,
    });
    expect(clean.verdict.consistent).toBe(true);
    expect(clean.findings).toHaveLength(0);
  });

  test("checked counters are honest: spans vs claims vs skipped", async () => {
    const state = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "`realEngine` and `madeUpThing` plus `https://x.example` and `2.4.0`")],
    });
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(report.checked.spans).toBe(4);
    expect(report.checked.claims).toBe(2);
    expect(report.checked.skipped.external).toBe(1);
    expect(report.checked.indexFreshness).toBe(1700000000000);
  });

  test("lastFullIndexAt is surfaced separately from the data freshness", async () => {
    const state = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "`realEngine`")],
      lastDataChangeAt: 1700000001000,
      lastFullIndexAt: 1700000000000,
    });
    const report = await runDocCheck(state, { noUndocumented: true });
    // The snapshot includes a watcher write after the last full job.
    expect(report.checked.indexFreshness).toBe(1700000001000);
    expect(report.checked.lastFullIndexAt).toBe(1700000000000);
  });
});

// ------------------------------------------------------ reverse coverage

describe("collectUndocumented", () => {
  const exported = (name: string, relPath = "src/thing.ts"): DocSymbol => ({
    symbolName: name,
    symbolType: "function",
    language: "typescript",
    relativePath: relPath,
    line: 1,
    content: `export function ${name}() {}`,
  });

  test("flags exported symbols never mentioned, sorted and capped", () => {
    const state = baseState({
      exportedSymbols: [exported("alphaOne"), exported("betaTwo"), exported("gammaThree")],
    });
    const idx = buildDocCheckIndex([]);
    const out = collectUndocumented(state, idx, new Set(["betaTwo"]), 2);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.symbolName)).toEqual(["alphaOne", "gammaThree"]);
    expect(out[0]!.confidence).toBe(40);
  });

  test("a bare-segment mention counts as documented; test files and hooks are excluded", () => {
    const state = baseState({
      exportedSymbols: [
        exported("IndexManager.checkDocs"),
        exported("hidden", "tests/x.test.ts"),
        exported("render", "src/ui.ts"),
      ],
    });
    const idx = buildDocCheckIndex([]);
    const out = collectUndocumented(state, idx, new Set(["checkDocs"]), 25);
    expect(out).toHaveLength(0);
  });

  test("noUndocumented disables reverse coverage entirely", async () => {
    const state = baseState({ exportedSymbols: [exported("alphaOne")] });
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(report.undocumented).toHaveLength(0);
  });
});

// -------------------------------------------------------------- docfiles

describe("collectDocFiles", () => {
  test("default set is root *.md plus docs/**, honoring gitignore-style skips", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cidx-doccheck-"));
    try {
      mkdirSync(path.join(dir, "docs", "sub"), { recursive: true });
      mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
      mkdirSync(path.join(dir, "notes"), { recursive: true });
      writeFileSync(path.join(dir, "README.md"), "root");
      writeFileSync(path.join(dir, "docs", "a.md"), "a");
      writeFileSync(path.join(dir, "docs", "sub", "b.md"), "b");
      writeFileSync(path.join(dir, "notes", "other.md"), "n");
      writeFileSync(path.join(dir, "node_modules", "x", "c.md"), "c");
      writeFileSync(path.join(dir, "docs", "ignored.md"), "i");
      writeFileSync(path.join(dir, ".cidxignore"), "ignored.md");
      const res = await collectDocFiles(dir);
      expect(res.files.map((f) => path.relative(dir, f).replace(/\\/g, "/")).sort()).toEqual([
        "README.md",
        "docs/a.md",
        "docs/sub/b.md",
      ]);
      expect(res.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("files/ignore options restrict and exclude the doc set", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cidx-doccheck-"));
    try {
      mkdirSync(path.join(dir, "docs"), { recursive: true });
      writeFileSync(path.join(dir, "README.md"), "r");
      writeFileSync(path.join(dir, "docs", "a.md"), "a");
      writeFileSync(path.join(dir, "docs", "draft.md"), "d");
      const only = await collectDocFiles(dir, { files: ["docs/**/*.md"] });
      expect(only.files.map((f) => path.basename(f)).sort()).toEqual(["a.md", "draft.md"]);
      // Refs are root-anchored: a leading `./` and an absolute path under the
      // root name the same docs (discovery + requestedDocs share this form).
      for (const ref of ["./docs/**/*.md", path.join(dir, "docs/**/*.md")]) {
        const normalized = await collectDocFiles(dir, { files: [ref] });
        expect(normalized.files.map((f) => path.basename(f)).sort()).toEqual(["a.md", "draft.md"]);
      }
      const filtered = await collectDocFiles(dir, { ignore: ["docs/draft.md"] });
      expect(filtered.files.map((f) => path.basename(f)).sort()).toEqual(["README.md", "a.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the 200-file cap is surfaced as truncated", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cidx-doccheck-"));
    try {
      mkdirSync(path.join(dir, "docs"), { recursive: true });
      for (let i = 0; i < DOC_MAX_FILES + 10; i++) writeFileSync(path.join(dir, "docs", `f${i}.md`), "x");
      const res = await collectDocFiles(dir);
      expect(res.files).toHaveLength(DOC_MAX_FILES);
      expect(res.truncated).toBe(true);
      expect(res.scanned).toBe(DOC_MAX_FILES + 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing project root yields an empty discovery, never a throw", async () => {
    const res = await collectDocFiles("/nonexistent/cidx-doccheck-probe");
    expect(res.files).toHaveLength(0);
  });
});

describe("root + manifest helpers", () => {
  test("listRootFiles returns file basenames only", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cidx-doccheck-"));
    try {
      writeFileSync(path.join(dir, "README.md"), "r");
      mkdirSync(path.join(dir, "sub"));
      expect(listRootFiles(dir)).toEqual(["README.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readProjectManifest reads deps/devDeps/scripts and tolerates broken JSON", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cidx-doccheck-"));
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ dependencies: { typescript: "5.9.2" }, scripts: { dev: "watch" } }),
      );
      const m = await readProjectManifest(dir);
      expect(m.deps.typescript).toBe("5.9.2");
      expect(m.scripts.dev).toBe("watch");
      writeFileSync(path.join(dir, "package.json"), "{nope");
      const broken = await readProjectManifest(dir);
      expect(Object.keys(broken.deps)).toHaveLength(0);
      const absent = await readProjectManifest(path.join(dir, "empty"));
      expect(absent.scripts).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
// ------------------------------------------------- 3. the engine (IndexManager)

/**
 * `IndexManager.checkDocs` over a REAL fixture project: the fixture's sqlite
 * registry and LanceDB table live on the throw-away root pinned by the `[test]`
 * preload (see tests/apidiff.test.ts for the full rationale). No Ollama — the
 * vectors are dummies, `check_docs` never embeds.
 */
const { randomUUID } = await import("node:crypto");
const db2 = await import("../src/services/db");
const CFG = (await import("../src/config")).CONFIG;
const { Registry: Registry2 } = await import("../src/core/registry");
const { JobQueue: JobQueue2 } = await import("../src/core/job-queue");
const { IndexManager: IndexManager2 } = await import("../src/core/index-manager");
const { chunkCode: chunkCode2 } = await import("../src/chunking/chunker");
const { isolatedHome: isolatedHome2 } = await import("./helpers/isolated-cidx-home");

describe("IndexManager.checkDocs — engine over a real fixture", () => {
  const HOME2 = isolatedHome2;
  const PROJECT = mkdtempSync(path.join(os.tmpdir(), "cidx-doccheck-proj-"));
  const DB_PATH2 = path.join(HOME2, `doccheck-${randomUUID()}.db`);
  const TABLE = "idx_doccheck_fixture";
  const LAST_INDEXED_AT = 1700000000000;

  const README = [
    "# Fixture",
    "",
    "Startup calls `madeUpGhostFn` before the engine boots.",
    "Everything funnels through `realEngine`.",
    "",
    "See `src/lib.ts` for the details.",
  ].join("\n");

  const LIB = [
    "export function realEngine(input: string): string {",
    "  return input.trim();",
    "}",
  ].join("\n");

  let registry2: InstanceType<typeof Registry2>;
  let manager2: InstanceType<typeof IndexManager2>;

  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(HOME2)).toBe(true);
    await db2.initDB();
    mkdirSync(path.join(PROJECT, "docs"), { recursive: true });
    mkdirSync(path.join(PROJECT, "src"), { recursive: true });
    writeFileSync(path.join(PROJECT, "README.md"), README);
    writeFileSync(path.join(PROJECT, "docs", "guide.md"), "# Guide\nUse `realEngine` everywhere.\n");
    writeFileSync(path.join(PROJECT, "src", "lib.ts"), LIB);

    registry2 = new Registry2(DB_PATH2);
    registry2.upsertIndex({
      name: "docfix",
      path: PROJECT,
      tableName: TABLE,
      status: "ready",
      fileCount: 1,
      chunkCount: 1,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: LAST_INDEXED_AT,
      createdAt: 1,
      error: null,
    });
    registry2.setFileMtime("docfix", path.join(PROJECT, "src", "lib.ts"), 1);

    const abs = path.join(PROJECT, "src", "lib.ts");
    const chunks = await chunkCode2(abs, LIB);
    await db2.insertChunks(
      TABLE,
      chunks.map((c, i) => ({
        id: `lib.ts#${i}`,
        filePath: abs,
        content: c.content,
        vector: [0.1, 0.2, 0.3],
        language: c.language ?? null,
        symbolName: c.symbolName ?? null,
        symbolType: c.symbolType ?? null,
        startLine: c.startLine,
        endLine: c.endLine,
        doc: null,
        doc_vector: null,
        id_terms: null,
      })),
    );
    manager2 = new IndexManager2(registry2, new JobQueue2());
  });

  afterAll(() => {
    manager2?.stopAll?.();
    registry2?.close();
    rmSync(DB_PATH2, { force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("resolves a real project from a path and finds the planted drift", async () => {
    const report = await manager2.checkDocs({ path: PROJECT, noUndocumented: true });
    expect(report.project).toBe("docfix");
    expect(report.checked.docs).toBe(2); // README.md + docs/guide.md
    expect(report.verdict.consistent).toBe(false);
    const drift = report.findings.find((f) => f.kind === "identifier");
    expect(drift).toBeDefined();
    expect(drift!.message).toContain("madeUpGhostFn");
    expect(drift!.doc.path).toBe("README.md");
    // The resolvable claims really resolved:
    expect(report.checked.claims).toBeGreaterThanOrEqual(2);
  });

  test("surfaces index freshness and the source path claim", async () => {
    const report = await manager2.checkDocs({ path: PROJECT, noUndocumented: true });
    expect(report.checked.indexFreshness).toBe(LAST_INDEXED_AT);
    const pathClaim = report.findings.filter((f) => f.kind === "path");
    expect(pathClaim).toHaveLength(0); // src/lib.ts resolves via the cached file set
  });

  test("unknown project name throws, like every other engine entry point", async () => {
    await expect(manager2.checkDocs({ project: "does-not-exist" })).rejects.toThrow("Index not found");
  });

  test("a project with no markdown yields a valid empty report, not a crash", async () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), "cidx-doccheck-bare-"));
    try {
      registry2.upsertIndex({
        name: "docbare",
        path: bare,
        tableName: "idx_doccheck_bare",
        status: "ready",
        fileCount: 0,
        chunkCount: 0,
        embedModel: null,
        embedDim: null,
        lastIndexedAt: null,
        createdAt: 1,
        error: null,
      });
      const report = await manager2.checkDocs({ project: "docbare" });
      expect(report.checked.docs).toBe(0);
      expect(report.checked.spans).toBe(0);
      expect(report.verdict.consistent).toBe(true);
      expect(report.checked.indexFreshness).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("the drift window degrades to a full scan with a note on a non-repo project", async () => {
    const report = await manager2.checkDocs({ path: PROJECT, noUndocumented: true, window: true });
    expect(report.notes.some((n) => n.includes("not a git repo"))).toBe(true);
    expect(report.checked.window).toBeUndefined();
    expect(report.findings.length).toBe(1); // nothing was filtered away
  });

  test("judge unconfigured → no probe, no judge block, report byte-identical (D1b default)", async () => {
    // The test process runs with doccheck.judgeModel unset, so availability is
    // false-by-config and checkDocs must not touch the backend at all.
    expect(await manager2.ensureJudgeAvailable()).toBe(false);
    const report = await manager2.checkDocs({ path: PROJECT, noUndocumented: true });
    expect(Object.prototype.hasOwnProperty.call(report.checked, "judge")).toBe(false);
    expect(report.notes.every((n) => !n.includes("judge"))).toBe(true);
  });
});

// --------------------------------------------- live-run adjudication lessons

describe("checkPath — vocabulary/convention gates (live-run lessons)", () => {
  test("a bare extension mention is vocabulary, not an existence claim", () => {
    const state = baseState({ repoFiles: new Set(["src/a.ts"]) });
    for (const ext of [".md", ".json", ".xml", ".rst", ".gd", ".tscn", ".tres", ".godot"]) {
      const v = checkOne(state, span(ext, "path"));
      expect(v.status).toBe("skipped");
      expect(v.skipReason).toBe("external");
    }
  });

  test(".git paths, unresolved hidden files and URI-style paths are skipped", () => {
    const state = baseState({ repoFiles: new Set(["src/a.ts"]) });
    expect(checkOne(state, span(".git/HEAD", "path")).status).toBe("skipped");
    expect(checkOne(state, span(".cidx.json", "path")).status).toBe("skipped");
    expect(checkOne(state, span("/ping", "path")).status).toBe("skipped");
    expect(checkOne(state, span("/api/generate", "path")).status).toBe("skipped");
    // …but a hidden file that DOES exist still resolves:
    expect(checkOne(state, span(".gitignore", "path", { docRelPath: "" })).status).toBe("skipped");
  });

  test("convention files of supported projects are skipped; real extensions keep drift", () => {
    const state = baseState({ repoFiles: new Set(["src/a.ts"]) });
    expect(checkOne(state, span("project.godot", "path")).status).toBe("skipped");
    const ghost = checkOne(state, span("src/ghost.ts", "path"));
    expect(ghost.status).toBe("missing");
    expect(ghost.confidence).toBe(95);
  });

  test("an extension-less unresolved relative path is suspected, never drift", () => {
    const state = baseState({ repoFiles: new Set(["src/a.ts"]) });
    const v = checkOne(state, span("tools/list", "path"));
    expect(v.status).toBe("missing");
    expect(v.confidence).toBe(70);
  });

  test("files the indexer never indexed still resolve (the path universe is the repo)", () => {
    const state = baseState({ repoFiles: new Set(["scripts/build-wasm.sh", "src/chunking/wasm/g.wasm"]) });
    expect(checkOne(state, span("scripts/build-wasm.sh", "path")).status).toBe("ok");
    expect(checkOne(state, span("src/chunking/wasm/", "path")).status).toBe("ok");
  });
});

describe("adjudication lessons — dep ranges, env assignments, proposal files", () => {
  test("a caret range satisfies the pinned version it documents", () => {
    const state = baseState({ manifest: { deps: { "tree-sitter-wasms": "^0.1.13" }, devDeps: {}, scripts: {} } });
    expect(checkOne(state, span("tree-sitter-wasms@0.1.13", "dep")).status).toBe("ok");
    expect(checkOne(state, span("tree-sitter-wasms@0.1.14", "dep")).status).toBe("missing");
  });

  test("an ALL-CAPS assignment is checked as an environment variable", () => {
    const state = baseState();
    const v = checkOne(state, span('CUDA_VISIBLE_DEVICES=""', "kv", { parts: ["CUDA_VISIBLE_DEVICES", '""'] }));
    expect(v.status).toBe("skipped");
    expect(v.skipReason).toBe("external");
  });

  test("proposal/roadmap files are aspirational — never accused", async () => {
    // The daemon assigns fileClass via HISTORICAL_FILE_RE; mirror that here.
    const rel = "docs/proposals.md";
    expect(HISTORICAL_FILE_RE.test(rel)).toBe(true);
    const file = docFile(rel, "## D-next\nwill add `madeUpPlannedThing` in `src/core/future.ts`", "historical");
    const spans = extractDocSpans(file);
    expect(spans.every((s) => s.region === "historical")).toBe(true);
    const state = baseState({ docs: [file], chunks: [chunk("src/x.ts", "const q = 1;")] });
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(report.findings).toHaveLength(0);
    expect(report.checked.skipped.historical).toBe(2);
  });
});

// ------------------------------------------------- semantic judge (D1b)

describe("runDocCheck — semantic judge (D1b)", () => {
  const codeChunks = [
    chunk("src/core/engine.ts", "export function realEngine() {}", {
      symbolName: "realEngine",
      symbolType: "function",
    }),
  ];

  /**
   * A state whose deterministic run leaves exactly one needsReview claim:
   * `tools/list` is an extension-less unresolved relative path → missing, 70
   * (suspected). `madeUpThing` on the same line is a 95-confidence drift
   * finding — the judge must never touch findings.
   */
  const state = baseState({
    chunks: codeChunks,
    docs: [docFile("docs/a.md", "Run `tools/list` from the root and see `madeUpThing` too.")],
  });

  /** A judge that records what it is asked and always answers with the given verdict. */
  function recordingJudge(
    verdict: { consistent: boolean; confidence: number } | null,
  ): { judge: DocJudge; claims: DocJudgeClaim[]; contexts: DocJudgeContext[] } {
    const claims: DocJudgeClaim[] = [];
    const contexts: DocJudgeContext[] = [];
    const judge: DocJudge = async (claim, context) => {
      claims.push(claim);
      contexts.push(context);
      return verdict;
    };
    return { judge, claims, contexts };
  }

  test("no judge → no checked.judge block, byte-identical output (config default off)", async () => {
    const report = await runDocCheck(state, { noUndocumented: true });
    expect(Object.prototype.hasOwnProperty.call(report.checked, "judge")).toBe(false);
    expect(JSON.stringify(report)).not.toContain('"judge"');
    // Unchanged behavior: the drift finding stays, the suspected claim stays.
    expect(report.findings).toHaveLength(1);
    expect(report.needsReview).toHaveLength(1);
    // Pure: two identical runs are byte-for-byte identical.
    const again = await runDocCheck(state, { noUndocumented: true });
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  test("high-confidence consistent → the claim drops out of needsReview and is counted", async () => {
    const { judge, claims, contexts } = recordingJudge({ consistent: true, confidence: 0.9 });
    const report = await runDocCheck(state, {
      noUndocumented: true,
      judge,
      judgeModel: "test-judge",
    });
    expect(report.needsReview).toHaveLength(0);
    const j = report.checked.judge!;
    expect(j).toEqual({ model: "test-judge", available: true, judged: 1, resolved: 1, failed: 0 });
    // The drift finding is untouched — the judge never accuses.
    expect(report.findings).toHaveLength(1);
    expect(report.verdict.consistent).toBe(false);
    // The judge saw the real claim as plain data (span + deterministic verdict).
    expect(claims).toHaveLength(1);
    const c = claims[0]!;
    expect(c.token).toBe("tools/list");
    expect(c.spanClass).toBe("path");
    expect(c.status).toBe("missing");
    expect(c.confidence).toBe(70);
    expect(c.doc).toEqual({ path: "docs/a.md", line: 1, excerpt: "Run `tools/list` from the root and see `madeUpThing` too." });
    expect(contexts[0]!.project).toBe("t");
    expect(contexts[0]!.surrounding).toContain("Run `tools/list` from the root and see `madeUpThing` too.");
  });

  test("low-confidence consistent stays in needsReview", async () => {
    const { judge } = recordingJudge({ consistent: true, confidence: 0.55 });
    const report = await runDocCheck(state, { noUndocumented: true, judge, judgeModel: "m" });
    expect(report.needsReview).toHaveLength(1);
    expect(report.checked.judge).toEqual({ model: "m", available: true, judged: 1, resolved: 0, failed: 0 });
  });

  test("a verdict at exactly JUDGE_CONFIRM_MIN resolves; below it does not", async () => {
    const at = recordingJudge({ consistent: true, confidence: JUDGE_CONFIRM_MIN });
    const ok = await runDocCheck(state, { noUndocumented: true, judge: at.judge });
    expect(ok.checked.judge!.resolved).toBe(1);
    const below = recordingJudge({ consistent: true, confidence: JUDGE_CONFIRM_MIN - 0.01 });
    const kept = await runDocCheck(state, { noUndocumented: true, judge: below.judge });
    expect(kept.checked.judge!.resolved).toBe(0);
    expect(kept.needsReview).toHaveLength(1);
  });

  test("high-confidence inconsistent stays in needsReview — never escalated to drift", async () => {
    const { judge } = recordingJudge({ consistent: false, confidence: 0.99 });
    const report = await runDocCheck(state, { noUndocumented: true, judge });
    expect(report.needsReview).toHaveLength(1);
    expect(report.findings).toHaveLength(1); // only the deterministic drift
    expect(report.checked.judge!.resolved).toBe(0);
    expect(report.checked.judge!.failed).toBe(0);
  });

  test("judge returns null (no opinion) → the claim stays", async () => {
    const { judge } = recordingJudge(null);
    const report = await runDocCheck(state, { noUndocumented: true, judge });
    expect(report.needsReview).toHaveLength(1);
    expect(report.checked.judge).toEqual({ model: "", available: true, judged: 1, resolved: 0, failed: 0 });
  });

  test("a throwing judge fails honestly: note + unchanged report", async () => {
    const judgeThrows: DocJudge = async () => {
      throw new Error("judge offline");
    };
    const report = await runDocCheck(state, { noUndocumented: true, judge: judgeThrows, judgeModel: "m" });
    expect(report.needsReview).toHaveLength(1);
    expect(report.findings).toHaveLength(1); // findings unchanged by the failure
    expect(report.checked.judge!.failed).toBe(1);
    expect(report.notes).toContain("1 semantic judge call(s) failed; those claim(s) stay in needsReview");
  });

  test("prose-example claims are never judged (the intent shield stands)", async () => {
    const { judge, claims } = recordingJudge({ consistent: true, confidence: 0.95 });
    const exampleState = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "For example, write paths like `a/b.py` in your config.")],
    });
    const report = await runDocCheck(exampleState, { noUndocumented: true, judge, judgeModel: "m" });
    expect(claims).toHaveLength(0);
    expect(report.checked.judge!.judged).toBe(0);
    expect(report.needsReview).toHaveLength(1); // the example stays advice, unchanged
  });

  test("configured but unavailable → honest block with zero counters", async () => {
    const report = await runDocCheck(state, { noUndocumented: true, judgeModel: "absent-model" });
    expect(report.checked.judge).toEqual({
      model: "absent-model",
      available: false,
      judged: 0,
      resolved: 0,
      failed: 0,
    });
    expect(report.needsReview).toHaveLength(1);
  });

  test("deterministic with a fixed judge (bounded concurrency, input-ordered)", async () => {
    // Two uncertain claims → two judge calls; a verdict-per-token policy keeps
    // the whole run reproducible.
    const judge: DocJudge = async (claim) =>
      claim.token === "tools/list" ? { consistent: true, confidence: 0.9 } : { consistent: true, confidence: 0.2 };
    const state2 = baseState({
      chunks: codeChunks,
      docs: [docFile("docs/a.md", "uses `tools/list` or `FOOBA`")],
    });
    const one = await runDocCheck(state2, { noUndocumented: true, judge, judgeModel: "m" });
    const two = await runDocCheck(state2, { noUndocumented: true, judge, judgeModel: "m" });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
    expect(one.checked.judge!.judged).toBe(2);
    expect(one.checked.judge!.resolved).toBe(1); // only tools/list crossed the threshold
    expect(one.needsReview.map((f) => f.id)).toEqual(["D-2"]); // FOOBA (review 50) stayed
  });

  test("the judge sees the surrounding doc lines, capped per line", async () => {
    const long = "x".repeat(400);
    const doc = docFile("docs/a.md", ["before one", "before two", `claims \`tools/list\` after ${long}`, "after two", "after three"].join("\n"));
    const { judge, contexts } = recordingJudge({ consistent: false, confidence: 0.9 });
    await runDocCheck(baseState({ chunks: codeChunks, docs: [doc] }), { noUndocumented: true, judge });
    expect(contexts).toHaveLength(1);
    const surrounding = contexts[0]!.surrounding;
    expect(surrounding).toHaveLength(5); // ±2 around line 3, claim line included
    expect(surrounding[2]!.startsWith(`claims \`tools/list\` after ${"x".repeat(206)}`)).toBe(true);
    expect(surrounding[2]!.endsWith("…")).toBe(true);
    expect(surrounding[0]).toBe("before one");
    expect(surrounding[4]).toBe("after three");
  });
});

// ------------------------------------------------- requested-doc resolution

describe("resolveRequestedDocs — the non-silent requested doc feedback", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cidx-reqdocs-"));
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "README.md"), "# d\n");
    writeFileSync(path.join(root, "docs/PLAN.md"), "# p\n");
    writeFileSync(path.join(root, "notes.txt"), "on disk, not a doc include\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const matched = () => new Set<string>([path.join(root, "README.md"), path.join(root, "docs/PLAN.md")]);

  test("each status is assigned where the checker was silent before", () => {
    const res = resolveRequestedDocs(
      ["README.md", "docs/PLAN.md", "docs/NOPE.md", "../outside.md"],
      root,
      matched(),
    );
    expect(res).toEqual([
      { ref: "README.md", status: "matched" },
      { ref: "docs/PLAN.md", status: "matched" },
      { ref: "docs/NOPE.md", status: "missing" },
      { ref: "../outside.md", status: "outsideRoot" },
    ]);
  });

  test("on-disk-but-not-discovered is 'filtered'; outside-root wins even if missing", () => {
    const res = resolveRequestedDocs(["notes.txt", "../definitely-not-here.md"], root, matched());
    // On disk inside the root, but not in the discovered doc set (not a doc
    // include) — the ref the discovery silently dropped before this existed.
    expect(res[0]).toEqual({ ref: "notes.txt", status: "filtered" });
    expect(res[1]).toEqual({ ref: "../definitely-not-here.md", status: "outsideRoot" });
    // An absolute ref INSIDE the root resolves like its relative form.
    expect(resolveRequestedDocs([path.join(root, "docs/PLAN.md")], root, matched())[0])
      .toEqual({ ref: path.join(root, "docs/PLAN.md"), status: "matched" });
  });

  test("include globs (the documented `files` form) resolve as matched, not missing", () => {
    const walked = new Set(["notes.txt"]);
    const res = resolveRequestedDocs(
      ["*.md", "docs/**/*.md", "docs/**/*.mdx", "./docs/*.md"],
      root,
      matched(),
      walked,
    );
    expect(res).toEqual([
      { ref: "*.md", status: "matched" },
      { ref: "docs/**/*.md", status: "matched" },
      // A glob the walk sees nothing for is still honestly reported.
      { ref: "docs/**/*.mdx", status: "missing" },
      // The walker normalises a leading `./`; the feedback must agree.
      { ref: "./docs/*.md", status: "matched" },
    ]);
    // An absolute glob inside the root resolves like its relative form.
    const absGlob = path.join(root, "docs/**/*.md");
    expect(resolveRequestedDocs([absGlob], root, matched(), walked)[0])
      .toEqual({ ref: absGlob, status: "matched" });
  });

  test("a glob naming only walked-but-undiscovered files is 'filtered'; out-of-root globs never match", () => {
    expect(resolveRequestedDocs(["*.txt"], root, matched(), new Set(["notes.txt"]))[0])
      .toEqual({ ref: "*.txt", status: "filtered" });
    expect(resolveRequestedDocs(["../docs/**/*.md"], root, matched())[0])
      .toEqual({ ref: "../docs/**/*.md", status: "outsideRoot" });
  });
});
