/**
 * Identifier-part tokenization tests (proposal S1): the pure splitter, the
 * per-chunk `id_terms` extraction, and the query-side leg gate.
 *
 * The LanceDB-side legacy invariant (a table created without `id_terms` runs the
 * exact legacy search paths) is covered at the bottom via a real temp table.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ID_TERMS_CHARS,
  splitIdentifier,
  extractIdTerms,
  idTermsQueryParts,
  wantIdTermsLeg,
} from "../src/core/idterms";
import type { CodeRecord } from "../src/services/db";

describe("splitIdentifier — table-driven", () => {
  const cases: [string, string[]][] = [
    // camelCase
    ["getUserName", ["get", "User", "Name"]],
    ["filePath", ["file", "Path"]],
    ["a", ["a"]],
    // snake_case
    ["user_id", ["user", "id"]],
    ["get_user_name", ["get", "user", "name"]],
    ["_private_field", ["private", "field"]],
    ["__init__", ["init"]],
    // kebab-case (splitter-level; the extractor does not feed kebab tokens)
    ["user-name", ["user", "name"]],
    // SCREAMING_SNAKE
    ["SCREAMING_SNAKE", ["SCREAMING", "SNAKE"]],
    ["MAX_ID_TERMS_CHARS", ["MAX", "ID", "TERMS", "CHARS"]],
    // Acronym runs keep their shape (`HTTPServer` → HTTP | Server)
    ["HTTPServer", ["HTTP", "Server"]],
    ["getHTTPResponse", ["get", "HTTP", "Response"]],
    ["parseJSONString", ["parse", "JSON", "String"]],
    // dotted
    ["fs.readFile", ["fs", "read", "File"]],
    ["com.example.app.Core", ["com", "example", "app", "Core"]],
    ["Class.method", ["Class", "method"]],
    // digits stay attached to the word they follow
    ["md5Hash", ["md5", "Hash"]],
    ["sha256sum", ["sha256sum"]],
    ["user2Name", ["user2", "Name"]],
    ["HTML5Parser", ["HTML5", "Parser"]],
    ["v2", ["v2"]],
    // `$` is a separator (and a JS identifier char)
    ["foo$bar", ["foo", "bar"]],
    ["$scope", ["scope"]],
    // unicode letters behave like letters
    ["getUserİD", ["get", "User", "İD"]],
    ["получитьПользователя", ["получить", "Пользователя"]],
    // separators only → no parts
    ["---", []],
    ["", []],
  ];

  for (const [input, expected] of cases) {
    test(`splitIdentifier(${JSON.stringify(input)})`, () => {
      expect(splitIdentifier(input)).toEqual(expected);
    });
  }
});

describe("extractIdTerms", () => {
  test("camelCase / snake_case / dotted all contribute raw + parts", () => {
    expect(extractIdTerms("user_id")).toBe("user_id user id");
    const out = extractIdTerms("function getUserName(session) { return session.user_id; }");
    expect(out).toContain("getusername get user name");
    // A dotted occurrence contributes its qualified raw form plus the same parts.
    expect(out).toContain("session.user_id session user id");
  });

  test("dotted paths are extracted as one compound identifier", () => {
    const out = extractIdTerms("const x = fs.readFile(p);");
    expect(out).toBe("fs.readfile fs read file");
  });

  test("single-word identifiers are skipped (the content leg already covers them)", () => {
    expect(extractIdTerms("const cache = new Map();")).toBe("");
  });

  test("repeated identifiers are deduplicated (first-seen order)", () => {
    const out = extractIdTerms("getUserName(a); getUserName(b); refreshCache();");
    expect(out).toBe("getusername get user name refreshcache refresh cache");
  });

  test("empty / no-compound content yields an empty string", () => {
    expect(extractIdTerms("")).toBe("");
    expect(extractIdTerms("plain prose only")).toBe("");
  });

  test("output is lowercase", () => {
    expect(extractIdTerms("SCREAMING_SNAKE_CASE")).toBe(
      "screaming_snake_case screaming snake case",
    );
  });

  test("minified input is capped at a term boundary", () => {
    // Each identifier yields exactly one `raw part part` group (3 tokens).
    const minified = Array.from({ length: 5000 }, (_, i) => `compoundIdentifier${i}`).join(";");
    const out = extractIdTerms(minified);
    expect(out.length).toBeLessThanOrEqual(MAX_ID_TERMS_CHARS);
    // Never cut mid-group: a whole number of groups fits, and the last token is
    // the final part of a complete identifier (not a partial word).
    const tokens = out.split(" ");
    expect(tokens.length % 3).toBe(0);
    expect(tokens[tokens.length - 1]).toMatch(/^identifier\d+$/);
  });

  test("a lone identifier longer than the whole budget is truncated", () => {
    const huge = `${"a".repeat(MAX_ID_TERMS_CHARS + 100)}B`;
    expect(extractIdTerms(huge).length).toBe(MAX_ID_TERMS_CHARS);
  });

  test("an explicit smaller cap is honored", () => {
    const out = extractIdTerms("getUserName refreshCache deleteUser", 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.startsWith("getusername")).toBe(true);
  });
});

describe("idTermsQueryParts / leg gate", () => {
  test("natural-language queries tokenize per word", () => {
    expect(idTermsQueryParts("update user name")).toEqual(["update", "user", "name"]);
  });

  test("an identifier-shaped query splits into its parts", () => {
    expect(idTermsQueryParts("getUserName")).toEqual(["get", "user", "name"]);
    expect(idTermsQueryParts("user_id")).toEqual(["user", "id"]);
  });

  test("punctuation-only words are dropped", () => {
    expect(idTermsQueryParts("refresh --all cache?")).toEqual(["refresh", "all", "cache"]);
  });

  test("empty query → no parts", () => {
    expect(idTermsQueryParts("")).toEqual([]);
    expect(idTermsQueryParts("   ")).toEqual([]);
  });

  test("the leg runs only with a column AND a ≥2-part query", () => {
    expect(wantIdTermsLeg("update user name", true)).toBe(true);
    expect(wantIdTermsLeg("update user name", false)).toBe(false);
    expect(wantIdTermsLeg("cache", true)).toBe(false);
    expect(wantIdTermsLeg("", true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LanceDB integration: the new column, and the byte-for-byte legacy invariant.
// ---------------------------------------------------------------------------

describe("id_terms column + legacy tables (LanceDB)", () => {
  let home: string;
  // Config is resolved at import time → set CIDX_HOME before loading the module.
  let db: typeof import("../src/services/db");

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cidx-idterms-"));
    process.env.CIDX_HOME = home;
    db = await import("../src/services/db");
    await db.initDB();
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.CIDX_HOME;
  });

  const DOC = "Returns the user name for a session.";
  const rows = (): CodeRecord[] => [
    {
      id: "s1.ts#0",
      filePath: "/p/s1.ts",
      content: "export function getUserName(session: Session) { return session.user_id; }",
      vector: [0.1, 0.2, 0.3, 0.4],
      language: "typescript",
      symbolName: "getUserName",
      symbolType: "function",
      startLine: 1,
      endLine: 1,
      doc: DOC,
      doc_vector: null,
      id_terms: "getusername get user name user_id user id session_id session id",
    },
    {
      id: "s2.ts#0",
      filePath: "/p/s2.ts",
      content: "export function refreshCache(store: Store) { store.flush(); }",
      vector: [0.4, 0.3, 0.2, 0.1],
      language: "typescript",
      symbolName: "refreshCache",
      symbolType: "function",
      startLine: 1,
      endLine: 1,
      doc: null,
      doc_vector: null,
      id_terms: "refreshcache refresh cache",
    },
  ];

  /** The same rows, pre-S1 style (the `id_terms` field was not written yet). */
  const legacyRows = (): CodeRecord[] =>
    rows().map(({ id_terms: _dropped, ...rest }) => {
      void _dropped;
      return rest;
    });

  test("a fresh table carries the id_terms column and searches it (BM25 leg)", async () => {
    const table = "idx_idterms_fresh";
    await db.insertChunks(table, rows());
    expect(await db.tableColumns(table)).toContain("id_terms");
    await db.ensureFtsIndex(table);

    // FTS over id_terms alone finds the compound-identifier row.
    const hits = await db.searchTableText(table, "user name", 5, undefined, ["id_terms"]);
    expect(hits.map((r) => r.symbolName)).toContain("getUserName");
    // ...and the leg is opt-in: the default text search stays content-only.
    const contentHits = await db.searchTableText(table, "flush", 5);
    expect(contentHits.map((r) => r.symbolName)).toEqual(["refreshCache"]);
    await db.dropTable(table);
  });

  test("ensureFtsIndex builds BM25 over id_terms as well", async () => {
    const table = "idx_idterms_fts";
    await db.insertChunks(table, rows());
    const built = await db.ensureFtsIndex(table);
    expect(built).toBe(3); // content + doc + id_terms
    // Second run is a no-op (already indexed).
    expect(await db.ensureFtsIndex(table)).toBe(0);
    await db.dropTable(table);
  });

  test("writes to a legacy table (no id_terms column) are stripped, not rejected", async () => {
    // Create the table pre-S1 style: same rows minus the id_terms field.
    const table = "idx_idterms_legacy";
    await db.insertChunks(table, legacyRows());
    expect(await db.tableColumns(table)).not.toContain("id_terms");
    // Now write S1-shaped records (carrying id_terms) into it — must not throw.
    await db.insertChunks(table, rows());
    expect(await db.countTableRows(table)).toBe(2);
    // Stored rows carry no id_terms field, and the column never appears.
    const stored = await db.searchTableText(table, "flush", 5);
    expect(stored[0]?.id_terms).toBeUndefined();
    expect(await db.tableColumns(table)).not.toContain("id_terms");
    await db.dropTable(table);
  });

  test("legacy table search results keep the exact pre-S1 shape", async () => {
    const table = "idx_idterms_legacy_shape";
    await db.insertChunks(table, legacyRows());
    expect(await db.tableColumns(table)).not.toContain("id_terms");
    await db.ensureFtsIndex(table);

    // Content-BM25 single leg: the row carries the pre-S1 column set only, with
    // its NATIVE BM25 metric (well above the RRF maximum of 1/60 → provably not
    // a rank-fused score) and no doc/identifier marker.
    const textOnly = await db.searchTableText(table, "flush", 5);
    expect(textOnly.map((r) => r.symbolName)).toEqual(["refreshCache"]);
    expect(textOnly[0]!._score).toBeGreaterThan(1 / 60);
    expect(textOnly[0]!._docHit).toBeUndefined();
    expect(textOnly[0]!.id_terms).toBeUndefined();

    // Vector single leg: native `_distance`, never an RRF `_score`.
    const vecOnly = await db.searchTable(table, [0.4, 0.3, 0.2, 0.1], 5);
    expect(vecOnly.length).toBe(2);
    for (const row of vecOnly) {
      expect(row._distance).toBeGreaterThanOrEqual(0);
      expect(row._score).toBeUndefined();
      expect(row.id_terms).toBeUndefined();
    }

    // The gate cannot turn the leg on for a table without the column.
    const cols = await db.tableColumns(table);
    expect(wantIdTermsLeg("user name", cols.has("id_terms"))).toBe(false);
    await db.dropTable(table);
  });
});
