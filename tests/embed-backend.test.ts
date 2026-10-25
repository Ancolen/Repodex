import { test, expect, describe } from "bun:test";
import {
  pickProvider,
  resolveEmbedBackend,
  setEmbedBackend,
  resetEmbedBackend,
  getEmbedding,
  isTransientEmbedError,
  waitForEmbedBackend,
} from "../src/services/embed";
import { probeLlamaHealth, llamaEmbeddings, llamaRerankTopLogprobs } from "../src/services/llamacpp";
import { modelTagPresent } from "../src/utils/model-tag";

describe("pickProvider — auto backend selection", () => {
  test("an Ollama that reports the configured model wins over a live llama-server", () => {
    const pick = pickProvider(
      { up: true, models: ["qwen3-embedding:latest"] },
      { up: true, models: ["embeddinggemma-2"] },
      "qwen3-embedding",
    );
    expect(pick).toBe("ollama");
  });

  test("a live llama-server wins when Ollama lacks the model", () => {
    const pick = pickProvider(
      { up: true, models: ["llama3"] },
      { up: true, models: ["embeddinggemma-2"] },
      "qwen3-embedding",
    );
    expect(pick).toBe("llamacpp");
  });

  test("a live llama-server wins when Ollama is down", () => {
    const pick = pickProvider({ up: false, models: [] }, { up: true, models: ["m"] }, "qwen3-embedding");
    expect(pick).toBe("llamacpp");
  });

  test("Ollama without the model is the last resort (its own error is informative)", () => {
    const pick = pickProvider({ up: true, models: [] }, { up: false, models: [] }, "qwen3-embedding");
    expect(pick).toBe("ollama");
  });

  test("nothing reachable → null (caller throws an actionable error)", () => {
    expect(pickProvider({ up: false, models: [] }, { up: false, models: [] }, "qwen3-embedding")).toBe(null);
  });
});

describe("modelTagPresent — shared tag matching", () => {
  test("bare name matches its :latest tag; pinned variant matches exactly", () => {
    expect(modelTagPresent(["embeddinggemma-2:latest"], "embeddinggemma-2")).toBe(true);
    expect(modelTagPresent(["embeddinggemma-2"], "embeddinggemma-2")).toBe(true);
    expect(modelTagPresent(["embeddinggemma-2:bf16"], "embeddinggemma-2")).toBe(true);
    expect(modelTagPresent(["embeddinggemma-2:bf16"], "embeddinggemma-2:other")).toBe(false);
  });
});

describe("resolveEmbedBackend — memoized dispatch", () => {
  test("a pinned backend is served to every call and persists across calls", async () => {
    setEmbedBackend({ provider: "llamacpp", url: "http://mock:1", reason: "explicit" });
    try {
      await expect(resolveEmbedBackend()).resolves.toEqual({
        provider: "llamacpp",
        url: "http://mock:1",
        reason: "explicit",
      });
      await expect(resolveEmbedBackend()).resolves.toEqual({
        provider: "llamacpp",
        url: "http://mock:1",
        reason: "explicit",
      });
    } finally {
      resetEmbedBackend();
    }
  });
});

describe("getEmbedding — llama.cpp path via /v1/embeddings", () => {
  test("sends the alias as model and returns the single vector", async () => {
    const realFetch = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      bodies.push({ url: String(input), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    setEmbedBackend({ provider: "llamacpp", url: "http://mock:2", reason: "explicit" });
    try {
      const v = await getEmbedding("hello world", "embeddinggemma-2");
      expect(v).toEqual([1, 2, 3]);
      expect(bodies[0].url).toBe("http://mock:2/v1/embeddings");
      expect(bodies[0].body.model).toBe("embeddinggemma-2");
      // single embed rides the batch endpoint with one entry
      expect(bodies[0].body.input).toEqual(["hello world"]);
    } finally {
      globalThis.fetch = realFetch;
      resetEmbedBackend();
    }
  });
});

describe("llamaEmbeddings — wire hygiene", () => {
  test("lone surrogates never reach the request body (strict parsers reject them)", async () => {
    // The production failure: a chunk cut mid-emoji ended on a lone high
    // surrogate, JSON.stringify escaped it to \ud83d, and llama.cpp's
    // nlohmann rejected the whole request with HTTP 400 — the file then
    // failed to index on every sync. The wire client sanitizes instead.
    const realFetch = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_input: any, init?: any) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1] },
            { index: 1, embedding: [2] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await llamaEmbeddings(["before \uD83D after", "clean"], "http://mock:3", "m");
      expect(bodies[0]).not.toMatch(/\\ud[0-9a-f]{3}/i);
      const parsed = JSON.parse(bodies[0]!) as { input: string[] };
      expect(parsed.input).toEqual(["before � after", "clean"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("llamaRerankTopLogprobs — response shape tolerance", () => {
  const realFetch = globalThis.fetch;

  test("OpenAI wrapper shape: logprobs = { content: [{ top_logprobs }] }", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ logprobs: { content: [{ logprob: 0, top_logprobs: [{ token: "yes", logprob: -0.2 }] }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      const top = await llamaRerankTopLogprobs("prompt", "http://mock:3", "m");
      expect(top).toEqual([{ token: "yes", logprob: -0.2 }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("llama.cpp flat shape: logprobs = [{ logprob, top_logprobs }] with tok_str tokens", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ logprobs: [{ logprob: 0, top_logprobs: [{ tok_str: " no", logprob: -0.4 }] }] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      const top = await llamaRerankTopLogprobs("prompt", "http://mock:4", "m");
      expect(top).toEqual([{ tok_str: " no", logprob: -0.4 }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a non-ok response throws (rerank degrades to neutral upstream)", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 503 })) as typeof fetch;
    try {
      await expect(llamaRerankTopLogprobs("prompt", "http://mock:5", "m")).rejects.toThrow("HTTP 503");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
// ------------------------------------------------ readiness + transient retry

describe("embedding backend readiness and 503 retry", () => {
  test("isTransientEmbedError: only 'up but loading' errors qualify", () => {
    expect(isTransientEmbedError(new Error('llama-server /v1/embeddings HTTP 503: {"error":{"message":"Loading model"}}'))).toBe(true);
    expect(isTransientEmbedError(new Error("Loading model"))).toBe(true);
    expect(isTransientEmbedError(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(false);
    expect(isTransientEmbedError(new Error("llama-server /v1/embeddings HTTP 400"))).toBe(false);
    expect(isTransientEmbedError("boom")).toBe(false);
  });

  test("probeLlamaHealth: 200 ready, 503 loading, unknown status does not block", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
      expect(await probeLlamaHealth("http://mock:health")).toBe(true);
      globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
      expect(await probeLlamaHealth("http://mock:health")).toBe(false);
      // A server/proxy without /health: unknown, treated as usable by callers.
      globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
      expect(await probeLlamaHealth("http://mock:health")).toBeNull();
      globalThis.fetch = (async () => {
        throw new Error("Unable to connect");
      }) as typeof fetch;
      expect(await probeLlamaHealth("http://mock:health")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("waitForEmbedBackend with a zero timeout probes once and reports the outage", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("Unable to connect");
    }) as typeof fetch;
    setEmbedBackend({ provider: "llamacpp", url: "http://mock:down", reason: "explicit" });
    try {
      const started = Date.now();
      await expect(waitForEmbedBackend(0)).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      resetEmbedBackend();
    }
  });

  test("a 503 'Loading model' is retried after the health probe succeeds", async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (url.endsWith("/v1/embeddings")) {
        // First attempt: the server is up but still loading the model.
        if (calls.filter((u) => u.endsWith("/v1/embeddings")).length === 1) {
          return new Response(JSON.stringify({ error: { message: "Loading model", code: 503 } }), { status: 503 });
        }
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [4, 5, 6] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    setEmbedBackend({ provider: "llamacpp", url: "http://mock:loading", reason: "explicit" });
    try {
      await expect(getEmbedding("hello", "m")).resolves.toEqual([4, 5, 6]);
      expect(calls.filter((u) => u.endsWith("/v1/embeddings"))).toHaveLength(2);
      expect(calls.some((u) => u.endsWith("/health"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      resetEmbedBackend();
    }
  });

  test("a connection failure is NOT retried per call (the index job owns recovery)", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("Unable to connect. Is the computer able to access the url?");
    }) as typeof fetch;
    setEmbedBackend({ provider: "llamacpp", url: "http://mock:down", reason: "explicit" });
    try {
      await expect(getEmbedding("hello", "m")).rejects.toThrow("Unable to connect");
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      resetEmbedBackend();
    }
  });

  test("a rejected auto discovery is not memoized forever", async () => {
    const realFetch = globalThis.fetch;
    // First resolution: nothing is reachable → resolveAuto throws.
    globalThis.fetch = (async () => {
      throw new Error("Unable to connect");
    }) as typeof fetch;
    try {
      resetEmbedBackend();
      await expect(resolveEmbedBackend()).rejects.toThrow("no embedding backend reachable");
      // The backend comes up (e.g. llama-server finished loading); the next
      // resolution must re-probe instead of returning the poisoned rejection.
      globalThis.fetch = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;
      const resolved = await resolveEmbedBackend();
      expect(["ollama", "llamacpp"]).toContain(resolved.provider);
    } finally {
      globalThis.fetch = realFetch;
      resetEmbedBackend();
    }
  });
});
