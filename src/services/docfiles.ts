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

/** Only real prose formats; code fences live inside them. */
const DOC_EXTS = new Set([".md", ".mdx"]);

export interface DocDiscovery {
  /** Absolute paths of the discovered doc files (sorted, deterministic). */
  files: string[];
  /** True when the DOC_MAX_FILES cap cut the list short. */
  truncated: boolean;
  /** How many candidate doc files were seen (before the cap). */
  scanned: number;
}

export interface DocDiscoveryOpts {
  /** Restrict the doc set (project-relative, root-anchored globs). */
  files?: string[];
  /** Extra doc files/globs to skip (on top of .gitignore/.cidxignore). */
  ignore?: string[];
}

/**
 * Walk `baseDir` (depth-capped, ignore-aware) and collect documentation files
 * matching the include set. Missing/unreadable roots yield an empty result —
 * never a throw (an unreadable project must not crash the daemon).
 */
export async function collectDocFiles(baseDir: string, opts?: DocDiscoveryOpts): Promise<DocDiscovery> {
  const includes = (opts?.files && opts.files.length > 0 ? opts.files : DOC_DEFAULT_INCLUDE).map(globToRegex);
  const extraIgnore = (opts?.ignore ?? []).map(globToRegex);

  let ig;
  try {
    ig = await buildIgnore(baseDir);
  } catch {
    ig = ignore(); // unreadable ignore files → match nothing extra, still walk
  }

  const found: string[] = [];
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
      if (!DOC_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      if (isPathIgnored(ig, baseDir, abs)) continue;
      if (extraIgnore.some((re) => re.test(relEntry))) continue;
      const relPosix = relEntry.replace(/\\/g, "/");
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
  return { files: found, truncated, scanned };
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