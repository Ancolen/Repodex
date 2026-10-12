/**
 * Runtime helpers for the db + Control-API integration battery
 * (tests/integration/control-api.test.ts).
 *
 * The battery has two moving parts, both real, both self-contained:
 *
 * 1. A FAKE embedding backend — a real HTTP server on an EPHEMERAL port
 *    speaking exactly the Ollama wire shape the daemon uses: `GET /api/tags`
 *    (backend probes + /doctor), `POST /api/embed` (batch indexing),
 *    `POST /api/embeddings` (query embeds) and `POST /api/show` (the reranker
 *    probe — deliberately 404 so the session runs rerank-free, byte-identically
 *    to a backend without the model). Vectors are derived from sha256(text) at
 *    a fixed dim, so identical embed inputs produce identical vectors across
 *    calls: an exact-byte-equality vector query can be asserted.
 *
 * 2. The REAL daemon, spawned as a subprocess (`bun src/index.ts`) with its own
 *    mkdtemp CIDX_HOME and free ports picked per attempt for MCP_PORT /
 *    CONTROL_PORT (never the production 9371/9372). `EMBED_PROVIDER=ollama`
 *    plus the fake URL pin the resolved backend so nothing probes the
 *    developer's live services; boot is verified by polling /ping with a
 *    deadline, and a bind conflict retries with fresh ports.
 *
 * Unlike the rest of the suite this battery runs real processes, real sqlite
 * and real LanceDB tables — under rules that keep it safe in any environment:
 * every wait is bounded (a hang fails a test, never the run), nothing touches
 * `~/.cidx`, and every temp directory is removed again.
 *
 * Env-var priority note (`src/config.ts` resolves `defaults < yaml < env`):
 * anything that could redirect the daemon at the developer's own data root or
 * embedding services is deleted/pinned in `daemonEnv` before the spawn.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The worktree root — the daemon runs from here so it loads THIS tree's src. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The daemon entry (`src/index.ts` — the compiled main.ts dispatches here too). */
export const DAEMON_ENTRY = path.join(REPO_ROOT, "src", "index.ts");

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------- deterministic vectors

/** The fake model tag every fake endpoint reports (matched by /doctor too). */
export const FAKE_MODEL = "cidx-battery-embed";

/** Fixed vector dimension — small, so the sqlite BLOB cache stays tiny. */
export const FAKE_EMBED_DIM = 64;

/**
 * Deterministic fake embedding: the fixed-dim expansion of sha256(text).
 * Identical inputs → identical vectors (assertable equality), different inputs
 * → effectively unrelated directions (the exact-match cosine wins by a mile).
 */
export function fakeVector(text: string): number[] {
  const digest = createHash("sha256").update(text, "utf8").digest();
  const vector: number[] = [];
  for (let i = 0; i < FAKE_EMBED_DIM; i++) {
    vector.push(((digest[i % digest.length] ?? 0) - 127.5) / 127.5);
  }
  return vector;
}

// ------------------------------------------------------- fake embedding backend

export interface FakeEmbedBackend {
  /** Base URL the daemon's OLLAMA_URL is pointed at. */
  url: string;
  /** Wire paths that were hit (diagnostics — e.g. proving the rerank probe 404'd). */
  requests: string[];
  /** Closes the listener and its open connections. */
  stop(): void;
}

/**
 * The fake Ollama. `GET /api/tags` lists the fake model; both embed endpoints
 * answer with hash-derived vectors; everything else 404s (which is exactly how
 * the reranker availability probe is supposed to fail).
 */
export function startFakeEmbedBackend(): FakeEmbedBackend {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (req.method === "GET" && url.pathname === "/api/tags") {
        return json({ models: [{ name: FAKE_MODEL, model: FAKE_MODEL }] });
      }
      if (req.method === "POST" && url.pathname === "/api/embed") {
        const body = (await req.json()) as { input?: string[] };
        const inputs = Array.isArray(body.input) ? body.input : [];
        return json({ model: FAKE_MODEL, embeddings: inputs.map((text) => fakeVector(text)) });
      }
      if (req.method === "POST" && url.pathname === "/api/embeddings") {
        const body = (await req.json()) as { prompt?: string };
        return json({ model: FAKE_MODEL, embedding: fakeVector(body.prompt ?? "") });
      }
      return json({ error: `${url.pathname} is not served by the fake backend` }, 404);
    },
  });
  // Bun's `server.address` is a property (an AddressInfo), not a method.
  const address = (server as unknown as { address?: { port?: number } }).address;
  const port = address?.port ?? 0;
  if (port <= 0) {
    throw new Error("fake embed backend: listener has no port");
  }
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () => server.stop(true),
  };
}

// ------------------------------------------------------------------- processes

/** Type of the spawned daemon (`Bun.spawn` return), used for kill/exit handling. */
export type DaemonProcess = ReturnType<typeof Bun.spawn>;

/** The `net.Server` ephemeral-port dance: hand the daemon genuinely free ports. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "object") {
        const port = address?.port ?? 0;
        server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
        return;
      }
      server.close(() => reject(new Error("unexpected non-tcp address")));
    });
  });
}

export interface DaemonHandle {
  /** The Control API base — every scenario talks to this. */
  controlUrl: string;
  /** The daemon's own data root (removed again by the caller). */
  home: string;
  proc: DaemonProcess;
  /**
   * The accumulated stderr (tail-capped). The daemon never writes stdout; its
   * diagnostics live here and turn failures readable.
   */
  stderrText(): Promise<string>;
}

/**
 * The daemon's spawn env: the test process's env minus anything that would
 * redirect it at the developer's own data root/config/backend, plus the
 * scenario pins (temp CIDX_HOME, free ports, fake Ollama).
 */
export function daemonEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  // A stray $CIDX_CONFIG would point the daemon at the user's own YAML (env
  // vars override its values, but honesty beats cleverness: drop the file).
  delete env.CIDX_CONFIG;
  return { ...env, ...overrides };
}

/**
 * Finds free ports, spawns the daemon and waits for a healthy /ping — with a
 * full retry on bind conflict (two "free" ports can be closed in the instant
 * before the daemon binds them). Boot failures include the daemon's stderr so
 * the failure is diagnosable without re-running anything.
 */
export async function startDaemon(opts: {
  embedUrl: string;
  bootTimeoutMs?: number;
  attempts?: number;
  model?: string;
}): Promise<DaemonHandle> {
  const attempts = opts.attempts ?? 3;
  const bootTimeoutMs = opts.bootTimeoutMs ?? 30_000;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const home = mkdtempSync(path.join(tmpdir(), "cidx-battery-daemon-"));
    const [mcpPort, controlPort] = await Promise.all([pickFreePort(), pickFreePort()]);
    const controlUrl = `http://127.0.0.1:${controlPort}`;
    const proc = Bun.spawn({
      cmd: [process.execPath, DAEMON_ENTRY],
      cwd: REPO_ROOT,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: daemonEnv({
        CIDX_HOME: home,
        HOST: "127.0.0.1",
        MCP_PORT: String(mcpPort),
        CONTROL_PORT: String(controlPort),
        EMBED_PROVIDER: "ollama",
        OLLAMA_URL: opts.embedUrl,
        OLLAMA_MODEL: opts.model ?? FAKE_MODEL,
        RERANK_URL: "",
      }),
    });
    let stderrPromise: Promise<string> | null = null;
    const stderrText = async (): Promise<string> => {
      if (stderrPromise === null && proc.stderr instanceof ReadableStream) {
        stderrPromise = new Response(proc.stderr).text();
      }
      const text = await (stderrPromise ?? Promise.resolve(""));
      return text.length > 4000 ? text.slice(-4000) : text;
    };
    try {
      await waitForBoot(controlUrl, proc, stderrText, bootTimeoutMs);
      return { controlUrl, home, proc, stderrText };
    } catch (err) {
      lastError = err;
      // The failed attempt's process + scratch home must not leak.
      try {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        await proc.exited;
      } catch {
        /* already gone */
      }
      rmSync(home, { recursive: true, force: true });
    }
  }
  throw new Error(`daemon did not boot after ${attempts} attempts: ${String(lastError)}`);
}

/** Bounded /ping poll; fails fast if the child exits during boot. */
async function waitForBoot(
  controlUrl: string,
  proc: DaemonProcess,
  stderrText: () => Promise<string>,
  deadlineMs: number,
): Promise<void> {
  const bootDeadline = Date.now() + deadlineMs;
  while (Date.now() < bootDeadline) {
    if (proc.exitCode !== null) {
      throw new Error(`daemon exited during boot (code ${proc.exitCode}):\n${await stderrText()}`);
    }
    try {
      const resp = await fetch(`${controlUrl}/ping`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const body = (await resp.json()) as { ok?: boolean };
        if (body.ok === true) return;
      }
    } catch {
      // Not up yet — keep polling until the deadline.
    }
    await sleep(150);
  }
  throw new Error(`daemon did not answer /ping within ${deadlineMs}ms:\n${await stderrText()}`);
}

/**
 * Stops the daemon: SIGTERM (the same graceful path as SIGINT and /shutdown —
 * watchers closed, sqlite closed, exit code 0), escalated to SIGKILL if it
 * misses the graceful deadline. Returns the final exit code; the caller
 * asserts death (an `exitCode !== null` check) so a runaway daemon can never
 * outlive the suite.
 */
export async function stopDaemon(handle: DaemonHandle, gracefulMs = 15_000): Promise<number> {
  if (handle.proc.exitCode !== null) return handle.proc.exitCode;
  try {
    handle.proc.kill("SIGTERM");
  } catch {
    return handle.proc.exitCode ?? -1;
  }
  const code = await Promise.race([handle.proc.exited, sleep(gracefulMs).then(() => null)]);
  if (code !== null) return code;
  try {
    handle.proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await handle.proc.exited;
  return handle.proc.exitCode ?? -1;
}

/** Removes a daemon data root / fixture directory (afterAll hygiene). */
export function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------------- HTTP client

/**
 * JSON client for the Control API. Non-2xx throws WITH the response body (the
 * daemon's self-healing error shapes are the payload), so assertion failures
 * carry the message the daemon produced.
 */
export async function callApi<T>(
  controlUrl: string,
  request: string,
  options?: { method?: "GET" | "POST" | "DELETE"; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const method = options?.method ?? "GET";
  const headers: Record<string, string> | undefined =
    options?.body !== undefined ? { "content-type": "application/json" } : undefined;
  const resp = await fetch(`${controlUrl}${request}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 30_000),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${resp.status} ${resp.statusText} — ${method} ${request} → ${text.slice(0, 500)}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
}

/**
 * Bounded condition wait. `probe` returns a truthy value to stop (or null/
 * undefined/false to keep polling). Throws — naming the condition and the
 * last probe error — when the deadline passes, so a hang becomes a failed
 * test instead of a dead suite.
 */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await sleep(options.intervalMs ?? 250);
  }
  const suffix = lastError !== null ? ` (last error: ${String(lastError)})` : "";
  throw new Error(`timeout waiting for ${label} after ${options.timeoutMs}ms${suffix}`);
}