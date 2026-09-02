/**
 * Integration test for the dependency-graph ENGINE (getDependencies) against the
 * repo's own source. No Ollama, no LanceDB — getDependencies only needs the
 * files on disk + the registry's file_cache, so we register a fake "ready"
 * project seeded with the real src/*.ts paths and exercise the full path:
 * extractImports → resolveImports → buildImportGraph (forward + reverse).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Registry } from "../src/core/registry";
import { JobQueue } from "../src/core/job-queue";
import { IndexManager } from "../src/core/index-manager";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "src");
const DB_PATH = path.join(tmpdir(), `mcp-deps-${randomUUID()}.db`);

/** Recursively collects every .ts file under src/. */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTs(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

let reg: Registry;
let manager: IndexManager;
let files: string[];

beforeAll(() => {
  reg = new Registry(DB_PATH);
  files = collectTs(SRC);
  reg.upsertIndex({
    name: "repodex",
    path: ROOT,
    tableName: "idx_repodex_test",
    status: "ready",
    fileCount: files.length,
    chunkCount: files.length,
    embedModel: null,
    embedDim: null,
    lastIndexedAt: null,
    createdAt: 1,
    error: null,
  });
  for (const f of files) reg.setFileMtime("repodex", f, statSync(f).mtimeMs);
  manager = new IndexManager(reg, new JobQueue());
});

afterAll(() => {
  rmSync(DB_PATH, { force: true });
});

describe("getDependencies — engine against real repo files", () => {
  test("project is inferred from the file path; imports resolve", async () => {
    const r = await manager.getDependencies(path.join(SRC, "core/index-manager.ts"));
    expect(r.project).toBe("repodex");
    expect(r.file).toBe(path.join(SRC, "core/index-manager.ts"));
    // "./registry" resolves to an indexed file.
    const registryEdge = r.imports.find(
      (e) => e.status === "resolved" && e.path?.endsWith(path.join("core", "registry.ts")),
    );
    expect(registryEdge).toBeTruthy();
    // Bare specifiers (node:fs, chokidar, ...) are external.
    expect(r.imports.some((e) => e.status === "external")).toBe(true);
    // Invariant: every resolved path is inside the indexed tree (no phantoms).
    for (const e of r.imports) {
      if (e.status === "resolved") expect(e.path!.startsWith(ROOT)).toBe(true);
    }
  });

  test("reverse graph: who imports index-manager", async () => {
    const r = await manager.getDependencies(path.join(SRC, "core/index-manager.ts"));
    // Real importers (incl. type-only imports): the daemon entry + the server
    // layer + the formatter (which imports result types from index-manager).
    expect(r.importedBy).toContain(path.join("src", "index.ts"));
    expect(r.importedBy).toContain(path.join("src", "server", "mcp.ts"));
    expect(r.importedBy).toContain(path.join("src", "server", "control-api.ts"));
    expect(r.importedBy).toContain(path.join("src", "server", "format.ts"));
    expect(r.scannedFiles).toBe(files.length);
  });

  test("reverse edge: index-manager imports resolve", async () => {
    const r = await manager.getDependencies(path.join(SRC, "core", "resolve.ts"));
    expect(r.importedBy).toContain(path.join("src", "core", "index-manager.ts"));
  });

  test("the mtime-cached reverse graph is stable across calls", async () => {
    const a = await manager.getDependencies(path.join(SRC, "core/index-manager.ts"));
    const b = await manager.getDependencies(path.join(SRC, "core/index-manager.ts"));
    expect(b.importedBy).toEqual(a.importedBy);
    expect(b.imports.length).toBe(a.imports.length);
  });

  test("explicit --project works", async () => {
    const r = await manager.getDependencies(
      path.join(SRC, "core/index-manager.ts"),
      "repodex",
    );
    expect(r.project).toBe("repodex");
  });

  test("a file outside any indexed project throws (no silent match)", async () => {
    await expect(manager.getDependencies("/nonexistent/outside.ts")).rejects.toThrow(
      /No indexed project/,
    );
  });
});
