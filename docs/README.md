# MCP Code Indexer — Documentation

> Binary **`cidx`** (alias **`repodex`**) — a Bun daemon that vectorizes codebases with a local Ollama (`qwen3-embedding`) and exposes hybrid (semantic + BM25) code search over MCP.

This folder is the **canonical, living documentation** for the project. The root [`README.md`](../README.md) is the user-facing install & usage guide; everything here is for contributors and for tracking what the system does, how it's built, and what's planned.

## At a glance

- **Current version:** `2.4.0` (docstring / comment embedding + doc search legs)
- **Status:** core architecture, hybrid search (now with rerank / MMR / docstring legs), multi-language chunking (incl. Godot), and all robustness/security fixes are **complete and stable**. See [`status.md`](./status.md) for the full done / not-done breakdown.
- **Test suite:** `bun test` — 489/489 passing (1347 expectations).

## Documentation map

| Document | What's in it | Edit it when… |
|----------|--------------|---------------|
| [architecture.md](./architecture.md) | Design, runtime/toolchain, core decisions, data flow, directory layout, security model, test strategy | A structural / architectural decision changes |
| [features.md](./features.md) | Capability catalog — what the tool *does* today, organized by area | A feature is added or changes behavior |
| [status.md](./status.md) | ✅ **Done** / 🚧 **In progress** / 💡 **Proposed** / ⏸️ **Deferred** — the roadmap tracker | You finish something, start something, or decide on a proposal |
| [proposals.md](./proposals.md) | Detailed designs for the 💡 Proposed items (motivation, mechanics, files touched, risks, acceptance) | You flesh out a proposal, or reality changes a proposal's design |
| [changelog.md](./changelog.md) | Version-by-version implementation history (v1 → v4), newest first | You cut a release or finish a versioned milestone |
| [cpu-only-ops.md](./cpu-only-ops.md) | Running Ollama CPU-only — operational notes | The CPU-mode workaround changes |

## How to use these docs

- **Adding a new feature?** Update [`features.md`](./features.md) (what it does) **and** [`status.md`](./status.md) (move it from 💡 Proposed to ✅ Done), then add an entry to [`changelog.md`](./changelog.md).
- **Making an architectural decision?** Record it in [`architecture.md`](./architecture.md).
- **Brainstorming what to build next?** Add it to the 💡 Proposed section of [`status.md`](./status.md); when it earns a real design, flesh it out in [`proposals.md`](./proposals.md) and reference its ID from `status.md`.
- **AI-agent operating notes** (critical invariants, index freshness, strictness quirks) live in the root [`CLAUDE.md`](../CLAUDE.md) — that file is the contract Claude Code works against; the docs here describe the system itself.
