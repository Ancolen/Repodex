import { test, expect, describe, spyOn } from "bun:test";
import { CONFIG } from "../src/config";
import { scoreFromLogprobs, rerankScores } from "../src/services/rerank";

describe("scoreFromLogprobs", () => {
  test("yes-dominant pair → softmax above 0.5", () => {
    const s = scoreFromLogprobs([
      { token: " yes", logprob: -0.5 },
      { token: " no", logprob: -2.0 },
    ]);
    // softmax: exp(-0.5)/(exp(-0.5)+exp(-2.0)) ≈ 0.8176
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeCloseTo(0.8176, 3);
  });

  test("no-dominant pair → softmax below 0.5", () => {
    const s = scoreFromLogprobs([
      { token: "yes", logprob: -3.0 },
      { token: "no", logprob: -0.2 },
    ]);
    expect(s).toBeLessThan(0.5);
  });

  test("only yes present → 1.0 (absent token is -Infinity)", () => {
    expect(scoreFromLogprobs([{ token: "yes", logprob: -1.0 }])).toBe(1);
  });

  test("only no present → 0.0", () => {
    expect(scoreFromLogprobs([{ token: "no", logprob: -1.0 }])).toBe(0);
  });

  test("neither verdict token → neutral 0.5", () => {
    expect(
      scoreFromLogprobs([
        { token: "maybe", logprob: -0.1 },
        { token: "definitely", logprob: -0.5 },
      ]),
    ).toBe(0.5);
  });

  test("token whitespace/case normalized", () => {
    const s = scoreFromLogprobs([
      { token: "  YES ", logprob: -0.3 },
      { token: " No", logprob: -1.5 },
    ]);
    expect(s).toBeGreaterThan(0.5);
  });

  test("duplicate yes entries take the max logprob", () => {
    // two "yes" entries (−2.0, −0.4); the −0.4 should win.
    const s = scoreFromLogprobs([
      { token: "yes", logprob: -2.0 },
      { token: "yes", logprob: -0.4 },
      { token: "no", logprob: -0.5 },
    ]);
    // yes(−0.4) vs no(−0.5): expYes=1, expNo=exp(−0.1)≈0.9048 → 0.5252
    expect(s).toBeCloseTo(0.5252, 3);
    expect(s).toBeGreaterThan(0.5);
  });

  test("score is symmetric & monotone in the logprob gap", () => {
    // bigger yes-advantage → bigger score
    const small = scoreFromLogprobs([
      { token: "yes", logprob: -0.6 },
      { token: "no", logprob: -0.4 },
    ]);
    const big = scoreFromLogprobs([
      { token: "yes", logprob: -0.1 },
      { token: "no", logprob: -5.0 },
    ]);
    expect(big).toBeGreaterThan(small);
  });
});

describe("rerankScores", () => {
  test("empty input → empty output (no network)", async () => {
    expect(await rerankScores("anything", [])).toEqual([]);
  });

  test("the /api/generate body carries num_ctx alongside num_predict/temperature", async () => {
    // Ollama allocates its context buffer from num_ctx (4096 when unset), so the
    // rerank request must pin it explicitly. Guarded here because a regression
    // would only show up as VRAM bloat, never as an error.
    const bodies: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: any, init?: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ logprobs: [{ top_logprobs: [{ token: "yes", logprob: -0.1 }] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const scores = await rerankScores("parse the config", ["const x = readConfig();"]);
      expect(scores).toEqual([1]); // only "yes" in the logprobs → 1.0
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(bodies.length).toBe(1);
    expect(bodies[0].model).toBe(CONFIG.RERANK_MODEL);
    expect(bodies[0].raw).toBe(true);
    expect(bodies[0].stream).toBe(false);
    expect(bodies[0].logprobs).toBe(true);
    expect(bodies[0].options.num_predict).toBe(1);
    expect(bodies[0].options.temperature).toBe(0);
    expect(bodies[0].options.num_ctx).toBe(CONFIG.RERANK_NUM_CTX);
    expect(bodies[0].prompt).toContain("<Query>: parse the config");
    expect(bodies[0].prompt).toContain("<Document>: const x = readConfig();");
  });

  test("a per-doc failure degrades to the neutral score instead of throwing", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    // The degradation is logged by design; keep it out of the test output.
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await rerankScores("q", ["doc"])).toEqual([0.5]);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      globalThis.fetch = realFetch;
    }
  });
});
