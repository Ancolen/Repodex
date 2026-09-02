#!/usr/bin/env bun
/**
 * Single-binary entry point (the `bun build --compile` target).
 *
 * Dispatches to the appropriate sub-program based on the arguments:
 *   __daemon  → daemon (src/index.ts)
 *   __bridge  → stdio MCP bridge (src/stdio-bridge.ts)
 *   <other>   → thin CLI client (src/cli.ts)
 *
 * This file runs both as the compiled binary and via `bun run src/main.ts ...`.
 */
import { userArgs } from "./runtime";

const args = userArgs();
const sub = args[0];

if (sub === "__daemon") {
  // Normalized argv for the daemon: [exec, "daemon", ...rest]
  process.argv = [process.argv[0] ?? "cidx", "daemon", ...args.slice(1)];
  await import("./index");
} else if (sub === "__bridge") {
  process.argv = [process.argv[0] ?? "cidx", "bridge"];
  await import("./stdio-bridge");
} else {
  // CLI: cli.ts reads the command starting from `process.argv[2]`; normalize it.
  process.argv = [process.argv[0] ?? "cidx", "cidx", ...args];
  await import("./cli");
}
