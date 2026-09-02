/**
 * Tests for the `cidx open` editor helpers — pure logic, no process spawn.
 */
import { test, expect, describe } from "bun:test";
import { resolveEditor, buildEditorArgs } from "../src/utils/editor";

describe("resolveEditor", () => {
  test("prefers $VISUAL, then $EDITOR, then vi", () => {
    expect(resolveEditor({ VISUAL: "code -w", EDITOR: "nano" })).toBe("code -w");
    expect(resolveEditor({ EDITOR: "nano" })).toBe("nano");
    expect(resolveEditor({})).toBe("vi");
  });

  test("a blank value falls through to the next candidate", () => {
    expect(resolveEditor({ VISUAL: "", EDITOR: "nano" })).toBe("nano");
    expect(resolveEditor({ VISUAL: "", EDITOR: "" })).toBe("vi");
  });
});

describe("buildEditorArgs", () => {
  const file = "/repo/src/a.ts";

  test("default convention: +<line> before the file (vim/nano/emacs)", () => {
    expect(buildEditorArgs("vim", file, 42)).toEqual(["vim", "+42", file]);
    expect(buildEditorArgs("nano", file, 7)).toEqual(["nano", "+7", file]);
    // An editor path is handled by basename detection, not the whole string.
    expect(buildEditorArgs("/usr/bin/nvim", file, 3)).toEqual(["/usr/bin/nvim", "+3", file]);
  });

  test("VS Code family: --goto <file>:<line>, own flags preserved", () => {
    expect(buildEditorArgs("code -w", file, 42)).toEqual(["code", "-w", "--goto", `${file}:42`]);
    expect(buildEditorArgs("codium", file, 1)).toEqual(["codium", "--goto", `${file}:1`]);
  });

  test("Helix: <file>:<line>", () => {
    expect(buildEditorArgs("hx", file, 5)).toEqual(["hx", `${file}:5`]);
  });

  test("line is always >= 1 and coerced into the argv", () => {
    expect(buildEditorArgs("vi", file, 0)).toEqual(["vi", "+0", file]);
  });
});