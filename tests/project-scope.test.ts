/**
 * Project-scope resolution tests (LanceDB-free).
 *
 * The self-healing error contract shared by every tool that accepts
 * `project?`/`path?`: an unknown name lists the available projects (and the
 * likeliest intended one), a path anchors to the most-specific containing
 * project, and the single-indexed-project fallback. These paths never touch
 * LanceDB, so they run against a temp sqlite registry — the same shape as
 * `callgraph-engine.test.ts`.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Registry } from "../src/core/registry";
import { IndexManager, indexNotFoundMessage } from "../src/core/index-manager";
import { JobQueue } from "../src/core/job-queue";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import path from "node:path";

function upsert(reg: Registry, name: string, projectPath: string): void {
  reg.upsertIndex({
    name,
    path: projectPath,
    tableName: `idx_${name}`,
    status: "ready",
    fileCount: 1,
    chunkCount: 1,
    embedModel: null,
    embedDim: null,
    lastIndexedAt: null,
    createdAt: 1,
    error: null,
  });
}

describe("indexNotFoundMessage — the self-healing unknown-project error", () => {
  test("names the available projects", () => {
    const msg = indexNotFoundMessage("nope", ["alpha", "beta"]);
    expect(msg).toContain("Index not found: nope");
    expect(msg).toContain("(available: alpha, beta)");
  });

  test("suggests the likeliest intended project for a close guess", () => {
    const msg = indexNotFoundMessage("alph", ["alpha", "beta"]);
    expect(msg).toContain("did you mean 'alpha'?");
  });

  test("case-insensitive + substring guesses are caught", () => {
    expect(indexNotFoundMessage("repodex-wrong", ["Repodex", "projects"])).toContain(
      "did you mean 'Repodex'?",
    );
  });

  test("no hint for an unrelated name", () => {
    const msg = indexNotFoundMessage("zzz-unrelated", ["alpha", "beta"]);
    expect(msg).not.toContain("did you mean");
    expect(msg).toContain("(available: alpha, beta)");
  });

  test("bare message when nothing is indexed", () => {
    expect(indexNotFoundMessage("nope", [])).toBe("Index not found: nope");
  });
});

describe("resolveProjectScope — one project indexed", () => {
  const DB1 = path.join(tmpdir(), `mcp-scope1-${randomUUID()}.db`);
  let reg1: Registry;
  let manager1: IndexManager;

  beforeAll(() => {
    reg1 = new Registry(DB1);
    manager1 = new IndexManager(reg1, new JobQueue());
    upsert(reg1, "solo", "/solo");
  });
  afterAll(() => {
    rmSync(DB1, { force: true });
  });

  test("explicit name resolves", () => {
    expect(manager1.resolveProjectScope("solo")).toBe("solo");
  });

  test("a path inside the project resolves to it", () => {
    expect(manager1.resolveProjectScope(undefined, "/solo/src/x.ts")).toBe("solo");
  });

  test("nothing given → undefined when allWhenUnset (the search family)", () => {
    expect(manager1.resolveProjectScope()).toBeUndefined();
  });

  test("nothing given → the single project when !allWhenUnset (the report tools)", () => {
    expect(manager1.resolveProjectScope(undefined, undefined, false)).toBe("solo");
  });
});

describe("resolveProjectScope — multiple projects indexed", () => {
  const DB2 = path.join(tmpdir(), `mcp-scope2-${randomUUID()}.db`);
  let reg2: Registry;
  let manager2: IndexManager;

  beforeAll(() => {
    reg2 = new Registry(DB2);
    manager2 = new IndexManager(reg2, new JobQueue());
    upsert(reg2, "alpha", "/alpha");
    upsert(reg2, "child", "/alpha/child");
    upsert(reg2, "beta", "/beta");
  });
  afterAll(() => {
    rmSync(DB2, { force: true });
  });

  test("a path anchors to the MOST-SPECIFIC containing project", () => {
    expect(manager2.resolveProjectScope(undefined, "/alpha/child/src/x.ts")).toBe("child");
    expect(manager2.resolveProjectScope(undefined, "/alpha/src/x.ts")).toBe("alpha");
    expect(manager2.resolveProjectScope(undefined, "/beta/y.ts")).toBe("beta");
  });

  test("an explicit 'project' wins over the path", () => {
    expect(manager2.resolveProjectScope("beta", "/alpha/child/src/x.ts")).toBe("beta");
  });

  test("unknown name → the self-healing error (available list + hint)", () => {
    expect(() => manager2.resolveProjectScope("nope")).toThrow(
      /Index not found: nope \(available: alpha, child, beta\)/,
    );
  });

  test("a path outside every project → an error that names them", () => {
    expect(() => manager2.resolveProjectScope(undefined, "/elsewhere/x.ts")).toThrow(
      /No indexed project contains '\/elsewhere\/x\.ts' \(available: alpha, child, beta\)/,
    );
  });

  test("nothing given + !allWhenUnset → an error naming them all", () => {
    expect(() => manager2.resolveProjectScope(undefined, undefined, false)).toThrow(
      /Multiple projects are indexed \(alpha, child, beta\)/,
    );
  });
});