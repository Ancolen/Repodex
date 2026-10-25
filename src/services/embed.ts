import { CONFIG } from "../config";
import { hashContent } from "../utils/hash";
import { modelTagPresent } from "../utils/model-tag";
import { ollamaEmbedding, ollamaEmbeddings, type EmbedCache } from "./ollama";
import { llamaEmbedding, llamaEmbeddings, probeLlamaHealth, probeLlamaServer } from "./llamacpp";

/**
 * Pluggable embedding-backend dispatch.
 *
 * cidx talks to whichever embedding server runs on the machine:
 *   - `ollama`    — the Ollama daemon (`ollama.url`), full model management.
 *   - `llamacpp`  — a bare `llama-server` (`embedding.llamacppUrl`), one model
 *     per process via the OpenAI-compatible endpoints.
 *
 * `embedding.provider: auto` (default) probes both and picks by availability:
 * an Ollama that reports the configured model wins (it manages models,
 * `num_ctx` and multi-project model mixing); a live llama-server comes next;
 * then a live Ollama without the model (the request will surface Ollama's own
 * error); never reachable → the caller throws an actionable message. An
 * explicit `ollama`/`llamacpp` skips probing entirely.
 *
 * The resolved backend is memoized per process; changing the backend means
 * restarting the daemon (config is read once at boot anyway). Cache keys and
 * `IndexRecord.embedModel` stay the single global model string — when switching
 * backends, serve the SAME model identifier (llama-server's `-a` alias) or
 * reindex the affected projects.
 */

export type EmbedProvider = "ollama" | "llamacpp";
export type EmbedProviderSetting = EmbedProvider | "auto";

/** What a probe learned about one backend (models = tags served there). */
export interface BackendProbe {
  up: boolean;
  models: string[];
}

/** The resolved backend: where to call and what answered. */
export interface ResolvedBackend {
  provider: EmbedProvider;
  /** Base URL the request goes through (`ollama.url` / `embedding.llamacppUrl`). */
  url: string;
  /** How auto found its pick (`provider` explicit → "explicit"). */
  reason: "explicit" | "model-match" | "llamacpp-up" | "ollama-up";
}

// ---------------------------------------------------------------- probes

/** Probes Ollama `GET /api/tags` (never throws). */
export async function probeOllama(url: string, timeoutMs = 5000): Promise<BackendProbe> {
  try {
    const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return { up: true, models: [] };
    const data = (await resp.json()) as { models?: Array<{ name?: string; model?: string }> };
    return {
      up: true,
      models: (data.models ?? [])
        .map((m) => m.name ?? m.model ?? "")
        .filter((n) => n.length > 0),
    };
  } catch {
    return { up: false, models: [] };
  }
}

// ------------------------------------------------------------- selection

/**
 * Pure provider choice from probed state (`null` = nothing usable). The rules
 * in priority order:
 *   1. Ollama is up AND reports the configured model (tag or `name:*` prefix);
 *   2. llama-server is up (it serves exactly one model — whatever that is);
 *   3. Ollama is up (its own model-miss error is more informative than ours).
 */
export function pickProvider(ollama: BackendProbe, llamacpp: BackendProbe, model: string): EmbedProvider | null {
  if (ollama.up && modelTagPresent(ollama.models, model)) return "ollama";
  if (llamacpp.up) return "llamacpp";
  if (ollama.up) return "ollama";
  return null;
}

// ------------------------------------------------------------- dispatch

let resolvePromise: Promise<ResolvedBackend> | null = null;

/** Probes both backends and resolves the auto pick; never returns without a backend. */
async function resolveAuto(): Promise<ResolvedBackend> {
  const [ollama, llamacpp] = await Promise.all([
    probeOllama(CONFIG.OLLAMA_URL),
    probeLlamaServer(CONFIG.LLAMACPP_URL),
  ]);
  const provider = pickProvider(ollama, llamacpp, CONFIG.OLLAMA_MODEL);
  if (provider === null) {
    throw new Error(
      "no embedding backend reachable — start Ollama (ollama serve, default " +
        CONFIG.OLLAMA_URL +
        ") or llama-server (-m <gguf> --embedding, default " +
        CONFIG.LLAMACPP_URL +
        "), or set embedding.provider",
    );
  }
  return {
    provider,
    url: provider === "ollama" ? CONFIG.OLLAMA_URL : CONFIG.LLAMACPP_URL,
    reason:
      provider === "ollama"
        ? modelTagPresent(ollama.models, CONFIG.OLLAMA_MODEL)
          ? "model-match"
          : "ollama-up"
        : "llamacpp-up",
  };
}

/**
 * The memoized backend resolution. Probes once per process; every embed call
 * afterwards skips the network round-trip. The choice is logged the first time
 * so `daemon.log` shows which backend answered.
 */
export async function resolveEmbedBackend(): Promise<ResolvedBackend> {
  if (resolvePromise === null) {
    resolvePromise = (async () => {
      if (CONFIG.EMBED_PROVIDER !== "auto") {
        const provider = CONFIG.EMBED_PROVIDER;
        return {
          provider,
          url: provider === "ollama" ? CONFIG.OLLAMA_URL : CONFIG.LLAMACPP_URL,
          reason: "explicit" as const,
        };
      }
      const resolved = await resolveAuto();
      const models =
        resolved.provider === "ollama" ? "Ollama model list" : `llama-server at ${CONFIG.LLAMACPP_URL}`;
      console.error(
        `[embed] backend: ${resolved.provider} (${resolved.url}) — auto: ${resolved.reason} via ${models}`,
      );
      return resolved;
    })();
    // A failed first resolution must not poison the memo for the process's
    // lifetime: under `auto`, the usual reason is that both servers are still
    // starting (e.g. a boot-time index job racing llama-server's model load).
    // Clearing it lets the next embed/readiness probe retry the discovery.
    void resolvePromise.catch(() => {
      resolvePromise = null;
    });
  }
  return resolvePromise;
}

/** Test hook — forget the memoized resolution (tests re-probe at each scenario). */
export function resetEmbedBackend(): void {
  resolvePromise = null;
}

/** Test hook — pin the resolved backend so tests never touch the live network. */
export function setEmbedBackend(backend: ResolvedBackend | null): void {
  resolvePromise = backend === null ? null : Promise.resolve(backend);
}

// ---------------------------------------------------- readiness + retry

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True for an error that means "the backend is up but not ready yet" —
 * llama-server answers `/v1/embeddings` with HTTP 503 while it loads the model.
 * Connection-level failures are deliberately NOT in this class: they are
 * handled once per index job (a readiness wait before the first embed and a
 * single retry pass at the end), so a dead backend fails fast instead of
 * sleeping per file.
 */
export function isTransientEmbedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\bHTTP 503\b|Loading model/i.test(msg);
}

/**
 * Waits until the resolved embedding backend answers a readiness probe.
 * llama.cpp: `/health` (200 ready, 503 loading; an unknown endpoint counts as
 * usable). Ollama: `/api/tags` (the server is up; model loading happens on the
 * embed call itself). `auto` re-runs its discovery when the memoized resolution
 * failed. Returns false at the deadline — the caller proceeds and lets the
 * per-file error path report the outage.
 */
export async function waitForEmbedBackend(timeoutMs = CONFIG.EMBED_READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let delay = 250;
  for (;;) {
    let ready = false;
    try {
      const backend = await resolveEmbedBackend();
      ready =
        backend.provider === "llamacpp"
          ? (await probeLlamaHealth(backend.url)) !== false
          : (await probeOllama(backend.url)).up;
    } catch {
      // No backend reachable yet (auto discovery) — keep polling.
      ready = false;
    }
    if (ready) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(delay, Math.max(1, deadline - Date.now())));
    delay = Math.min(delay * 2, 2000);
  }
}

/** A single 503 retry waits at most this long for the model to finish loading. */
const EMBED_RETRY_MAX_WAIT_MS = 10_000;

/**
 * One transparent retry for a "loading" 503: wait for readiness, then repeat
 * the request. Used by every embed call (indexing and query paths alike), so a
 * search issued while llama-server is loading recovers instead of failing.
 */
async function embedWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientEmbedError(err)) throw err;
    const ready = await waitForEmbedBackend(Math.min(CONFIG.EMBED_READY_TIMEOUT_MS, EMBED_RETRY_MAX_WAIT_MS));
    if (!ready) throw err;
    return fn();
  }
}

/** Generates an embedding for a single text (model defaults to the global config). */
export async function getEmbedding(text: string, model: string = CONFIG.OLLAMA_MODEL): Promise<number[]> {
  const backend = await resolveEmbedBackend();
  return embedWithRetry(() =>
    backend.provider === "llamacpp" ? llamaEmbedding(text, backend.url, model) : ollamaEmbedding(text, model),
  );
}

/**
 * Embeds multiple texts in one request (batch indexing). The backend choice is
 * shared with `getEmbedding`, so a daemon runs all its embed traffic through
 * the same server.
 */
export async function getEmbeddings(texts: string[], model: string = CONFIG.OLLAMA_MODEL): Promise<number[][]> {
  const backend = await resolveEmbedBackend();
  return embedWithRetry(() =>
    backend.provider === "llamacpp" ? llamaEmbeddings(texts, backend.url, model) : ollamaEmbeddings(texts, model),
  );
}

/**
 * Embeds a single text through the content-hash cache (shared with indexing).
 * Repeated searches for the same query skip the backend round-trip entirely; a
 * query whose text matches an already-indexed chunk reuses that row (same model
 * + same content hash). Keyed by (model, sha256(text)) via `hashContent`.
 */
export async function cachedEmbed(
  text: string,
  model: string,
  cache: EmbedCache,
  embed: (text: string) => Promise<number[]> = getEmbedding,
): Promise<number[]> {
  const hash = hashContent(text);
  const hit = cache.getCachedEmbedding(model, hash);
  if (hit) return hit;
  const vector = await embed(text);
  try {
    cache.putCachedEmbeddings(model, [{ hash, vector }]);
  } catch (err) {
    // Cache write is best-effort — a failed write must not fail the search.
    console.error("[embed] embedding cache write failed:", err);
  }
  return vector;
}