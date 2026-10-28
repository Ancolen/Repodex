/**
 * Doc-file discovery for the doc–code conformance checker (proposal D1).
 *
 * The fs half of `src/core/doccheck.ts` (which stays pure): walk the project for
 * documentation files, list root names, and read the package.json manifest. The
 * walk REUSES the indexer's ignore machinery (`buildIgnore`/`isPathIgnored`) —
 * a doc the project ignores is not a doc to check.
 */
import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { buildIgnore, isPathIgnored } from "./indexer";
import { globToRegex } from "../core/doccheck";

/** Default doc set: every markdown file in the root plus under docs/. */
export const DOC_DEFAULT_INCLUDE = ["*.md", "docs/**/*.md"];

/** Doc-discovery caps — always surfaced, never silently applied. */
export const DOC_MAX_FILES = 200;
export const DOC_MAX_DEPTH = 6;
/** Cap on the walked-file universe (the path-claim side of the checker). */
export const DOC_MAX_WALK_FILES = 10000;

/** Only real prose formats; code fences live inside them. */
const DOC_EXTS = new Set([".md", ".mdx"]);

/** The glob metacharacters `globToRegex` understands. */
const GLOB_MAGIC_RE = /[*?]/;

/**
 * Normalise one include/ignore ref to the root-anchored posix vocabulary the
 * walker matches paths in: separators become `/`, a leading `./` is dropped,
 * and an absolute ref under the project root becomes its relative form. Shared
 * by discovery and `resolveRequestedDocs` so the checked set and the feedback
 * can never disagree about what a ref means.
 */
function rootAnchoredRef(ref: string, root: string): string {
  if (!path.isAbsolute(ref)) return ref.replace(/\\/g, "/").replace(/^\.\//, "");
  const rel = path.relative(root, path.resolve(ref)).replace(/\\/g, "/");
  return rel.length === 0 ? ref.replace(/\\/g, "/") : rel;
}

export interface DocDiscovery {
  /** Absolute paths of the discovered doc files (sorted, deterministic). */
  files: string[];
  /** True when the DOC_MAX_FILES cap cut the list short. */
  truncated: boolean;
  /** How many candidate doc files were seen (before the cap). */
  scanned: number;
  /**
   * EVERY non-ignored file the walk passed (project-relative posix, capped at
   * DOC_MAX_WALK_FILES) — the path-claim universe for the checker, which must
   * cover files the indexer never indexed (`.sh`, `.wasm`, LICENSE, …). The
   * same walk produces it, so there is no second traversal.
   */
  allFiles: string[];
}

export interface DocDiscoveryOpts {
  /** Restrict the doc set (project-relative, root-anchored globs). */
  files?: string[] | undefined;
  /** Extra doc files/globs to skip (on top of .gitignore/.cidxignore). */
  ignore?: string[] | undefined;
}

/**
 * Walk `baseDir` (depth-capped, ignore-aware) and collect documentation files
 * matching the include set. Missing/unreadable roots yield an empty result —
 * never a throw (an unreadable project must not crash the daemon).
 */
export async function collectDocFiles(baseDir: string, opts?: DocDiscoveryOpts): Promise<DocDiscovery> {
  const includes = (opts?.files && opts.files.length > 0 ? opts.files : DOC_DEFAULT_INCLUDE).map((ref) =>
    globToRegex(rootAnchoredRef(ref, baseDir)),
  );
  const extraIgnore = (opts?.ignore ?? []).map((ref) => globToRegex(rootAnchoredRef(ref, baseDir)));

  let ig;
  try {
    ig = await buildIgnore(baseDir);
  } catch {
    ig = ignore(); // unreadable ignore files → match nothing extra, still walk
  }

  const found: string[] = [];
  const walked: string[] = [];
  let truncated = false;
  let scanned = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relEntry = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= DOC_MAX_DEPTH) continue;
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        if (isPathIgnored(ig, baseDir, abs)) continue;
        if (extraIgnore.some((re) => re.test(`${relEntry}/`) || re.test(relEntry))) continue;
        walk(abs, relEntry, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isPathIgnored(ig, baseDir, abs)) continue;
      if (extraIgnore.some((re) => re.test(relEntry))) continue;
      const relPosix = relEntry.replace(/\\/g, "/");
      if (walked.length < DOC_MAX_WALK_FILES) walked.push(relPosix);
      if (!DOC_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      if (!includes.some((re) => re.test(relPosix))) continue;
      scanned++;
      if (found.length >= DOC_MAX_FILES) {
        // Admissions are capped; the walk still counts candidates so
        // `scanned`/`truncated` are honest about what was left out.
        truncated = true;
        continue;
      }
      found.push(abs);
    }
  };

  walk(baseDir, "", 0);
  found.sort();
  walked.sort();
  return { files: found, truncated, scanned, allFiles: walked };
}

/** Basenames of the files (not directories) directly in `baseDir`. */
export function listRootFiles(baseDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
}

export async function readProjectManifest(baseDir: string): Promise<{
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  scripts: Record<string, string>;
}> {
  const empty = { deps: {}, devDeps: {}, scripts: {} };
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(baseDir, "package.json"), "utf-8");
  } catch {
    return empty;
  }
  try {
    const raw = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    return {
      deps: raw.dependencies ?? {},
      devDeps: raw.devDependencies ?? {},
      scripts: raw.scripts ?? {},
    };
  } catch {
    return empty;
  }
}
// ------------------------------------------------- requested-doc resolution

/**
 * Resolves caller-passed doc refs (`opts.files` / `.cidx.json`
 * `doccheck.files`) against a discovered set. Refs are **root-anchored globs**
 * (the documented `files` form) or literal paths; either way a ref the engine
 * never picks up is NOT silent — an out-of-root ref, a ref matching nothing, or
 * a ref whose files were filtered away each get their own status, so a report
 * whose checked subset reads `docs: 1` can explain itself.
 *
 * A glob is `matched` when it names at least one checked doc, `filtered` when
 * it only names walked (on-disk, non-ignored) files the doc set never picked
 * up, and `missing` when the walk sees nothing it names. A literal ref keeps
 * file-level resolution (exists on disk → `matched`/`filtered`, absent →
 * `missing`). Pure data + one fs existence check per literal ref (this module
 * is the fs half of D1).
 */
export function resolveRequestedDocs(
  refs: readonly string[],
  root: string,
  matchedAbs: ReadonlySet<string>,
  walkedRel: ReadonlySet<string> = new Set(),
): Array<{ ref: string; status: "matched" | "missing" | "filtered" | "outsideRoot" }> {
  // The discovered docs in the walker's own vocabulary (project-relative
  // posix), so include globs resolve against exactly what discovery selected.
  let matchedRel: Set<string> | undefined;
  const discoveredRel = (): Set<string> => {
    if (!matchedRel) {
      matchedRel = new Set<string>();
      for (const abs of matchedAbs) {
        const rel = path.relative(root, abs);
        if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) {
          matchedRel.add(rel.replace(/\\/g, "/"));
        }
      }
    }
    return matchedRel;
  };

  return refs.map((ref) => {
    if (GLOB_MAGIC_RE.test(ref)) {
      const glob = rootAnchoredRef(ref, root);
      if (glob === ".." || glob.startsWith("../") || path.isAbsolute(glob)) {
        return { ref, status: "outsideRoot" };
      }
      const re = globToRegex(glob);
      if ([...discoveredRel()].some((p) => re.test(p))) return { ref, status: "matched" };
      if ([...walkedRel].some((p) => re.test(p))) return { ref, status: "filtered" };
      return { ref, status: "missing" };
    }
    const abs = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(root, ref);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { ref, status: "outsideRoot" };
    let onDisk = false;
    try {
      onDisk = fs.statSync(abs).isFile();
    } catch {
      onDisk = false;
    }
    if (!onDisk) return { ref, status: "missing" };
    return { ref, status: matchedAbs.has(abs) ? "matched" : "filtered" };
  });
}
