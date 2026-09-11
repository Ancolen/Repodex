/**
 * Test-only data-root isolation, wired up by `bunfig.toml` (`[test] preload`).
 *
 * `src/config.ts` flattens `CONFIG` — data root included — once, when the
 * module is first imported. `bun test` runs every test file in ONE process with
 * a shared module registry, so whichever file imports it first decides the data
 * root for all the others: a per-file `process.env.CIDX_HOME = ...` ahead of a
 * dynamic `import()` only holds while that file is the first to load the
 * module. The LanceDB-writing suites (`tests/apidiff.test.ts`,
 * `tests/idterms.test.ts`) lost that race against files with a static
 * `src/config` / `src/services/db` import and created their fixture tables in
 * the user's real `~/.cidx/db`, where `cidx doctor` reports them as orphans.
 *
 * Pinning the root here, before any test module is imported, removes the race
 * for every test, present and future. It is unconditional — an inherited
 * `$CIDX_HOME` would be a real data root, and tests write tables into it. The
 * directory is removed once the run has finished.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "bun:test";

/** The throw-away data root shared by every test in this run. */
export const isolatedHome = mkdtempSync(path.join(tmpdir(), "cidx-test-home-"));

process.env.CIDX_HOME = isolatedHome;

// Not `process.on("exit")`: the test runner tears the process down without
// running exit handlers. This hook is global (registered before any test file
// loads), so it fires once, after the last file — every per-file hook in the
// suite has already had its turn on this directory.
afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});
