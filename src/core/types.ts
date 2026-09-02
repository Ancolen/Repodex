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
