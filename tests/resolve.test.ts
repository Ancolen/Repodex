/**
 * Resolution tests: import specs → indexed files. Pure logic (no I/O); builds a
 * FileIndex from a fixture list and asserts resolved paths / statuses. Verifies
 * the "never returns a non-indexed path" invariant and per-language strategies.
 */
import { test, expect, describe } from "bun:test";
import { buildFileIndex, resolveImports } from "../src/core/resolve";
import type { ImportSpec } from "../src/chunking/imports";

function spec(raw: string, language: ImportSpec["language"], kind: ImportSpec["kind"] = "relative", line = 1): ImportSpec {
  return { raw, language, line, kind };
}

describe("resolveImports — JS/TS", () => {
  const files = ["/proj/src/a.ts", "/proj/src/b.ts", "/proj/src/sub/index.ts", "/proj/src/c.mjs"];
  const index = buildFileIndex(files);

  test("relative resolves to extension variant", () => {
    const r = resolveImports([spec("./a", "typescript")], "/proj", index, "/proj/src/main.ts");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/proj/src/a.ts");
  });
  test("directory import resolves to index file", () => {
    const r = resolveImports([spec("./sub", "typescript")], "/proj", index, "/proj/src/main.ts");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/proj/src/sub/index.ts");
  });
  test("bare specifier is external (node_modules)", () => {
    const r = resolveImports([spec("react", "typescript", "external")], "/proj", index, "/proj/src/main.ts");
    expect(r[0]!.status).toBe("external");
    expect(r[0]!.reason).toBe("node_modules");
  });
  test("unresolved relative never invents a path", () => {
    const r = resolveImports([spec("./missing", "typescript")], "/proj", index, "/proj/src/main.ts");
    expect(r[0]!.status).toBe("unresolved");
    expect(r[0]!.resolvedPath).toBeUndefined();
  });
});

describe("resolveImports — Python", () => {
  const files = ["/proj/pkg/mod.py", "/proj/pkg/sub/__init__.py"];
  const index = buildFileIndex(files);

  test("bare module resolves to module file", () => {
    const r = resolveImports([spec("pkg.mod", "python", "external")], "/proj", index, "/proj/pkg/main.py");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/proj/pkg/mod.py");
  });
  test("package resolves to __init__.py", () => {
    const r = resolveImports([spec("pkg.sub", "python", "external")], "/proj", index, "/proj/pkg/main.py");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/proj/pkg/sub/__init__.py");
  });
  test("stdlib module is external", () => {
    const r = resolveImports([spec("os", "python", "external")], "/proj", index, "/proj/pkg/main.py");
    expect(r[0]!.status).toBe("external");
  });
});

describe("resolveImports — Rust", () => {
  const files = ["/proj/src/lib.rs", "/proj/src/m/mod.rs", "/proj/src/m/x.rs"];
  const index = buildFileIndex(files);

  test("crate-relative item resolves to its own file", () => {
    const r = resolveImports([spec("crate::m::x", "rust", "relative")], "/proj", index, "/proj/src/lib.rs");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/proj/src/m/x.rs");
  });
  test("module-only use resolves to mod.rs (peels the item)", () => {
    const r = resolveImports([spec("crate::m::Type", "rust", "relative")], "/proj", index, "/proj/src/lib.rs");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/proj/src/m/mod.rs");
  });
  test("external crate is external", () => {
    const r = resolveImports([spec("serde::Deserialize", "rust", "external")], "/proj", index, "/proj/src/lib.rs");
    expect(r[0]!.status).toBe("external");
  });
});

describe("resolveImports — C / C++", () => {
  const files = ["/proj/src/local.h", "/proj/include/other.h"];
  const index = buildFileIndex(files);

  test("local include resolves relative to importing dir", () => {
    const r = resolveImports([spec("local.h", "c", "relative")], "/proj", index, "/proj/src/main.c");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/proj/src/local.h");
  });
  test("system include is external", () => {
    const r = resolveImports([spec("stdio.h", "c", "system")], "/proj", index, "/proj/src/main.c");
    expect(r[0]!.status).toBe("external");
    expect(r[0]!.reason).toBe("system header");
  });
});

describe("resolveImports — GDScript", () => {
  const files = ["/g/scripts/character.gd", "/g/scripts/player.gd", "/g/scripts/base.gd", "/g/ui/hud.gd"];
  const index = buildFileIndex(files);

  test("res:// resolves against the project root", () => {
    const r = resolveImports([spec("res://scripts/character.gd", "gdscript")], "/g", index, "/g/scripts/player.gd");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/g/scripts/character.gd");
  });
  test("extension may be omitted (.gd appended)", () => {
    const r = resolveImports([spec("res://scripts/base", "gdscript")], "/g", index, "/g/scripts/player.gd");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/g/scripts/base.gd");
  });
  test("bare relative path resolves against the importing file's dir", () => {
    const r = resolveImports([spec("./character.gd", "gdscript")], "/g", index, "/g/scripts/player.gd");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/g/scripts/character.gd");
  });
  test("missing target never invents a path", () => {
    const r = resolveImports([spec("res://missing.gd", "gdscript")], "/g", index, "/g/scripts/player.gd");
    expect(r[0]!.status).toBe("unresolved");
    expect(r[0]!.resolvedPath).toBeUndefined();
  });
  test("suffix fallback when the res:// prefix differs from the indexed root", () => {
    const r = resolveImports([spec("res://ui/hud.gd", "gdscript")], "/godot-proj", index, "/g/scripts/player.gd");
    expect(r[0]!.status).toBe("resolved");
    expect(r[0]!.resolvedPath).toBe("/g/ui/hud.gd");
    expect(r[0]!.reason).toBe("suffix");
  });
});

describe("resolveImports — invariants", () => {
  test("a resolved path is always a member of the indexed set", () => {
    const files = ["/proj/a.ts", "/proj/b.ts"];
    const index = buildFileIndex(files);
    const specs = [spec("./a", "typescript"), spec("./b", "typescript"), spec("./nope", "typescript")];
    const r = resolveImports(specs, "/proj", index, "/proj/main.ts");
    for (const dep of r) {
      if (dep.status === "resolved") expect(files).toContain(dep.resolvedPath);
      else expect(dep.resolvedPath).toBeUndefined();
    }
  });
});
