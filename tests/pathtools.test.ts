/**
 * Pure path-relation tests for the index-start overlap note (agent UX): an
 * `index_project` on a directory inside/containing an already-indexed project
 * warns before the duplicate disk work happens.
 */
import { test, expect, describe } from "bun:test";
import { nestedRegisteredRoots, pathOverlapNote, isWithinDir } from "../src/utils/pathtools";

describe("isWithinDir", () => {
  test("parent/child/identity/outside relations", () => {
    expect(isWithinDir("/a/b", "/a/b/c")).toBe(true);
    expect(isWithinDir("/a/b", "/a/b")).toBe(true);
    expect(isWithinDir("/a/b", "/a/bc")).toBe(false); // prefix-string trap
    expect(isWithinDir("/a/b", "/a")).toBe(false);
    expect(isWithinDir("/a/b", "/c/d")).toBe(false);
  });
});

describe("nestedRegisteredRoots — an umbrella index never scans a child project", () => {
  const records = [
    { name: "parent", path: "/work/mono" },
    { name: "child", path: "/work/mono/packages/app" },
    { name: "grandchild", path: "/work/mono/packages/app/src/deep" },
    { name: "sibling", path: "/work/other" },
  ];

  test("strictly-inside roots are returned, the parent itself and outside paths are not", () => {
    expect(nestedRegisteredRoots("/work/mono", records).sort()).toEqual([
      "/work/mono/packages/app",
      "/work/mono/packages/app/src/deep",
    ]);
    expect(nestedRegisteredRoots("/work/mono/packages/app", records)).toEqual([
      "/work/mono/packages/app/src/deep",
    ]);
    expect(nestedRegisteredRoots("/work/other", records)).toEqual([]);
    expect(nestedRegisteredRoots("/work/mono", [records[0]!])).toEqual([]);
  });

  test("duplicate registrations of one path are deduped", () => {
    const dup = [
      { name: "a", path: "/work/mono/child" },
      { name: "b", path: "/work/mono/child/" },
    ];
    expect(nestedRegisteredRoots("/work/mono", dup)).toEqual(["/work/mono/child"]);
  });
});

describe("pathOverlapNote — the duplicate-scope catch at index start", () => {
  const existing = [
    { name: "server", path: "/home/duldul/robot/server" },
    { name: "robot-server-src", path: "/home/duldul/robot/server/src" },
    { name: "unrelated", path: "/home/duldul/oyun" },
  ];

  test("indexing INSIDE an indexed parent names the covering project", () => {
    const note = pathOverlapNote("/home/duldul/robot/server/src/brain", existing.slice(0, 1));
    expect(note).toContain("'server'");
    expect(note).toContain("parent directory");
    expect(note).toContain("duplicate results");
  });

  test("indexing a PARENT over an indexed inner project points at the inner one", () => {
    const note = pathOverlapNote("/home/duldul/robot/server", [
      { name: "robot-server-src", path: "/home/duldul/robot/server/src" },
    ]);
    expect(note).toContain("'robot-server-src'");
    expect(note).toContain("inside this directory");
  });

  test("a different requested name on the same path says the name is ignored", () => {
    const note = pathOverlapNote(
      "/home/duldul/robot/server",
      [{ name: "server", path: "/home/duldul/robot/server" }],
      "server-alt",
    );
    expect(note).toContain("already indexed as 'server'");
    expect(note).toContain("'server-alt' is ignored");
    // No requested name (or the same one) → still the silent reindex path.
    expect(
      pathOverlapNote("/home/duldul/robot/server", [{ name: "server", path: "/home/duldul/robot/server" }], "server"),
    ).toBeNull();
  });

  test("the same directory itself and unrelated directories yield null", () => {
    expect(pathOverlapNote("/home/duldul/robot/server", [{ name: "server", path: "/home/duldul/robot/server" }])).toBeNull();
    expect(pathOverlapNote("/home/duldul/oyun", existing)).toBeNull();
    expect(pathOverlapNote("/home/duldul/newproj", [existing[2]!])).toBeNull();
  });
});
