/**
 * The doccheck anchor rule (2.10.0): a fresh check and the stored-snapshot read
 * resolve the SAME project. An explicit `project` wins, a `path` anchors to its
 * containing project, and neither → the single indexed project. 0 projects or
 * 2+ is the self-healing pick-one error. Registry-only (no LanceDB, no daemon).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IndexRecord } from "../src/core/registry";

const { Registry } = await import("../src/core/registry");
const { JobQueue } = await import("../src/core/job-queue");
const { IndexManager } = await import("../src/core/index-manager");

let dir: string;
let registry: InstanceType<typeof Registry>;
let manager: InstanceType<typeof IndexManager>;

const rec = (name: string, projectPath: string): IndexRecord => ({
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `cidx-doccheck-scope-${randomUUID()}-`));
  registry = new Registry(join(dir, "meta.db"));
  manager = new IndexManager(registry, new JobQueue({ registry }));
});

afterEach(async () => {
  await manager.shutdown();
  registry.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("doccheck project resolution", () => {
  test("zero projects is an actionable error", () => {
    expect(() => manager.resolveDocCheckProject()).toThrow("No indexed project");
  });

  test("a single project is resolved without an anchor", () => {
    registry.upsertIndex(rec("solo", "/solo"));
    expect(manager.resolveDocCheckProject().name).toBe("solo");
    expect(manager.resolveDocCheckProject(undefined, "/solo/src/x.ts").name).toBe("solo");
  });

  test("two projects without an anchor is the pick-one error naming them", () => {
    registry.upsertIndex(rec("alpha", "/alpha"));
    registry.upsertIndex(rec("beta", "/beta"));
    expect(() => manager.resolveDocCheckProject()).toThrow(/multiple projects \(alpha, beta\)/);
    expect(() => manager.resolveDocCheckProject()).toThrow("pass the 'project' (or 'path') argument");
  });

  test("an explicit project wins; a path anchors to the most-specific project", () => {
    registry.upsertIndex(rec("alpha", "/alpha"));
    registry.upsertIndex(rec("child", "/alpha/child"));
    expect(manager.resolveDocCheckProject("alpha").name).toBe("alpha");
    expect(manager.resolveDocCheckProject(undefined, "/alpha/child/src/x.ts").name).toBe("child");
    expect(manager.resolveDocCheckProject(undefined, "/alpha/src/x.ts").name).toBe("alpha");
  });

  test("an unknown project is the self-healing not-found error", () => {
    registry.upsertIndex(rec("solo", "/solo"));
    expect(() => manager.resolveDocCheckProject("ghost")).toThrow("Index not found");
  });
});

describe("lastDocCheckReport anchor rule", () => {
  test("a single project answers an anchorless stored-snapshot read", async () => {
    registry.upsertIndex(rec("solo", "/solo"));
    registry.saveDocCheckReport({
      project: "solo",
      ts: 1700000000000,
      consistent: true,
      findings: 0,
      needsReview: 0,
      reportJson: "{}",
    });
    const found = await manager.lastDocCheckReport({});
    expect(found).not.toBeNull();
    expect(found!.project).toBe("solo");
    expect(found!.ts).toBe(1700000000000);
  });

  test("two projects without an anchor refuse instead of guessing", async () => {
    registry.upsertIndex(rec("alpha", "/alpha"));
    registry.upsertIndex(rec("beta", "/beta"));
    await expect(manager.lastDocCheckReport({})).rejects.toThrow("multiple projects");
  });
});
