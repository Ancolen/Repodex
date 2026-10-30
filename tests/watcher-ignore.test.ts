/**
 * The watcher must apply the SAME ignore/extension rules as the full indexer
 * at the chokidar level, not only when an event fires.
 *
 * Why this is a resource bug, not a style point: chokidar opens a watch handle
 * per accepted file. Applying ignore rules only in the `add`/`change` handler
 * still made chokidar watch every file in ignored trees — a Python `.venv`
 * alone held tens of thousands of descriptors in production (`cidx.service`
 * was observed at ~98k fds). These tests assert on `getWatched()`, which is
 * exactly the set chokidar opened handles for.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildIgnore, buildIgnoreSync } from "../src/services/indexer";
import { readProjectConfig } from "../src/core/project-config";
import { startWatcher } from "../src/services/watcher";

const root = mkdtempSync(join(tmpdir(), "cidx-watcher-ignore-"));

function write(rel: string, content = "export const x = 1;\n"): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Flatten chokidar's getWatched() map into absolute paths. */
function watchedPaths(w: { getWatched(): Record<string, string[]> }): Set<string> {
  const out = new Set<string>();
  for (const [dir, names] of Object.entries(w.getWatched())) {
    for (const name of names) out.add(join(dir, name));
  }
  return out;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("startWatcher — ignore rules are applied before chokidar opens handles", () => {
  test(
    "ignored trees and unindexable extensions are never watched; indexable files are",
    async () => {
      write("src/a.ts");
      write("docs/readme.md");
      write("notes.txt");
      write("node_modules/dep/index.js");
      write(".venv/lib/python3.12/site-packages/dep.py");
      write("generated/g.ts");
      write("secret/s.ts");
      write(".cidxignore", "generated/\n");
      write(".cidx.json", JSON.stringify({ ignore: ["secret/"] }));

      const target = { indexName: "ignore-fixture", tableName: "idx_ignore_fixture", baseDir: root };
      const w = startWatcher(target, { debounceMs: 10 });
      try {
        await new Promise<void>((res) => w.once("ready", () => res()));
        const watched = watchedPaths(w);

        expect(watched.has(join(root, "src/a.ts"))).toBe(true);
        expect(watched.has(join(root, "docs/readme.md"))).toBe(true);

        // Disallowed extension: the indexer would reject it, so no handle.
        expect(watched.has(join(root, "notes.txt"))).toBe(false);
        // Global ignoredDirs (defaults include node_modules and .venv).
        expect([...watched].some((p) => p.includes(`${join(root, "node_modules")}`))).toBe(false);
        expect([...watched].some((p) => p.includes(`${join(root, ".venv")}`))).toBe(false);
        // `.cidxignore` and `.cidx.json` extra patterns are honored too. The
        // directory itself may still be traversed (gitignore's `dir/` form
        // matches contents, not the directory), but none of its files get a
        // watch handle.
        expect(watched.has(join(root, "generated/g.ts"))).toBe(false);
        expect(watched.has(join(root, "secret/s.ts"))).toBe(false);
      } finally {
        await w.close();
      }
    },
    20000,
  );

  test(
    "a directory containing a FIFO is never watched (Bun's fs.watch opens children and blocks on FIFOs)",
    async () => {
      // No FIFOs on Windows.
      if (process.platform === "win32") return;
      const probe = join(root, "probe-runs");
      mkdirSync(probe, { recursive: true });
      write("probe-runs/ok.md");
      write("safe/keep.ts");
      try {
        execFileSync("mkfifo", [join(probe, "host-stdin.fifo")], { stdio: "ignore" });
      } catch {
        return; // no mkfifo on this system: nothing to assert
      }

      const target = { indexName: "fifo-fixture", tableName: "idx_fifo_fixture", baseDir: root };
      const w = startWatcher(target, { debounceMs: 10 });
      try {
        await new Promise<void>((res) => w.once("ready", () => res()));
        const watched = watchedPaths(w);

        // The FIFO itself has no handle…
        expect(watched.has(join(probe, "host-stdin.fifo"))).toBe(false);
        // …and neither does its PARENT directory. Bun's `fs.watch(dir)` walks
        // the directory and `open()`s every direct child: one FIFO parks an fs
        // worker forever, and once the pool is exhausted the event loop itself
        // blocks — the daemon hung at startup in production this way.
        expect([...watched].some((p) => p.startsWith(probe))).toBe(false);
        // A safe sibling directory still gets its handles.
        expect(watched.has(join(root, "safe/keep.ts"))).toBe(true);
      } finally {
        await w.close();
      }
    },
    20000,
  );

  test("buildIgnoreSync matches the async buildIgnore for the same project", async () => {
    const pcfg = readProjectConfig(root);
    const sync = buildIgnoreSync(root, pcfg?.ignore);
    const asyncIg = await buildIgnore(root, pcfg?.ignore);
    const relative = [
      "src/a.ts",
      "notes.txt",
      "node_modules/dep/index.js",
      ".venv/lib/python3.12/site-packages/dep.py",
      "generated/g.ts",
      "secret/s.ts",
      "docs/readme.md",
    ];
    for (const rel of relative) {
      expect(sync.ignores(rel)).toBe(asyncIg.ignores(rel));
    }
  });
});
