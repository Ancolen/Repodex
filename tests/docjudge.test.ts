import { describe, test, expect } from "bun:test";
import {
  judgePrompt,
  verdictFromLogprobs,
  ollamaJudgeTopLogprobs,
  createDocJudge,
  createJudgeAvailabilityProbe,
  type DocJudgeDeps,
} from "../src/services/docjudge";
import { extractTopLogprobs } from "../src/services/llamacpp";
import { setEmbedBackend, resetEmbedBackend } from "../src/services/embed";
import type { DocJudgeClaim, DocJudgeContext } from "../src/core/doccheck";

// ---------------------------------------------------------------- fixtures

const claim: DocJudgeClaim = {
  token: "tools/list",
  spanClass: "path",
  status: "missing",
  confidence: 70,
  message: "'tools/list' could not be resolved as an indexed path",
  doc: { path: "docs/a.md", line: 3, excerpt: "Run `tools/list` from the root." },
};

const context: DocJudgeContext = { project: "t", surrounding: ["Run `tools/list` from the root."] };

const YES = [{ token: "yes", logprob: -0.2 }, { token: "no", logprob: -2.0 }];
const NO = [{ token: "yes", logprob: -3.0 }, { token: "no", logprob: -0.2 }];

/** A fake fetch that records calls and answers each request with a canned body. */
function fakeFetch(responder: (url: string, body: any) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init: init ?? {} });
    const out = responder(url, body);
    const status = out.status ?? 200;
    return new Response(status < 400 ? JSON.stringify(out.body) : "", {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** The pinned judge backend most wire tests resolve through. */
const backend = { provider: "ollama" as const, url: "http://judge.test:11434", reason: "explicit" as const };

// --------------------------------------------------------- verdictFromLogprobs

describe("verdictFromLogprobs", () => {
  test("yes-dominant table → consistent with the softmax confidence", () => {
    const v = verdictFromLogprobs(YES);
    expect(v).toEqual({ consistent: true, confidence: expect.closeTo(0.858, 2) });
  });

  test("no-dominant table → inconsistent", () => {
    const v = verdictFromLogprobs(NO);
    expect(v!.consistent).toBe(false);
    expect(v!.confidence).toBeLessThan(0.5);
  });

  test("only one verdict token present → the softmax is certain (1.0 / 0.0)", () => {
    expect(verdictFromLogprobs([{ token: "yes", logprob: -1.0 }])).toEqual({ consistent: true, confidence: 1 });
    expect(verdictFromLogprobs([{ token: "no", logprob: -1.0 }])).toEqual({ consistent: false, confidence: 0 });
  });

  test("neither verdict token → null (no opinion, not a 50/50 score)", () => {
    expect(verdictFromLogprobs([{ token: "maybe", logprob: -0.1 }])).toBeNull();
  });

  test("whitespace/case normalized; other tokens ignored; max yes logprob wins", () => {
    const v = verdictFromLogprobs([
      { token: " Yes ", logprob: -0.3 },
      { token: "no", logprob: -1.5 },
      { token: "the", logprob: -0.01 },
    ]);
    expect(v!.consistent).toBe(true);
    expect(v!.confidence).toBeGreaterThan(0.7);
  });
});

// -------------------------------------------------------- response shapes

describe("wire response shape tolerance", () => {
  test("ollama shape: logprobs[0].top_logprobs (first generated token)", () => {
    const raw = { logprobs: [{ top_logprobs: [{ token: "yes", logprob: -0.2 }] }] };
    expect(ollamaJudgeTopLogprobs(raw)).toEqual([{ token: "yes", logprob: -0.2 }]);
    expect(ollamaJudgeTopLogprobs({})).toEqual([]);
    expect(ollamaJudgeTopLogprobs(null)).toEqual([]);
  });

  test("llama.cpp flat shape via the shared extractTopLogprobs (tok_str tolerated)", () => {
    const raw = [{ logprob: -1.0, top_logprobs: [{ tok_str: "yes", logprob: -0.4 }, { token: "no", logprob: -2.0 }] }];
    expect(extractTopLogprobs(raw)).toEqual([
      { tok_str: "yes", logprob: -0.4 },
      { token: "no", logprob: -2.0 },
    ]);
  });

  test("llama.cpp OpenAI wrapper shape (content[0].top_logprobs)", () => {
    const raw = { content: [{ logprob: -1.0, top_logprobs: [{ token: "no", logprob: -0.1 }] }] };
    expect(extractTopLogprobs(raw)).toEqual([{ token: "no", logprob: -0.1 }]);
  });

  test("empty/absent logprobs → no verdict (null)", () => {
    expect(verdictFromLogprobs([])).toBeNull();
  });
});

// ---------------------------------------------------------------- prompt

describe("judgePrompt", () => {
  test("carries the claim, the deterministic verdict, the suggestion and the doc prose", () => {
    const withSuggestion: DocJudgeClaim = { ...claim, suggestion: "tools/lint" };
    const p = judgePrompt(withSuggestion, context);
    expect(p).toContain("`tools/list` (path)");
    expect(p).toContain("'tools/list' could not be resolved as an indexed path");
    expect(p).toContain("; the checker suggests 'tools/lint'");
    expect(p).toContain("Run `tools/list` from the root.");
    expect(p).toContain('"yes" or "no"');
  });

  test("without a message/suggestion the checker line is generic and stable", () => {
    const bare: DocJudgeClaim = { token: "FOOBA", spanClass: "identifier", status: "review", confidence: 50, doc: claim.doc };
    const p = judgePrompt(bare, context);
    expect(p).toContain("`FOOBA` (identifier)");
    expect(p).toContain("the 'identifier' claim 'FOOBA' could not be resolved");
    expect(p).not.toContain("suggests");
  });
});

// ------------------------------------------------------------- createDocJudge

describe("createDocJudge — the wire call", () => {
  test("ollama: posts the raw prompt with logprobs and scores the verdict", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { logprobs: [{ top_logprobs: YES }] } }));
    const judge = createDocJudge({
      model: "gemma4:e4b",
      resolveBackend: async () => backend,
      fetchFn: fn,
    });
    const v = await judge(claim, context);
    expect(v).toEqual({ consistent: true, confidence: expect.closeTo(0.858, 2) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://judge.test:11434/api/generate");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("gemma4:e4b");
    expect(body.raw).toBe(true);
    expect(body.options.num_predict).toBe(1);
    expect(body.logprobs).toBe(true);
    expect(String(body.prompt)).toContain("`tools/list` (path)");
  });

  test("llamacpp: posts to /v1/completions and reads the OpenAI wrapper shape", async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: { choices: [{ logprobs: { content: [{ top_logprobs: [{ tok_str: "no", logprob: -0.1 }, { token: "yes", logprob: -3.0 }] }] } }] },
    }));
    const judge = createDocJudge({
      model: "judge-8b",
      resolveBackend: async () => ({ ...backend, provider: "llamacpp", url: "http://llama.test:8080" }),
      fetchFn: fn,
    });
    const v = await judge(claim, context);
    expect(v!.consistent).toBe(false);
    expect(calls[0]!.url).toBe("http://llama.test:8080/v1/completions");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.max_tokens).toBe(1);
    expect(body.logprobs).toBe(20);
  });

  test("an explicit deps.url wins over the resolved backend URL", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { logprobs: [{ top_logprobs: YES }] } }));
    const judge = createDocJudge({ model: "m", url: "http://dedicated:9000", resolveBackend: async () => backend, fetchFn: fn });
    await judge(claim, context);
    expect(calls[0]!.url).toBe("http://dedicated:9000/api/generate");
  });

  test("HTTP failure → throws (the engine catches per claim and keeps the review item)", async () => {
    const { fn } = fakeFetch((url) => (url.endsWith("/api/generate") ? { status: 500, body: "boom" } : { body: {} }));
    const judge = createDocJudge({ model: "m", resolveBackend: async () => backend, fetchFn: fn });
    await expect(judge(claim, context)).rejects.toThrow("HTTP 500");
  });
});

// ---------------------------------------------------- availability probe

describe("createJudgeAvailabilityProbe", () => {
  test("ollama: one POST /api/show per session; positive verdict is cached", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { exists: true } }));
    const probe = createJudgeAvailabilityProbe({
      model: "gemma4:e4b",
      resolveUrl: async () => "http://judge.test:11434",
      resolveProvider: async () => "ollama",
      fetchFn: fn,
    });
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://judge.test:11434/api/show");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "gemma4:e4b" });
  });

  test("a miss is cached too, and onMiss fires exactly once", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 404, body: "no" }));
    const misses: string[] = [];
    const probe = createJudgeAvailabilityProbe({
      model: "absent-model",
      resolveUrl: async () => "http://judge.test:11434",
      resolveProvider: async () => "ollama",
      fetchFn: fn,
      onMiss: (m) => misses.push(m),
    });
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
    expect(calls).toHaveLength(1);
    expect(misses).toHaveLength(1);
    expect(misses[0]).toContain("absent-model");
  });

  test("llamacpp: model tag found in the /v1/models listing", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { data: [{ id: "judge-8b" }, { id: "embed" }] } }));
    const probe = createJudgeAvailabilityProbe({
      model: "judge-8b",
      resolveUrl: async () => "http://llama.test:8080",
      resolveProvider: async () => "llamacpp",
      fetchFn: fn,
    });
    expect(await probe()).toBe(true);
    expect(calls[0]!.url).toBe("http://llama.test:8080/v1/models");
  });

  test("an unreachable backend degrades to false with on_miss, never throws", async () => {
    const misses: string[] = [];
    const probe = createJudgeAvailabilityProbe({
      model: "m",
      resolveUrl: async () => {
        throw new Error("backend down");
      },
      resolveProvider: async () => "ollama",
      onMiss: (m) => misses.push(m),
    });
    expect(await probe()).toBe(false);
    expect(await probe()).toBe(false);
    expect(misses).toHaveLength(1);
  });
});

describe("docjudge — default backend resolution seam", () => {
  test("without an injected resolveBackend, the memoized embed backend is used", async () => {
    setEmbedBackend(backend);
    try {
      const { fn, calls } = fakeFetch(() => ({ body: { logprobs: [{ top_logprobs: YES }] } }));
      const judge = createDocJudge({ model: "m", fetchFn: fn });
      const v = await judge(claim, context);
      expect(v!.consistent).toBe(true);
      expect(calls[0]!.url).toBe("http://judge.test:11434/api/generate");
    } finally {
      setEmbedBackend(null);
      resetEmbedBackend();
    }
  });
});

describe("docjudge deps type sanity", () => {
  test("every dep except model is optional", () => {
    const deps: DocJudgeDeps = { model: "m" };
    expect(deps.url).toBeUndefined();
    expect(deps.fetchFn).toBeUndefined();
    expect(deps.resolveBackend).toBeUndefined();
  });
});