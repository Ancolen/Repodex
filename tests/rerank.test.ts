import { test, expect, describe } from "bun:test";
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
});
