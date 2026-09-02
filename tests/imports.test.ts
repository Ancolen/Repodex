/**
 * Import-extraction tests: one fixture per grammar, verifying the raw specifier,
 * kind, and (where relevant) imported names parsed out of the real AST.
 * These exercise the tree-sitter grammars (no Ollama, no LanceDB).
 */
import { test, expect, describe } from "bun:test";
import { extractImports } from "../src/chunking/imports";

const jsSample = [
  'import { foo, bar } from "./a";',
  'import "./side";',
  'import React from "react";',
  'import * as ns from "../pkg/b";',
].join("\n");

describe("extractImports — JS/TS", () => {
  test("JS named, side-effect, default, namespace", async () => {
    const specs = await extractImports("test.js", jsSample);
    expect(specs.map((s) => s.raw)).toEqual(["./a", "./side", "react", "../pkg/b"]);
    expect(specs.map((s) => s.kind)).toEqual(["relative", "relative", "external", "relative"]);
  });
  test("TSX shares the import grammar", async () => {
    const specs = await extractImports("c.tsx", 'import { X } from "./c";');
    expect(specs[0]!.raw).toBe("./c");
    expect(specs[0]!.language).toBe("tsx");
  });
});

describe("extractImports — Python", () => {
  test("bare import is external; from-import captures module + names", async () => {
    const specs = await extractImports("m.py", ['import os', 'from a.b import c, d', 'from . import e', 'from ..pkg import f'].join("\n"));
    const byRaw = Object.fromEntries(specs.map((s) => [s.raw, s]));
    expect(byRaw["os"].kind).toBe("external");
    expect(byRaw["a.b"].kind).toBe("external");
    expect(byRaw["a.b"].names).toEqual(["c", "d"]);
    expect(byRaw["."].kind).toBe("relative"); // "from . import e"
    expect(byRaw["..pkg"].kind).toBe("relative"); // "from ..pkg import f"
  });
});

describe("extractImports — Go", () => {
  test("single import and import block both yield one spec per path", async () => {
    const specs = await extractImports("main.go", ['package main', 'import "fmt"', 'import (', '  "os"', '  "github.com/x/y"', ')'].join("\n"));
    const raws = specs.map((s) => s.raw).sort();
    expect(raws).toEqual(["fmt", "github.com/x/y", "os"].sort());
    expect(specs.every((s) => s.kind === "external")).toBe(true);
  });
});

describe("extractImports — Rust", () => {
  test("external crate, crate-relative, and brace-list forms", async () => {
    const specs = await extractImports("lib.rs", ['use std::io;', 'use crate::m::X;', 'use a::{b, c};', 'use super::y;'].join("\n"));
    const byRaw = Object.fromEntries(specs.map((s) => [s.raw, s]));
    expect(byRaw["std::io"].kind).toBe("external");
    expect(byRaw["crate::m::X"].kind).toBe("relative");
    expect(byRaw["super::y"].kind).toBe("relative");
    expect(byRaw["a"].names).toEqual(["b", "c"]);
  });
});

describe("extractImports — Java", () => {
  test("dotted package path reconstructed", async () => {
    const specs = await extractImports("A.java", 'import com.foo.Bar;\nimport static com.foo.Baz.qux;');
    expect(specs.map((s) => s.raw)).toEqual(["com.foo.Bar", "com.foo.Baz.qux"]);
  });
});

describe("extractImports — C / C++", () => {
  test("system vs local include", async () => {
    const c = await extractImports("main.c", '#include <stdio.h>\n#include "local.h"');
    const byRaw = Object.fromEntries(c.map((s) => [s.raw, s]));
    expect(byRaw["stdio.h"].kind).toBe("system");
    expect(byRaw["local.h"].kind).toBe("relative");
  });
});

describe("extractImports — C#", () => {
  test("using directive dotted path", async () => {
    const specs = await extractImports("P.cs", 'using System.IO;\nusing static System.Math;');
    expect(specs.map((s) => s.raw)).toEqual(["System.IO", "System.Math"]);
  });
});

describe("extractImports — Ruby", () => {
  test("require_relative is relative; require is external", async () => {
    const specs = await extractImports("app.rb", ['require_relative "helper"', 'require "json"', 'load "x.rb"'].join("\n"));
    const byRaw = Object.fromEntries(specs.map((s) => [s.raw, s]));
    expect(byRaw["helper"].kind).toBe("relative");
    expect(byRaw["json"].kind).toBe("external");
    expect(byRaw["x.rb"].kind).toBe("external");
  });
});

describe("extractImports — PHP", () => {
  test("require_once string + namespace use", async () => {
    const specs = await extractImports("index.php", ['<?php', 'require_once __DIR__ . "/lib.php";', 'use App\\Service;'].join("\n"));
    const raws = specs.map((s) => s.raw);
    expect(raws).toContain("/lib.php");
    expect(raws).toContain("App\\Service");
  });
});

describe("extractImports — Kotlin / Swift / Scala", () => {
  test("Kotlin import_header", async () => {
    const specs = await extractImports("M.kt", 'import com.foo.Bar');
    expect(specs.map((s) => s.raw)).toEqual(["com.foo.Bar"]);
  });
  test("Swift import_declaration", async () => {
    const specs = await extractImports("S.swift", 'import Foundation');
    expect(specs.map((s) => s.raw)).toEqual(["Foundation"]);
  });
  test("Scala import_declaration", async () => {
    const specs = await extractImports("X.scala", 'import scala.collection.mutable');
    expect(specs.map((s) => s.raw)).toEqual(["scala.collection.mutable"]);
  });
});

describe("extractImports — GDScript", () => {
  test("extends file path, preload const, onready preload, bare load", async () => {
    const src = [
      'extends "res://scripts/character.gd"',
      "",
      "const CharScene = preload(\"res://scripts/character.gd\")",
      "@onready var sprite = preload(\"res://ui/sprite.gd\")",
      "var cfg = load(\"res://settings.gd\")",
    ].join("\n");
    const specs = await extractImports("player.gd", src);
    const byRaw = Object.fromEntries(specs.map((s) => [s.raw, s]));
    expect(byRaw["res://scripts/character.gd"].kind).toBe("relative");
    expect(byRaw["res://ui/sprite.gd"].kind).toBe("relative");
    expect(byRaw["res://settings.gd"].kind).toBe("relative");
    expect(specs.every((s) => s.language === "gdscript")).toBe(true);
  });
  test("engine class extends and uid:// preload yield nothing", async () => {
    const src = [
      "extends Node2D",
      "const X = preload(\"uid://c1doicxmq8skp\")",
    ].join("\n");
    const specs = await extractImports("npc.gd", src);
    expect(specs).toEqual([]);
  });
  test("preload inside a function body is not collected (top-level scan only)", async () => {
    const src = ["func f():", "\tvar x = preload(\"res://inside.gd\")"].join("\n");
    const specs = await extractImports("inner.gd", src);
    expect(specs).toEqual([]);
  });
});

describe("extractImports — edge cases", () => {
  test("unknown extension / empty content returns []", async () => {
    expect(await extractImports("readme.md", "import x")).toEqual([]);
    expect(await extractImports("a.ts", "   ")).toEqual([]);
  });
  test("file with no imports returns []", async () => {
    const specs = await extractImports("a.ts", "function f() { return 1; }");
    expect(specs).toEqual([]);
  });
});
