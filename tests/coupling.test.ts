/**
 * Coupling metrics (proposal C5) — three levels:
 *
 *  1. `computeCoupling` — the pure reduction over an injected `forward` map:
 *     fan-in/fan-out/instability math, external-edge exclusion, band membership,
 *     ranking, caps + truncation.
 *  2. `getCoupling` — the engine over a REAL fixture project written to a temp
 *     dir and parsed with the REAL engines (`extractImports` → `resolveImports`
 *     → the mtime-keyed graph cache) — no LanceDB, no Ollama (the coupling report
 *     needs no table access at all). The acceptance check lives here: the known
 *     hub file ranks top fan-in.
 *  3. The project-anchor contract (explicit project → path anchor → single
 *     project; every failure self-healing), on the real method.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { computeCoupling } from "../src/core/coupling";
import type { CouplingBand, CouplingReport, FileCoupling } from "../src/core/coupling";
import { Registry } from "../src/core/registry";
import { JobQueue } from "../src/core/job-queue";
import { IndexManager } from "../src/core/index-manager";

// --------------------------------------------------------------- pure helpers

/** Fetches one band member by project-relative path (throws when absent). */
function byRel(band: CouplingBand, rel: string): FileCoupling {
  const hit = band.items.find((f) => f.relativeFile === rel);
  if (!hit) throw new Error(`'${rel}' not found in the band: [${band.items.map((f) => f.relativeFile).join(", ")}]`);
  return hit;
}

const rels = (band: CouplingBand): string[] => band.items.map((f) => f.relativeFile);

// ---------------------------------------------------- 1. computeCoupling (pure)

describe("computeCoupling — pure graph math", () => {
  // A known graph under /fx/src: hub is the top fan-in AND the only change magnet;
  // entry/mid carry the magnet boundary (fanIn 1, fanOut 2 → NOT a magnet).
  const FORWARD = new Map<string, string[]>([
    ["/fx/src/app.ts", ["/fx/src/hub.ts"]],
    ["/fx/src/main.ts", ["/fx/src/entry.ts"]],
    ["/fx/src/entry.ts", ["/fx/src/hub.ts", "/fx/src/mid.ts"]],
    ["/fx/src/mid.ts", ["/fx/src/hub.ts", "/fx/src/helper.ts"]],
    ["/fx/src/hub.ts", ["/fx/src/util.ts", "/fx/src/helper.ts"]],
    ["/fx/src/helper.ts", ["/fx/src/util.ts"]],
    ["/fx/src/orphan.ts", ["/fx/src/util.ts"]],
    // standalone imports only external modules → no internal edges, but 2 external
  ]);
  const FILES = [
    "/fx/src/app.ts", "/fx/src/main.ts", "/fx/src/entry.ts", "/fx/src/mid.ts",
    "/fx/src/hub.ts", "/fx/src/helper.ts", "/fx/src/orphan.ts", "/fx/src/util.ts",
    "/fx/src/standalone.ts",
  ];
  const EXTERNAL = new Map<string, number>([
    ["/fx/src/hub.ts", 3],
    ["/fx/src/standalone.ts", 2],
  ]);

  const run = (over: Partial<Parameters<typeof computeCoupling>[0]> = {}): CouplingReport =>
    computeCoupling({
      project: "purefx",
      projectRoot: "/fx",
      files: FILES,
      forward: FORWARD,
      externalImports: EXTERNAL,
      ...over,
    });

  test("the hub file ranks top fan-in and the bands rank deterministically", () => {
    const r = run();
    expect(r.project).toBe("purefx");
    expect(r.scannedFiles).toBe(FILES.length);
    // hub(3) and util(3) tie on fanIn — the path tiebreak keeps the order stable.
    expect(rels(r.topFanIn)).toEqual([
      "src/hub.ts", // 3
      "src/util.ts", // 3 (hub.ts < util.ts)
      "src/helper.ts", // 2 (hub + mid)
      "src/entry.ts", // 1 (main)
      "src/mid.ts", // 1 (entry)
    ]);
    expect(r.topFanIn.total).toBe(5);
    expect(r.topFanIn.truncated).toBe(false);
  });

  test("fan values: internal edges only, distinct files, external counted separately", () => {
    const r = run();
    const hub = byRel(r.topFanIn, "src/hub.ts");
    // hub imports 2 indexed files but has 3 external specifiers → fanOut stays 2.
    expect(hub.fanIn).toBe(3);
    expect(hub.fanOut).toBe(2);
    expect(hub.externalImports).toBe(3);
    // util is imported by hub/helper/orphan and imports nothing.
    const util = byRel(r.topFanIn, "src/util.ts");
    expect(util.fanIn).toBe(3);
    expect(util.fanOut).toBe(0);
    expect(util.externalImports).toBe(0);
    // Project-wide external total (3 + 2) is reported even for never-listed files.
    expect(r.externalImports).toBe(5);
  });

  test("instability boundaries: 0 (attracting), 1 (depending), null (no edges)", () => {
    const r = run();
    expect(byRel(r.topFanIn, "src/util.ts").instability).toBe(0);
    expect(byRel(r.unstableLeaves, "src/main.ts").fanIn).toBe(0);
    expect(byRel(r.unstableLeaves, "src/main.ts").fanOut).toBe(1);
    expect(byRel(r.unstableLeaves, "src/main.ts").instability).toBe(1);
    // hub: fanOut 2 / (fanIn 3 + fanOut 2) = 0.4
    expect(byRel(r.topFanIn, "src/hub.ts").instability).toBe(0.4);
    // helper: 1/3 → rounds to 3 decimals
    expect(byRel(r.topFanIn, "src/helper.ts").instability).toBe(0.333);
    // standalone: no internal edges at all → null instability, not listed anywhere
    expect(r.unclassified).toBe(1);
    for (const band of [r.topFanIn, r.changeMagnets, r.unstableLeaves]) {
      expect(band.items.some((f) => f.relativeFile === "src/standalone.ts")).toBe(false);
    }
  });

  test("band membership rules: a magnet needs fanIn >= 2 AND fanOut >= 2", () => {
    const r = run();
    // Only hub qualifies: entry/mid have fanOut 2 but fanIn 1, helper has fanIn 2 but fanOut 1.
    expect(rels(r.changeMagnets)).toEqual(["src/hub.ts"]);
    // entry/mid land in topFanIn (fanIn > 0) — a magnet is a view, not a partition.
    expect(rels(r.topFanIn)).toContain("src/entry.ts");
    expect(rels(r.topFanIn)).toContain("src/mid.ts");
  });

  test("change magnets rank by fanIn + fanOut: the doubly-coupled hub first", () => {
    // hub2: fanIn 3 (a, b, c) × fanOut 3 (leaf1, leaf2, d) = 6; mid2: fanIn 2 × fanOut 2 = 4.
    const r = computeCoupling({
      project: "magnets",
      projectRoot: "/m",
      files: ["/m/a.ts", "/m/b.ts", "/m/c.ts", "/m/hub2.ts", "/m/mid2.ts", "/m/leaf1.ts", "/m/leaf2.ts", "/m/d.ts"],
      forward: new Map<string, string[]>([
        ["/m/a.ts", ["/m/hub2.ts", "/m/mid2.ts"]],
        ["/m/b.ts", ["/m/hub2.ts", "/m/mid2.ts"]],
        ["/m/c.ts", ["/m/hub2.ts"]],
        ["/m/hub2.ts", ["/m/leaf1.ts", "/m/leaf2.ts", "/m/d.ts"]],
        ["/m/mid2.ts", ["/m/leaf1.ts", "/m/leaf2.ts"]],
      ]),
    });
    expect(rels(r.changeMagnets)).toEqual(["hub2.ts", "mid2.ts"]);
    expect(byRel(r.changeMagnets, "hub2.ts").fanIn).toBe(3);
    expect(byRel(r.changeMagnets, "hub2.ts").fanOut).toBe(3);
    // A sum tie is broken by fanIn desc, then path: here hub2 (6) outranks mid2 (4).
    expect(r.changeMagnets.total).toBe(2);
  });

  test("unstable leaves: fanIn 0 with fanOut > 0, ranked by fanOut", () => {
    const r = run();
    expect(rels(r.unstableLeaves)).toEqual(["src/app.ts", "src/main.ts", "src/orphan.ts"]);
    expect(r.unstableLeaves.total).toBe(3);
    for (const f of r.unstableLeaves.items) {
      expect(f.fanIn).toBe(0);
      expect(f.fanOut).toBeGreaterThan(0);
      expect(f.instability).toBe(1);
    }
  });

  test("caps: every band capped by limit with honest totals and truncated flags", () => {
    const r = run({ limit: 2 });
    expect(r.topFanIn.items).toHaveLength(2);
    expect(r.topFanIn.total).toBe(5);
    expect(r.topFanIn.truncated).toBe(true);
    expect(r.changeMagnets.items).toHaveLength(1);
    expect(r.changeMagnets.total).toBe(1);
    expect(r.changeMagnets.truncated).toBe(false);
    expect(r.unstableLeaves.items).toHaveLength(2);
    expect(r.unstableLeaves.total).toBe(3);
    expect(r.unstableLeaves.truncated).toBe(true);
    expect(r.truncated).toBe(true);
    // The band totals still cover every member — nothing was silently dropped.
    expect(r.unclassified).toBe(1);
    expect(r.scannedFiles).toBe(9);
  });

  test("edge hygiene: repeated targets, self-edges and stray nodes", () => {
    // Two specifiers importing the same file are one coupling, not two.
    const dup = computeCoupling({
      project: "d",
      projectRoot: "/d",
      files: ["/d/a.ts", "/d/b.ts"],
      forward: new Map([["/d/a.ts", ["/d/b.ts", "/d/b.ts"]]]),
    });
    expect(byRel(dup.topFanIn, "b.ts").fanIn).toBe(1);
    expect(byRel(dup.unstableLeaves, "a.ts").fanOut).toBe(1);

    // A self-edge never couples a file to itself.
    const self = computeCoupling({
      project: "s",
      projectRoot: "/s",
      files: ["/s/a.ts"],
      forward: new Map([["/s/a.ts", ["/s/a.ts"]]]),
    });
    expect(self.scannedFiles).toBe(1);
    expect(self.unclassified).toBe(1);

    // An edge pointing outside the declared set extends the set instead of lying.
    const stray = computeCoupling({
      project: "x",
      projectRoot: "/x",
      files: ["/x/a.ts"],
      forward: new Map([["/x/a.ts", ["/x/b.ts"]]]),
    });
    expect(stray.scannedFiles).toBe(2);
    expect(byRel(stray.topFanIn, "b.ts").fanIn).toBe(1);
  });

  test("an empty project reports zeros honestly", () => {
    const r = computeCoupling({ project: "e", projectRoot: "/e", files: [], forward: new Map() });
    expect(r.scannedFiles).toBe(0);
    expect(r.topFanIn.total).toBe(0);
    expect(r.changeMagnets.total).toBe(0);
    expect(r.unstableLeaves.total).toBe(0);
    expect(r.unclassified).toBe(0);
    expect(r.externalImports).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

// ------------------------------------------------- 2. getCoupling — fixture project

const FIXTURE_FILES: Record<string, string> = {
  // hub: imported by app/main/extra, imports util + helper → top fan-in AND change magnet.
  "src/hub.ts": `import { U } from "./util";
import { H } from "./helper";

export const C = U + H;
`,
  // util: imported by hub + orphan, imports nothing → stable attractiveness (instability 0).
  "src/util.ts": `export const U = 1;
`,
  // helper: imported by hub + midA, imports nothing → fanIn 2, fanOut 0 (not a magnet).
  "src/helper.ts": `export const H = 1;
`,
  // orphan: imports util, imported by nobody → unstable leaf.
  "src/orphan.ts": `import { U } from "./util";

export const O = U;
`,
  // midA: imports helper, imported by nobody → unstable leaf.
  "src/midA.ts": `import { H } from "./helper";

export const A = H;
`,
  // app: imported by main, imports hub → fanIn 1, fanOut 1 (topFanIn only).
  "src/app.ts": `import { C } from "./hub";

export const APP = C;
`,
  // main: imports hub + app, imported by nobody → unstable leaf (fanOut 2).
  "src/main.ts": `import { C } from "./hub";
import { APP } from "./app";

export const M = C + APP;
`,
  // extra: imports hub, imported by nobody → unstable leaf.
  "src/extra.ts": `import { C } from "./hub";

export const EXTRA = C;
`,
  // standalone: only an external import → no internal edges → unclassified, external 1.
  "src/standalone.ts": `import { join } from "node:path";

export const S = join("a", "b");
`,
};

const FX_ROOT = mkdtempSync(join(tmpdir(), "cidx-coupling-fx-"));
const FX_DB = join(tmpdir(), `mcp-coupling-${randomUUID()}.db`);

let manager: IndexManager;

beforeAll(() => {
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(FX_ROOT, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const reg = new Registry(FX_DB);
  const files = Object.keys(FIXTURE_FILES).map((rel) => join(FX_ROOT, rel));
  reg.upsertIndex({
    name: "couplingfx",
    path: FX_ROOT,
    tableName: "idx_couplingfx_test",
    status: "ready",
    fileCount: files.length,
    chunkCount: files.length,
    embedModel: null,
    embedDim: null,
    lastIndexedAt: null,
    createdAt: 1,
    error: null,
  });
  for (const f of files) reg.setFileMtime("couplingfx", f, statSync(f).mtimeMs);
  manager = new IndexManager(reg, new JobQueue());
});

afterAll(() => {
  rmSync(FX_ROOT, { recursive: true, force: true });
  rmSync(FX_DB, { force: true });
});

describe("getCoupling — fixture project (real parses, real graph cache)", () => {
  let report: CouplingReport;

  beforeAll(async () => {
    report = await manager.getCoupling(); // single indexed project → no anchor needed
  });

  test("the known hub file ranks top fan-in (acceptance)", () => {
    expect(report.project).toBe("couplingfx");
    expect(report.scannedFiles).toBe(Object.keys(FIXTURE_FILES).length);
    expect(rels(report.topFanIn)).toEqual(["src/hub.ts", "src/helper.ts", "src/util.ts", "src/app.ts"]);
    const hub = report.topFanIn.items[0]!;
    expect(hub.fanIn).toBe(3);
    expect(hub.fanOut).toBe(2);
    expect(hub.instability).toBe(0.4);
  });

  test("change magnets: the hub is the only doubly-coupled file", () => {
    expect(rels(report.changeMagnets)).toEqual(["src/hub.ts"]);
    // helper/util have fanIn 2 but fanOut 0 → imported, not magnets.
    expect(report.changeMagnets.truncated).toBe(false);
  });

  test("unstable leaves: nothing imports main/extra/midA/orphan", () => {
    // main (fanOut 2) leads, then the fanOut-1 leaves in path order.
    expect(rels(report.unstableLeaves)).toEqual([
      "src/main.ts", "src/extra.ts", "src/midA.ts", "src/orphan.ts",
    ]);
    expect(report.unstableLeaves.items.every((f) => f.fanIn === 0)).toBe(true);
    expect(byRel(report.unstableLeaves, "src/main.ts").fanOut).toBe(2);
    expect(byRel(report.unstableLeaves, "src/main.ts").instability).toBe(1);
  });

  test("external edges stay out of the fan math but are counted", () => {
    expect(report.externalImports).toBe(1);
    // standalone.ts (node:path) has no internal coupling → counted, not listed.
    expect(report.unclassified).toBe(1);
    for (const band of [report.topFanIn, report.changeMagnets, report.unstableLeaves]) {
      expect(band.items.some((f) => f.relativeFile === "src/standalone.ts")).toBe(false);
    }
    // Bands partition: every non-standalone file appears somewhere.
    const listed = new Set([
      ...rels(report.topFanIn),
      ...rels(report.unstableLeaves),
    ]);
    expect(listed.size).toBe(8);
  });

  test("the mtime-cached graph gives identical results on a second call", async () => {
    const again = await manager.getCoupling("couplingfx");
    expect(again).toEqual(report);
  });

  test("explicit project and path anchors resolve to the same report", async () => {
    const byPath = await manager.getCoupling(undefined, FX_ROOT);
    expect(byPath).toEqual(report);
  });

  test("the limit caps each band with honest totals + truncation", async () => {
    const r = await manager.getCoupling("couplingfx", undefined, 2);
    expect(r.topFanIn.items).toHaveLength(2);
    expect(r.topFanIn.total).toBe(4);
    expect(r.topFanIn.truncated).toBe(true);
    expect(r.changeMagnets.total).toBe(1);
    expect(r.changeMagnets.truncated).toBe(false);
    expect(r.unstableLeaves.items).toHaveLength(2);
    expect(r.unstableLeaves.total).toBe(4);
    expect(r.unstableLeaves.truncated).toBe(true);
    expect(r.truncated).toBe(true);
  });
});

// -------------------------------------------------- 3. project-anchor contract

const CT_A = mkdtempSync(join(tmpdir(), "cidx-coupling-ct-a-"));
const CT_B = mkdtempSync(join(tmpdir(), "cidx-coupling-ct-b-"));
const CT_DB = join(tmpdir(), `mcp-coupling-ct-${randomUUID()}.db`);

describe("getCoupling — project resolution contract", () => {
  let registry: Registry;
  let contract: IndexManager;

  beforeAll(() => {
    registry = new Registry(CT_DB);
    contract = new IndexManager(registry, new JobQueue());
  });
  afterAll(() => {
    rmSync(CT_A, { recursive: true, force: true });
    rmSync(CT_B, { recursive: true, force: true });
    rmSync(CT_DB, { force: true });
  });

  test("zero indexed projects → helpful error", async () => {
    await expect(contract.getCoupling()).rejects.toThrow(/No indexed project/);
  });

  test("several projects, no anchor → the ambiguity error names them all", async () => {
    const base = {
      status: "ready" as const, fileCount: 0, chunkCount: 0, embedModel: null,
      embedDim: null, lastIndexedAt: null, createdAt: 1, error: null,
    };
    registry.upsertIndex({ ...base, name: "alpha", path: CT_A, tableName: "idx_alpha" });
    registry.upsertIndex({ ...base, name: "beta", path: CT_B, tableName: "idx_beta" });
    await expect(contract.getCoupling()).rejects.toThrow(/Multiple projects are indexed \(alpha, beta\)/);
  });

  test("an unknown project → not-found error", async () => {
    await expect(contract.getCoupling("nope")).rejects.toThrow(/Index not found/);
  });

  test("a path anchors the project containing it (the most specific prefix wins)", async () => {
    // gamma is indexed at a nested path INSIDE alpha's root: a file under 'pkg'
    // matches both projects, and the longer prefix wins.
    const nested = join(CT_A, "pkg");
    mkdirSync(nested, { recursive: true });
    registry.upsertIndex({
      name: "gamma", path: nested, tableName: "idx_gamma", status: "ready",
      fileCount: 0, chunkCount: 0, embedModel: null, embedDim: null,
      lastIndexedAt: null, createdAt: 2, error: null,
    });
    const r = await contract.getCoupling(undefined, join(nested, "x.ts"));
    expect(r.project).toBe("gamma");
    // A path only under the broader root still anchors alpha.
    const r2 = await contract.getCoupling(undefined, join(CT_A, "other.ts"));
    expect(r2.project).toBe("alpha");
  });

  test("a path outside every indexed project → error", async () => {
    await expect(contract.getCoupling(undefined, "/nonexistent/coupling/outside.ts")).rejects.toThrow(
      /No indexed project contains/,
    );
  });
});