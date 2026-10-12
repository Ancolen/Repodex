/**
 * The `cidx reindex` help text states the embedding-cache behavior honestly:
 * the cache is KEPT across a reindex — it is keyed by content hash + model, so
 * re-embeds happen only for never-seen content+model pairs (the behavior is
 * correct by design; the earlier "cache cleared" wording was wrong).
 *
 * The CLI main() runs at import time in this file's process, so the catalog is
 * asserted through a subprocess (`reindex --help` / `help reindex` need no
 * daemon — printCommandHelp is pure rendering). $CIDX_HOME is pinned to the
 * test-isolated data root so the config auto-create never touches the real one.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { isolatedHome } from "./helpers/isolated-cidx-home";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI = join(REPO_ROOT, "src", "cli.ts");

async function runCli(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CIDX_HOME: isolatedHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  return out + err;
}

describe("CLI help — the reindex embedding-cache wording", () => {
  test("`cidx reindex --help` says the embedding cache is kept and the file cache is cleared", async () => {
    const out = await runCli(["reindex", "--help"]);
    expect(out).toContain("table + file cache are cleared and rebuilt");
    expect(out).toContain("The embedding cache is KEPT (keyed by content hash + model)");
    expect(out).toContain("only content+model pairs never embedded before are re-embedded");
    expect(out).toContain("100% cache hits");
  });

  test("no rendering of the help catalog still claims a reindex clears the embedding cache", async () => {
    const detailed = await runCli(["help", "reindex"]);
    expect(detailed).not.toMatch(/clears.*embedding cache/i);
    expect(detailed).not.toMatch(/embedding cache.*(cleared|cleans|wiped)/i);
    const general = await runCli(["help"]);
    expect(general).not.toMatch(/clears.*embedding cache/i);
    // The general screen lists the corrected summary too (same catalog entry).
    expect(general).toContain("table + file cache are cleared and rebuilt");
  });
});