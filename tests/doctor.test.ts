/**
 * `cidx doctor` (proposal O1) — the check registry in `src/core/doctor.ts`.
 *
 * Every check is a pure function over injected, already-measured state, so this
 * suite needs no daemon, no Ollama and no LanceDB. The single exception is
 * `measureDiskUsage`, which walks a temp directory it creates itself.
 */
import { test, expect, describe } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateStatus,
  configCheck,
  daemonCheck,
  diskCheck,
  formatBytes,
  inspectConfigFile,
  measureDiskUsage,
  backendCheck,
  type BackendProbeState,
  orphanTablesCheck,
  projectCheck,
  projectFindings,
  rerankerCheck,
  runDoctor,
  type DoctorPorts,
  type ProjectDoctorState,
} from "../src/core/doctor";
import { modelTagPresent } from "../src/utils/model-tag";

/** The 2.4.0 schema — every column a fresh table carries. */
const FRESH_COLUMNS = [
  "id", "filePath", "content", "vector", "language",
  "symbolName", "symbolType", "startLine", "endLine", "doc", "doc_vector",
];

/** Pre-2.4.0 schema — the docstring columns are missing. */
const LEGACY_COLUMNS = FRESH_COLUMNS.filter((c) => c !== "doc" && c !== "doc_vector");

const FRESH_INDICES = [
  { columns: ["vector"], indexType: "IvfPq" },
  { columns: ["content"], indexType: "Inverted" },
  { columns: ["doc"], indexType: "Inverted" },
];

/** A healthy, fully-current project. */
function projectState(overrides: Partial<ProjectDoctorState> = {}): ProjectDoctorState {
  return {
    name: "api",
    path: "/home/dev/api",
    tableName: "idx_api",
    status: "ready",
    error: null,
    fileCount: 12,
    chunkCount: 120,
    embedModel: "qwen3-embedding",
    tableExists: true,
    tableRows: 120,
    columns: FRESH_COLUMNS,
    indices: FRESH_INDICES,
    modelOnBackend: true,
    vectorIndexThreshold: 50000,
    docstringsEnabled: true,
    ...overrides,
  };
}

/** Fully-wired fake ports: a healthy install unless overridden. */
function ports(overrides: Partial<DoctorPorts> = {}): DoctorPorts {
  return {
    indexes: () => [],
    tableNames: async () => [],
    tableColumns: async () => [],
    rowCount: async () => 0,
    tableIndices: async () => [],
    backend: async () => BACKEND_OK,
    rerankerAvailable: async () => true,
    configPath: () => null,
    readText: async () => null,
    diskUsage: () => ({
      root: "/home/dev/.cidx",
      rootExists: true,
      totalBytes: 2048,
      entries: [{ name: "db", bytes: 2048 }],
      tables: [{ name: "idx_api", bytes: 2048 }],
      errors: 0,
    }),
    settings: {
      home: "/home/dev/.cidx",
      dbDir: "/home/dev/.cidx/db",
      embedModel: "qwen3-embedding",
      docstrings: true,
      vectorIndexThreshold: 50000,
      rerankEnabled: true,
      rerankModel: "qwen3-reranker-q8",
    },
    ...overrides,
  };
}

const byId = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id);

// ------------------------------------------------------------------- daemon

describe("doctor — daemonCheck", () => {
  test("unreachable daemon is a fail with the start hint", () => {
    const c = daemonCheck({ reachable: false, cliVersion: "2.4.0" });
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("cidx start");
  });

  test("CLI ↔ daemon version mismatch is a warn with the restart hint", () => {
    const c = daemonCheck({ reachable: true, cliVersion: "2.5.0", daemonVersion: "2.4.0", pid: 42 });
    expect(c.status).toBe("warn");
    expect(c.hint).toContain("cidx stop");
    expect(c.detail).toContain("2.5.0");
    expect(c.detail).toContain("2.4.0");
  });

  test("matching versions are ok", () => {
    const c = daemonCheck({ reachable: true, cliVersion: "2.4.0", daemonVersion: "2.4.0", pid: 42 });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("pid 42");
  });
});

// ------------------------------------------------------------------- backend

const BACKEND_OK: BackendProbeState = {
  provider: "ollama",
  url: "http://127.0.0.1:11434",
  up: true,
  models: ["qwen3-embedding:latest", "qwen3-reranker-q8:latest"],
};

describe("doctor — modelTagPresent", () => {
  test("matches an exact tag, a bare name against its :latest tag, and a pinned variant", () => {
    const models = ["qwen3-embedding:latest", "qwen3-embedding:8b-q8_0", "llama3"];
    expect(modelTagPresent(models, "qwen3-embedding")).toBe(true);
    expect(modelTagPresent(models, "qwen3-embedding:latest")).toBe(true);
    expect(modelTagPresent(models, "qwen3-embedding:8b-q8_0")).toBe(true);
    expect(modelTagPresent(models, "llama3")).toBe(true);
    expect(modelTagPresent(models, "qwen3-reranker-q8")).toBe(false);
    expect(modelTagPresent(models, "")).toBe(false);
  });
});

describe("doctor — backendCheck", () => {
  test("no reachable backend is a fail with the both-servers hint", () => {
    const c = backendCheck({ provider: null, url: "", up: false, models: [] }, "qwen3-embedding");
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("ollama serve");
    expect(c.hint).toContain("llama-server");
    expect(c.hint).toContain("embedding.provider");
  });

  test("unreachable Ollama is a fail with the serve hint", () => {
    const c = backendCheck(
      { provider: "ollama", url: "http://127.0.0.1:11434", up: false, models: [] },
      "qwen3-embedding",
    );
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("ollama serve");
  });

  test("an unreachable llama-server is a fail naming llama-server", () => {
    const c = backendCheck(
      { provider: "llamacpp", url: "http://127.0.0.1:8080", up: false, models: [] },
      "embeddinggemma-2",
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("llama-server");
    expect(c.hint).toContain("llama-server -m");
  });

  test("a missing embedding model is a fail with the pull hint (Ollama)", () => {
    const c = backendCheck(
      { provider: "ollama", url: "http://127.0.0.1:11434", up: true, models: ["llama3"] },
      "qwen3-embedding",
    );
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("ollama pull qwen3-embedding");
  });

  test("a missing embedding model is a fail with the restart hint (llama-server)", () => {
    const c = backendCheck(
      { provider: "llamacpp", url: "http://127.0.0.1:8080", up: true, models: ["some-other-model"] },
      "embeddinggemma-2",
    );
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("restart llama-server");
  });

  test("a reachable Ollama with the configured model is ok", () => {
    const c = backendCheck(BACKEND_OK, "qwen3-embedding");
    expect(c.status).toBe("ok");
  });

  test("a live llama-server serving the model alias is ok", () => {
    const c = backendCheck(
      { provider: "llamacpp", url: "http://127.0.0.1:8080", up: true, models: ["embeddinggemma-2"] },
      "embeddinggemma-2",
    );
    expect(c.status).toBe("ok");
  });
});

// ---------------------------------------------------------------- reranker

describe("doctor — rerankerCheck", () => {
  test("disabled by config is ok (no reranker needed)", () => {
    const c = rerankerCheck({ enabled: false, model: "qwen3-reranker-q8", available: null });
    expect(c.status).toBe("ok");
  });

  test("an empty model string counts as disabled", () => {
    expect(rerankerCheck({ enabled: true, model: "", available: null }).status).toBe("ok");
  });

  test("an available model is ok", () => {
    expect(rerankerCheck({ enabled: true, model: "qwen3-reranker-q8", available: true }).status).toBe("ok");
  });

  test("a missing model is only a warn (search falls back to RRF order)", () => {
    const c = rerankerCheck({ enabled: true, model: "qwen3-reranker-q8", available: false });
    expect(c.status).toBe("warn");
    expect(c.hint).toContain("ollama pull qwen3-reranker-q8");
  });

  test("an unprobed model is a warn, not a fail", () => {
    expect(rerankerCheck({ enabled: true, model: "m", available: null }).status).toBe("warn");
  });
});

// ----------------------------------------------------------------- project

describe("doctor — projectCheck (healthy install)", () => {
  test("a fully current project is ok with no fix hint", () => {
    const c = projectCheck(projectState());
    expect(c.id).toBe("project:api");
    expect(c.status).toBe("ok");
    expect(c.hint).toBeUndefined();
    expect(c.detail).toContain("schema current");
  });
});

describe("doctor — projectCheck (table state)", () => {
  test("a missing table is a fail with the reindex hint and no further table findings", () => {
    const findings = projectFindings(projectState({ tableExists: false, tableRows: null, columns: [], indices: [] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.status).toBe("fail");
    expect(findings[0]!.hint).toBe("cidx reindex api — rebuilds the table");

    const c = projectCheck(projectState({ tableExists: false, tableRows: null, columns: [], indices: [] }));
    expect(c.status).toBe("fail");
  });

  test("a legacy (pre-2.4.0) schema yields the reindex hint for the docstring legs", () => {
    const c = projectCheck(projectState({ columns: LEGACY_COLUMNS, indices: FRESH_INDICES.slice(0, 2) }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("pre-2.4.0");
    expect(c.hint).toBe("cidx reindex api — enables the docstring search legs");
  });

  test("a legacy schema is by design when docstrings are disabled", () => {
    const c = projectCheck(projectState({ columns: LEGACY_COLUMNS, indices: FRESH_INDICES.slice(0, 2), docstringsEnabled: false }));
    expect(c.status).toBe("ok");
    expect(c.detail).not.toContain("pre-2.4.0");
  });

  test("a non-empty table without a content FTS index is a warn", () => {
    const c = projectCheck(projectState({ indices: [{ columns: ["vector"], indexType: "IvfPq" }] }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("BM25");
  });

  test("an empty table may legitimately lack indexes", () => {
    const c = projectCheck(projectState({ tableRows: 0, chunkCount: 0, indices: [] }));
    expect(c.status).toBe("ok");
  });

  test("a big table without an ANN index is a warn; a small one is by design", () => {
    const big = projectCheck(projectState({ tableRows: 60000, chunkCount: 60000, indices: FRESH_INDICES.slice(1) }));
    expect(big.status).toBe("warn");
    expect(big.detail).toContain("ANN");

    const small = projectCheck(projectState({ indices: FRESH_INDICES.slice(1) }));
    expect(small.status).toBe("ok");
    expect(small.detail).toContain("by design");
  });
});

describe("doctor — projectCheck (registry ↔ table sanity)", () => {
  test("a chunk-count mismatch is a warn with the sync hint", () => {
    const c = projectCheck(projectState({ tableRows: 90, chunkCount: 120 }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("120");
    expect(c.hint).toContain("cidx sync api");
  });

  test("an empty file cache over a non-empty table is a warn", () => {
    const c = projectCheck(projectState({ fileCount: 0 }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("file cache is empty");
  });

  test("counts are not flagged while a job is running", () => {
    const c = projectCheck(projectState({ status: "indexing", tableRows: 90, chunkCount: 120, fileCount: 0 }));
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("indexing in progress");
  });

  test("a failed job is a fail carrying the recorded error", () => {
    const c = projectCheck(projectState({ status: "error", error: "ollama unreachable" }));
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("ollama unreachable");
  });

  test("a project model missing from Ollama is a fail", () => {
    const c = projectCheck(projectState({ embedModel: "qwen3-embedding:8b-q8_0", modelOnBackend: false }));
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("ollama pull qwen3-embedding:8b-q8_0");
  });

  test("an unknown model list (Ollama unreachable) does not fail the project", () => {
    expect(projectCheck(projectState({ modelOnBackend: null })).status).toBe("ok");
  });

  test("the hint comes from the worst finding", () => {
    // A missing table (fail) outranks the legacy-schema warn.
    const c = projectCheck(projectState({ tableExists: false, tableRows: null, columns: LEGACY_COLUMNS }));
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("rebuilds the table");
  });
});

// ------------------------------------------------------------ orphan tables

describe("doctor — orphanTablesCheck", () => {
  test("disk tables missing from the registry are a warn naming the data dir", () => {
    const c = orphanTablesCheck({ tables: ["idx_api", "idx_ghost"], registeredTables: ["idx_api"], dbDir: "/h/.cidx/db" });
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("idx_ghost");
    expect(c.hint).toContain("/h/.cidx/db");
  });

  test("all tables registered is ok", () => {
    const c = orphanTablesCheck({ tables: ["idx_api"], registeredTables: ["idx_api"], dbDir: "/h/.cidx/db" });
    expect(c.status).toBe("ok");
  });

  test("an empty install is ok", () => {
    expect(orphanTablesCheck({ tables: [], registeredTables: [], dbDir: "/h/.cidx/db" }).status).toBe("ok");
  });
});

// ------------------------------------------------------------------- config

describe("doctor — inspectConfigFile (yaml)", () => {
  test("an absent file means defaults (ok)", () => {
    const f = inspectConfigFile("/h/.cidx/config.yml", "yaml", null);
    expect(f?.status).toBe("ok");
    expect(f?.message).toContain("defaults");
  });

  test("broken YAML is a warn with a fix hint (the daemon silently runs on defaults)", () => {
    const f = inspectConfigFile("/h/.cidx/config.yml", "yaml", "ollama:\n  model: [unclosed\n");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("does not parse");
    expect(f?.hint).toContain("restart the daemon");
  });

  test("a YAML scalar instead of a mapping is a warn", () => {
    const f = inspectConfigFile("/h/.cidx/config.yml", "yaml", "just some text\n");
    expect(f?.status).toBe("warn");
  });

  test("valid YAML is ok", () => {
    expect(inspectConfigFile("/h/.cidx/config.yml", "yaml", "ollama:\n  model: qwen3-embedding\n")?.status).toBe("ok");
  });
});

describe("doctor — inspectConfigFile (.cidx.json)", () => {
  test("an absent project config is not reported at all", () => {
    expect(inspectConfigFile("/p/.cidx.json", "project", null)).toBeNull();
  });

  test("invalid JSON is a warn", () => {
    const f = inspectConfigFile("/p/.cidx.json", "project", "{ languages: ");
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("invalid JSON");
  });

  test("a non-object payload is a warn", () => {
    expect(inspectConfigFile("/p/.cidx.json", "project", "[1,2]")?.status).toBe("warn");
  });

  test("fields failing the shared validator are a warn naming the valid fields", () => {
    const f = inspectConfigFile("/p/.cidx.json", "project", JSON.stringify({ languages: "typescript", nope: 1 }));
    expect(f?.status).toBe("warn");
    expect(f?.message).toContain("no valid fields");
    expect(f?.hint).toContain("embedModel");
  });

  test("a valid config is ok", () => {
    const f = inspectConfigFile("/p/.cidx.json", "project", JSON.stringify({ languages: ["typescript"], embedModel: "m" }));
    expect(f?.status).toBe("ok");
    expect(f?.message).toContain("2 field(s)");
  });

  test("an empty object is a valid no-op", () => {
    expect(inspectConfigFile("/p/.cidx.json", "project", "{}")?.status).toBe("ok");
  });
});

describe("doctor — configCheck", () => {
  test("no findings is ok", () => {
    const c = configCheck({ configPath: null, files: [] });
    expect(c.status).toBe("ok");
  });

  test("the worst file verdict wins and its hint is surfaced", () => {
    const bad = inspectConfigFile("/p/.cidx.json", "project", "{ oops")!;
    const good = inspectConfigFile("/p/.cidx.json", "project", "{}")!;
    const c = configCheck({ configPath: "/h/.cidx/config.yml", files: [good, bad] });
    expect(c.status).toBe("warn");
    expect(c.hint).toBe(bad.hint);
    expect(c.detail).toContain("config.yml");
  });
});

// --------------------------------------------------------------------- disk

describe("doctor — disk usage", () => {
  test("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("a missing data root is a warn", () => {
    const c = diskCheck({ root: "/nope", rootExists: false, totalBytes: 0, entries: [], tables: [], errors: 0 });
    expect(c.status).toBe("warn");
    expect(c.hint).toContain("cidx index");
  });

  test("a healthy root reports the total and the biggest tables", () => {
    const c = diskCheck({
      root: "/h/.cidx",
      rootExists: true,
      totalBytes: 500 * 1024 * 1024,
      entries: [{ name: "db", bytes: 490 * 1024 * 1024 }, { name: "meta.db", bytes: 10 * 1024 * 1024 }],
      tables: [{ name: "idx_api", bytes: 400 * 1024 * 1024 }, { name: "idx_b", bytes: 90 * 1024 * 1024 }],
      errors: 0,
    });
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("total 500.0 MB");
    expect(c.detail).toContain("idx_api 400.0 MB");
  });

  test("measureDiskUsage walks the tree and strips the .lance suffix", () => {
    const root = join(tmpdir(), `cidx-doctor-${crypto.randomUUID()}`);
    const tableDir = join(root, "db", "idx_demo.lance", "data");
    const manifest = join(root, "db", "__manifest");
    mkdirSync(tableDir, { recursive: true });
    mkdirSync(manifest, { recursive: true });
    writeFileSync(join(tableDir, "a.lance"), "x".repeat(1000));
    writeFileSync(join(tableDir, "b.lance"), "x".repeat(500));
    writeFileSync(join(manifest, "manifest.arrow"), "x".repeat(20));
    writeFileSync(join(root, "meta.db"), "x".repeat(10));
    try {
      const usage = measureDiskUsage(root);
      expect(usage.rootExists).toBe(true);
      expect(usage.totalBytes).toBe(1530);
      expect(usage.entries.find((e) => e.name === "meta.db")?.bytes).toBe(10);
      // LanceDB's own __manifest directory is not a table.
      expect(usage.tables).toEqual([{ name: "idx_demo", bytes: 1500 }]);
      expect(usage.errors).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("measureDiskUsage reports a missing root without throwing", () => {
    const usage = measureDiskUsage(join(tmpdir(), `cidx-nope-${crypto.randomUUID()}`));
    expect(usage.rootExists).toBe(false);
    expect(usage.totalBytes).toBe(0);
  });
});

// --------------------------------------------------------------- aggregate

describe("doctor — aggregateStatus", () => {
  test("a single fail outranks warns and oks", () => {
    expect(aggregateStatus([])).toBe("ok");
    expect(aggregateStatus([{ status: "ok" }, { status: "warn" }])).toBe("warn");
    expect(aggregateStatus([{ status: "ok" }, { status: "warn" }, { status: "fail" }])).toBe("fail");
  });
});

// ---------------------------------------------------------------- collector

describe("doctor — runDoctor (collector over fake ports)", () => {
  test("a healthy synthetic install is all-ok", async () => {
    const report = await runDoctor(
      ports({
        indexes: () => [
          {
            name: "api",
            path: "/home/dev/api",
            tableName: "idx_api",
            status: "ready",
            fileCount: 12,
            chunkCount: 120,
            embedModel: "qwen3-embedding",
            embedDim: null,
            lastIndexedAt: 1,
            createdAt: 1,
            error: null,
          },
        ],
        tableNames: async () => ["idx_api"],
        tableColumns: async () => FRESH_COLUMNS,
        rowCount: async () => 120,
        tableIndices: async () => FRESH_INDICES,
      }),
    );

    expect(report.status).toBe("ok");
    expect(report.checks.map((c) => c.id)).toEqual([
      "backend", "reranker", "project:api", "tables", "config", "disk",
    ]);
    for (const c of report.checks) expect(c.status).toBe("ok");
    expect(byId(report.checks, "project:api")?.detail).toContain("schema current");
  });

  test("a legacy-schema project and an orphan table surface their hints", async () => {
    const report = await runDoctor(
      ports({
        indexes: () => [
          {
            name: "legacy",
            path: "/home/dev/legacy",
            tableName: "idx_legacy",
            status: "ready",
            fileCount: 3,
            chunkCount: 30,
            embedModel: "qwen3-embedding",
            embedDim: null,
            lastIndexedAt: 1,
            createdAt: 1,
            error: null,
          },
        ],
        tableNames: async () => ["idx_legacy", "idx_ghost"],
        tableColumns: async (t) => (t === "idx_legacy" ? LEGACY_COLUMNS : []),
        rowCount: async (t) => (t === "idx_legacy" ? 30 : 0),
        tableIndices: async (t) => (t === "idx_legacy" ? FRESH_INDICES.slice(0, 2) : []),
      }),
    );

    expect(report.status).toBe("warn");
    const project = byId(report.checks, "project:legacy");
    expect(project?.status).toBe("warn");
    expect(project?.hint).toContain("cidx reindex legacy");
    expect(byId(report.checks, "tables")?.status).toBe("warn");
    expect(byId(report.checks, "tables")?.detail).toContain("idx_ghost");
  });

  test("an unreachable Ollama fails the run and skips the per-project model verdict", async () => {
    const report = await runDoctor(
      ports({
        backend: async () => ({ provider: null, url: "", up: false, models: [] }),
        indexes: () => [
          {
            name: "api",
            path: "/home/dev/api",
            tableName: "idx_api",
            status: "ready",
            fileCount: 1,
            chunkCount: 1,
            embedModel: "qwen3-embedding",
            embedDim: null,
            lastIndexedAt: 1,
            createdAt: 1,
            error: null,
          },
        ],
        tableNames: async () => ["idx_api"],
        tableColumns: async () => FRESH_COLUMNS,
        rowCount: async () => 1,
        tableIndices: async () => FRESH_INDICES,
      }),
    );

    expect(report.status).toBe("fail");
    expect(byId(report.checks, "backend")?.status).toBe("fail");
    // modelOnBackend is unknown, not false — the project check stays ok.
    expect(byId(report.checks, "project:api")?.status).toBe("ok");
  });

  test("a project config file is validated per registered project", async () => {
    const report = await runDoctor(
      ports({
        configPath: () => "/h/.cidx/config.yml",
        indexes: () => [
          {
            name: "api",
            path: "/home/dev/api",
            tableName: "idx_api",
            status: "ready",
            fileCount: 1,
            chunkCount: 1,
            embedModel: "qwen3-embedding",
            embedDim: null,
            lastIndexedAt: 1,
            createdAt: 1,
            error: null,
          },
        ],
        tableNames: async () => ["idx_api"],
        tableColumns: async () => FRESH_COLUMNS,
        rowCount: async () => 1,
        tableIndices: async () => FRESH_INDICES,
        readText: async (p) => (p === "/home/dev/api/.cidx.json" ? "{ broken" : null),
      }),
    );

    const cfg = byId(report.checks, "config");
    expect(cfg?.status).toBe("warn");
    expect(cfg?.detail).toContain(".cidx.json");
    expect(cfg?.hint).toContain(".cidx.json");
  });

  test("a table read failure degrades to a missing table instead of throwing", async () => {
    const report = await runDoctor(
      ports({
        indexes: () => [
          {
            name: "api",
            path: "/home/dev/api",
            tableName: "idx_api",
            status: "ready",
            fileCount: 1,
            chunkCount: 1,
            embedModel: null,
            embedDim: null,
            lastIndexedAt: 1,
            createdAt: 1,
            error: null,
          },
        ],
        tableColumns: async () => {
          throw new Error("boom");
        },
      }),
    );

    const project = byId(report.checks, "project:api");
    expect(project?.status).toBe("fail");
    expect(project?.detail).toContain("missing");
    expect(report.status).toBe("fail");
  });
});
