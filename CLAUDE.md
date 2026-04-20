# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin (`claude-memory`) that gives Claude Code continuous memory across sessions.
It hooks into Claude Code's session lifecycle, extracts conversation exchanges from JSONL
transcripts, summarises them via Haiku, and compresses them through a tiered memory pyramid
that is reloaded into context on the next `SessionStart`.

## Commands

```bash
npm test                        # vitest — 171 tests in tests/helpers/ + tests/entrypoints/
npm test -- tests/helpers/jsonl # run one file
npm run typecheck               # tsc --noEmit
npm run lint                    # biome check (also enforces 4-space indent)
npm run build                   # esbuild → dist/entrypoints/*.mjs
```

Node 20+ required. No Python, no shell scripts.

## Architecture

Two layers under `src/`:

- **`src/entrypoints/`** — thin orchestrators. Each one resolves paths, loads config,
  acquires a lock, calls helpers, and returns an exit code. Compiled to `dist/entrypoints/*.mjs`.
- **`src/helpers/`** — pure functions for file I/O, JSONL parsing, prompt rendering,
  Haiku invocation, locking, and cooldowns.

## Naming Convention (Important)

The memory tiers, in order from most recent to oldest:

| Name              | File                                           | Written by                                   |
| ----------------- | ---------------------------------------------- | -------------------------------------------- |
| working memory    | `.claude-memory/working-memory.md`             | `save`                                       |
| episodic memory   | `.claude-memory/episodic-memory/YYYY-MM-DD.md` | `compact`                                    |
| temporal store    | `.claude-memory/temporal.json`                 | `consolidate`                                |
| short-term memory | `.claude-memory/short-term-memory.md`          | `consolidate` (derived from `temporal.json`) |
| long-term memory  | `.claude-memory/long-term-memory.md`           | `consolidate` (derived from `temporal.json`) |

Plus `core-memories.md`, `agent-role.md`, and `session-handover.md` (one-shot, cleared after
injection).

All memory files live under `.claude-memory/` **inside the user's project** — never mention or
reference the old `.remember/` path.

### State facts vs events

`temporal.json` is the source of truth for short-term and long-term memory.
`short-term-memory.md` and `long-term-memory.md` are **machine-generated
derived views** — rendered from `temporal.json` on every `consolidate`.
Do not hand-edit them.

- **State facts** are durable project configuration (package manager,
  test runner, indent style). They live until a later run produces a
  contradictory fact; at that point the old fact is marked
  `supersededBy` rather than deleted. The injected `=== MEMORY ===`
  block shows current state prominently, plus a collapsed "Previously
  (superseded — do not follow)" section so that dated supersession
  overrides stale content elsewhere (README, CLAUDE.md).
- **Events** are dated happenings. They tier: within the last 3 days
  (`cfg.eventHorizonDays`) they live in `events.recent`; older events
  roll into `events.weekly` grouped by Monday-anchored week.

Only state facts are subject to supersession. Events are append-only.

## Conventions

- Pure ESM throughout. `.ts` source files import with `.ts` extensions; esbuild resolves them
  at bundle time.
- Strict TypeScript with `noUncheckedIndexedAccess` — treat all indexed array/object reads as
  potentially `undefined`.
- 4-space indentation everywhere (biome enforces this).
- No runtime dependencies. Node built-ins only.
- All file writes to memory files go through `src/helpers/memory-files.ts` — do not bypass.

## Files of Note

- `src/entrypoints/*.ts` — the five pipeline entry points (`session-start`, `post-tool-use`,
  `save`, `compact`, `consolidate`).
- `src/helpers/*.ts` — shared helpers; `memory-files.ts` owns all memory file I/O;
  `config.ts` has `DEFAULTS`.
- `src/helpers/temporal.ts` — owns the `temporal.json` data model:
  read/write, merge (with contradiction detection), event roll-up,
  and render-to-markdown. Pure functions + I/O only; no Haiku calls.
- `prompts/*.prompt.md` — the Haiku prompt templates. Edit these to tune summarisation
  behaviour. `{{UPPER_CASE}}` placeholders are substituted by `renderPrompt()`.
- `skills/session-handover/SKILL.md` — the `/session-handover` slash-command instruction.
- `hooks/hooks.json` — registers `SessionStart` + `PostToolUse`, pointing at
  `dist/entrypoints/*.mjs`.

## Out of Scope for Now

- `tests-old/` is retained as historical guidance only. Vitest is configured to ignore it —
  do not run it.
- No Python, no shell scripts. The old `pipeline/` and `scripts/` directories have been
  deleted.
- Haiku invocation still goes through a `claude -p` subprocess (`src/helpers/haiku.ts`) —
  not the Anthropic SDK. Do not switch to the SDK without discussion.
