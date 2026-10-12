/**
 * Query expansion (proposal S4) — the pure legs and the wire client.
 *
 * 1. Prompt: tight instruct form, names the identifier-shaped variant and the
 *    rephrased one, demands strict JSON.
 * 2. Parser/sanitizer: strict-JSON contract with a fenced/prose-wrapped
 *    salvage; any failure → empty variant list + reason (retry-free
 *    degradation), never a throw.
 * 3. Wire client: the two backend shapes (Ollama /api/generate, llama.cpp
 *    /v1/completions) over a fake fetch — no live backend anywhere. Failures
 *    degrade to `{ variants: [], error }`.
 * 4. Merge: weighted RRF — the original ranking (weight 1, first list) alone
 *    outranks any single variant's (0.5); corroboration still promotes.
 * 5. Envelope note rendering: blame (C4) stays byte-identical; expansion
 *    (S4) renders its own fragment.
 */
import { describe, test, expect } from "bun:test";

import {
  expandPrompt,
  parseExpandVariants,
  expandVariantsVia,
  expandQuery,
  expandConfig,
  setExpandConfig,
  mergeVariantRankings,
  EXPAND_VARIANT_WEIGHT,
} from "../src/services/expand";
import { rrfMerge } from "../src/utils/rrf";
import { setEmbedBackend, resetEmbedBackend } from "../src/services/embed";
import { CONFIG } from "../src/config";
import { formatBlameNote, formatExpandNote, formatEnvelopeNotes, formatResults } from "../src/server/format";

// -------------------------------------------------------------- 1. the prompt

describe("expandPrompt", () => {
  test("carries the query and the two variant kinds in an instruct form", () => {
    const p = expandPrompt("auth check middleware");
    expect(p).toContain("auth check middleware");
    expect(p).toContain("snake_case or camelCase");
    expect(p).toContain("rephrased".slice(0, 4)); // rephrasing instruction present
    expect(p).toContain("STRICT JSON");
    expect(p).toContain('{"variants"');
    expect(p.endsWith("JSON:")).toBe(true);
  });
});

// ---------------------------------------------------- 2. the parser/sanitizer

describe("parseExpandVariants", () => {
  test("plain strict-JSON response", () => {
    const r = parseExpandVariants('{"variants":["auth_check_middleware","middleware check","auth"]}', "auth check middleware", 3);
    expect(r.variants).toEqual(["auth_check_middleware", "middleware check", "auth"]);
    expect(r.error).toBeUndefined();
  });

  test("code-fenced JSON is stripped before parsing", () => {
    const r = parseExpandVariants('```json\n{"variants":["a_var","retry alpha"]}\n```', "alpha retry", 3);
    expect(r.variants).toEqual(["a_var", "retry alpha"]);
  });

  test("JSON embedded in stray prose is salvaged (brace-balanced span)", () => {
    const r = parseExpandVariants('Sure! {"variants":["x_var","y"]}" hope that helps', "q", 3);
    expect(r.variants).toEqual(["x_var", "y"]);
  });

  test("variants are trimmed; empties and string-adjacent junk dropped", () => {
    const r = parseExpandVariants('{"variants":["  spaced  ","", "  ", 42, null, "ok_var"]}', "q", 3);
    expect(r.variants).toEqual(["spaced", "ok_var"]);
  });

  test("duplicates of each other and of the ORIGINAL are dropped (case/whitespace-insensitive)", () => {
    const r = parseExpandVariants(
      '{"variants":["Auth Check Middleware","  auth  check   middleware ","auth_check_middleware","auth_check_middleware","two"]}',
      "Auth Check Middleware",
      3,
    );
    // The identifier-shaped rendering of the original is KEPT (that is variant
    // kind 1); only the literal echo (folded case + whitespace) is a duplicate.
    expect(r.variants).toEqual(["auth_check_middleware", "two"]);
  });

  test("capped at maxVariants", () => {
    const r = parseExpandVariants('{"variants":["a","b","c","d","e"]}', "q", 3);
    expect(r.variants).toEqual(["a", "b", "c"]);
  });

  test("a cap of 0 yields the no-usable-variants error (honest, not a throw)", () => {
    const r = parseExpandVariants('{"variants":["a","b"]}', "q", 0);
    expect(r.variants).toEqual([]);
    expect(r.error).toContain("no usable variants");
  });

  test("non-JSON text → empty variants + reason", () => {
    for (const raw of ["", "no json here", "```plain\ntext\n```", '{"nope":1}', "[1,2,3]"]) {
      const r = parseExpandVariants(raw, "q", 3);
      expect(r.variants).toEqual([]);
      expect(r.error).toBeDefined();
    }
  });

  test("malformed JSON inside balanced braces → error mentions the parse failure", () => {
    const r = parseExpandVariants('{"variants":["a" "b"]}', "q", 3);
    expect(r.variants).toEqual([]);
    expect(r.error).toContain("invalid JSON");
  });

  test("an unterminated object is not salvaged", () => {
    const r = parseExpandVariants('{"variants":["a"', "q", 3);
    // Brace-scan finds no CLOSE → extract returns null → the no-JSON error.
    expect(r.error).toContain("no JSON object");
  });

  test("an unbalanced quote inside a string does not end the object scan early", () => {
    const r = parseExpandVariants('{"variants":["say \\"hi\\" ok","b"]}', "q", 3);
    expect(r.variants).toEqual(['say "hi" ok', "b"]);
  });
});

// --------------------------------------------------------- 3. the wire client

const WIRE_CFG = { model: "test-expander", url: "", maxVariants: 3, timeoutMs: 1000 };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("expandVariantsVia (fake fetch, both backend shapes)", () => {
  test("ollama shape: POST /api/generate, template-applied generate with pinned num_ctx", async () => {
    const calls: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(input), body });
      return jsonResponse({ response: '{"variants":["sym_form","other words"]}' });
    }) as typeof fetch;
    try {
      const r = await expandVariantsVia("ollama", "http://127.0.0.1:11434", expandPrompt("parse config"), WIRE_CFG, "parse config");
      expect(r.variants).toEqual(["sym_form", "other words"]);
      expect(r.error).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/generate");
    expect(calls[0]!.body.model).toBe("test-expander");
    expect(calls[0]!.body.stream).toBe(false);
    expect(calls[0]!.body.options.temperature).toBe(0);
    expect(calls[0]!.body.options.num_ctx).toBe(CONFIG.OLLAMA_NUM_CTX);
    expect(calls[0]!.body.options.num_predict).toBeGreaterThan(0);
    expect(calls[0]!.body.prompt).toContain("Query: parse config");
  });

  test("llamacpp shape: POST /v1/completions with max_tokens, answer read from choices[0].text", async () => {
    const calls: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(input), body });
      return jsonResponse({ choices: [{ text: '{"variants":["ctx_var","rephrased thing"]}' }] });
    }) as typeof fetch;
    try {
      const r = await expandVariantsVia("llamacpp", "http://127.0.0.1:8080", "prompt", WIRE_CFG, "q");
      expect(r.variants).toEqual(["ctx_var", "rephrased thing"]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/v1/completions");
    expect(calls[0]!.body.max_tokens).toBeGreaterThan(0);
    expect(calls[0]!.body.temperature).toBe(0);
  });

  test("an HTTP error degrades to { variants: [], error } on both backends", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({ x: 1 }, 503)) as typeof fetch;
    try {
      const ollama = await expandVariantsVia("ollama", "http://x", "p", WIRE_CFG, "q");
      expect(ollama).toEqual({ variants: [], error: "expand /api/generate HTTP 503" });
      const llama = await expandVariantsVia("llamacpp", "http://x", "p", WIRE_CFG, "q");
      expect(llama).toEqual({ variants: [], error: "llama-server /v1/completions HTTP 503" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a model answer that is not the contract degrades the same way", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({ response: "I refuse to speak JSON." })) as typeof fetch;
    try {
      const r = await expandVariantsVia("ollama", "http://x", "p", WIRE_CFG, "q");
      expect(r.variants).toEqual([]);
      expect(r.error).toContain("no JSON object");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a dropped connection degrades too (never throws)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    try {
      const r = await expandVariantsVia("ollama", "http://x", "p", WIRE_CFG, "q");
      expect(r.variants).toEqual([]);
      expect(r.error).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("expandQuery (config + backend resolution)", () => {
  test("no configured model short-circuits WITHOUT any network call", async () => {
    setExpandConfig({ model: "", url: "", maxVariants: 3, timeoutMs: 100 });
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      throw new Error("must not be called");
    }) as typeof fetch;
    try {
      const r = await expandQuery("anything");
      expect(r.variants).toEqual([]);
      expect(r.error).toContain("no expansion model is configured");
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      setExpandConfig(null);
    }
  });

  test("an empty search.expand.url follows the resolved embedding backend", async () => {
    setExpandConfig({ model: "test-expander", url: "", maxVariants: 2, timeoutMs: 1000 });
    setEmbedBackend({ provider: "ollama", url: "http://127.0.0.1:41234", reason: "explicit" });
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      urls.push(String(input));
      return jsonResponse({ response: '{"variants":["one"]}' });
    }) as typeof fetch;
    try {
      const r = await expandQuery("some query");
      expect(r.variants).toEqual(["one"]);
      expect(urls[0]).toBe("http://127.0.0.1:41234/api/generate");
    } finally {
      globalThis.fetch = realFetch;
      resetEmbedBackend();
      setExpandConfig(null);
    }
  });

  test("setExpandConfig pins expandConfig() and resets back to the CONFIG block", () => {
    setExpandConfig({ model: "pinned", url: "http://pinned", maxVariants: 7, timeoutMs: 5 });
    expect(expandConfig()).toEqual({ model: "pinned", url: "http://pinned", maxVariants: 7, timeoutMs: 5 });
    setExpandConfig(null);
    expect(expandConfig().model).toBe(CONFIG.EXPAND_MODEL);
    expect(expandConfig().maxVariants).toBe(CONFIG.EXPAND_MAX_VARIANTS);
  });
});

// ------------------------------------------------------------------ 4. merge

describe("mergeVariantRankings (weighted RRF, original dominance)", () => {
  const keyOf = (r: { id: string }) => r.id;

  test("the original query's rank-1 outranks a variant-only rank-1", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const merged = mergeVariantRankings([[a], [b]], keyOf);
    expect(merged.map((m) => m.item.id)).toEqual(["a", "b"]);
    expect(merged[0]!.score).toBeCloseTo(1 / 61, 8);
    expect(merged[1]!.score).toBeCloseTo(EXPAND_VARIANT_WEIGHT / 61, 8);
  });

  test("dedup keeps the ORIGINAL list's item object; corroborated score adds up", () => {
    const a1 = { id: "x", from: "orig" };
    const a2 = { id: "x", from: "variant" };
    const merged = mergeVariantRankings([[a1], [a2]], keyOf);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.item).toBe(a1);
    expect(merged[0]!.score).toBeCloseTo((1 + EXPAND_VARIANT_WEIGHT) / 61, 8);
  });

  test("corroboration promotes: original rank-2 + variant rank-1 beats an uncorroborated rank-1", () => {
    const x = { id: "x" };
    const y = { id: "y" };
    const z = { id: "z" };
    // original [x, y, z]; one variant [y] → y: 1/62 + 0.5/61 ≈ 0.0243 > x: 1/61
    const merged = mergeVariantRankings([[x, y, z], [y]], keyOf);
    expect(merged.map((m) => m.item.id)).toEqual(["y", "x", "z"]);
  });

  test("three variants agreeing at rank 1 beat an uncorroborated original rank-1 (documented rule)", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const merged = mergeVariantRankings([[a], [b], [b], [b]], keyOf);
    expect(merged.map((m) => m.item.id)).toEqual(["b", "a"]);
    expect(merged[0]!.score).toBeCloseTo((3 * EXPAND_VARIANT_WEIGHT) / 61, 8);
  });

  test("the original is always lists[0] so stable ties resolve to it", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    // Unweighted RRF ties at 1/61 → the first-listed list's item stays first.
    expect(rrfMerge([[a], [b]], keyOf)[0]!.item).toBe(a);
  });

  test("rrfMerge weights: a demoted first list can lose to a weighted second", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const merged = rrfMerge([[a], [b]], keyOf, 60, [0.5, 1]);
    expect(merged.map((m) => m.item.id)).toEqual(["b", "a"]);
  });

  test("empty variant lists are safe (merge falls back to the base order)", () => {
    const a = { id: "a" };
    const merged = mergeVariantRankings([[a], []], keyOf);
    expect(merged.map((m) => m.item.id)).toEqual(["a"]);
    expect(merged[0]!.score).toBeCloseTo(1 / 61, 8);
  });
});

// -------------------------------------------------------- 5. envelope notes

describe("envelope note rendering", () => {
  test("blame-only output is unchanged from formatBlameNote (C4 byte-compat)", () => {
    expect(formatEnvelopeNotes({ blameNotARepo: true })).toBe(formatBlameNote({ blameNotARepo: true }));
    expect(formatBlameNote({ blameSkipped: 2 })).toBe("⚠ blame: 2 more file(s) skipped by the per-search blame cap (≤8)");
    expect(formatEnvelopeNotes({ blameSkipped: 2 })).toBe(formatBlameNote({ blameSkipped: 2 }));
  });

  test("expansion-only: the merged count and the degrade reason each render once", () => {
    expect(formatEnvelopeNotes({ expanded: 2 })).toBe(
      "⚠ expand: 2 expansion variant ranking(s) merged into this result (the original query keeps rank dominance)",
    );
    expect(formatEnvelopeNotes({ expanded: 0, expandNote: "query expansion did not run (boom) — results are the plain base search" })).toBe(
      "⚠ expand: query expansion did not run (boom) — results are the plain base search",
    );
    expect(formatExpandNote({ expanded: 0 })).toBe(null);
    expect(formatEnvelopeNotes(undefined)).toBe(null);
  });

  test("blame and expansion notes join on one line", () => {
    const joined = formatEnvelopeNotes({ blameNotARepo: true, expanded: 1 });
    expect(joined).toContain("no blame: the hit files are not in a git working tree");
    expect(joined).toContain("1 expansion variant ranking(s) merged");
    expect(joined.startsWith("⚠ ")).toBe(true);
  });

  test("formatResults appends the expansion note after the results", () => {
    const hit = {
      id: "f.ts#0",
      filePath: "/proj/src/f.ts",
      content: "export const answer = 42;",
      vector: [] as number[],
      project: "proj",
    };
    const text = formatResults([hit as any], { expanded: 1 });
    expect(text).toContain("Result 1:");
    expect(text).toContain("⚠ expand: 1 expansion variant ranking(s) merged");
    expect(formatResults([hit as any])).not.toContain("expand");
  });
});