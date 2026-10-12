import { CONFIG, CONFIG_SOURCE } from "./config";
import { initDB } from "./services/db";
import { Registry } from "./core/registry";
import { JobQueue } from "./core/job-queue";
import { IndexManager } from "./core/index-manager";
import { BridgeSessionRegistry } from "./core/bridgesessions";
import { shouldIdleShutdown, IDLE_TICK_MS } from "./core/idle";
import { startMcpServer } from "./server/mcp";
import { startControlApi } from "./server/control-api";

async function main(): Promise<void> {
  await initDB();
  console.error(`[init] Configuration: ${CONFIG_SOURCE ?? "(defaults)"}`);
  const registry = new Registry();
  const jobQueue = new JobQueue({ registry, concurrency: CONFIG.JOB_CONCURRENCY });
  const manager = new IndexManager(registry, jobQueue);
  // Live stdio-bridge MCP sessions (the idle-shutdown guardrail, proposal O4).
  const bridgeSessions = new BridgeSessionRegistry();

  // Idle shutdown (proposal O4): armed below only when daemon.idleTimeoutMinutes
  // > 0. With the default 0 nothing here runs — behavior is unchanged.
  const idleTimeoutMinutes = CONFIG.IDLE_TIMEOUT_MINUTES;
  let lastActivityAt = Date.now();
  const onActivity = (): void => {
    lastActivityAt = Date.now();
  };
  // A finished job is activity too: a long index burst keeps the daemon alive
  // for a fresh idle window after it ends (running jobs already block
  // shutdown via activeJobs).
  jobQueue.on("finished", onActivity);

  // Restore leftovers from the previous run: watchers + half-finished indexings.
  let restoring = false; // boot-time restore() phase; the idle tick reads it
  try {
    restoring = true;
    manager.restore();
  } finally {
    restoring = false;
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("\n[init] Shutting down...");
    // Send an abort signal to running jobs (an in-progress file write stops at
    // the file boundary), close watchers, then close SQLite cleanly.
    jobQueue.abortAll();
    await manager.shutdown();
    try {
      registry.close();
    } catch {
      // it's fine if it's already closed
    }
    process.exit(0);
  };

  // 1) Servers open IMMEDIATELY (do not wait for indexing).
  const mcp = await startMcpServer({ jobQueue, manager, onActivity });
  await startControlApi({ manager, jobQueue, onShutdown: shutdown, onActivity, bridgeSessions });

  // 2) If a directory was given on the command line, index/refresh that project (in the background).
  const dirArg = process.argv[2];
  if (dirArg) {
    const rec = manager.createIndex(dirArg);
    console.error(`[init] Project enqueued: '${rec.name}' → ${rec.path} (table: ${rec.tableName})`);
  }

  const indexes = manager.listIndexes();
  console.error(
    `[init] Daemon ready. ${indexes.length} projects registered.\n` +
      `       MCP (AI agent): http://${CONFIG.HOST}:${CONFIG.MCP_PORT}/mcp (Streamable HTTP) · /sse (legacy)\n` +
      `       Control (CLI):  http://${CONFIG.HOST}:${CONFIG.CONTROL_PORT}`,
  );

  if (idleTimeoutMinutes > 0) {
    console.error(`[init] Idle shutdown armed: exits after ${idleTimeoutMinutes} min without activity.`);
    // 30 s tick (IDLE_TICK_MS): good enough for a minutes-scale timeout, cheap
    // when idle. The decision function is pure (src/core/idle.ts) — the tick
    // only supplies live state, and the shutdown below is the SAME graceful
    // path as /shutdown and SIGINT (no forked mechanism, clean exit code 0).
    const timer = setInterval(() => {
      const now = Date.now();
      // Open sessions: bridge heartbeats (+ an unhearbeated-but-open legacy
      // SSE transport, which has no way to send activity on its own).
      const decision = shouldIdleShutdown({
        now,
        lastActivityAt,
        timeoutMinutes: idleTimeoutMinutes,
        activeJobs: jobQueue.activeJobCount(),
        // Legacy SSE clients count as open MCP sessions at the tick (the
        // registry count covers the stdio bridge itself).
        openBridgeSessions: bridgeSessions.activeCount(now) + mcp.openSseSessions(),
        restoring: restoring,
      });
      if (!decision.shutdown) return;
      clearInterval(timer);
      console.error(`[init] ${decision.reason ?? "Idle shutdown."}`);
      void shutdown();
    }, IDLE_TICK_MS);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[init] Fatal error:", err);
  process.exit(1);
});
