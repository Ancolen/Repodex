/**
 * Per-project configuration (.cidx.json) tests.
 * Pure logic: parse/validate/read + the language allowlist + the extra ignore
 * patterns and the collectFiles language filter (fs fixture, no Ollama/LanceDB).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  parseProjectConfig,
  readProjectConfig,
  extToLanguage,
  languageAllowSet,
  PROJECT_CONFIG_FILE,
} from "../src/core/project-config";
import { buildIgnore, collectFiles, isPathIgnored } from "../src/services/indexer";

describe("parseProjectConfig — validation", () => {
  test("accepts a full valid config", () => {
    const cfg = parseProjectConfig(
      { languages: ["typescript", "gdscript"], ignore: ["vendor/**", "*.gen.ts"], embedModel: "qwen3-embedding:8b-q8_0" },
      ".cidx.json",
    );
    expect(cfg).toEqual({
      languages: ["typescript", "gdscript"],
      ignore: ["vendor/**", "*.gen.ts"],
      embedModel: "qwen3-embedding:8b-q8_0",
    });
  });

  test("invalid field values are dropped, valid ones kept", () => {
    const cfg = parseProjectConfig(
      { languages: ["typescript", 42], ignore: ["ok/"], embedModel: 7, extra: true },
      ".cidx.json",
    );
    expect(cfg).toEqual({ ignore: ["ok/"] });
  });

  test("non-object payloads are rejected entirely", () => {
    expect(parseProjectConfig(null, ".cidx.json")).toBeUndefined();
    expect(parseProjectConfig([1, 2], ".cidx.json")).toBeUndefined();
    expect(parseProjectConfig("nope", ".cidx.json")).toBeUndefined();
  });

  test("an object with no valid fields is undefined", () => {
    expect(parseProjectConfig({ embedModel: 3 }, ".cidx.json")).toBeUndefined();
  });
});

describe("readProjectConfig — file lookup", () => {
  test("absent file → undefined", () => {
    expect(readProjectConfig(tmpdir())).toBeUndefined();
  });

  test("valid file is parsed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cidx-projcfg-"));
    try {
      writeFileSync(join(dir, PROJECT_CONFIG_FILE), JSON.stringify({ languages: ["python"] }));
      expect(readProjectConfig(dir)).toEqual({ languages: ["python"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid JSON → undefined (warn, never throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cidx-projcfg-"));
    try {
      writeFileSync(join(dir, PROJECT_CONFIG_FILE), "{ not json");
      expect(readProjectConfig(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extToLanguage / languageAllowSet", () => {
  test("grammar + text-label extensions map, others undefined", () => {
    expect(extToLanguage(".ts")).toBe("typescript");
    expect(extToLanguage(".gd")).toBe("gdscript");
    expect(extToLanguage(".md")).toBe("markdown");
    expect(extToLanguage(".xml")).toBe("xml");
    expect(extToLanguage(".tscn")).toBeUndefined(); // unlabeled text format
    expect(extToLanguage(".txt")).toBeUndefined();
  });

  test("empty/missing languages → null filter", () => {
    expect(languageAllowSet(undefined)).toBeNull();
    expect(languageAllowSet({})).toBeNull();
    expect(languageAllowSet({ languages: [] })).toBeNull();
    expect(languageAllowSet({ languages: ["python"] })).toEqual(new Set(["python"]));
  });
});

describe("collectFiles with a language allowlist", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cidx-langfilter-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/app.ts"), "const x = 1;");
    writeFileSync(join(root, "src/util.py"), "x = 1");
    writeFileSync(join(root, "README.md"), "# doc");
    writeFileSync(join(root, "notes.txt"), "not allowed anyway");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("no filter → all allowed extensions", async () => {
    const ig = await buildIgnore(root);
    const files = await collectFiles(root, ig);
    const rel = files.map((f) => f.slice(root.length + 1)).sort();
    expect(rel).toEqual(["README.md", "src/app.ts", "src/util.py"]);
  });

  test("languages: ['typescript'] keeps only .ts", async () => {
    const ig = await buildIgnore(root);
    const files = await collectFiles(root, ig, null, new Set(["typescript"]));
    expect(files.map((f) => f.slice(root.length + 1))).toEqual(["src/app.ts"]);
  });

  test("languages: ['markdown'] keeps only labeled doc formats", async () => {
    const ig = await buildIgnore(root);
    const files = await collectFiles(root, ig, null, new Set(["markdown"]));
    expect(files.map((f) => f.slice(root.length + 1))).toEqual(["README.md"]);
  });
});

describe("buildIgnore with extra .cidx.json patterns", () => {
  test("extra patterns ignore matching paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "cidx-extraign-"));
    try {
      writeFileSync(join(root, "keep.ts"), "export const a = 1");
      writeFileSync(join(root, "gen.ts"), "export const b = 2");
      const igNoExtra = await buildIgnore(root);
      expect(isPathIgnored(igNoExtra, root, join(root, "gen.ts"))).toBe(false);

      // NOTE: the `ignore` package matches `*.gen.ts` only below a directory
      // (x.gen.ts), not the bare root name — same as .cidxignore/.gitignore via
      // this library. Use a literal name for the root-level file.
      const ig = await buildIgnore(root, ["gen.ts"]);
      expect(isPathIgnored(ig, root, join(root, "gen.ts"))).toBe(true);
      expect(isPathIgnored(ig, root, join(root, "keep.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});