/**
 * `import x from "...wasm" with { type: "file" }` — Bun embeds this import into
 * the single binary and returns the file path (string) at runtime.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
