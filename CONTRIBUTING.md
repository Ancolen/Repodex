# Contributing

Thanks for considering a contribution! This project is a single-binary Bun
daemon (`cidx`) — a hybrid code-search MCP server. A quick map before you dive
in:

- `docs/architecture.md` — how the daemon fits together (hub, servers, pipeline)
- `CLAUDE.md` — operating contract with the invariants to respect when touching
  hot areas (model compatibility, write serialization, LIKE escaping, …)
- `docs/changelog.md` — everything user-visible lands here

## Setup

```bash
bun install
bun run typecheck   # tsc --noEmit — strict mode, must pass
bun test            # pure-logic unit tests; no Ollama required
```

Real indexing/search additionally needs a running Ollama with a `qwen3-embedding`
model, but tests don't.

## Ground rules

- **Run `bun run typecheck` and `bun test` before opening a PR.** The codebase
  is compiled with maximally strict TypeScript (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`).
- **New tree-sitter grammars** must pass the interleaved-determinism suite in
  `tests/tree-sitter.test.ts` before being bundled. Grammars known to corrupt
  subsequent parses in the shared WASM runtime (e.g. Lua today) stay on the
  character-chunking fallback.
- **New MCP tools** are defined once in `src/server/tool-defs.ts`, but must be
  wired through *all* layers: `mcp.ts` → `control-api.ts` → `stdio-bridge.ts`
  (which does **not** auto-discover tools — easy to miss) → `cli.ts` → `format.ts`
  → `index-manager.ts`.
- **Don't loosen security defaults**: servers bind `127.0.0.1` only, CORS is
  restricted to localhost, and every endpoint validates the `Host` header
  (DNS-rebinding protection).
- **No secrets in commits** — ever.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## Reporting issues

Open a GitHub issue with: what you ran, what you expected, what happened. For
indexing bugs, include the file type/language involved (no proprietary code —
a minimal repro snippet is enough). Security-sensitive reports go through
[SECURITY.md](SECURITY.md), not public issues.

## Releasing

Releases are cut from `main` with a tag; CI does the rest.

1. Bump the version — it appears in **five** places that must move together:
   `package.json`, `src/server/mcp.ts` (Server info), `src/server/control-api.ts`
   (`/ping`), `src/stdio-bridge.ts`, and `CLI_VERSION` in `src/cli.ts`.
2. Convert the "Unreleased" section of `docs/changelog.md` into the new version.
3. Tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Since native modules (LanceDB) are platform-specific, the binaries are not
cross-compiled — the Release workflow builds each on its own native runner:

| Asset               | Runner                 |
|---------------------|------------------------|
| `cidx-linux-x64`    | `ubuntu-latest`        |
| `cidx-linux-arm64`  | `ubuntu-24.04-arm`     |
| `cidx-darwin-x64`   | `macos-13` (Intel)     |
| `cidx-darwin-arm64` | `macos-14` (Apple Silicon) |

Each asset is uploaded to the GitHub Release with a `.sha256` checksum file;
the clone-free one-line install (`web-install.sh`) downloads the latest one.