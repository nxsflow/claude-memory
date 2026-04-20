# Changelog

All notable user-facing changes to the `claude-memory` plugin.

## 0.2.0 — 2026-04-20

### Added

- **Temporal memory store (`.claude-memory/temporal.json`).** A new durable
  data file is now the source of truth for short-term and long-term memory.
  `short-term-memory.md` and `long-term-memory.md` are regenerated from it on
  every `consolidate` run — do not hand-edit them.
- **State facts vs events.** Consolidated memory is now split into two kinds:
  - *State facts* — durable project configuration (package manager, test
    runner, indent style, etc.). When a later run produces a contradictory
    fact, the old one is marked `supersededBy` and demoted to a collapsed
    "Previously (superseded — do not follow)" section, so dated overrides
    beat stale content elsewhere (README, CLAUDE.md).
  - *Events* — dated happenings that tier automatically: within the last
    3 days they sit in `events.recent`; older entries roll into
    `events.weekly` grouped by Monday-anchored week. Events are
    append-only and never superseded.
- **Current subject glossary** in the injected `=== MEMORY ===` block, so
  the agent knows what recurring project nouns (branches, files, tools)
  refer to without re-deriving them from transcripts.
- **Agent-role bootstrap on first run.** When `agent-role.md` is missing
  or empty and the plugin ships an `agent-role.example.md` template,
  `SessionStart` now emits a `=== FIRST-RUN BOOTSTRAP ===` block with
  the template inline plus instructions to author the file. Restores
  the auto-creation behaviour from the older `claude-remember` plugin.
- **Legacy fallback for `SessionStart`.** Installations that predate
  `temporal.json` continue to work — the hook reads the legacy
  `short-term-memory.md` / `long-term-memory.md` files until the next
  `consolidate` run materialises the store.

### Changed

- **Consolidate pipeline rewritten.** The `consolidate` prompt is now a
  strict-JSON extraction step; merging, deduping, supersession, and
  weekly roll-up are handled by deterministic code in
  `src/helpers/temporal.ts`. This makes consolidation reproducible and
  no longer at the mercy of free-form Haiku summarisation.
- **Token soft-cap warnings.** When either the short-term or long-term
  rendered view exceeds its soft cap, the pipeline logs a warning
  instead of silently truncating.

### Fixed

- **Placeholder false positives in prompt rendering.** Conversation
  content that happened to mention `{{EPISODES}}` (or any other
  template token) no longer aborts the pipeline as "unrendered" — we
  now collect placeholders from the original template only.
- **Zero-byte autonomous log cleanup.** `post-tool-use` now sweeps
  empty log files left behind by silent saves.
- **Hook log directory creation.** Ensures the log directory exists
  before `stderr` is redirected, fixing the `2>>` failure on fresh
  installs.
- **Haiku rejection preserves episodes.** If the Haiku call fails or
  returns an invalid response during `consolidate`, episodic memory is
  left intact so the next run can retry — no silent data loss.
- **`temporal.json` version fallback.** A future-version or malformed
  store falls back to the legacy `.md` views rather than crashing.

### Permissions

- `.claude/settings.json` now allows `npx vitest run`, `gh issue view`,
  and `gh repo view` without prompting.

### Docs

- `CLAUDE.md` documents the state-vs-event model, the temporal store,
  and the `src/helpers/temporal.ts` module.
