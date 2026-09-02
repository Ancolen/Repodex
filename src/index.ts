import { CONFIG, CONFIG_SOURCE } from "./config";
import { initDB } from "./services/db";
import { Registry } from "./core/registry";
import { JobQueue } from "./core/job-queue";
import { IndexManager } from "./core/index-manager";
import { startMcpServer } from "./server/mcp";
import { startControlApi } from "./server/control-api";

async function main(): Promise<void> {
  await initDB();
  console.error(`[init] Configuration: ${CONFIG_SOURCE ?? "(defaults)"}`);
  const registry = new Registry();
  const jobQueue = new JobQueue({ registry, concurrency: CONFIG.JOB_CONCURRENCY });
  const manager = new IndexManager(registry, jobQueue);

  // Restore leftovers from the previous run: watchers + half-finished indexings.
  manager.restore();

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
  await startMcpServer({ jobQueue, manager });
  await startControlApi({ manager, jobQueue, onShutdown: shutdown });

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

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[init] Fatal error:", err);
  process.exit(1);
});
