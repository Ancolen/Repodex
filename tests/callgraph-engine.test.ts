/**
 * Call-graph engine wiring tests (LanceDB-free).
 *
 * `getCallGraph`'s adjacency lives in LanceDB (`tableSymbolsWithContent`), so the
 * happy path is covered by the pure suite (`callgraph.test.ts`) + the live smoke
 * in the changelog. This file pins the contract of the layer ABOVE LanceDB: the
 * anchor validation ("symbol and/or path") and project resolution (explicit /
 * inferred / ambiguous / not-found). These paths never touch LanceDB, so they run
 * against a temp sqlite registry with no Ollama and no daemon.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Registry } from "../src/core/registry";
import { IndexManager } from "../src/core/index-manager";
import { JobQueue } from "../src/core/job-queue";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import path from "node:path";

const DB_PATH = path.join(tmpdir(), `mcp-cg-${randomUUID()}.db`);

let reg: Registry;
let manager: IndexManager;

beforeAll(() => {
  reg = new Registry(DB_PATH);
  manager = new IndexManager(reg, new JobQueue());
});
afterAll(() => {
  rmSync(DB_PATH, { force: true });
});

describe("getCallGraph — anchor + project resolution (LanceDB-free)", () => {
  test("needs a symbol and/or a path", async () => {
    await expect(manager.getCallGraph({})).rejects.toThrow(/symbol name and\/or a file path/);
  });

  test("symbol only with zero indexed projects → helpful error", async () => {
    await expect(manager.getCallGraph({ symbol: "foo" })).rejects.toThrow(/No indexed project/);
  });

  test("symbol only with multiple projects and no --project → ambiguous error", async () => {
    reg.upsertIndex({
      name: "alpha", path: "/alpha", tableName: "idx_alpha", status: "ready",
      fileCount: 1, chunkCount: 1, embedModel: null, embedDim: null,
      lastIndexedAt: null, createdAt: 1, error: null,
    });
    reg.upsertIndex({
      name: "beta", path: "/beta", tableName: "idx_beta", status: "ready",
      fileCount: 1, chunkCount: 1, embedModel: null, embedDim: null,
      lastIndexedAt: null, createdAt: 1, error: null,
    });
    await expect(manager.getCallGraph({ symbol: "foo" })).rejects.toThrow(/could belong to multiple projects/);
  });

  test("explicit --project that does not exist → not-found error", async () => {
    await expect(manager.getCallGraph({ symbol: "foo", project: "nope" })).rejects.toThrow(/Index not found/);
  });

  test("a path outside every indexed project → error", async () => {
    await expect(manager.getCallGraph({ path: "/nonexistent/outside.ts" })).rejects.toThrow(
      /No indexed project contains/,
    );
  });
});
