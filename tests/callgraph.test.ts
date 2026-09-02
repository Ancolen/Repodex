/**
 * Call-graph tests: pure-logic coverage of `buildCallEdges` (the caller→callee
 * adjacency, same definition-rule as `countReferences`) and `traverseCallGraph`
 * (depth bounding, cycle safety, node-budget truncation). No Ollama, no LanceDB.
 */
import { test, expect, describe } from "bun:test";
import { buildCallEdges, traverseCallGraph, matchRootSymbols, type CallSymbol, type CallChunk } from "../src/core/callgraph";
import { matchNamesFor } from "../src/core/deadcode";

const ROOT = "/repo";

function sym(
  symbolName: string,
  filePath: string,
  declLine: number,
  opts?: { type?: string; endLine?: number; content?: string },
): CallSymbol {
  const s: CallSymbol = {
    key: `${symbolName}\0${filePath}`,
    symbolName,
    symbolType: opts?.type ?? "function",
    matchNames: matchNamesFor(symbolName),
    filePath,
    declarationLine: declLine,
    endLine: opts?.endLine ?? declLine,
  };
  if (opts?.content) s.content = opts.content;
  return s;
}
function body(symbolName: string, filePath: string, startLine: number, content: string): CallChunk {
  return { callerKey: `${symbolName}\0${filePath}`, filePath, startLine, content };
}
function metaOf(symbols: CallSymbol[]): Map<string, CallSymbol> {
  const m = new Map<string, CallSymbol>();
  for (const s of symbols) m.set(s.key, s);
  return m;
}

describe("buildCallEdges — caller→callee adjacency", () => {
  test("A calls B → forward A→B and reverse B→A", () => {
    const symbols = [sym("a", "/x.ts", 1), sym("b", "/x.ts", 10)];
    const chunks = [
      body("a", "/x.ts", 1, "function a() {\n  b();\n}"),
      body("b", "/x.ts", 10, "function b() {}"),
    ];
    const { forward, reverse } = buildCallEdges(symbols, chunks);
    expect(forward.get("a\0/x.ts")?.has("b\0/x.ts")).toBe(true);
    expect(forward.get("b\0/x.ts")).toBeUndefined();
    expect(reverse.get("b\0/x.ts")?.has("a\0/x.ts")).toBe(true);
  });

  test("the declaration line is not a self-edge", () => {
    const symbols = [sym("a", "/x.ts", 1)];
    // `a` only appears on its own declaration line → no edges.
    const chunks = [body("a", "/x.ts", 1, "function a() {}")];
    const { forward } = buildCallEdges(symbols, chunks);
    expect(forward.get("a\0/x.ts")).toBeUndefined();
  });

  test("a recursive call in the body IS a self-edge", () => {
    const symbols = [sym("fact", "/x.ts", 1)];
    const chunks = [
      body("fact", "/x.ts", 1, ["function fact(n) {", "  if (n <= 1) return 1;", "  return n * fact(n - 1);", "}"].join("\n")),
    ];
    const { forward } = buildCallEdges(symbols, chunks);
    expect(forward.get("fact\0/x.ts")?.has("fact\0/x.ts")).toBe(true);
  });

  test("dotted Class.method matches the bare segment when called on an instance", () => {
    const symbols = [sym("Foo.bar", "/x.ts", 1, { type: "method" })];
    const chunks = [body("use", "/y.ts", 1, "const f = new Foo(); f.bar();")];
    const { forward } = buildCallEdges(symbols, chunks);
    expect(forward.get("use\0/y.ts")?.has("Foo.bar\0/x.ts")).toBe(true);
  });

  test("a function split across chunks is scanned in full", () => {
    const symbols = [sym("big", "/x.ts", 1), sym("helper", "/x.ts", 10)];
    const chunks = [
      body("big", "/x.ts", 1, "function big() {\n  // part 1\n"), // no call here
      body("big", "/x.ts", 4, "  helper();\n}"), // call in the continuation chunk
      body("helper", "/x.ts", 10, "function helper() {}"),
    ];
    const { forward } = buildCallEdges(symbols, chunks);
    expect(forward.get("big\0/x.ts")?.has("helper\0/x.ts")).toBe(true);
  });

  test("a call to a name NOT in the inventory yields no edge (in-index callables only)", () => {
    // `externalLib` is called but never defined as an inventory symbol → no edge.
    const symbols = [sym("a", "/x.ts", 1)];
    const chunks = [body("a", "/x.ts", 1, "function a() {\n  externalLib();\n}")];
    const { forward } = buildCallEdges(symbols, chunks);
    expect(forward.get("a\0/x.ts")).toBeUndefined();
  });

  test("empty inputs → empty maps", () => {
    const { forward, reverse } = buildCallEdges([], []);
    expect(forward.size).toBe(0);
    expect(reverse.size).toBe(0);
  });
});

describe("traverseCallGraph — depth, cycles, budget", () => {
  // Chain a → b → c (forward).
  const chain = (): { symbols: CallSymbol[]; chunks: CallChunk[] } => ({
    symbols: [sym("a", "/x.ts", 1), sym("b", "/x.ts", 10), sym("c", "/x.ts", 20)],
    chunks: [
      body("a", "/x.ts", 1, "function a() {\n  b();\n}"),
      body("b", "/x.ts", 10, "function b() {\n  c();\n}"),
      body("c", "/x.ts", 20, "function c() {}"),
    ],
  });

  test("depth 0 → roots only", () => {
    const { symbols, chunks } = chain();
    const { forward } = buildCallEdges(symbols, chunks);
    const { nodes } = traverseCallGraph(["a\0/x.ts"], forward, metaOf(symbols), ROOT, 0, 100);
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.symbol).toBe("a");
    expect(nodes[0]!.children.length).toBe(0);
  });

  test("depth 1 → one level of callees", () => {
    const { symbols, chunks } = chain();
    const { forward } = buildCallEdges(symbols, chunks);
    const { nodes } = traverseCallGraph(["a\0/x.ts"], forward, metaOf(symbols), ROOT, 1, 100);
    expect(nodes[0]!.children.length).toBe(1);
    expect(nodes[0]!.children[0]!.symbol).toBe("b");
    expect(nodes[0]!.children[0]!.children.length).toBe(0); // depth 1 stops here
  });

  test("depth 2 → two levels", () => {
    const { symbols, chunks } = chain();
    const { forward } = buildCallEdges(symbols, chunks);
    const { nodes } = traverseCallGraph(["a\0/x.ts"], forward, metaOf(symbols), ROOT, 2, 100);
    const b = nodes[0]!.children[0]!;
    expect(b.symbol).toBe("b");
    expect(b.children.length).toBe(1);
    expect(b.children[0]!.symbol).toBe("c");
  });

  test("a cycle is shown as a cyclic leaf, not expanded", () => {
    const symbols = [sym("a", "/x.ts", 1), sym("b", "/x.ts", 10)];
    const chunks = [
      body("a", "/x.ts", 1, "function a() {\n  b();\n}"),
      body("b", "/x.ts", 10, "function b() {\n  a();\n}"),
    ];
    const { forward } = buildCallEdges(symbols, chunks);
    const { nodes } = traverseCallGraph(["a\0/x.ts"], forward, metaOf(symbols), ROOT, 10, 100);
    const b = nodes[0]!.children[0]!;
    expect(b.symbol).toBe("b");
    expect(b.children.length).toBe(1);
    expect(b.children[0]!.symbol).toBe("a");
    expect(b.children[0]!.cyclic).toBe(true);
  });

  test("a node reachable via two paths appears under each (a tree, not a DAG)", () => {
    // a → b → d, a → c → d (diamond).
    const symbols = [sym("a", "/x.ts", 1), sym("b", "/x.ts", 10), sym("c", "/x.ts", 20), sym("d", "/x.ts", 30)];
    const chunks = [
      body("a", "/x.ts", 1, "b(); c();"),
      body("b", "/x.ts", 10, "d();"),
      body("c", "/x.ts", 20, "d();"),
      body("d", "/x.ts", 30, ""),
    ];
    const { forward } = buildCallEdges(symbols, chunks);
    const { nodes } = traverseCallGraph(["a\0/x.ts"], forward, metaOf(symbols), ROOT, 5, 100);
    const a = nodes[0]!;
    expect(a.children.map((n) => n.symbol).sort()).toEqual(["b", "c"]);
    const dCount = a.children.filter((n) => n.children.some((c) => c.symbol === "d")).length;
    expect(dCount).toBe(2); // d appears under both b and c
  });

  test("hitting the node budget sets truncated", () => {
    const { symbols, chunks } = chain();
    const { forward } = buildCallEdges(symbols, chunks);
    const { truncated } = traverseCallGraph(["a\0/x.ts"], forward, metaOf(symbols), ROOT, 10, 2);
    expect(truncated).toBe(true);
  });

  test("reverse adjacency → callers tree", () => {
    const { symbols, chunks } = chain();
    const { reverse } = buildCallEdges(symbols, chunks);
    // Who calls c? b. Who calls b? a.
    const { nodes } = traverseCallGraph(["c\0/x.ts"], reverse, metaOf(symbols), ROOT, 5, 100);
    const c = nodes[0]!;
    expect(c.children[0]!.symbol).toBe("b");
    expect(c.children[0]!.children[0]!.symbol).toBe("a");
  });
});

describe("matchRootSymbols — anchor resolution (mirrors find_symbol)", () => {
  // nameToSymbols: symbolName → CallSymbol[] (as built by buildCallGraph).
  function nameMapOf(symbols: CallSymbol[]): Map<string, CallSymbol[]> {
    const m = new Map<string, CallSymbol[]>();
    for (const s of symbols) {
      const arr = m.get(s.symbolName) ?? [];
      arr.push(s);
      m.set(s.symbolName, arr);
    }
    return m;
  }

  test("a bare method name resolves to its Class.method form", () => {
    const symbols = [
      sym("IndexManager.getDependencies", "/m.ts", 10, { type: "method" }),
      sym("searchIndex", "/s.ts", 1),
    ];
    const matched = matchRootSymbols(nameMapOf(symbols), "getDependencies");
    expect(matched.length).toBe(1);
    expect(matched[0]!.symbolName).toBe("IndexManager.getDependencies");
  });

  test("exact + prefix still work for non-dotted names", () => {
    const symbols = [sym("searchIndex", "/s.ts", 1), sym("searchIndexAll", "/s.ts", 5)];
    const matched = matchRootSymbols(nameMapOf(symbols), "searchIndex");
    // exact (searchIndex) + prefix (searchIndexAll) both match.
    expect(matched.map((s) => s.symbolName).sort()).toEqual(["searchIndex", "searchIndexAll"]);
  });

  test("a nested qualified name resolves via the dotted-substring clause", () => {
    const symbols = [sym("Outer.Inner.run", "/o.ts", 1, { type: "method" })];
    const matched = matchRootSymbols(nameMapOf(symbols), "run");
    expect(matched[0]!.symbolName).toBe("Outer.Inner.run");
  });

  test("same name in two files returns both, deduped by key", () => {
    const symbols = [sym("foo", "/a.ts", 1), sym("foo", "/b.ts", 1)];
    const matched = matchRootSymbols(nameMapOf(symbols), "foo");
    expect(matched.length).toBe(2);
    expect(new Set(matched.map((s) => s.filePath))).toEqual(new Set(["/a.ts", "/b.ts"]));
  });

  test("empty query + no match return []", () => {
    const symbols = [sym("foo", "/a.ts", 1)];
    expect(matchRootSymbols(nameMapOf(symbols), "")).toEqual([]);
    expect(matchRootSymbols(nameMapOf(symbols), "nope")).toEqual([]);
  });
});
