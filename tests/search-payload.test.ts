/**
 * Public search-result payload tests over a real fixture project.
 *
 * The contract: rows returned by `searchIndex`/`searchAll`/`findSymbol` (and
 * therefore by `/search`, `/find` and the MCP payloads — pack hits pass the
 * searchIndex rows through untouched) never carry the embedding columns —
 * `vector`/`doc_vector` are ~20 KB of floats per row that only the in-daemon
 * rerank/MMR machinery consumes. They
 * are dropped at the public boundary (`IndexManager.stripEmbeddings`), while
 * the raw LanceDB rows and `doc`/`id_terms` stay untouched. The fixture's
 * registry and table live on the throw-away root pinned by the `[test]`
 * preload. No Ollama — `text` mode needs no vectors.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Dynamic imports so the `[test]` preload (isolated CIDX_HOME) is in effect first.
const { randomUUID } = await import("node:crypto");
const db = await import("../src/services/db");
const CFG = (await import("../src/config")).CONFIG;
const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");
const { chunkCode } = await import("../src/chunking/chunker");
const { isolatedHome } = await import("./helpers/isolated-cidx-home");

describe("IndexManager public search results — no embedding columns (real fixture)", () => {
  const HOME = isolatedHome;
  const PROJECT = mkdtempSync(path.join(os.tmpdir(), "cidx-payload-proj-"));
  const DB_PATH = path.join(HOME, `payload-${randomUUID()}.db`);
  const TABLE = "idx_payload_fixture";

  const LIB = [
    "export function payloadProbe(input: string): string {",
    "  return input.trim();",
    "}",
  ].join("\n");

  let registry: InstanceType<typeof Registry>;
  let manager: InstanceType<typeof IndexManager>;

  beforeAll(async () => {
    expect(CFG.DB_DIR.startsWith(HOME)).toBe(true);
    await db.initDB();
    mkdirSync(path.join(PROJECT, "src"), { recursive: true });
    writeFileSync(path.join(PROJECT, "src", "lib.ts"), LIB);

    registry = new Registry(DB_PATH);
    registry.upsertIndex({
      name: "payfix",
      path: PROJECT,
      tableName: TABLE,
      status: "ready",
      fileCount: 1,
      chunkCount: 1,
      embedModel: null,
      embedDim: null,
      lastIndexedAt: 1700000000000,
      createdAt: 1,
      error: null,
    });
    registry.setFileMtime("payfix", path.join(PROJECT, "src", "lib.ts"), 1);

    const abs = path.join(PROJECT, "src", "lib.ts");
    const chunks = await chunkCode(abs, LIB);
    await db.insertChunks(
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
    manager = new IndexManager(registry, new JobQueue());
  });

  afterAll(() => {
    manager?.stopAll?.();
    registry?.close();
    rmSync(DB_PATH, { force: true });
    rmSync(PROJECT, { recursive: true, force: true });
  });

  test("findSymbol results carry content but no vector/doc_vector", async () => {
    const rows = await manager.findSymbol("payloadProbe", "payfix");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect("vector" in r).toBe(false);
      expect("doc_vector" in r).toBe(false);
      expect(typeof r.content).toBe("string");
      expect(r.symbolName).toBe("payloadProbe");
    }
  });

  test("text-mode search results carry content but no vector/doc_vector", async () => {
    const { results: rows } = await manager.searchIndex("payfix", "payloadProbe", 5, {
      mode: "text",
      rerank: false,
      mmr: false,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect("vector" in r).toBe(false);
      expect("doc_vector" in r).toBe(false);
    }
  });

  // NOTE: context-pack hits need no separate test — `getContextPack` passes the
  // searchIndex/searchAll rows through as `hit` untouched, so the pack (and its
  // MCP structuredContent) inherits the stripped shape by construction.
});