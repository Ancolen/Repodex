/**
 * Pure path-relation helpers shared by layer code (index start responses).
 * No daemon imports — unit-testable without the LanceDB/registry machinery.
 */
import * as path from "node:path";

/** Is `child` inside (or equal to) `parent` on disk? Both absolute, resolved. */
export function isWithinDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A human note describing how `dir` relates to an ALREADY-indexed project
 * directory (null = no overlap, or the same directory itself). Overlapping
 * indexes double the disk work and split search results across two projects
 * (observed live: `~server/src` indexed as its own project next to `~server`),
 * so an `index_project` start warns before the work happens.
 */
export function pathOverlapNote(
  dir: string,
  existing: ReadonlyArray<{ name: string; path: string }>,
  /** The name the caller asked for (2.10.0): a different name on the SAME path is reported. */
  requestedName?: string | undefined,
): string | null {
  const base = path.resolve(dir);
  for (const rec of existing) {
    const other = path.resolve(rec.path);
    if (other === base) {
      // The same directory is already a project (createIndex reuses it). With a
      // different requested name, say so instead of silently ignoring it.
      if (requestedName !== undefined && requestedName !== rec.name) {
        return (
          `this path is already indexed as '${rec.name}' — the requested name '${requestedName}' ` +
          "is ignored and the existing project is reused (rename it first to use another name)"
        );
      }
      continue;
    }
    if (isWithinDir(other, base)) {
      return (
        `project '${rec.name}' (${other}) already indexes a parent directory of this path — ` +
        `its watcher covers it; consider indexing '${rec.name}' instead to avoid duplicate results`
      );
    }
    if (isWithinDir(base, other)) {
      return (
        `existing project '${rec.name}' (${other}) is inside this directory — ` +
        `two scopes will cover the same code; consider removing the inner one once done`
      );
    }
  }
  return null;
}