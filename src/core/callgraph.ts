/**
 * Call-graph analysis — pure helpers, no I/O and no LanceDB.
 *
 * Sibling of `deadcode.ts`. Where `countReferences` produces a flat per-symbol
 * reference COUNT (and loses who the caller was), `buildCallEdges` produces a
 * caller→callee ADJACENCY. It reuses the identical whole-identifier scan and the
 * same "definition rule", so the call graph inherits the same discipline:
 *
 *  - An occurrence of callee C's identifier inside caller A's body is an edge
 *    A→C, EXCEPT when that occurrence sits on C's exact declaration line in that
 *    file — so a recursive call in the body is still a real self-edge, while the
 *    declaration itself is not.
 *  - Identical names across files/scopes are indistinguishable (pragmatic
 *    whole-identifier matching, not full LSP) — see `find_references`.
 *
 * `traverseCallGraph` turns the adjacency into a bounded, cycle-safe tree from a
 * set of roots — the "call stack / roadmap" for a symbol. The engine
 * (`IndexManager.getCallGraph`) composes these.
 */
import path from "node:path";
import { buildNameRegex, matchNamesFor, NAME_REGEX_CAP } from "./deadcode";
import { deriveSignature } from "../utils/text";

/** A callable symbol in the inventory (deduped per name+file). */
export interface CallSymbol {
  /** Unique id: `${symbolName}\0${filePath}`. */
  key: string;
  symbolName: string;
  symbolType: string;
  /** Identifiers that count as a reference to this symbol (from `matchNamesFor`). */
  matchNames: string[];
  filePath: string;
  /** 1-based declaration line. */
  declarationLine: number;
  endLine: number;
  language?: string;
  /** Body content (longest chunk) — used to derive the node signature. */
  content?: string;
}

/** One callable chunk body to scan for outgoing calls. */
export interface CallChunk {
  /** The caller this body belongs to (`${symbolName}\0${filePath}`). */
  callerKey: string;
  filePath: string;
  startLine: number;
  content: string;
}

/** A node in the call tree. */
export interface CallGraphNode {
  key: string;
  symbol: string;
  symbolType: string;
  file: string;
  relativeFile: string;
  startLine: number;
  endLine: number;
  /** 0 for a root, increasing with depth. */
  depth: number;
  children: CallGraphNode[];
  /** True when this edge closes a cycle (shown but not expanded). */
  cyclic?: boolean;
  language?: string;
  signature?: string;
}

export interface CallEdges {
  /** callerKey → set of calleeKeys. */
  forward: Map<string, Set<string>>;
  /** calleeKey → set of callerKeys. */
  reverse: Map<string, Set<string>>;
}

/**
 * Build a caller→callee adjacency in one pass over callable chunk bodies. Mirrors
 * `countReferences`, but emits edges instead of a flat counter. The definition
 * rule (skip an occurrence on the matched name's declaration line in that file)
 * keeps declarations from becoming self-edges while preserving recursion.
 */
export function buildCallEdges(symbols: CallSymbol[], chunks: CallChunk[]): CallEdges {
  const forward = new Map<string, Set<string>>();
  const nameToKeys = new Map<string, Set<string>>(); // identifier → callee keys
  const defLookup = new Map<string, Map<string, Set<number>>>(); // name → file → decl lines
  for (const s of symbols) {
    for (const name of s.matchNames) {
      if (!name) continue;
      let keys = nameToKeys.get(name);
      if (!keys) {
        keys = new Set();
        nameToKeys.set(name, keys);
      }
      keys.add(s.key);
      let perFile = defLookup.get(name);
      if (!perFile) {
        perFile = new Map();
        defLookup.set(name, perFile);
      }
      let lines = perFile.get(s.filePath);
      if (!lines) {
        lines = new Set();
        perFile.set(s.filePath, lines);
      }
      lines.add(s.declarationLine);
    }
  }

  // Scan in name-GROUPS so no single combined regex exceeds NAME_REGEX_CAP. The
  // def-index is GLOBAL (built from every symbol), so the declaration-line
  // exclusion stays correct across groups.
  const allNames = [...nameToKeys.keys()];
  for (let gi = 0; gi < allNames.length; gi += NAME_REGEX_CAP) {
    const re = buildNameRegex(allNames.slice(gi, gi + NAME_REGEX_CAP));
    if (!re) continue;
    for (const chunk of chunks) {
      if (!chunk.content) continue;
      const lines = chunk.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const matched = m[1]!;
          const absLine = chunk.startLine + i;
          const defLines = defLookup.get(matched)?.get(chunk.filePath);
          if (defLines && defLines.has(absLine)) {
            // Declaration line for this name in this file → not a call.
            if (m.index === re.lastIndex) re.lastIndex++;
            continue;
          }
          const keys = nameToKeys.get(matched);
          if (keys) {
            let out = forward.get(chunk.callerKey);
            if (!out) {
              out = new Set();
              forward.set(chunk.callerKey, out);
            }
            for (const k of keys) out.add(k);
          }
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      }
    }
  }

  const reverse = new Map<string, Set<string>>();
  for (const [caller, callees] of forward) {
    for (const callee of callees) {
      let arr = reverse.get(callee);
      if (!arr) {
        arr = new Set();
        reverse.set(callee, arr);
      }
      arr.add(caller);
    }
  }
  return { forward, reverse };
}

/** Build the display node for a key at a given depth (pure). */
function makeNode(
  key: string,
  meta: Map<string, CallSymbol>,
  projectRoot: string,
  depth: number,
): CallGraphNode {
  const m = meta.get(key);
  const file = m?.filePath ?? "";
  const node: CallGraphNode = {
    key,
    symbol: m?.symbolName ?? key,
    symbolType: m?.symbolType ?? "",
    file,
    relativeFile: file ? path.relative(projectRoot, file) : "",
    startLine: m?.declarationLine ?? 0,
    endLine: m?.endLine ?? 0,
    depth,
    children: [],
  };
  if (m?.language) node.language = m.language;
  if (m?.content) {
    const sig = deriveSignature(m.content);
    if (sig) node.signature = sig;
  }
  return node;
}

/**
 * Traverse `adj` from `roots` into a bounded, cycle-safe tree.
 *  - `maxDepth` bounds the depth (0 = roots only).
 *  - `maxNodes` caps the total real nodes across all roots; exceeding it sets
 *    `truncated` (cycle markers don't count against the budget).
 *  - Cycles (a child already on the current root→leaf path) are emitted as a
 *    `cyclic: true` leaf and not expanded, so traversal always terminates.
 *  - A node reachable via several non-cyclic paths appears under each path (a
 *    tree, not a deduped DAG) — that is the point of a "call stack".
 */
export function traverseCallGraph(
  roots: string[],
  adj: Map<string, Set<string>>,
  meta: Map<string, CallSymbol>,
  projectRoot: string,
  maxDepth: number,
  maxNodes: number,
): { nodes: CallGraphNode[]; truncated: boolean } {
  let budget = maxNodes;
  let truncated = false;

  const build = (key: string, depth: number, onPath: Set<string>): CallGraphNode | null => {
    if (budget <= 0) {
      truncated = true;
      return null;
    }
    budget--;
    const node = makeNode(key, meta, projectRoot, depth);
    if (depth >= maxDepth) return node;
    const next = adj.get(key);
    if (!next || next.size === 0) return node;
    onPath.add(key);
    for (const childKey of next) {
      if (onPath.has(childKey)) {
        node.children.push({ ...makeNode(childKey, meta, projectRoot, depth + 1), cyclic: true });
        continue;
      }
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const child = build(childKey, depth + 1, onPath);
      if (child) node.children.push(child);
    }
    onPath.delete(key);
    return node;
  };

  const nodes: CallGraphNode[] = [];
  for (const root of roots) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const n = build(root, 0, new Set());
    if (n) nodes.push(n);
  }
  return { nodes, truncated };
}

/**
 * Resolve which inventory symbols a user's anchor `query` refers to. Mirrors
 * `db.searchSymbol` so `getCallGraph` accepts the same names `find_symbol` does —
 * including a BARE method name (`getDependencies`) resolving to its qualified
 * indexed form (`IndexManager.getDependencies`). Four clauses: exact, prefix,
 * dotted-suffix (`Class.query`), dotted-substring (`Outer.Inner.query`). Results
 * are deduped by symbol key. Empty string matches nothing.
 */
export function matchRootSymbols(
  nameToSymbols: Map<string, CallSymbol[]>,
  query: string,
): CallSymbol[] {
  if (!query) return [];
  const dotted = "." + query;
  const out: CallSymbol[] = [];
  const seen = new Set<string>();
  for (const [name, syms] of nameToSymbols) {
    if (name === query || name.startsWith(query) || name.includes(dotted)) {
      for (const s of syms) {
        if (!seen.has(s.key)) {
          seen.add(s.key);
          out.push(s);
        }
      }
    }
  }
  return out;
}
