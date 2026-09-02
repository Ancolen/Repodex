/**
 * Editor-launch helpers for `cidx open` (search → open the result in an editor
 * at the matching line). Pure logic — the CLI spawns the process; these only
 * decide *which* editor and *what* argv. No filesystem or process access.
 */

/**
 * The editor to launch: `$VISUAL`, then `$EDITOR`, then `vi` (the POSIX
 * fallback). `$VISUAL` is preferred because it may hold a full-screen editor
 * while `$EDITOR` is allowed to be a line editor (ex/ed).
 */
export function resolveEditor(env: Record<string, string | undefined>): string {
  return env.VISUAL || env.EDITOR || "vi";
}

/**
 * Builds the argv for launching `editor` on `filePath` at 1-based `line`.
 * The value may carry its own args ("code -w") — it's split on whitespace
 * (an editor path/value containing spaces is not supported).
 *
 * Line-position conventions:
 * - Most terminal editors (vim/vi/nvim/nano/emacs and the POSIX convention)
 *   take a `+<line>` argument before the file — used for anything unknown.
 * - The VS Code family wants `--goto <file>:<line>`.
 * - Helix (`hx`) wants `<file>:<line>`.
 */
export function buildEditorArgs(editor: string, filePath: string, line: number): string[] {
  const base = editor.trim().split(/\s+/).filter(Boolean);
  const cmd = base[0] ?? "vi";
  const name = cmd.split("/").pop() ?? cmd;
  if (name === "code" || name === "code-insiders" || name === "codium" || name === "code-oss") {
    return [...base, "--goto", `${filePath}:${line}`];
  }
  if (name === "hx") {
    return [...base, `${filePath}:${line}`];
  }
  return [...base, `+${line}`, filePath];
}