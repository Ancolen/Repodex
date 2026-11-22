/**
 * Search input validation (2.10.0).
 *
 * The tool/HTTP schemas say "string", but a raw JSON consumer could still send
 * `undefined`, a number or `{queries: [...]}` to the single-query entry points —
 * `query.trim()` then crashed the request. Every public search call now rejects
 * a non-string/blank query with an actionable message instead.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager, assertSearchQuery } = await import("../src/core/index-manager");

let dir: string;
let registry: InstanceType<typeof Registry>;
let manager: InstanceType<typeof IndexManager>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `cidx-search-validation-${randomUUID()}-`));
  registry = new Registry(join(dir, "meta.db"));
  manager = new IndexManager(registry, new JobQueue({ registry }));
});

afterEach(async () => {
  await manager.shutdown();
  registry.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("assertSearchQuery", () => {
  test("rejects anything that is not a non-empty string, naming the batch tool", () => {
    for (const bad of [undefined, null, 42, {}, [], "", "   ", { queries: ["a"] }]) {
      expect(() => assertSearchQuery(bad)).toThrow(/non-empty string/);
    }
    expect(() => assertSearchQuery("ok")).not.toThrow();
  });
});

describe("search entry points reject malformed queries", () => {
  test("searchIndex / searchAll / getContextPack", async () => {
    await expect(manager.searchIndex("p", undefined as unknown as string)).rejects.toThrow(/non-empty string/);
    await expect(manager.searchAll(42 as unknown as string)).rejects.toThrow(/non-empty string/);
    await expect(manager.getContextPack({} as unknown as string)).rejects.toThrow(/non-empty string/);
  });

  test("searchBatch rejects a non-array or non-string elements", async () => {
    await expect(manager.searchBatch(undefined as unknown as string[])).rejects.toThrow(/array of non-empty strings/);
    await expect(manager.searchBatch(["ok", 5 as unknown as string])).rejects.toThrow(/array of non-empty strings/);
  });

  test("searchBatch drops blank entries and accepts an all-blank list as empty", async () => {
    expect(await manager.searchBatch([" ", ""])).toEqual([]);
  });

  test("a valid query with no indexed project is still a completed empty search", async () => {
    expect(await manager.searchAll("anything")).toEqual({ results: [] });
  });
});
