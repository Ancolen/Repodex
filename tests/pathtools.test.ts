/**
 * Pure path-relation tests for the index-start overlap note (agent UX): an
 * `index_project` on a directory inside/containing an already-indexed project
 * warns before the duplicate disk work happens.
 */
import { test, expect, describe } from "bun:test";
import { pathOverlapNote, isWithinDir } from "../src/utils/pathtools";

describe("isWithinDir", () => {
  test("parent/child/identity/outside relations", () => {
    expect(isWithinDir("/a/b", "/a/b/c")).toBe(true);
    expect(isWithinDir("/a/b", "/a/b")).toBe(true);
    expect(isWithinDir("/a/b", "/a/bc")).toBe(false); // prefix-string trap
    expect(isWithinDir("/a/b", "/a")).toBe(false);
    expect(isWithinDir("/a/b", "/c/d")).toBe(false);
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

  test("the same directory itself and unrelated directories yield null", () => {
    expect(pathOverlapNote("/home/duldul/robot/server", [{ name: "server", path: "/home/duldul/robot/server" }])).toBeNull();
    expect(pathOverlapNote("/home/duldul/oyun", existing)).toBeNull();
    expect(pathOverlapNote("/home/duldul/newproj", [existing[2]!])).toBeNull();
  });
});
