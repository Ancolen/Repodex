import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Are we running inside a single-binary produced by `bun build --compile`?
 *
 * In both dev (bun run src/x.ts) and the compiled binary, the process.argv
 * structure is the same: [exec, entryPath, ...userArgs]. The difference is that
 * in the compiled binary entryPath is an embedded virtual path ("/$bunfs/root/...")
 * while in dev it is a real .ts file path.
 */
export const IS_COMPILED: boolean = (() => {
  const a1 = process.argv[1];
  if (!a1) return true;
  if (a1.includes("$bunfs") || a1.includes("B:\\~BUN")) return true;
  if (/\.(c|m)?[tj]s$/.test(a1) && existsSync(a1)) return false;
  return true;
})();

/** User arguments (from argv[2] onward in both modes). */
export function userArgs(): string[] {
  return process.argv.slice(2);
}

/**
 * The command to run to start the daemon.
 * - Compiled: invokes itself with the hidden `__daemon` sub-command.
 * - Dev: `bun run src/index.ts`.
 */
export function daemonCommand(srcDir: string): string[] {
  if (IS_COMPILED) return [process.execPath, "__daemon"];
  return ["bun", "run", path.join(srcDir, "index.ts")];
}

/**
 * The command to run to start the stdio bridge.
 * - Compiled: invokes itself with the hidden `__bridge` sub-command.
 * - Dev: `bun run src/stdio-bridge.ts`.
 */
export function bridgeCommand(srcDir: string): string[] {
  if (IS_COMPILED) return [process.execPath, "__bridge"];
  return ["bun", "run", path.join(srcDir, "stdio-bridge.ts")];
}
