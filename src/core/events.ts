/**
 * Daemon event stream (proposal A2 — MCP resources + index notifications).
 *
 * The daemon keeps an in-memory, append-only ring of notable state changes:
 * a job finished (`index`/`migrate`), a project was added, a project was
 * removed. `IndexManager` emits these through its subscribable hook; the
 * daemon appends them to the ring, the Control API serves `GET /events?since=`
 * over it, and the stdio bridge polls that endpoint and turns each event into
 * MCP notifications:
 *   - job-completed   → `notifications/message` (an "index finished" log line)
 *   - index-added/removed → `notifications/resources/list_changed`
 *
 * In-memory only: ids come from a process-local counter, so a daemon restart
 * resets the sequence to 1. A poller detects that (response `lastId` lower than
 * its cursor — encoded by `nextEventCursor`) and re-syncs from 0, so a restart
 * never looks like "no news" to a connected agent.
 */

export type DaemonEventType = "job-completed" | "index-added" | "index-removed";

/** The event as producers hand it in — id and ts are assigned by the ring. */
export interface DaemonEventInput {
  type: DaemonEventType;
  /** Project the event is about (the index name). */
  project?: string;
  /** job-completed only: which job finished (e.g. "index" or "migrate"). */
  jobType?: string;
  /** job-completed only: the final job status (completed | failed | cancelled). */
  status?: string;
}

export interface DaemonEvent extends DaemonEventInput {
  id: number;
  /** Wall-clock ms of the moment the event was appended. */
  ts: number;
}

/** The `GET /events?since=<id>` response (the bridge's poll payload). */
export interface DaemonEventPage {
  /** Retained events with `id > since`, oldest first. */
  events: DaemonEvent[];
  /** The highest id the ring has ever assigned (0 before the first event). */
  lastId: number;
}

/**
 * Ring capacity: bounded replay for a (re)connecting poller, oldest evicted
 * first. Deliberately small — this is a notification stream, not a history:
 * a slow consumer skips evicted events (it re-reads `get_index_status` to catch
 * up on state, exactly like the resource it is being notified about).
 */
export const EVENT_RING_CAPACITY = 512;

/**
 * In-memory append-only ring with monotonic ids (A2). `ts` defaults to the
 * wall clock but is always an argument, so the paging/eviction semantics are
 * testable without waiting.
 */
export class DaemonEventRing {
  private buffer: DaemonEvent[] = [];
  private nextId = 1;

  constructor(private readonly capacity: number = EVENT_RING_CAPACITY) {}

  /** Appends one event, assigning the next monotonic id. */
  append(input: DaemonEventInput, ts: number = Date.now()): DaemonEvent {
    const event: DaemonEvent = {
      id: this.nextId,
      type: input.type,
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.jobType !== undefined ? { jobType: input.jobType } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ts,
    };
    this.nextId++;
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    return event;
  }

  /** The highest id assigned so far (0 when nothing was ever appended). */
  get lastId(): number {
    return this.nextId - 1;
  }

  /** All retained events with `id > since`, oldest first, plus `lastId`. */
  since(since: number): DaemonEventPage {
    return {
      events: this.buffer.filter((e) => e.id > since),
      lastId: this.lastId,
    };
  }
}

/**
 * The poller's cursor rule (pure): advance to the page's `lastId`, but reset to
 * 0 when the daemon's counter went BACKWARDS — within one process ids only
 * grow, so that can only mean the daemon restarted (fresh counter). Resetting
 * re-delivers the new daemon's retained events on the next poll; within a live
 * daemon the rule is a no-op (equal lastId → stay, higher → advance), so it can
 * never replay the current daemon's already-seen events.
 */
export function nextEventCursor(currentSince: number, page: DaemonEventPage): number {
  if (page.lastId < currentSince) return 0;
  return page.lastId;
}

// ------------------------------------------------------- bridge notification

/**
 * The wire shape the bridge emits on its stdout JSON-RPC channel. Produced by
 * `eventNotifications` (pure) and dispatched by the bridge through the MCP SDK
 * (sendLoggingMessage / sendResourceListChanged) — the ONLY things the poll
 * loop ever writes to stdout are these JSON-RPC notifications.
 */
export type IndexEventNotification =
  | { kind: "log"; level: "info"; logger: string; data: string }
  | { kind: "resources-list-changed" };

/**
 * Pure events → MCP notifications framing (A2):
 * - job-completed → ONE `notifications/message` (info level, logger "cidx",
 *   e.g. `index finished for my-project (completed)`); a running migration
 *   reports as `migrate finished for …`. Failure/success is reported in the
 *   text (the addendum pins the level to info).
 * - index-added / index-removed → ONE `notifications/resources/list_changed`
 *   so connected agents refresh their resources/list.
 * An unknown event type maps to nothing: a newer daemon must never crash an
 * older bridge (forward compatibility).
 */
export function eventNotifications(ev: DaemonEvent): IndexEventNotification[] {
  if (ev.type === "job-completed") {
    const job = ev.jobType ?? "index";
    const project = ev.project ?? "(unknown project)";
    const status = ev.status ?? "completed";
    return [
      {
        kind: "log",
        level: "info",
        logger: "cidx",
        data: `${job} finished for ${project} (${status})`,
      },
    ];
  }
  if (ev.type === "index-added" || ev.type === "index-removed") {
    return [{ kind: "resources-list-changed" }];
  }
  return [];
}

// ------------------------------------------------------------- bridge wire

/** How often the bridge polls `GET /events` while its client is connected. */
export const BRIDGE_EVENT_POLL_MS = 3_000;

/** Wire shape of the events poll the bridge sends to the Control API. */
export interface EventsPollRequest {
  method: "GET";
  path: string;
}

/** GET /events?since=<id> — the poll the bridge sends, at its current cursor. */
export function eventsPollRequest(since: number): EventsPollRequest {
  return { method: "GET", path: `/events?since=${since}` };
}