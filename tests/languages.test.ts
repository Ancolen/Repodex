/**
 * Multi-language AST chunking tests.
 *
 * This suite does two things:
 *  1) Strictly verifies symbol extraction in fully supported languages
 *     (Python, Rust, Java, PHP, JS, TS, TSX, Go).
 *  2) Clearly documents known LIMITATIONS (C# namespaces, C/C++ function names, Ruby).
 *     These tests lock down current behavior as a "regression lock"; if the behavior
 *     improves (e.g. drilling down C# namespaces) these tests should be updated.
 *     Limitation test headers carry a [LIMITATION] tag.
 */
import { test, expect, describe } from "bun:test";
import { chunkCode } from "../src/chunking/chunker";

function symbolsOf(chunks: { symbolName?: string; symbolType?: string }[]): string[] {
  return chunks.filter((c) => c.symbolName).map((c) => `${c.symbolType}:${c.symbolName}`);
}

describe("multi-language chunking — fully supported languages", () => {
  test("Python: function + class named, language tag 'python'", async () => {
    const src = `import os

def greet(name):
    return f"hi {name}"

class Animal:
    def speak(self):
        return "noise"
`;
    const chunks = await chunkCode("svc.py", src);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.language === "python")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("function:greet");
    expect(syms).toContain("class:Animal");
  });

  test("Go: function and method named", async () => {
    const src = `package main

import "fmt"

func NewServer(a string) *Server { return &Server{} }

func (s *Server) Run() error {
	fmt.Println(s)
	return nil
}
`;
    const chunks = await chunkCode("main.go", src);
    expect(chunks.every((c) => c.language === "go")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("function:NewServer");
    expect(syms).toContain("method:Run");
  });

  test("Rust: struct/impl/trait/function named", async () => {
    const src = `pub struct Point { pub x: i32 }

impl Point {
    pub fn new(x: i32) -> Self { Point { x } }
}

pub fn add(a: i32, b: i32) -> i32 { a + b }

trait Shape { fn area(&self) -> f64; }
`;
    const chunks = await chunkCode("lib.rs", src);
    expect(chunks.every((c) => c.language === "rust")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("struct:Point");
    expect(syms).toContain("impl:Point");
    expect(syms).toContain("function:add");
    expect(syms).toContain("trait:Shape");
  });

  test("Java: class and interface named (with package header)", async () => {
    const src = `package demo;

public class Calculator {
    public int add(int a, int b) { return a + b; }
}

interface Greeter { String greet(String n); }
`;
    const chunks = await chunkCode("Calculator.java", src);
    expect(chunks.every((c) => c.language === "java")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("class:Calculator");
    expect(syms).toContain("interface:Greeter");
  });

  test("PHP: function and class named", async () => {
    const src = `<?php
function greet($name) { return "hi $name"; }

class Animal {
    public function speak() { return "noise"; }
}
`;
    const chunks = await chunkCode("svc.php", src);
    expect(chunks.every((c) => c.language === "php")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("function:greet");
    expect(syms).toContain("class:Animal");
  });

  test("JavaScript: export function/class (export wrapper stripped)", async () => {
    const src = `export function greet(name) { return "hi " + name; }

export class Animal { speak() { return "noise"; } }
`;
    const chunks = await chunkCode("svc.js", src);
    expect(chunks.every((c) => c.language === "javascript")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("function:greet");
    expect(syms).toContain("class:Animal");
  });

  test("TSX: component function and class named", async () => {
    const src = `import React from "react";

export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}

export class Panel extends React.Component {
  render() { return <div />; }
}
`;
    const chunks = await chunkCode("Button.tsx", src);
    expect(chunks.every((c) => c.language === "tsx")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("function:Button");
    expect(syms).toContain("class:Panel");
  });

  test(".mjs/.cjs/.cts/.mts extensions also map to correct language", async () => {
    const mjs = await chunkCode("a.mjs", `export function f() { return 1; }`);
    expect(mjs.some((c) => c.symbolName === "f")).toBe(true);
    const mts = await chunkCode("a.mts", `export function g(): number { return 1; }`);
    expect(mts.some((c) => c.symbolName === "g")).toBe(true);
  });
});

describe("multi-language chunking — C#, C, C++, Ruby full support", () => {
  test("C#: class/interface/record/struct/enum inside namespace are named", async () => {
    const src = `using System;

namespace Demo.Sub {
    public class Calculator {
        public int Add(int a, int b) { return a + b; }
    }
    public interface IGreeter { string Greet(string n); }
    public record Point(int X, int Y);
    public struct Vec { public int X; }
    public enum Color { Red, Green }
}
`;
    const chunks = await chunkCode("Calc.cs", src);
    expect(chunks.every((c) => c.language === "c_sharp")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("class:Calculator");
    expect(syms).toContain("interface:IGreeter");
    expect(syms).toContain("class:Point"); // record
    expect(syms).toContain("struct:Vec");
    expect(syms).toContain("enum:Color");
  });

  test("C#: file-scoped namespace content also named", async () => {
    const src = `namespace Demo;

public class Service {
    public void Run() {}
}
`;
    const syms = symbolsOf(await chunkCode("Svc.cs", src));
    expect(syms).toContain("class:Service");
  });

  test("C: free functions and struct are named", async () => {
    const src = `#include <stdio.h>

int add(int a, int b) { return a + b; }

void greet(const char *n) { printf("%s", n); }

struct Pt { int x; };
`;
    const chunks = await chunkCode("util.c", src);
    expect(chunks.every((c) => c.language === "c")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("function:add");
    expect(syms).toContain("function:greet");
    expect(syms).toContain("struct:Pt");
  });

  test("C++: class, free function, and template function inside namespace are named", async () => {
    const src = `namespace ns {
class Widget {
public:
    int value() const { return v_; }
private:
    int v_ = 0;
};

int add(int a, int b) { return a + b; }

template<typename T> T identity(T x) { return x; }
}
`;
    const chunks = await chunkCode("widget.cpp", src);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("class:Widget");
    expect(syms).toContain("function:add");
    expect(syms).toContain("function:identity");
  });

  test("Ruby: top-level def, class, and module content are named", async () => {
    const src = `def greet(name)
  "hi #{name}"
end

class Animal
  def speak
    "noise"
  end
end

module Helpers
  def helper; end
end
`;
    const chunks = await chunkCode("svc.rb", src);
    expect(chunks.every((c) => c.language === "ruby")).toBe(true);
    const syms = symbolsOf(chunks);
    // In Ruby, since all `def`s have the node type 'method', their symbolType is 'method'.
    expect(syms).toContain("method:greet");
    expect(syms).toContain("class:Animal");
    expect(syms).toContain("method:helper"); // drills down to method inside module
  });

  test("Go: struct and interface types also named", async () => {
    const src = `package main

type Server struct { Addr string }
type Stringer interface { String() string }

func NewServer() *Server { return nil }
`;
    const syms = symbolsOf(await chunkCode("srv.go", src));
    expect(syms).toContain("struct:Server");
    expect(syms).toContain("interface:Stringer");
    expect(syms).toContain("function:NewServer");
  });

  test("Rust: drills down to function inside mod; TS namespace content is named", async () => {
    const rs = symbolsOf(await chunkCode("m.rs", `mod inner { pub fn helper() {} }\npub fn top() {}`));
    expect(rs).toContain("function:helper");
    expect(rs).toContain("function:top");

    const ts = symbolsOf(
      await chunkCode("n.ts", `export namespace Outer {\n  export function inner() {}\n  export class Thing {}\n}`),
    );
    expect(ts).toContain("function:inner");
    expect(ts).toContain("class:Thing");
  });
});

describe("multi-language chunking — Kotlin / Swift / Scala", () => {
  test("Kotlin: class, interface, object and top-level fun are named", async () => {
    const src = `package demo

class Calculator {
    fun add(a: Int, b: Int): Int { return a + b }
}

interface Greeter { fun greet(n: String): String }

object Singleton { fun run() {} }

fun topLevel() {}
`;
    const chunks = await chunkCode("Calc.kt", src);
    expect(chunks.every((c) => c.language === "kotlin")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("class:Calculator");
    expect(syms).toContain("class:Greeter"); // Kotlin interface is class_declaration → class
    expect(syms).toContain("class:Singleton");
    expect(syms).toContain("function:topLevel");
  });

  test(".kts extension also maps to kotlin", async () => {
    const syms = symbolsOf(await chunkCode("build.kts", `fun configure() {}`));
    expect(syms).toContain("function:configure");
  });

  test("Swift: class, protocol, struct and free function are named", async () => {
    const src = `import Foundation

class Calculator {
    func add(a: Int, b: Int) -> Int { return a + b }
}

protocol Greeter { func greet(n: String) -> String }

struct Point { var x: Int }

func topLevel() {}
`;
    const chunks = await chunkCode("Calc.swift", src);
    expect(chunks.every((c) => c.language === "swift")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("class:Calculator");
    expect(syms).toContain("interface:Greeter"); // protocol → interface
    expect(syms).toContain("function:topLevel");
  });

  test("Scala: class, trait and object are named", async () => {
    const src = `package demo

class Calculator {
  def add(a: Int, b: Int): Int = a + b
}

trait Greeter { def greet(n: String): String }

object Main { def run(): Unit = {} }
`;
    const chunks = await chunkCode("Calc.scala", src);
    expect(chunks.every((c) => c.language === "scala")).toBe(true);
    const syms = symbolsOf(chunks);
    expect(syms).toContain("class:Calculator");
    expect(syms).toContain("trait:Greeter");
    expect(syms).toContain("class:Main"); // object → class
  });
});
