/**
 * MCP resource definitions (proposal A2 — the `cidx://` resources).
 *
 * Both the in-process MCP server (`server/mcp.ts`) and the stdio bridge
 * (`stdio-bridge.ts`) use this single source — the same pattern as
 * TOOL_DEFINITIONS — so the URIs, the templates and the payloads never diverge:
 *
 *   cidx://indexes                     → the index list (GET /indexes payload)
 *   cidx://indexes/{name}/overview     → the get_repo_overview payload
 *   cidx://indexes/{name}/status       → job status/progress (GET /indexes/{name})
 *
 * Payloads reuse the existing serializers exactly (the same JSON the Control
 * API returns) — there is no new formatting surface. Resources are read-only
 * and read-on-demand: the stateless HTTP MCP server cannot push notifications,
 * so HTTP clients re-list/re-read cheaply on demand (the stdio bridge is the
 * stateful side that receives `notifications/resources/list_changed`).
 *
 * This module must stay free of runtime `core/` imports beyond registry TYPES:
 * the stdio bridge imports it at startup and must not gain LanceDB/daemon
 * dependencies — every payload comes from the injected `ResourceReadTargets`.
 */
import type { IndexRecord } from "../core/registry";

/** Every resource is a JSON document (existing serializers, pretty-printed). */
export const RESOURCE_MIME_TYPE = "application/json";

/** URI scheme — mirrors the Control API paths one to one. */
export const INDEXES_RESOURCE_URI = "cidx://indexes";
export const INDEX_OVERVIEW_TEMPLATE = "cidx://indexes/{name}/overview";
export const INDEX_STATUS_TEMPLATE = "cidx://indexes/{name}/status";

const INDEXES_URI_PREFIX = "cidx://indexes/";

// ------------------------------------------------------------------ payloads

/** Live job progress as the Control API serializes it (`GET /indexes`). */
export interface ActiveJobView {
  id: string;
  status: string;
  processed: number;
  total: number;
  /** Rounded percentage (0 when total is 0). */
  percent: number;
}

/**
 * The Control-API index view (`viewIndex` in control-api's response for
 * /indexes, /indexes/{name}, /index, /reindex and /sync) — the single source
 * for that JSON shape, shared by the daemon, the MCP server and the bridge.
 */
export interface IndexView {
  name: string;
  path: string;
  table: string;
  status: string;
  files: number;
  chunks: number;
  lastIndexedAt: number | null;
  error: string | null;
  /** Diagnostic note from the last index job (zero-file explanation); null when none. */
  note: string | null;
  job: ActiveJobView | null;
}

/** The slice of IndexManager the view/reader needs (kept structural — the
 * stdio bridge instantiates none of it, it forwards over HTTP). */
export interface ResourceViewJobs {
  activeJob(name: string): { id: string; status: string; progress: { processed: number; total: number } } | null;
}

/**
 * Serializes an index record + live job progress into the EXACT JSON the
 * Control API returns (`GET /indexes`). One source of truth for the daemon,
 * the MCP resources and the stdio bridge's forwarded payloads.
 */
export function viewIndex(jobs: ResourceViewJobs, rec: IndexRecord): IndexView {
  const job = jobs.activeJob(rec.name);
  return {
    name: rec.name,
    path: rec.path,
    table: rec.tableName,
    status: rec.status,
    files: rec.fileCount,
    chunks: rec.chunkCount,
    lastIndexedAt: rec.lastIndexedAt,
    error: rec.error,
    note: rec.note ?? null,
    job: job
      ? {
          id: job.id,
          status: job.status,
          processed: job.progress.processed,
          total: job.progress.total,
          percent:
            job.progress.total > 0
              ? Math.round((job.progress.processed / job.progress.total) * 100)
              : 0,
        }
      : null,
  };
}

// ------------------------------------------------------------------ listing

export interface CidxResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: typeof RESOURCE_MIME_TYPE;
}

export interface CidxResourceTemplateDescriptor {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: typeof RESOURCE_MIME_TYPE;
}

/** The stateless-HTTP caveat every description carries (no push over HTTP). */
const HTTP_ON_DEMAND_NOTE =
  "Read-only, read-on-demand: the stateless HTTP MCP server pushes no notifications, " +
  "so re-list/re-read cheaply after an indexing job (stdio clients get notifications instead).";

/** The `cidx://indexes/{name}/status` + `/overview` URIs for one project. */
export function indexResourceUris(name: string): { status: string; overview: string } {
  const n = encodeURIComponent(name);
  return {
    status: `${INDEXES_URI_PREFIX}${n}/status`,
    overview: `${INDEXES_URI_PREFIX}${n}/overview`,
  };
}

const indexesResourceDescription =
  "All indexed projects with live job progress (the list_indexes payload): " +
  "name, path, status, file/chunk counts — and one error line when a job failed. " +
  HTTP_ON_DEMAND_NOTE;

function statusDescription(name: string): string {
  return (
    "Live status of project '" + name + "': indexing state, progress %, file/chunk counts " +
    "and the table backing it (the get_index_status(" + name + ") JSON). " +
    HTTP_ON_DEMAND_NOTE
  );
}

function overviewDescription(name: string): string {
  return (
    "Structural snapshot of project '" + name + "' (the get_repo_overview payload): " +
    "language/symbol-type distribution, top directories, entry points. " +
    HTTP_ON_DEMAND_NOTE
  );
}

/**
 * The `resources/list` + `resources/templates/list` payload for a given index
 * view snapshot: the static index list, one concrete status + overview resource
 * per project (so agents discover them without building URIs), and the two URI
 * templates. Pure — both transports feed it from their own source (the daemon
 * serializes `listIndexes` in-process; the bridge forwards `GET /indexes`).
 */
export function buildResourceCatalog(indexes: IndexView[]): {
  resources: CidxResourceDescriptor[];
  resourceTemplates: CidxResourceTemplateDescriptor[];
} {
  const resources: CidxResourceDescriptor[] = [
    { uri: INDEXES_RESOURCE_URI, name: "Indexes", description: indexesResourceDescription, mimeType: RESOURCE_MIME_TYPE },
  ];
  for (const ix of indexes) {
    const uris = indexResourceUris(ix.name);
    resources.push(
      { uri: uris.status, name: `${ix.name} status`, description: statusDescription(ix.name), mimeType: RESOURCE_MIME_TYPE },
      { uri: uris.overview, name: `${ix.name} overview`, description: overviewDescription(ix.name), mimeType: RESOURCE_MIME_TYPE },
    );
  }
  return {
    resources,
    resourceTemplates: [
      {
        uriTemplate: INDEX_STATUS_TEMPLATE,
        name: "Index status",
        description:
          "Live status/progress of one indexed project by name (the GET /indexes/{name} JSON). " +
          HTTP_ON_DEMAND_NOTE,
        mimeType: RESOURCE_MIME_TYPE,
      },
      {
        uriTemplate: INDEX_OVERVIEW_TEMPLATE,
        name: "Repo overview",
        description:
          "Structural snapshot of one indexed project by name (the get_repo_overview JSON). " +
          HTTP_ON_DEMAND_NOTE,
        mimeType: RESOURCE_MIME_TYPE,
      },
    ],
  };
}

// ------------------------------------------------------------------- read

/** A parsed resource URI: which kind to read, with the (decoded) project name. */
export type ParsedIndexResourceUri =
  | { kind: "indexes" }
  | { kind: "status"; name: string }
  | { kind: "overview"; name: string };

/**
 * Parses a `cidx://…` resource URI against the definitions above. Returns null
 * for anything else (unknown scheme / unknown action / malformed path) — the
 * caller turns that into a self-healing "Unknown resource" error.
 */
export function parseIndexResourceUri(uri: string): ParsedIndexResourceUri | null {
  if (uri === INDEXES_RESOURCE_URI) return { kind: "indexes" };
  if (!uri.startsWith(INDEXES_URI_PREFIX)) return null;
  const rest = uri.slice(INDEXES_URI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  let name: string;
  try {
    name = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return null; // malformed percent-encoding
  }
  const action = rest.slice(slash + 1);
  if (action === "status") return { kind: "status", name };
  if (action === "overview") return { kind: "overview", name };
  return null;
}

/**
 * The read adapters a transport must supply for `readCidxResource`. The
 * in-process MCP server implements them over IndexManager; the stdio bridge
 * forwards each one to the Control API. An unknown project name must REJECT
 * with a self-healing message each transport already has (the daemon builds
 * indexNotFoundMessage; the bridge gets the Control API's 404 text back).
 */
export interface ResourceReadTargets {
  /** The index list payload (the whole `GET /indexes` response). */
  indexes(): Promise<IndexView[]>;
  /** The single-index payload; rejects when the project is unknown. */
  index(name: string): Promise<IndexView>;
  /** The repoOverview payload; rejects when the project is unknown. */
  overview(name: string): Promise<unknown>;
}

/** One read resource's contents (a TextResourceContents). */
export interface ResourceReadContent {
  uri: string;
  mimeType: typeof RESOURCE_MIME_TYPE;
  text: string;
}

/**
 * Reads one resource URI to the EXISTING Control-API payload — no new
 * formatting surface. Returns null when the URI matches no definition.
 */
export async function readCidxResource(
  targets: ResourceReadTargets,
  uri: string,
): Promise<ResourceReadContent | null> {
  const parsed = parseIndexResourceUri(uri);
  if (!parsed) return null;
  const payload =
    parsed.kind === "indexes"
      ? await targets.indexes()
      : parsed.kind === "status"
        ? await targets.index(parsed.name)
        : await targets.overview(parsed.name);
  return { uri, mimeType: RESOURCE_MIME_TYPE, text: `${JSON.stringify(payload, null, 2)}\n` };
}

// ------------------------------------------------------------ bridge targets

/** The Control-API fetch helper the stdio bridge already uses (`api(method, path, body?)`). */
export type ControlApiCall = (method: string, pathname: string, body?: unknown) => Promise<unknown>;

/**
 * The stdio bridge's forwarding adapters (A2): `resources/list` and
 * `resources/read` ride the Control API endpoints that already exist —
 * `/indexes` and `/overview` — feeding the SAME `buildResourceCatalog` /
 * `readCidxResource` the in-process daemon uses, so the payloads cannot
 * diverge. An unknown project name comes back as the Control API's self-healing
 * 404 message and propagates as the read's rejection.
 */
export function controlApiResourceTargets(call: ControlApiCall): ResourceReadTargets {
  return {
    indexes: () => call("GET", "/indexes") as Promise<IndexView[]>,
    index: (name) => call("GET", `/indexes/${encodeURIComponent(name)}`) as Promise<IndexView>,
    overview: (name) => call("POST", "/overview", { project: name }),
  };
}