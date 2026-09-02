## What

<!-- What does this PR do? One paragraph. -->

## Why

<!-- Link the issue, or describe the motivation. -->

## Checklist

- [ ] `bun run typecheck` passes (strict mode)
- [ ] `bun test` passes (no Ollama needed)
- [ ] New MCP tools are wired through **all** layers: `tool-defs.ts` → `mcp.ts` → `control-api.ts` → `stdio-bridge.ts` → `cli.ts` → `format.ts` → `index-manager.ts`
- [ ] User-visible changes are noted in `docs/changelog.md`
- [ ] No secrets or personal paths in the diff