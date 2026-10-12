/**
 * Daemon event stream (proposal A2) — pure logic from src/core/events.ts:
 * the in-memory ring (monotonic ids, since-paging, capacity eviction), the
 * poller's cursor rule (advance / restart re-sync from 0), the pure
 * events→MCP-notification framing, and the bridge's poll wire shape.
 */
import { describe, test, expect } from "bun:test";
import {
  DaemonEventRing,
  EVENT_RING_CAPACITY,
  nextEventCursor,
  eventNotifications,
  eventsPollRequest,
  BRIDGE_EVENT_POLL_MS,
  type DaemonEvent,
  type IndexEventNotification,
} from "../src/core/events";

describe("DaemonEventRing — append and ids", () => {
  test("assigns monotonic ids and the given ts", () => {
    const ring = new DaemonEventRing();
    const a = ring.append({ type: "index-added", project: "a" }, 1000);
    const b = ring.append({ type: "index-removed", project: "a" }, 1500);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.ts).toBe(1000);
    expect(b.ts).toBe(1500);
    expect(ring.lastId).toBe(2);
  });

  test("lastId is 0 before the first event", () => {
    expect(new DaemonEventRing().lastId).toBe(0);
  });

  test("keeps the optional payload fields it was given", () => {
    const ring = new DaemonEventRing();
    const ev = ring.append(
      { type: "job-completed", project: "repo", jobType: "migrate", status: "failed" },
      42,
    );
    expect(ev.project).toBe("repo");
    expect(ev.jobType).toBe("migrate");
    expect(ev.status).toBe("failed");
  });

  test("omits the optional fields it was not given", () => {
    const ev = new DaemonEventRing().append({ type: "index-added", project: "repo" }, 1);
    expect("jobType" in ev).toBe(false);
    expect("status" in ev).toBe(false);
  });
});

describe("DaemonEventRing — since paging", () => {
  test("returns all events when since=0", () => {
    const ring = new DaemonEventRing();
    for (let i = 0; i < 5; i++) ring.append({ type: "index-added", project: `p${i}` }, i);
    const page = ring.since(0);
    expect(page.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(page.lastId).toBe(5);
  });

  test("returns only events after the cursor, oldest first", () => {
    const ring = new DaemonEventRing();
    for (let i = 0; i < 5; i++) ring.append({ type: "job-completed", project: "p" }, i);
    const page = ring.since(3);
    expect(page.events.map((e) => e.id)).toEqual([4, 5]);
    expect(page.lastId).toBe(5);
  });

  test("an empty page still carries lastId (the cursor can advance)", () => {
    const ring = new DaemonEventRing();
    ring.append({ type: "index-added", project: "p" }, 0);
    const page = ring.since(100);
    expect(page.events).toEqual([]);
    expect(page.lastId).toBe(1);
  });
});

describe("DaemonEventRing — capacity eviction", () => {
  test("evicts the oldest beyond the ring capacity, lastId keeps counting", () => {
    const ring = new DaemonEventRing(EVENT_RING_CAPACITY);
    for (let i = 1; i <= EVENT_RING_CAPACITY + 5; i++) {
      ring.append({ type: "job-completed", project: "p" }, i);
    }
    const page = ring.since(0);
    expect(page.events.length).toBe(EVENT_RING_CAPACITY);
    expect(page.events[0]!.id).toBe(6); // 1..5 evicted
    expect(page.events[EVENT_RING_CAPACITY - 1]!.id).toBe(EVENT_RING_CAPACITY + 5);
    expect(page.lastId).toBe(EVENT_RING_CAPACITY + 5);
  });

  test("since keeps working across the eviction boundary", () => {
    const ring = new DaemonEventRing(4);
    for (let i = 1; i <= 6; i++) ring.append({ type: "index-added", project: "p" }, i);
    expect(ring.since(5).events.map((e) => e.id)).toEqual([6]);
    expect(ring.since(2).events.map((e) => e.id)).toEqual([3, 4, 5, 6]); // retained tail
  });
});

describe("nextEventCursor — the restart re-sync rule", () => {
  const page = (lastId: number, events: DaemonEvent[] = []): { events: DaemonEvent[]; lastId: number } => ({
    events,
    lastId,
  });

  test("stays when the daemon has no news (lastId == since)", () => {
    expect(nextEventCursor(5, page(5))).toBe(5);
  });

  test("advances to the returned lastId", () => {
    expect(nextEventCursor(5, page(8))).toBe(8);
  });

  test("stays at 0 for an empty daemon", () => {
    expect(nextEventCursor(0, page(0))).toBe(0);
  });

  test("resets to 0 when the daemon's counter went backwards (restart)", () => {
    // A poller that had already seen id 1500 now reads lastId 3 — within one
    // process ids only grow, so only a restart explains this: re-sync from 0.
    expect(nextEventCursor(1500, page(3))).toBe(0);
  });

  test("a live daemon can never trigger the reset (lastId >= since)", () => {
    // Sequential live polls: the cursor only ever moves forward or stays.
    let cursor = 0;
    for (const lastId of [1, 4, 4, 9, 9, 12]) {
      cursor = nextEventCursor(cursor, page(lastId));
      expect(cursor).toBe(lastId);
    }
  });
});

describe("eventNotifications — pure framing", () => {
  test("job-completed → exactly one info log notification on the cidx logger", () => {
    const ev: DaemonEvent = {
      id: 1, ts: 0, type: "job-completed", project: "my-project", jobType: "index", status: "completed",
    };
    expect(eventNotifications(ev)).toEqual([
      { kind: "log", level: "info", logger: "cidx", data: "index finished for my-project (completed)" },
    ]);
  });

  test("a migration job names itself ('migrate finished for …')", () => {
    const ev: DaemonEvent = {
      id: 2, ts: 0, type: "job-completed", project: "repo", jobType: "migrate", status: "completed",
    };
    const [note] = eventNotifications(ev);
    expect(note).toEqual({
      kind: "log",
      level: "info",
      logger: "cidx",
      data: "migrate finished for repo (completed)",
    });
  });

  test("a failed job carries the status in the text", () => {
    const ev: DaemonEvent = { id: 3, ts: 0, type: "job-completed", project: "r", status: "failed" };
    const [note] = eventNotifications(ev);
    expect(note?.kind).toBe("log");
    if (note.kind === "log") expect(note.data).toBe("index finished for r (failed)");
  });

  test("falls back gracefully when optional fields are missing", () => {
    const ev: DaemonEvent = { id: 4, ts: 0, type: "job-completed" };
    const [note] = eventNotifications(ev);
    expect(note?.kind).toBe("log");
    if (note.kind === "log") {
      expect(note.data).toBe("index finished for (unknown project) (completed)");
    }
  });

  test("index-added and index-removed → exactly one resources/list_changed", () => {
    expect(eventNotifications({ id: 5, ts: 0, type: "index-added", project: "a" })).toEqual([
      { kind: "resources-list-changed" },
    ]);
    expect(eventNotifications({ id: 6, ts: 0, type: "index-removed", project: "a" })).toEqual([
      { kind: "resources-list-changed" },
    ]);
  });

  test("an unknown event type produces nothing (forward compatibility)", () => {
    const ev = { id: 7, ts: 0, type: "something-newer" } as unknown as DaemonEvent;
    expect(eventNotifications(ev)).toEqual([]);
  });

  test("stdout stays JSON-RPC-only: every emitted notification is an MCP one", () => {
    // The bridge writes ONLY what this framing produces (via the SDK's send*)
    // to stdout. Assert no framing output ever escapes the two allowed JSON-RPC
    // notification shapes, and that each is JSON-serializable.
    const events: DaemonEvent[] = [
      { id: 1, ts: 0, type: "job-completed", project: "p", jobType: "index", status: "completed" },
      { id: 2, ts: 0, type: "job-completed", project: "p", jobType: "migrate", status: "failed" },
      { id: 3, ts: 0, type: "index-added", project: "p" },
      { id: 4, ts: 0, type: "index-removed", project: "p" },
      { id: 5, ts: 0, type: "nope" } as unknown as DaemonEvent,
    ];
    const flat = events.flatMap((e) => eventNotifications(e));
    const allowed = new Set(["log", "resources-list-changed"]);
    for (const note of flat as IndexEventNotification[]) {
      expect(allowed.has(note.kind)).toBe(true);
      expect(JSON.parse(JSON.stringify(note))).toEqual(note); // JSON-RPC wire-safe
    }
    // One completed event → at most one notification (no dupes/spam per event).
    for (const e of events) expect(eventNotifications(e).length).toBeLessThanOrEqual(1);
  });
});

describe("eventsPollRequest — the bridge's poll wire shape", () => {
  test("GET /events with the current cursor", () => {
    expect(eventsPollRequest(0)).toEqual({ method: "GET", path: "/events?since=0" });
    expect(eventsPollRequest(42)).toEqual({ method: "GET", path: "/events?since=42" });
  });

  test("the poll interval is the addendum's 3 s", () => {
    expect(BRIDGE_EVENT_POLL_MS).toBe(3_000);
  });
});