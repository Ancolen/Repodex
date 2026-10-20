import { describe, expect, test } from "bun:test";
import { probeDaemon } from "../src/daemon-probe";

const HOST = "127.0.0.1";

function target(port: number) {
  return { base: `http://${HOST}:${port}`, host: HOST, port };
}

/** A port that was just bound and released — nothing listens on it afterwards. */
function freePort(): number {
  const server = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

describe("daemon-probe — up / busy / down", () => {
  test("up when /ping answers", async () => {
    const server = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    try {
      expect(await probeDaemon(target(server.port), { pingTimeoutMs: 500 })).toBe("up");
    } finally {
      server.stop(true);
    }
  });

  test("busy when the port accepts but /ping stalls", async () => {
    // Models a daemon blocked in a long synchronous pass: the socket accepts,
    // the request is never answered.
    const server = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      expect(await probeDaemon(target(server.port), { pingTimeoutMs: 200 })).toBe("busy");
    } finally {
      server.stop(true);
    }
  });

  test("down when nothing is listening", async () => {
    expect(await probeDaemon(target(freePort()), { pingTimeoutMs: 200 })).toBe("down");
  });

  test("a non-ok /ping is not 'up' (the port still proves the process exists)", async () => {
    const server = Bun.serve({
      hostname: HOST,
      port: 0,
      fetch: () => new Response("nope", { status: 500 }),
    });
    try {
      expect(await probeDaemon(target(server.port), { pingTimeoutMs: 500 })).toBe("busy");
    } finally {
      server.stop(true);
    }
  });
});
