/**
 * MCP resources (proposal A2) — src/server/resource-defs.ts: the shared index
 * serializer, the URI templates + catalog, URI parsing, resource reads and the
 * stdio bridge's forwarding targets. Plus one integration test that drives the
 * REAL in-process MCP server (src/server/mcp.ts → buildServer) over the SDK's
 * in-memory transport: capability announcement, resources/list,
 * resources/templates/list and resources/read end to end.
 */
import { describe, test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IndexRecord } from "../src/core/registry";
import type { IndexManager } from "../src/core/index-manager";
import {
  INDEXES_RESOURCE_URI,
  INDEX_OVERVIEW_TEMPLATE,
  INDEX_STATUS_TEMPLATE,
  RESOURCE_MIME_TYPE,
  buildResourceCatalog,
  controlApiResourceTargets,
  indexResourceUris,
  parseIndexResourceUri,
  readCidxResource,
  viewIndex,
  type IndexView,
  type ResourceReadTargets,
} from "../src/server/resource-defs";
import { overviewPickOneNote, isOverviewPickOne } from "../src/server/format";
import { buildServer } from "../src/server/mcp";

// ------------------------------------------------------------------ fixtures

const rec = (over: Partial<IndexRecord> = {}): IndexRecord => ({
  name: "demo",
  path: "/workspaces/demo",
  tableName: "idx_demo",
  status: "ready",
  fileCount: 3,
  chunkCount: 7,
  embedModel: "qwen3-embedding",
  embedDim: null,
  lastIndexedAt: 1000,
  createdAt: 0,
  error: null,
  ...over,
});

const jobsNoop = { activeJob: (_name: string) => null };

// ----------------------------------------------------------------- viewIndex

describe("viewIndex — the shared Control-API serializer", () => {
  test("serializes a record without a live job", () => {
    expect(viewIndex(jobsNoop, rec())).toEqual({
      name: "demo",
      path: "/workspaces/demo",
      table: "idx_demo",
      status: "ready",
      files: 3,
      chunks: 7,
      lastIndexedAt: 1000,
      error: null,
      note: null,
      job: null,
    });
  });

  test("serializes a record with live job progress (rounded percent)", () => {
    const view = viewIndex(
      { activeJob: () => ({ id: "j1", status: "running", progress: { processed: 5, total: 10 } }) },
      rec({ status: "indexing" }),
    );
    expect(view.job).toEqual({ id: "j1", status: "running", processed: 5, total: 10, percent: 50 });
  });

  test("percent is 0 while total is still 0", () => {
    const view = viewIndex(
      { activeJob: () => ({ id: "j1", status: "running", progress: { processed: 0, total: 0 } }) },
      rec({ status: "indexing" }),
    );
    expect(view.job?.percent).toBe(0);
  });

  test("carries the record's error line", () => {
    const view = viewIndex(jobsNoop, rec({ status: "error", error: "boom" }));
    expect(view.error).toBe("boom");
  });
});

// ------------------------------------------------------- catalog + templates

describe("buildResourceCatalog", () => {
  const view = (name: string): IndexView => ({ ...viewIndex(jobsNoop, rec({ name })), name });

  test("an empty daemon still lists the index list + the two templates", () => {
    const { resources, resourceTemplates } = buildResourceCatalog([]);
    expect(resources.map((r) => r.uri)).toEqual([INDEXES_RESOURCE_URI]);
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      INDEX_STATUS_TEMPLATE,
      INDEX_OVERVIEW_TEMPLATE,
    ]);
  });

  test("concrete status + overview resources per index, plus templates", () => {
    const { resources, resourceTemplates } = buildResourceCatalog([view("a"), view("b")]);
    expect(resources.map((r) => r.uri)).toEqual([
      INDEXES_RESOURCE_URI,
      "cidx://indexes/a/status",
      "cidx://indexes/a/overview",
      "cidx://indexes/b/status",
      "cidx://indexes/b/overview",
    ]);
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      INDEX_STATUS_TEMPLATE,
      INDEX_OVERVIEW_TEMPLATE,
    ]);
    for (const r of resources) {
      expect(r.mimeType).toBe(RESOURCE_MIME_TYPE);
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  test("the descriptions note that stateless HTTP clients re-list on demand", () => {
    const { resources, resourceTemplates } = buildResourceCatalog([view("a")]);
    for (const entry of [...resources.map((r) => r.description), ...resourceTemplates.map((t) => t.description)]) {
      expect(entry).toContain("read-on-demand");
    }
  });

  test("template URIs are the canonical {name} placeholders", () => {
    expect(INDEX_STATUS_TEMPLATE).toBe("cidx://indexes/{name}/status");
    expect(INDEX_OVERVIEW_TEMPLATE).toBe("cidx://indexes/{name}/overview");
  });
});

// ------------------------------------------------------------- URI round trip

describe("indexResourceUris / parseIndexResourceUri — URI round trip", () => {
  test("simple names round trip", () => {
    const uris = indexResourceUris("demo");
    expect(parseIndexResourceUri(uris.status)).toEqual({ kind: "status", name: "demo" });
    expect(parseIndexResourceUri(uris.overview)).toEqual({ kind: "overview", name: "demo" });
  });

  test("names with spaces, unicode and slashes survive encoding", () => {
    for (const name of ["my repo", "проект", "a/b", "c++", "100%"]) {
      const uris = indexResourceUris(name);
      expect(parseIndexResourceUri(uris.status)).toEqual({ kind: "status", name });
      expect(parseIndexResourceUri(uris.overview)).toEqual({ kind: "overview", name });
    }
  });

  test("the static index-list URI parses", () => {
    expect(parseIndexResourceUri(INDEXES_RESOURCE_URI)).toEqual({ kind: "indexes" });
  });

  test("foreign URIs and malformed paths return null", () => {
    expect(parseIndexResourceUri("file:///etc/passwd")).toBeNull();
    expect(parseIndexResourceUri("cidx://")).toBeNull();
    expect(parseIndexResourceUri("cidx://indexes")).not.toBeNull(); // the static list itself
    expect(parseIndexResourceUri("cidx://indexes/demo")).toBeNull(); // no action segment
    expect(parseIndexResourceUri("cidx://indexes/demo/readme")).toBeNull(); // unknown action
    expect(parseIndexResourceUri("cidx://other/demo/status")).toBeNull(); // foreign path root
    expect(parseIndexResourceUri("cidx://indexes/demo%/status")).toBeNull(); // bad encoding
  });
});

// ---------------------------------------------------------------------- read

describe("readCidxResource — one serializer per payload", () => {
  const indexView: IndexView = viewIndex(jobsNoop, rec());
  const overview = { name: "demo", path: "/workspaces/demo", files: 3, chunks: 7, symbols: 9 };
  const targets = {
    indexes: async () => [indexView],
    index: async (name: string) => {
      if (name !== "demo") throw new Error(`Index not found: ${name}`);
      return indexView;
    },
    overview: async (_name: string) => overview,
  } satisfies ResourceReadTargets;

  test("cidx://indexes → the index-list payload, pretty JSON", async () => {
    const content = await readCidxResource(targets, INDEXES_RESOURCE_URI);
    expect(content).not.toBeNull();
    expect(content!.uri).toBe(INDEXES_RESOURCE_URI);
    expect(content!.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(JSON.parse(content!.text)).toEqual([indexView]);
  });

  test("a status URI → the single-index payload", async () => {
    const content = await readCidxResource(targets, "cidx://indexes/demo/status");
    expect(JSON.parse(content!.text)).toEqual(indexView);
  });

  test("an overview URI → the repoOverview payload", async () => {
    const content = await readCidxResource(targets, "cidx://indexes/demo/overview");
    expect(JSON.parse(content!.text)).toEqual(overview);
  });

  test("the read routes to exactly one target per URI kind", async () => {
    let indexesCalls = 0;
    let indexCalls = 0;
    let overviewCalls = 0;
    const counting: ResourceReadTargets = {
      indexes: async () => {
        indexesCalls++;
        return [];
      },
      index: async () => {
        indexCalls++;
        return indexView;
      },
      overview: async () => {
        overviewCalls++;
        return overview;
      },
    };
    await readCidxResource(counting, INDEXES_RESOURCE_URI);
    await readCidxResource(counting, indexResourceUris("demo").status);
    await readCidxResource(counting, indexResourceUris("demo").overview);
    expect([indexesCalls, indexCalls, overviewCalls]).toEqual([1, 1, 1]);
  });

  test("an unknown URI returns null (the caller shapes the error)", async () => {
    expect(await readCidxResource(targets, "cidx://nope")).toBeNull();
    expect(await readCidxResource(targets, "cidx://indexes/demo/readme")).toBeNull();
  });

  test("an unknown project name propagates the self-healing rejection", async () => {
    await expect(readCidxResource(targets, "cidx://indexes/nope/status")).rejects.toThrow(
      "Index not found: nope",
    );
  });
});

// --------------------------------------------------- bridge forwarding targets

describe("controlApiResourceTargets — the bridge forwards over the Control API", () => {
  test("each resource kind maps onto the existing GET/POST endpoints", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const call = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === "/indexes") return [];
      return { ok: true };
    };
    const targets = controlApiResourceTargets(call);
    await targets.indexes();
    await targets.index("my repo");
    await targets.overview("other");
    expect(calls).toEqual([
      { method: "GET", path: "/indexes" },
      { method: "GET", path: "/indexes/my%20repo" },
      { method: "POST", path: "/overview", body: { project: "other" } },
    ]);
  });

  test("encoded names keep slashes out of the path segments", async () => {
    const calls: string[] = [];
    const call = async (_method: string, path: string) => {
      calls.push(path);
      return { ok: true };
    };
    await controlApiResourceTargets(call).index("a/b");
    expect(calls).toEqual(["/indexes/a%2Fb"]);
  });
});

// -------------------------------------------- in-process MCP server (integration)

describe("buildServer — resources over the MCP SDK (in-memory transport)", () => {
  const stub: IndexManager = {
    listIndexes: () => [rec({ name: "demo" }), rec({ name: "other" })],
    getIndex: (name: string) => (name === "demo" ? rec({ name: "demo" }) : null),
    activeJob: (name: string) =>
      name === "demo" ? { id: "j1", status: "running", progress: { processed: 5, total: 10 } } : null,
    repoOverview: async (name: string) => ({
      name,
      path: "/workspaces/demo",
      status: "ready",
      files: 3,
      chunks: 7,
      symbols: 9,
      lastIndexedAt: 1000,
      embedModel: "qwen3-embedding",
      languageDistribution: [],
      symbolTypeBreakdown: [],
      topLevelDirs: [],
      entryPoints: [],
      topSymbols: [],
    }),
  } as unknown as IndexManager;

  const deps = { jobQueue: {} as never, manager: stub };

  async function withServer(
    fn: (client: Client) => Promise<void>,
  ): Promise<void> {
    const server = buildServer(deps);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Same deliberate cast the real transports need (exactOptionalPropertyTypes).
    await Promise.all([
      server.connect(serverTransport as unknown as Parameters<typeof server.connect>[0]),
      client.connect(clientTransport),
    ]);
    try {
      await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  test("announces the resources capability with listChanged", async () => {
    await withServer(async (client) => {
      const caps = client.getServerCapabilities();
      expect(caps?.resources).toEqual({ listChanged: true });
    });
  });

  test("resources/list discovers the index list + concrete per-project resources", async () => {
    await withServer(async (client) => {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri);
      expect(uris).toContain(INDEXES_RESOURCE_URI);
      expect(uris).toContain("cidx://indexes/demo/status");
      expect(uris).toContain("cidx://indexes/demo/overview");
      expect(uris).toContain("cidx://indexes/other/status");
      expect(uris).toContain("cidx://indexes/other/overview");
      for (const r of resources) expect(r.mimeType).toBe(RESOURCE_MIME_TYPE);
    });
  });

  test("resources/templates/list offers the two {name} templates", async () => {
    await withServer(async (client) => {
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
        INDEX_STATUS_TEMPLATE,
        INDEX_OVERVIEW_TEMPLATE,
      ]);
    });
  });

  test("resources/read cidx://indexes → the Control-API index-list JSON", async () => {
    await withServer(async (client) => {
      const result = await client.readResource({ uri: INDEXES_RESOURCE_URI });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]!.mimeType).toBe(RESOURCE_MIME_TYPE);
      const payload = JSON.parse(result.contents[0]!.text) as Array<Record<string, unknown>>;
      expect(payload).toHaveLength(2);
      expect(payload[0]).toMatchObject({ name: "demo", table: "idx_demo", files: 3, chunks: 7 });
      expect(payload[0]!.job).toEqual({ id: "j1", status: "running", processed: 5, total: 10, percent: 50 });
    });
  });

  test("resources/read on a project URI → that project's payload", async () => {
    await withServer(async (client) => {
      const status = await client.readResource({ uri: "cidx://indexes/demo/status" });
      expect(JSON.parse(status.contents[0]!.text)).toMatchObject({ name: "demo", status: "ready" });
      const overview = await client.readResource({ uri: "cidx://indexes/demo/overview" });
      expect(JSON.parse(overview.contents[0]!.text)).toMatchObject({ name: "demo", symbols: 9 });
    });
  });

  test("an unknown URI is a JSON-RPC error (self-healing wording)", async () => {
    await withServer(async (client) => {
      expect(client.readResource({ uri: "cidx://indexes/demo/readme" })).rejects.toThrow(
        "Unknown resource",
      );
    });
  });

  test("an unknown project name surfaces the 'Index not found' message", async () => {
    await withServer(async (client) => {
      expect(client.readResource({ uri: "cidx://indexes/missing/status" })).rejects.toThrow(
        "Index not found: missing",
      );
    });
  });
});
// ------------------------------------------------------- overview pick-one

describe("overviewPickOne — the graceful multi-project /overview response", () => {
  test("lists every project with the anchor hint", () => {
    const note = overviewPickOneNote([
      { name: "server", path: "/home/duldul/robot/server", status: "ready", files: 92, chunks: 955 },
      { name: "oyun", path: "/home/duldul/oyun", status: "ready", files: 1312, chunks: 5344 },
    ]);
    expect(note).toContain("Multiple projects are indexed");
    expect(note).toContain("'project' (or 'path')");
    expect(note).toContain("• server [ready] — /home/duldul/robot/server (92 files, 955 chunks)");
    expect(note).toContain("• oyun [ready] — /home/duldul/oyun (1312 files, 5344 chunks)");
  });

  test("isOverviewPickOne accepts only the pickOne payload", () => {
    expect(isOverviewPickOne({ pickOne: true, note: "x" })).toBe(true);
    expect(isOverviewPickOne({ name: "demo" })).toBe(false);
    expect(isOverviewPickOne(null)).toBe(false);
  });
});
