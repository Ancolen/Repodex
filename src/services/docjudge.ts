/**
 * Wire client for the doccheck semantic judge (proposal D1b) — the local
 * instruct model that adjudicates the claims the deterministic checker could
 * not reach (`checked.judge`/needsReview; see `core/doccheck.ts` for the
 * engine-side contract).
 *
 * The judge answers ONE yes/no question per claim and is scored via completion
 * logprobs, reusing the reranker's machinery patterns (`services/rerank.ts`):
 * Ollama path `/api/generate` (`raw` prompt + `logprobs: true`), llama.cpp path
 * `/v1/completions` (`logprobs` table) — tolerant to both response shapes via
 * the shared `extractTopLogprobs`. An empty `doccheck.judgeUrl` follows the
 * resolved embedding backend, exactly like an empty `search.rerank.url` does.
 *
 * The engine never imports this module — the daemon builds a `DocJudge` here
 * and injects it into `runDocCheck`, so the engine stays byte-for-byte
 * reproducible and tests inject their own judge.
 */

import { CONFIG } from "../config";
import type { DocJudge, DocJudgeClaim, DocJudgeContext, JudgeVerdict } from "../core/doccheck";
import {
  REQUEST_TIMEOUT_MS,
  RERANK_TOP_LOGPROBS,
  extractTopLogprobs,
  probeLlamaServer,
  type LlamaLogprobEntry,
} from "./llamacpp";
import { modelTagPresent } from "../utils/model-tag";
import { resolveEmbedBackend, type EmbedProvider, type ResolvedBackend } from "./embed";
import { scoreFromLogprobs } from "./rerank";

// ------------------------------------------------------------- logprob parse

/** Normalizes either backend's logprob table into the shape the scorer reads (same as rerank's helper). */
function normalizeTopLogprobs(
  entries: readonly { token?: string; tok_str?: string; logprob?: number }[],
): { token: string; logprob: number }[] {
  return entries.map((e) => ({ token: e.token ?? e.tok_str ?? "", logprob: e.logprob ?? -Infinity }));
}

const VERDICT_TOKENS = new Set(["yes", "no"]);

/**
 * The yes/no verdict behind a top-logprobs table, or `null` when neither
 * verdict token surfaced at all (the judge has no opinion — a genuinely
 * different signal from a real 50/50 split, which is why this is NOT simply
 * `scoreFromLogprobs`'s neutral 0.5).
 */
export function verdictFromLogprobs(
  entries: readonly { token: string; logprob: number }[],
): JudgeVerdict | null {
  const hasVerdict = entries.some((e) => VERDICT_TOKENS.has(e.token.trim().toLowerCase()));
  if (!hasVerdict) return null;
  const score = scoreFromLogprobs(entries.map((e) => ({ token: e.token, logprob: e.logprob })));
  // `score >= 0.5` = the model leaned yes. A tied 0.5 with verdict tokens
  // present stays below the confirm threshold, so the boundary is inert.
  return { consistent: score >= 0.5, confidence: score };
}

/** Extracts the first generated token's top-logprobs from an Ollama `/api/generate` response. */
export function ollamaJudgeTopLogprobs(raw: unknown): LlamaLogprobEntry[] {
  const data = (raw ?? {}) as { logprobs?: Array<{ top_logprobs?: LlamaLogprobEntry[] } | null> | null };
  // num_predict: 1 → the first generated token holds the yes/no verdict.
  return data.logprobs?.[0]?.top_logprobs ?? [];
}

// ------------------------------------------------------------------- prompt

/**
 * The judge prompt: the same ChatML/raw shape the reranker uses (proven over
 * both wire paths) with a plain instruct question instead of the Qwen3
 * retrieval template. The model sees only what the checker knows: the claim,
 * its prose context, what failed to resolve, and any fuzzy suggestion.
 */
export function judgePrompt(claim: DocJudgeClaim, context: DocJudgeContext): string {
  const parts = claim.parts && claim.parts.length > 0 ? claim.parts.join(" ") : "";
  const check = claim.message ?? `the '${claim.spanClass}' claim '${claim.token}' could not be resolved`;
  const hint = claim.suggestion !== undefined ? `; the checker suggests '${claim.suggestion}'` : "";
  return (
    "<|im_start|>system\n" +
    'Judge whether the documented reference is consistent with the code project. Note that the answer can only be "yes" or "no".' +
    "<|im_end|>\n" +
    "<|im_start|>user\n" +
    '<Instruct>: A static doc-code checker could not verify one claim in a documentation file. Decide whether the claim is nonetheless consistent with the project — it plausibly refers to something real in this project — or inconsistent: it contradicts the project or names something that cannot exist there. Answer with exactly one token: "yes" or "no".\n' +
    `<Claim>: \`${claim.token}\` (${claim.spanClass}${parts.length > 0 ? ` ${parts}` : ""})\n` +
    `<Checker>: ${check}${hint}\n` +
    `<Document>: ${context.surrounding.join("\n")}` +
    "<|im_end|>\n" +
    "<|im_start|>assistant\n"
  );
}

// ------------------------------------------------------------------ the call

/**
 * The judge's configuration, as `createDocJudge` reads it. Fields are plain
 * data so tests can inject everything (backend + fetch) without env dancing.
 */
export interface DocJudgeDeps {
  /** The judge model tag (Ollama model name / llama-server alias). */
  model: string;
  /** Explicit judge base URL; empty/undefined = `doccheck.judgeUrl` → the embedding backend. */
  url?: string | undefined;
  /** Wire fetch override (tests); defaults to the global fetch. */
  fetchFn?: typeof fetch | undefined;
  /** Backend resolution override (tests); defaults to the memoized `resolveEmbedBackend`. */
  resolveBackend?: (() => Promise<ResolvedBackend>) | undefined;
}

/** Builds the Ollama/llama.cpp yes/no call for one claim and scores it via logprobs. */
async function judgeClaim(deps: DocJudgeDeps, claim: DocJudgeClaim, context: DocJudgeContext): Promise<JudgeVerdict | null> {
  const backend = deps.resolveBackend ? await deps.resolveBackend() : await resolveEmbedBackend();
  // Empty `doccheck.judgeUrl` = follow the embedding backend's server (rerank precedent).
  const judgeUrl = deps.url || CONFIG.DOC_CHECK_JUDGE_URL || backend.url;
  const prompt = judgePrompt(claim, context);
  let entries: LlamaLogprobEntry[];
  if (backend.provider === "llamacpp") {
    const resp = await (deps.fetchFn ?? fetch)(`${judgeUrl}/v1/completions`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        prompt,
        max_tokens: 1,
        temperature: 0,
        logprobs: RERANK_TOP_LOGPROBS,
      }),
    });
    if (!resp.ok) throw new Error(`doccheck judge /v1/completions HTTP ${resp.status}`);
    const data = (await resp.json()) as { choices?: Array<{ logprobs?: unknown }> };
    entries = extractTopLogprobs(data.choices?.[0]?.logprobs);
  } else {
    const resp = await (deps.fetchFn ?? fetch)(`${judgeUrl}/api/generate`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        prompt,
        raw: true,
        stream: false,
        options: { num_predict: 1, temperature: 0, num_ctx: CONFIG.OLLAMA_NUM_CTX },
        logprobs: true,
        top_logprobs: RERANK_TOP_LOGPROBS,
      }),
    });
    if (!resp.ok) throw new Error(`doccheck judge generate HTTP ${resp.status}`);
    entries = ollamaJudgeTopLogprobs(await resp.json());
  }
  return verdictFromLogprobs(normalizeTopLogprobs(entries));
}

/**
 * Builds the injected `DocJudge` for `runDocCheck` from configuration. The
 * engine only ever sees the async function — never the model, never the wire.
 */
export function createDocJudge(deps: DocJudgeDeps): DocJudge {
  return (claim, context) => judgeClaim(deps, claim, context);
}

// ------------------------------------------------------- availability probe

/**
 * Probes once whether the judge model exists on the resolved backend (Ollama
 * `POST /api/show`, llama-server `GET /v1/models`), caches the verdict for the
 * session and auto-disables on a miss — the `ensureRerankAvailable` precedent:
 * judge-on-config with a missing model must not storm the backend nor fail
 * runs; it degrades to judge-off with a note in the report instead.
 *
 * The returned probe NEVER throws and calls `onMiss` exactly once (the daemon
 * passes its logger; tests count calls). Caching is per probe instance — the
 * daemon builds one at boot, so config is read once anyway.
 */
export function createJudgeAvailabilityProbe(deps: {
  model: string;
  /** Resolves the judge base URL (config URL, else the embedding backend's). */
  resolveUrl: () => Promise<string>;
  resolveProvider: () => Promise<EmbedProvider>;
  /** Wire fetch override (tests); defaults to the global fetch. */
  fetchFn?: typeof fetch | undefined;
  /** Called at most once, when the probe found the model absent (or probing failed). */
  onMiss?: ((message: string) => void) | undefined;
}): () => Promise<boolean> {
  let cached: Promise<boolean> | null = null;
  return () => {
    if (cached !== null) return cached;
    cached = (async () => {
      try {
        const [url, provider] = await Promise.all([deps.resolveUrl(), deps.resolveProvider()]);
        const fetchFn = deps.fetchFn ?? fetch;
        const found =
          provider === "llamacpp"
            ? await probeLlamaServer(url, undefined, fetchFn).then(
                (listing) => listing.up && modelTagPresent(listing.models, deps.model),
              )
            : await fetchFn(`${url}/api/show`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: deps.model }),
              }).then((resp) => resp.ok);
        if (!found) {
          deps.onMiss?.(
            `[manager] doccheck judge model '${deps.model}' not found on the ${provider} backend; ` +
              `the semantic judge is disabled for this session (install the model, or set doccheck.judgeModel="").`,
          );
        }
        return found;
      } catch {
        // Unreachable backend → judge-off for the session, same as a model miss.
        deps.onMiss?.(
          `[manager] doccheck judge availability probe failed; the semantic judge is disabled for this session.`,
        );
        return false;
      }
    })();
    return cached;
  };
}