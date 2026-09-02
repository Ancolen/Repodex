import path from "node:path";
import { readFileSync } from "node:fs";
import { EXT_TO_GRAMMAR } from "../chunking/tree-sitter";
import { TEXT_LANG_BY_EXT } from "../chunking/chunker";

/**
 * Per-project configuration, read from an optional `.cidx.json` at the project
 * root. Layered on top of the global YAML config: everything here is optional
 * and only narrows/overrides what the global config allows for THIS project.
 *
 * {
 *   "languages":   ["typescript", "python"],  // allowlist of language labels
 *   "ignore":      ["vendor/**", "*.gen.ts"], // extra ignore patterns
 *   "embedModel":  "qwen3-embedding:8b-q8_0"  // per-project embedding model
 * }
 *
 * Applied at index time (full index/sync and watcher writes). Changes only take
 * effect after a reindex — except `languages`/`ignore`, which the incremental
 * sync also picks up through the deleted-file cleanup, and `embedModel`, which
 * triggers a full reindex automatically (vectors from two models can never
 * share a table).
 */

export interface ProjectConfig {
  /** Allowlist of language labels, exactly as they appear in the `language` column (e.g. "typescript", "gdscript", "markdown"). */
  languages?: string[];
  /** Extra ignore patterns (gitignore syntax) layered on .gitignore/.cidxignore/global. */
  ignore?: string[];
  /** Per-project embedding model override (Ollama tag). */
  embedModel?: string;
}

/** The project config file name, looked up at the project root. */
export const PROJECT_CONFIG_FILE = ".cidx.json";

/** Parses and validates a raw `.cidx.json` payload. Returns undefined on invalid input. */
export function parseProjectConfig(raw: unknown, source: string): ProjectConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(`[project-config] '${source}' must be a JSON object; ignoring it.`);
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: ProjectConfig = {};
  let valid = false;

  if (obj.languages !== undefined) {
    if (Array.isArray(obj.languages) && obj.languages.every((x) => typeof x === "string" && x.length > 0)) {
      out.languages = obj.languages as string[];
      valid = true;
    } else {
      console.error(`[project-config] '${source}': 'languages' must be an array of non-empty strings; skipping it.`);
    }
  }
  if (obj.ignore !== undefined) {
    if (Array.isArray(obj.ignore) && obj.ignore.every((x) => typeof x === "string" && x.length > 0)) {
      out.ignore = obj.ignore as string[];
      valid = true;
    } else {
      console.error(`[project-config] '${source}': 'ignore' must be an array of non-empty strings; skipping it.`);
    }
  }
  if (obj.embedModel !== undefined) {
    if (typeof obj.embedModel === "string" && obj.embedModel.length > 0) {
      out.embedModel = obj.embedModel;
      valid = true;
    } else {
      console.error(`[project-config] '${source}': 'embedModel' must be a non-empty string; skipping it.`);
    }
  }

  return valid ? out : undefined;
}

/**
 * Reads `<baseDir>/.cidx.json` if present. Returns undefined when absent or
 * invalid (with a warning on stderr for the latter — an invalid file must not
 * silently change indexing behavior).
 */
export function readProjectConfig(baseDir: string): ProjectConfig | undefined {
  const p = path.join(baseDir, PROJECT_CONFIG_FILE);
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    return undefined; // absent (or unreadable) → no per-project config
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`[project-config] failed to parse '${p}':`, err);
    return undefined;
  }
  return parseProjectConfig(raw, PROJECT_CONFIG_FILE);
}

/** The `language` label a file extension produces during chunking (undefined = unlabeled fallback). */
export function extToLanguage(ext: string): string | undefined {
  const e = ext.toLowerCase();
  return EXT_TO_GRAMMAR[e] ?? TEXT_LANG_BY_EXT[e];
}

/** Builds the language allowlist for a project config (null = no filter). */
export function languageAllowSet(cfg: ProjectConfig | undefined): Set<string> | null {
  if (!cfg?.languages || cfg.languages.length === 0) return null;
  return new Set(cfg.languages);
}