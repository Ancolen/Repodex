/**
 * Additional edge cases for db.buildWhere (complements the existing hybrid.test.ts):
 * combination of three filters, glob + literal escape combination, injection escaping.
 */
import { test, expect, describe } from "bun:test";
import { buildWhere } from "../src/services/db";

describe("buildWhere — combined filters", () => {
  test("language + symbolType + pathGlob all combine with AND", () => {
    const w = buildWhere({ language: "go", symbolType: "method", pathGlob: "src/*" });
    expect(w).toBe(
      "language = 'go' AND symbolType = 'method' AND filePath LIKE '%src/%' ESCAPE '\\'",
    );
  });

  test("only symbolType", () => {
    expect(buildWhere({ symbolType: "class" })).toBe("symbolType = 'class'");
  });

  test("only pathGlob, wildcard in the middle", () => {
    expect(buildWhere({ pathGlob: "src/*/handler" })).toBe(
      "filePath LIKE '%src/%/handler' ESCAPE '\\'",
    );
  });

  test("pathGlob: leading '/' anchors the absolute path start", () => {
    // Stored filePath values are absolute; a leading '/' means the user wants
    // start-anchored matching instead of project-relative anywhere-matching.
    expect(buildWhere({ pathGlob: "/repo/src/*" })).toBe(
      "filePath LIKE '/repo/src/%' ESCAPE '\\'",
    );
  });

  test("pathGlob: '**' collapses to a wildcard like '*'", () => {
    expect(buildWhere({ pathGlob: "docs/**/*.xml" })).toBe(
      "filePath LIKE '%docs/%.xml' ESCAPE '\\'",
    );
  });

  test("pathGlob: both literal '_' and wildcard '*' — '_' is escaped, '*' → '%'", () => {
    // 'my_dir/*' → '_' is literal (\_), '*' is wildcard (%).
    expect(buildWhere({ pathGlob: "my_dir/*" })).toBe(
      "filePath LIKE '%my\\_dir/%' ESCAPE '\\'",
    );
  });

  test("pathGlob: literal '%' is escaped", () => {
    expect(buildWhere({ pathGlob: "100%done" })).toBe(
      "filePath LIKE '%100\\%done%' ESCAPE '\\'",
    );
  });

  test("single quote inside symbolType is escaped against injection", () => {
    expect(buildWhere({ symbolType: "cl'ass" })).toBe("symbolType = 'cl''ass'");
  });

  test("empty string filters are ignored (falsy)", () => {
    // Empty language/symbolType/pathGlob → no condition is added.
    expect(buildWhere({ language: "", symbolType: "", pathGlob: "" })).toBeUndefined();
  });
});
