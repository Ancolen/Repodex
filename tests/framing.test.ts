/**
 * Per-model embedding task framing.
 *
 * Pure preset resolution (model families × none/auto settings, the framed
 * prefix helpers), the per-project config validation, the registry's lazy
 * `framing` column (legacy rows read as null and stay byte-identical), the
 * embed-site framing observed ON THE WIRE (stubbed global fetch — never a live
 * backend): indexing frames the document texts (content + the docstring leg)
 * and the query path frames the query per record, both cache-keyed on the
 * FRAMED text; a framing change escalates through the zero-downtime migrate
 * job (eg2-preset shadow re-embeds framed; qwen3-preset leaves documents
 * unframed while queries get the official instruction); the watcher skips
 * writes on a framing divergence and writes framed on a match.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CodeRecord } from "../src/services/db";
import type { IndexRecord } from "../src/core/registry";

// Pure module — safe to import statically (it imports nothing).
import {
  FRAMING_PRESETS,
  resolveFraming,
  framingPresetForModel,
  frameDoc,
  frameQuery,
  framingDocPrefix,
  framingQueryPrefix,
} from "../src/core/framing";
import { parseProjectConfig } from "../src/core/project-config";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const CONFIG = (await import("../src/config")).CONFIG;
const DEFAULT_CONFIG_YAML = (await import("../src/config")).DEFAULT_CONFIG_YAML;
const db = await import("../src/services/db");
const Registry = (await import("../src/core/registry")).Registry;
const JobQueue = (await import("../src/core/job-queue")).JobQueue;
const IndexManager = (await import("../src/core/index-manager")).IndexManager;
const indexFile = (await import("../src/services/indexer")).indexFile;
const setEmbedBackend = (await import("../src/services/embed")).setEmbedBackend;
const resetEmbedBackend = (await import("../src/services/embed")).resetEmbedBackend;
const startWatcher = (await import("../src/services/watcher")).startWatcher;
const isolatedHome = (await import("./helpers/isolated-cidx-home")).isolatedHome;

// ---------------------------------------------------------------- fixtures

const INDEX = "frameproj";
const MODEL = "embeddinggemma-2-test"; // prefix-matches the eg2 preset
const QWEN_MODEL = "qwen3-embedding-test"; // prefix-matches the qwen preset

/** A fixture file carrying a docstring (the docstring leg must fire). A Python
 * def keeps the docstring text DISTINCT from any chunk content — a TS file's
 * leading comment is ALSO chunked as its own loose chunk, which makes the doc
 * text identical to chunk #0 and its embed a legitimate cache hit. */
const FILE = "/proj/src/a.py";
const FILE_BODY = 'def alpha():\n    """Alpha does the thing."""\n    return 1\n';
const DOC_TEXT = "Alpha does the thing."; // the docstring the chunker extracts

/** Deterministic stub vector, sensitive to the EXACT text sent (framed ≠ raw). */
function vecFor(text: string, model: string): number[] {
  const m = model === QWEN_MODEL ? 0.5 : 1;
  return [((text.length % 7) + 1) * m, ((text.charCodeAt(0) % 5) + 1) * m, text.length * m, 3 * m];
}

function sourceRecord(file: string, content: string, model: string, doc: string | null): CodeRecord {
  return {
    id: `${file}#0`,
    filePath: file,
    content,
    vector: vecFor(content, model),
    language: "typescript",
    symbolName: "alpha",
    symbolType: "function",
    startLine: 1,
    endLine: 1,
    doc,
    doc_vector: doc ? vecFor(doc, model) : null,
    id_terms: null,
  } as CodeRecord;
}

// ------------------------------------------------------- stubbed embed wire

interface WireCall {
  url: string;
  model: string;
  texts: string[];
}

const wire: { calls: WireCall[] } = { calls: [] };
let realFetch: typeof globalThis.fetch | null = null;

// The stubbed wire covers EVERY test in this file (the two hook lines below):
// no embed request of any suite may ever touch a real backend. The Ollama
// client routes fetch through the live global (services/ollama.ts), so an
// installed stub is honored by every call site.
beforeAll(() => {
  installFetch();
});
afterAll(() => {
  uninstallFetch();
});

function installFetch(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const bodyRaw = init?.body;
    const body =
      typeof bodyRaw === "string" ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};
    const model = typeof body.model === "string" ? body.model : "";
    const texts: string[] = Array.isArray(body.input)
      ? (body.input as unknown[]).filter((t): t is string => typeof t === "string")
      : typeof body.prompt === "string"
        ? [body.prompt]
        : [];
    wire.calls.push({ url, model, texts });
    if (url.endsWith("/api/embeddings")) {
      return new Response(JSON.stringify({ embedding: vecFor(texts[0] ?? "", model) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ embeddings: texts.map((t) => vecFor(t, model)) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function uninstallFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
}

function makeRecord(table: string, overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    name: INDEX,
    path: "/proj",
    tableName: table,
    status: "ready",
    fileCount: 1,
    chunkCount: 1,
    embedModel: MODEL,
    embedDim: 4,
    lastIndexedAt: 123,
    createdAt: 1,
    error: null,
    ...overrides,
  };
}

function tempDbPath(): string {
  return path.join(isolatedHome, `framing-${randomUUID()}.db`);
}

function tempTable(): string {
  return `idx_frame_${randomUUID().slice(0, 8)}`.replaceAll("-", "_");
}

function removeDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(dbPath + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function rmTemp(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Collects every row of a table (file-aligned batches; order is irrelevant
 * here) — the honest read-back for asserting stored text stays raw.
 */
async function allRows(table: string): Promise<CodeRecord[]> {
  const rows: CodeRecord[] = [];
  await db.scanTableBatches(table, 100, async (batch) => rows.push(...batch));
  return rows;
}

// ---------------------------------------------------------------- pure presets

describe("framing presets — resolution table", () => {
  test("embeddinggemma-2* matches by model-string prefix, case-insensitively", () => {
    for (const model of ["embeddinggemma-2", "embeddinggemma-2:270m-nvfp4-text", "embeddinggemma-2-bf16"]) {
      expect(resolveFraming("auto", model)).toBe("embeddinggemma-2");
    }
    // Stored aliases may carry casing; matching is normalized.
    expect(resolveFraming("auto", "EmbeddingGemma-2-BF16")).toBe("embeddinggemma-2");
  });

  test("qwen3-embedding* matches; a non-embedding qwen3 model does not", () => {
    expect(resolveFraming("auto", "qwen3-embedding")).toBe("qwen3-embedding");
    expect(resolveFraming("auto", "qwen3-embedding:0.6b")).toBe("qwen3-embedding");
    expect(resolveFraming("auto", "qwen3:8b")).toBeNull();
  });

  test('setting "none" (and anything unrecognized) never frames — the default keeps existing installs byte-identical', () => {
    for (const model of ["embeddinggemma-2", "qwen3-embedding:0.6b", "text-embedding-3-small"]) {
      expect(resolveFraming("none", model)).toBeNull();
      expect(resolveFraming(undefined, model)).toBeNull();
      expect(resolveFraming("whatever", model)).toBeNull();
    }
  });

  test('"auto" falls back to none for unknown models and null/empty models (a legacy null record stays null)', () => {
    expect(resolveFraming("auto", "model-a")).toBeNull();
    expect(resolveFraming("auto", "")).toBeNull();
    expect(resolveFraming("auto", null)).toBeNull();
    expect(resolveFraming("auto", undefined)).toBeNull();
  });

  test("preset identities are stable and every preset carries both prefixes as data", () => {
    expect(FRAMING_PRESETS.map((p) => p.id)).toEqual(["embeddinggemma-2", "qwen3-embedding"]);
    for (const p of FRAMING_PRESETS) {
      expect(typeof p.docPrefix).toBe("string");
      expect(typeof p.queryPrefix).toBe("string");
      expect(p.modelPrefix).toBe(p.modelPrefix.toLowerCase());
    }
  });
});

describe("framing prefixes — frameDoc/frameQuery", () => {
  test("eg2 preset: docs get 'title: none', queries get 'task: search result'", () => {
    expect(frameDoc("fn()", "embeddinggemma-2")).toBe("title: none\n\ntext: fn()");
    expect(frameQuery("auth middleware", "embeddinggemma-2")).toBe(
      "task: search result\n\nquery: auth middleware",
    );
    expect(framingDocPrefix("embeddinggemma-2")).toBe("title: none\n\ntext: ");
    expect(framingQueryPrefix("embeddinggemma-2")).toBe("task: search result\n\nquery: ");
  });

  test("qwen3 preset: queries get the official instruction, documents UNframed", () => {
    expect(frameDoc("fn()", "qwen3-embedding")).toBe("fn()");
    expect(frameQuery("auth middleware", "qwen3-embedding")).toBe(
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: auth middleware",
    );
  });

  test("null/undefined/unknown framing is byte-identical (identity, not just equal)", () => {
    for (const framing of [null, undefined]) {
      expect(frameDoc("const x = 1;", framing)).toBe("const x = 1;");
      expect(frameQuery("q", framing)).toBe("q");
    }
    expect(frameDoc("s", "no-such-preset")).toBe("s");
    expect(frameQuery("s", "no-such-preset")).toBe("s");
  });

  test("an unknown model string resolves to no preset", () => {
    expect(framingPresetForModel("text-embedding-3-small")).toBeNull();
    expect(framingPresetForModel(null)).toBeNull();
  });
});

// ------------------------------------------------------------ per-project config

describe("project-config — framing field", () => {
  test('accepts "none" and "auto"', () => {
    expect(parseProjectConfig({ framing: "auto" }, ".cidx.json")).toEqual({ framing: "auto" });
    expect(parseProjectConfig({ framing: "none" }, ".cidx.json")).toEqual({ framing: "none" });
  });

  test("an invalid framing is dropped, other fields kept", () => {
    const cfg = parseProjectConfig({ framing: "prefix-all", embedModel: "m", extra: true }, ".cidx.json");
    expect(cfg).toEqual({ embedModel: "m" });
  });

  test("framing rides alongside the embedModel override", () => {
    expect(parseProjectConfig({ embedModel: "qwen3-embedding:0.6b", framing: "auto" }, ".cidx.json")).toEqual({
      embedModel: "qwen3-embedding:0.6b",
      framing: "auto",
    });
  });
});

describe("config — embedding.framing key", () => {
  test("the shipped template defaults the key to none (existing installs unchanged)", () => {
    expect(DEFAULT_CONFIG_YAML).toContain("framing: none");
  });

  const FIXTURE = path.join(import.meta.dir, "fixtures", "print-config.ts");
  const NO_YAML = path.join(os.tmpdir(), `cidx-no-such-config-${randomUUID()}.yml`);

  async function runConfig(env: Record<string, string>): Promise<Record<string, any>> {
    const proc = Bun.spawn(["bun", "run", FIXTURE], {
      env: { ...process.env, CIDX_CONFIG: NO_YAML, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(out.trim().split("\n").pop()!) as Record<string, any>;
  }

  test('EMBEDDING_FRAMING=auto overrides; an invalid value falls back to "none"', async () => {
    const auto = await runConfig({ EMBEDDING_FRAMING: "auto" });
    expect(auto.CONFIG.EMBEDDING_FRAMING).toBe("auto");
    const bad = await runConfig({ EMBEDDING_FRAMING: "prefix-all" });
    expect(bad.CONFIG.EMBEDDING_FRAMING).toBe("none");
  });
});

// ---------------------------------------------------------------- registry

describe("registry — the framing column", () => {
  test("a record's framing round-trips through upsert/get (preset id and null)", () => {
    const dbPath = tempDbPath();
    const reg = new Registry(dbPath);
    try {
      reg.upsertIndex(makeRecord("t1", { framing: "embeddinggemma-2" }));
      expect(reg.getIndex(INDEX)?.framing).toBe("embeddinggemma-2");
      reg.upsertIndex(makeRecord("t1", { framing: null }));
      expect(reg.getIndex(INDEX)?.framing).toBeNull();
      // A legacy-shaped record WITHOUT the field writes null, not junk.
      const legacy = { ...makeRecord("t1") } as Partial<IndexRecord>;
      delete legacy.framing;
      reg.upsertIndex(legacy as IndexRecord);
      expect(reg.getIndex(INDEX)?.framing).toBeNull();
    } finally {
      reg.close();
      removeDb(dbPath);
    }
  });

  test("setIndexFraming re-pins without touching anything else", () => {
    const dbPath = tempDbPath();
    const reg = new Registry(dbPath);
    try {
      reg.upsertIndex(makeRecord("t2", { embedModel: MODEL, embedDim: 4 }));
      reg.setIndexFraming(INDEX, "qwen3-embedding");
      const rec = reg.getIndex(INDEX)!;
      expect(rec.framing).toBe("qwen3-embedding");
      expect(rec.embedModel).toBe(MODEL);
      expect(rec.chunkCount).toBe(1);
      reg.setIndexFraming(INDEX, null);
      expect(reg.getIndex(INDEX)?.framing).toBeNull();
    } finally {
      reg.close();
      removeDb(dbPath);
    }
  });

  test("a registry predating the framing column is migrated lazily; legacy rows read as null and stay unforced", () => {
    // A raw pre-framing meta.db: no `framing` column at all — the same foreign
    // shape the table_name lazy migration handles.
    const dbPath = tempDbPath();
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE indexes (
      name TEXT PRIMARY KEY, path TEXT NOT NULL, table_name TEXT NOT NULL, status TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
      embed_model TEXT, embed_dim INTEGER, last_indexed_at INTEGER,
      created_at INTEGER NOT NULL, error TEXT
    )`);
    raw.run(
      `INSERT INTO indexes (name, path, table_name, status, embed_model, created_at)
       VALUES ('${INDEX}', '/proj', 'idx_legacy', 'ready', '${MODEL}', 1)`,
    );
    raw.close();

    const reg = new Registry(dbPath);
    try {
      // No backfill write on purpose: null IS the legacy value (unframed).
      const rec = reg.getIndex(INDEX)!;
      expect(rec.framing).toBeNull();
      expect(rec.embedModel).toBe(MODEL);
      expect(rec.tableName).toBe("idx_legacy");
      // The altered column accepts framed writes.
      reg.upsertIndex(makeRecord("idx_legacy", { framing: "embeddinggemma-2" }));
    } finally {
      reg.close();
    }
    const again = new Registry(dbPath);
    try {
      expect(again.getIndex(INDEX)?.framing).toBe("embeddinggemma-2");
    } finally {
      again.close();
      removeDb(dbPath);
    }
  });
});

// ----------------------------------------------- index-site framing (the wire)

describe("indexFile — documents framed at the embed site (stubbed wire)", () => {
  let projDir: string;
  let dbPath: string;
  let table: string;
  let reg: InstanceType<typeof Registry>;

  beforeAll(async () => {
    await db.initDB();
  });

  beforeEach(() => {
    projDir = mkdtempSync(path.join(os.tmpdir(), "cidx-framing-proj-"));
    mkdirSync(path.join(projDir, "src"), { recursive: true });
    writeFileSync(path.join(projDir, "src/a.py"), FILE_BODY);
    dbPath = tempDbPath();
    table = tempTable();
    reg = new Registry(dbPath);
    setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
    wire.calls = [];
  });

  afterEach(() => {
    resetEmbedBackend();
    reg.close();
    removeDb(dbPath);
    rmTemp(projDir);
  });

  const target = (): { indexName: string; tableName: string; baseDir: string } => ({
    indexName: INDEX,
    tableName: table,
    baseDir: projDir,
  });
  const file = (): string => path.join(projDir, "src/a.py");

  test("a framed embeddinggemma record prefixes content AND the docstring leg; stored text stays raw", async () => {
    const r = await indexFile(target(), file(), reg, undefined, MODEL, "embeddinggemma-2");
    expect(r.chunks).toBe(1);

    const [row] = await allRows(table);
    expect(row?.doc).toBeTruthy();

    // Two embed calls: the content leg, then the docstring leg — both framed
    // with the document prefix.
    expect(wire.calls.length).toBe(2);
    expect(wire.calls[0]!.model).toBe(MODEL);
    expect(wire.calls[0]!.texts[0]).toBe("title: none\n\ntext: " + row!.content);
    expect(wire.calls[1]!.texts[0]).toBe("title: none\n\ntext: " + row!.doc);

    // The stored chunk/doc are the RAW text — framing lives in the vector.
    expect(row!.content.startsWith("title:")).toBe(false);
  });

  test("a null framing sends the RAW texts — byte-identical pre-framing behavior", async () => {
    await indexFile(target(), file(), reg, undefined, MODEL, null);

    const rows = await allRows(table);
    expect(wire.calls.length).toBe(2);
    expect(wire.calls[0]!.texts[0]).toBe(rows[0]!.content);
    expect(wire.calls[1]!.texts[0]).toBe(rows[0]!.doc!);
  });

  test("the cache keys on the FRAMED text: a re-run hits the cache; a framing change re-keys", async () => {
    await indexFile(target(), file(), reg, undefined, MODEL, "embeddinggemma-2");
    expect(wire.calls.length).toBe(2);

    // Same framed text → same hash → the cache serves the re-index.
    reg.clearFileCache(INDEX); // drop the mtime skip so indexFile runs again
    wire.calls = [];
    await indexFile(target(), file(), reg, undefined, MODEL, "embeddinggemma-2");
    expect(wire.calls.length).toBe(0);

    // Unframed text hashes differently → a fresh embed of the RAW input.
    reg.clearFileCache(INDEX); // clear the mtime skip again
    wire.calls = [];
    const otherTable = tempTable();
    try {
      await indexFile(
        { indexName: INDEX, tableName: otherTable, baseDir: projDir },
        file(),
        reg,
        undefined,
        MODEL,
        null,
      );
      expect(wire.calls.length).toBe(2);
      const [row] = await allRows(otherTable);
      expect(wire.calls[0]!.texts[0]).toBe(row!.content); // the raw text itself
      expect(wire.calls[0]!.texts[0]).not.toBe("title: none\n\ntext: " + row!.content);
    } finally {
      await db.dropTable(otherTable);
    }
  });
});

// ------------------------------------------------ query-site framing (the wire)

describe("searchIndex — the query framed per record (stubbed wire)", () => {
  const QUERY = "alpha";
  let dbPath: string;
  let table: string;
  let reg: InstanceType<typeof Registry>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    await db.initDB();
  });

  beforeEach(async () => {
    dbPath = tempDbPath();
    table = tempTable();
    reg = new Registry(dbPath);
    manager = new IndexManager(reg, new JobQueue({ registry: reg }));
    reg.upsertIndex(makeRecord(table, { embedModel: MODEL, framing: "embeddinggemma-2" }));
    await db.insertChunks(table, [sourceRecord(FILE, FILE_BODY, MODEL, DOC_TEXT)]);
    setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
    wire.calls = [];
  });

  afterEach(async () => {
    await manager?.shutdown();
    resetEmbedBackend();
    reg.close();
    removeDb(dbPath);
  });

  const searchOpts = { mode: "vector", rerank: false, mmr: false, doc: false } as const;

  test("the query is framed with the record's framing and cached on the framed text", async () => {
    const { results } = await manager.searchIndex(INDEX, QUERY, 3, searchOpts);
    expect(results.length).toBeGreaterThan(0);
    expect(wire.calls.length).toBe(1);
    expect(wire.calls[0]!.url.endsWith("/api/embeddings")).toBe(true);
    expect(wire.calls[0]!.texts[0]).toBe("task: search result\n\nquery: " + QUERY);

    // The identical search → the framed hash hits the cache → no wire call.
    wire.calls = [];
    await manager.searchIndex(INDEX, QUERY, 3, searchOpts);
    expect(wire.calls.length).toBe(0);
  });

  test("the BM25 (text) mode never embeds, so framing stays out of its way", async () => {
    const { results } = await manager.searchIndex(INDEX, "alpha", 3, { mode: "text" });
    expect(results.length).toBeGreaterThan(0);
    expect(wire.calls.length).toBe(0);
  });

  test("an unframed record embeds the RAW query — the framed and raw cache keys differ", async () => {
    reg.setIndexFraming(INDEX, null);
    await manager.searchIndex(INDEX, QUERY, 3, searchOpts);
    expect(wire.calls.length).toBe(1);
    expect(wire.calls[0]!.texts[0]).toBe(QUERY);
  });

  test("searchAll frames per record exactly like searchIndex", async () => {
    const { results } = await manager.searchAll(QUERY, 3, searchOpts);
    expect(results.length).toBeGreaterThan(0);
    expect(wire.calls.every((c) => c.texts[0] === "task: search result\n\nquery: " + QUERY)).toBe(true);
  });
});

// ------------------------------- syncIndex escalation + migrate carries framing

describe("syncIndex escalation — a framing change migrates with the target framing", () => {
  let projDir: string;
  let dbPath: string;
  let table: string;
  let registry: InstanceType<typeof Registry>;
  let queue: InstanceType<typeof JobQueue>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    await db.initDB();
  });

  beforeEach(() => {
    projDir = mkdtempSync(path.join(os.tmpdir(), "cidx-framing-esc-"));
    dbPath = tempDbPath();
    table = tempTable();
    registry = new Registry(dbPath);
    queue = new JobQueue({ registry });
    manager = new IndexManager(registry, queue);
    setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
    wire.calls = [];
  });

  afterEach(async () => {
    await manager?.shutdown();
    resetEmbedBackend();
    registry?.close();
    removeDb(dbPath);
    rmTemp(projDir);
  });

  function seed(model: string, framing: string | null): void {
    registry.upsertIndex(makeRecord(table, { path: projDir, embedModel: model, embedDim: 4, framing }));
  }

  const searchOpts = { mode: "vector", rerank: false, mmr: false, doc: false } as const;

  test("eg2 preset: the shadow is embedded with framed documents and the swap pins the framing", async () => {
    writeFileSync(path.join(projDir, ".cidx.json"), JSON.stringify({ embedModel: MODEL, framing: "auto" }));
    seed(MODEL, null); // legacy unframed record
    await db.insertChunks(table, [sourceRecord(FILE, FILE_BODY, MODEL, DOC_TEXT)]);

    manager.syncIndex(INDEX);
    expect(registry.getIndex(INDEX)!.status).toBe("indexing");
    const job = manager.activeJob(INDEX);
    expect(job?.type).toBe("migrate");
    await queue.waitForJob(job!.id);

    // Registry flip: framing pinned, model unchanged, table swapped.
    const flipped = registry.getIndex(INDEX)!;
    expect(flipped.tableName).toBe(`${table}_mig`);
    expect(flipped.framing).toBe("embeddinggemma-2");
    expect(flipped.embedModel).toBe(MODEL);
    expect(flipped.status).toBe("ready");

    // The wire saw FRAMED document texts only — content and docstring legs.
    const framedTexts = wire.calls.flatMap((c) => c.texts);
    expect(framedTexts.length).toBeGreaterThanOrEqual(2);
    for (const t of framedTexts) expect(t.startsWith("title: none\n\ntext: ")).toBe(true);
    expect(framedTexts).toContain("title: none\n\ntext: " + DOC_TEXT);

    // The shadow really holds FRAMED vectors: nearest to the framed text's
    // vector, with the stored content kept RAW.
    const shadowRows = await allRows(`${table}_mig`);
    expect(shadowRows.length).toBe(1);
    const row = shadowRows[0]!;
    const hits = await db.searchTable(`${table}_mig`, vecFor("title: none\n\ntext: " + row.content, MODEL), 1);
    expect(hits[0]?.content).toBe(row.content);
    expect(hits[0]?._distance ?? 9).toBeLessThan(1e-6);
    const docHits = await db.searchTable(
      `${table}_mig`,
      vecFor("title: none\n\ntext: " + row.doc, MODEL),
      1,
      undefined,
      "doc_vector",
    );
    expect(docHits[0]?._distance ?? 9).toBeLessThan(1e-6);

    // Search after the swap frames the QUERIES with the eg2 preset.
    wire.calls = [];
    await manager.searchIndex(INDEX, "q", 3, searchOpts);
    expect(wire.calls[0]!.texts[0]).toBe("task: search result\n\nquery: q");

    // A second sync is no escalation: the pin matches the config again.
    const again = manager.syncIndex(INDEX);
    const next = manager.activeJob(INDEX);
    expect(next?.type).toBe("index");
    if (next) await queue.waitForJob(next.id);
    expect(again.tableName).toBe(`${table}_mig`);
  });

  test("qwen3 preset: documents stay UNframed while queries get the official instruction", async () => {
    writeFileSync(path.join(projDir, ".cidx.json"), JSON.stringify({ embedModel: QWEN_MODEL, framing: "auto" }));
    seed(QWEN_MODEL, null);
    await db.insertChunks(table, [sourceRecord(FILE, FILE_BODY, QWEN_MODEL, DOC_TEXT)]);

    manager.syncIndex(INDEX);
    expect(registry.getIndex(INDEX)!.status).toBe("indexing");
    const job = manager.activeJob(INDEX);
    expect(job?.type).toBe("migrate");
    await queue.waitForJob(job!.id);

    const flipped = registry.getIndex(INDEX)!;
    expect(flipped.framing).toBe("qwen3-embedding");
    expect(flipped.embedModel).toBe(QWEN_MODEL);
    expect(flipped.tableName).toBe(`${table}_mig`);

    // The document re-embed under the qwen preset is the RAW text (the preset
    // has no doc prefix) — the wire never sees a document prefix.
    const embedded = wire.calls.flatMap((c) => c.texts);
    expect(embedded).toContain(FILE_BODY);
    expect(embedded.some((t) => t.startsWith("title: none"))).toBe(false);

    // Content vectors did not move: same raw input, same stub vector.
    const hits = await db.searchTable(`${table}_mig`, vecFor(FILE_BODY, QWEN_MODEL), 1);
    expect(hits[0]?.content).toBe(FILE_BODY);
    expect(hits[0]?._distance ?? 9).toBeLessThan(1e-6);

    // Queries — and only queries — carry the official instruction now.
    wire.calls = [];
    await manager.searchIndex(INDEX, "q", 3, searchOpts);
    expect(wire.calls[0]!.texts[0]).toBe(
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: q",
    );
  });

  test("a legacy null record under the none default does NOT escalate (no forced reindex)", async () => {
    // No .cidx.json → the global default ("none") resolves to null == the pin.
    seed(MODEL, null);
    await db.insertChunks(table, [sourceRecord(FILE, FILE_BODY, MODEL, DOC_TEXT)]);

    manager.syncIndex(INDEX);
    const job = manager.activeJob(INDEX);
    expect(job?.type).toBe("index"); // a plain incremental sync, not a migrate
    if (job) await queue.waitForJob(job.id);
    const rec = registry.getIndex(INDEX)!;
    expect(rec.tableName).toBe(table);
    expect(rec.framing).toBeNull();

    // The unframed search embeds the raw query.
    wire.calls = [];
    await manager.searchIndex(INDEX, "raw q", 3, searchOpts);
    expect(wire.calls[0]!.texts[0]).toBe("raw q");
  });
});

// ------------------------------------------------------ watcher framing guard

describe("watcher — a framing divergence skips writes (the model-mismatch rule's twin)", () => {
  let projDir: string;
  let dbPath: string;
  let table: string;
  let reg: InstanceType<typeof Registry>;

  beforeAll(async () => {
    await db.initDB();
  });

  beforeEach(() => {
    projDir = mkdtempSync(path.join(os.tmpdir(), "cidx-framing-watch-"));
    mkdirSync(path.join(projDir, "src"), { recursive: true });
    writeFileSync(path.join(projDir, "src/a.py"), FILE_BODY);
    // The per-project config resolves to the eg2 preset under the pinned model.
    writeFileSync(path.join(projDir, ".cidx.json"), JSON.stringify({ embedModel: MODEL, framing: "auto" }));
    dbPath = tempDbPath();
    table = tempTable();
    reg = new Registry(dbPath);
    setEmbedBackend({ provider: "ollama", url: CONFIG.OLLAMA_URL, reason: "explicit" });
    wire.calls = [];
  });

  afterEach(() => {
    resetEmbedBackend();
    reg.close();
    removeDb(dbPath);
    rmTemp(projDir);
  });

  const file = (): string => path.join(projDir, "src/a.py");
  const touch = (): void => writeFileSync(file(), FILE_BODY + "\n# touched " + Date.now() + "\n");
  // Real chokidar watch; a short debounce but awaitWriteFinish still adds its
  // ~200ms stability window before each event fires.
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 1300));

  test("a pin below the intended framing skips writes until migrated; a match writes framed", async () => {
    // Legacy pin (null) vs a config resolving to the eg2 preset → the DIVERGENCE.
    reg.upsertIndex(makeRecord(table, { path: projDir }));
    const w = startWatcher({ indexName: INDEX, tableName: table, baseDir: projDir }, {
      registry: reg,
      debounceMs: 50,
    });
    try {
      touch();
      await settle();
      // Nothing written, nothing embedded — the divergence, not the model
      // rule, is what skipped this (model and pin agree by construction).
      expect(await db.countTableRows(table)).toBe(0);
      expect(wire.calls.length).toBe(0);

      // After the (off-screen) migration the pin matches the config → the
      // watcher writes framed documents again.
      reg.setIndexFraming(INDEX, "embeddinggemma-2");
      touch();
      await settle();
      expect(wire.calls.length).toBeGreaterThanOrEqual(1);
      const [row] = await allRows(table);
      const framedTexts = wire.calls.flatMap((c) => c.texts);
      expect(framedTexts).toContain("title: none\n\ntext: " + row!.content);
      // The write used the RECORD's model (pinned, matching the config).
      for (const c of wire.calls) expect(c.model).toBe(MODEL);
    } finally {
      await w.close();
    }
  });
});