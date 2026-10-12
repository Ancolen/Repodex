/**
 * Extensible job system types.
 * To add a new job type: define a payload type and register a handler with
 * JobQueue.registerHandler(type, handler).
 */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobProgress {
  processed: number;
  total: number;
  message?: string;
}

export interface Job<TPayload = unknown, TResult = unknown> {
  id: string;
  type: string;
  status: JobStatus;
  payload: TPayload;
  progress: JobProgress;
  result?: TResult;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** The execution context given to a handler: progress reporting + cancellation check. */
export interface JobContext<TPayload = unknown> {
  readonly job: Job<TPayload>;
  readonly payload: TPayload;
  readonly signal: AbortSignal;
  updateProgress(processed: number, total?: number, message?: string): void;
  isCancelled(): boolean;
}

export type JobHandler<TPayload = unknown, TResult = unknown> = (
  ctx: JobContext<TPayload>,
) => Promise<TResult>;

// ------------------------------------------------------- registered job types
// Payload types + type constants for the registered job handlers; the handlers
// live with their managers (IndexManager registers `index` and `migrate` at
// daemon boot via JobQueue.registerHandler).

/** The async indexing job: (re)index the project's table from the working tree. */
export const INDEX_JOB_TYPE = "index";

/** The zero-downtime model migration job (proposal O2): rebuild every vector of the
 * project's current table in a shadow table with `targetModel` and swap the
 * registry to it in one transaction once the shadow is complete. Search keeps
 * serving the old table until the swap. */
export const MIGRATE_JOB_TYPE = "migrate";

export interface MigrateJobPayload {
  project: string;
  targetModel: string;
  /**
   * The framing identity to embed the shadow table with (per-model framing
   * layer, `src/core/framing.ts`): the resolved preset id
   * ("embeddinggemma-2" | "qwen3-embedding") or null for none. `startMigration`
   * resolves it from the effective framing setting under `targetModel`, so the
   * commit pins exactly what the shadow embedded — a framing change rides the
   * same zero-downtime machinery as a model change. Payloads enqueued before
   * framing existed carry no field and read as null (the only framing those
   * records could have pinned).
   */
  framing?: string | null;
}
