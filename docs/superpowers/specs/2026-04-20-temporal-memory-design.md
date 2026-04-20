# Temporal memory: contradiction detection and state-vs-event model

Spec for [issue #1](https://github.com/nxsflow/claude-memory/issues/1).
Date: 2026-04-20. Status: Approved — ready for implementation plan.

## Problem

The memory pipeline is append-only and time-blind. `consolidate` is a
mechanical compression step — its prompt forbids adding content — so
contradictions and stale facts accumulate silently across days. Two
observed failure modes past ~1 month of use:

1. **Contradictions coexist.** Long-term says `pkg manager: pnpm`, later
   short-term says `migrated to npm`. Both end up in the injected
   `=== MEMORY ===` block. Claude sees inconsistent signal and may
   follow the older fact.
2. **No temporal validity.** Entries carry a write timestamp (day / week
   header), but individual facts have no `validFrom` / `supersededOn`.
   There is no way to say _"this was true on 2026-03-12, superseded on
   2026-04-01"_ — only when a line was _written_.

Field research (Mem0, Zep/Graphiti, SSGM) identifies this as the
dominant cause of "memory rot" in long-running agent memory.

## Goals

- `consolidate` detects when a new fact contradicts an existing one and
  records supersession (does not delete the old fact).
- Memory carries temporal validity (`validFrom`, optional
  `supersededOn`, explicit supersession edges).
- The injected `MEMORY` block shows current facts prominently and lists
  superseded facts in a clearly-labelled "Previously" section — so
  dated supersession overrides stale content in CLAUDE.md or other
  docs.
- Storage is structured (JSON), machine-parseable, versioned.

## Non-goals

- No vector embeddings, no similarity scoring.
- No mid-session re-consolidation.
- No user-facing conflict-resolution UI. Newer wins by default.
- No change to `working-memory.md`, `episodic-memory/`, `core-memories.md`,
  `agent-role.md`, `session-handover.md`. Scope is short-term + long-term
  tiers only.
- No auto-purge of superseded facts in v1. Revisit if the injected block
  grows large in practice.

## Key decisions

| #   | Decision                                                                                                                                                                                                                             | Why                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Structured JSON sidecar (`.claude-memory/temporal.json`) as source of truth; `.md` files are derived views, regenerated on every `SessionStart`.                                                                                     | Avoids text-matching fragility. Haiku never has to preserve machine markers across compression.                                                      |
| D2  | Separate **state facts** from **events**. Only state facts are subject to supersession. Events are append-only history.                                                                                                              | "Yesterday Claude fixed bug X" is not superseded by "today Claude fixed bug Y"; "package manager is pnpm" IS superseded by "package manager is npm". |
| D3  | Injection shows **current facts + collapsed "Previously (superseded — do not follow)"** section.                                                                                                                                     | Dated supersession beats stale docs (CLAUDE.md, READMEs). Acts as active counter-weight, not just audit trail.                                       |
| D4  | **Events tier (recent → weekly); state does not tier.** State facts live until superseded.                                                                                                                                           | Tiering by age makes no sense for state — only supersession matters.                                                                                 |
| D5  | **Haiku extracts; code merges.** Haiku's only job is to emit `{newFacts, newEvents}` JSON. Subject normalization, contradiction detection, ID assignment, supersession marking, weekly roll-up all live in deterministic TypeScript. | Testable, reproducible, cheap. Avoids the "prompt must carve out an exception to NEVER add content" problem.                                         |
| D6  | **Migration M2 — graceful coexistence.** If `temporal.json` is absent, `session-start` falls back to legacy `.md` emit; `consolidate` creates a fresh `temporal.json` and it accumulates from there.                                 | No bootstrap LLM risk. Users on v0.x see no regression.                                                                                              |

## Data model

`.claude-memory/temporal.json` is the authoritative store:

```json
{
  "version": 1,
  "state": [
    {
      "id": "s7",
      "subject": "pkg-manager",
      "value": "pnpm",
      "validFrom": "2026-03-12",
      "supersededBy": "s12",
      "supersededOn": "2026-04-01"
    },
    {
      "id": "s12",
      "subject": "pkg-manager",
      "value": "npm (migrated from pnpm)",
      "validFrom": "2026-04-01",
      "supersedes": ["s7"]
    }
  ],
  "events": {
    "recent": [
      {
        "id": "e88",
        "date": "2026-04-18",
        "summary": "Added biome 4-space rule"
      }
    ],
    "weekly": [
      {
        "id": "w6",
        "weekOf": "2026-03-09",
        "summary": "Set up vitest harness; 118 tests green."
      }
    ]
  }
}
```

Invariants:

- `state[i].subject` is lowercase-kebab. Enforced by the merge layer;
  if Haiku emits a malformed subject (camelCase, whitespace, etc.),
  the merger normalizes it.
- `id` is monotonic (`s1`, `s2`, `e1`, `e2`, `w1`, `w2`). Assigned by
  code, never by Haiku.
- A state fact is current iff `supersededBy` is absent.
- An event is in `events.recent` iff `today - date ≤ eventHorizonDays`
  (default 3). Otherwise it has been rolled into `events.weekly`. This
  preserves the current prompt's "older than 3 days" semantics.
- No fact is deleted in v1.
- `version` pins the schema. Mismatch raises a clear migration error.

## Components

**`src/helpers/temporal.ts`** (new, pure functions, no I/O except
`read*` / `write*`):

- `readTemporal(dataDir) → TemporalStore`
- `writeTemporal(dataDir, store)` — atomic rename, same pattern as
  `memory-files.ts`.
- `mergeExtracted(store, today, {newFacts, newEvents}) → TemporalStore`
- `rollEvents(store, today) → TemporalStore`
- `renderMarkdown(store, today) → { shortTerm, longTerm }` — two
  strings. Each is empty when the relevant slice of the store is
  empty (no header-only output). `session-start` concatenates them.
- `currentSubjects(store) → string[]` — glossary for the Haiku prompt.

**`src/entrypoints/consolidate.ts`** (rewritten — no longer writes
markdown directly):

1. Read `temporal.json`, episodes, `cfg`.
2. Render prompt with `currentSubjects(store)` as glossary.
3. Call Haiku → parse strict JSON into `{newFacts, newEvents}`.
4. `store = rollEvents(mergeExtracted(store, today, extracted), today)`.
5. `writeTemporal(dataDir, store)`.
6. Regenerate derived `.md` files via `renderMarkdown`.
7. Delete consumed episode files **only after successful write**.

**`src/entrypoints/session-start.ts`** (modified): reads
`temporal.json`, calls `renderMarkdown`, emits the rendered blocks
inside the existing `=== MEMORY ===` wrapper. If `temporal.json` is
absent, falls back to emitting legacy `.md` files verbatim (migration
path M2, also a safety net).

**`prompts/consolidate.prompt.md`** (rewritten): extraction only, strict
JSON output, subject glossary, no supersession logic.

Unchanged: `save.ts`, `compact.ts`, `post-tool-use.ts`, `lock.ts`,
`cooldown.ts`, `jsonl.ts`, `haiku.ts`, and the working / episodic /
handover paths in `memory-files.ts`.

## Data flow (worked example)

Today: `2026-04-01`. `temporal.json` already has
`s7 = {subject: "pkg-manager", value: "pnpm", validFrom: "2026-03-12"}`.

Episode `episodic-memory/2026-04-01.md`:

> Migrated from pnpm to npm. Updated package-lock.json, removed
> pnpm-lock.yaml, updated CI. Also fixed an off-by-one in the paginator.

`consolidate` runs:

1. Glossary sent to Haiku:
   `["pkg-manager", "test-runner", "ci-provider", ...]`.
2. Haiku returns:

   ```json
   {
     "newFacts": [
       { "subject": "pkg-manager", "value": "npm (migrated from pnpm)" }
     ],
     "newEvents": [
       {
         "date": "2026-04-01",
         "summary": "pnpm→npm migration; paginator off-by-one fix"
       }
     ]
   }
   ```

3. `mergeExtracted` finds current `s7` with `subject = "pkg-manager"`,
   new value differs → assigns `s12`, sets
   `s12.supersedes = ["s7"]`, mutates
   `s7.supersededBy = "s12"`, `s7.supersededOn = "2026-04-01"`.
4. `rollEvents` moves anything older than 3 days from `recent` to
   `weekly[weekOfMonday]`.
5. `writeTemporal`. Delete the episode. Regenerate derived `.md`.

Next `SessionStart`, injected block:

```md
=== MEMORY ===
--- short-term-memory.md ---

# Short-Term Memory

## State

- pkg-manager: npm (migrated from pnpm) (since 2026-04-01)
- test-runner: vitest (since 2026-03-12)
- ci-provider: github-actions (since 2026-03-12)

### Previously (superseded — do not follow)

- pkg-manager: pnpm (2026-03-12 → 2026-04-01)

## Recent events

- 2026-04-01: pnpm→npm migration; paginator off-by-one fix
- 2026-03-30: Added biome 4-space rule

--- long-term-memory.md ---

# Long-Term Memory

## Week of 2026-03-09

- Set up vitest harness; 118 tests green.
```

## Extraction prompt contract

`prompts/consolidate.prompt.md` is rewritten. Full behaviour:

- Input: `{{EPISODES}}` (all un-consolidated episode files, each with
  its own `## YYYY-MM-DD` header from `compact`) and
  `{{SUBJECT_GLOSSARY}}` (current state-fact subject keys).
- Rules:
  1. Reuse glossary subjects when the fact applies; only invent a new
     subject when no match exists.
  2. A state fact has a kebab-case subject + a value ≤ 60 chars.
  3. An event has a date (YYYY-MM-DD from the episode header) + a
     summary ≤ 20 words.
  4. Ignore iteration / debugging noise that is not a deliverable.
  5. Do NOT emit supersession markers or IDs — that is code's job.
- Output: strict JSON, no prose, optionally code-fence-wrapped:

  ```json
  {
    "newFacts": [{ "subject": "kebab-case", "value": "short string" }],
    "newEvents": [{ "date": "YYYY-MM-DD", "summary": "short string" }]
  }
  ```

Parser: `parseExtractResponse(raw)` — strips optional code fences, fails
loud with a 120-char snippet on malformed JSON, mirrors the defensive
style of the existing `parseConsolidateResponse`. Missing top-level
keys throw. Extra keys are ignored (forward-compat).

## Injection rendering

`renderMarkdown(store, today)` is deterministic. Short-term block:

1. `# Short-Term Memory` header.
2. `## State` — one bullet per current state fact (`supersededBy`
   absent), sorted by `subject` ascending.
   Format: `- {subject}: {value}  (since {validFrom})`.
3. `### Previously (superseded — do not follow)` — **only emitted if
   ≥1 superseded fact exists.** One bullet per superseded fact, most
   recent supersession first.
   Format: `- {subject}: {value}  ({validFrom} → {supersededOn})`.
4. `## Recent events` — `events.recent`, reverse-chronological.
   Format: `- {date}: {summary}`.

Long-term block:

1. `# Long-Term Memory` header.
2. `## Week of {weekOf}` per weekly rollup, reverse-chronological.
   Summary verbatim.

Token budget: the old 600 / 400 hard caps are removed. After render,
log a warning if either block exceeds a soft cap (`cfg.tokenSoftCap`
shortTerm 800 / longTerm 600). No truncation. Rationale: growth is
bounded by fact count (naturally small per project) and weekly
rollups (5-year projection ~ 8k tokens — manageable).

## Migration (v0 → v1)

Chosen approach: **M2 — graceful coexistence.**

- On every `SessionStart`:
  - If `temporal.json` exists → render and emit new blocks.
  - Else → emit legacy `short-term-memory.md` / `long-term-memory.md`
    via the existing `emitFile` path.
- On the next `consolidate` after upgrade:
  - Read `temporal.json` (empty store if absent).
  - Proceed normally. Write `temporal.json` for the first time.
  - Regenerate derived `.md` files. Legacy content in the old files
    is overwritten by the regenerated views.

Trade-off: pre-upgrade facts have no supersession history. That matches
the prior reality (they were never superseded before) — no regression.

## Testing

**`tests/helpers/temporal.test.ts`** — pure-function tests, no fs, no
LLM:

- `mergeExtracted`:
  - Empty store + 1 fact → `state[0]` has generated id, correct
    `validFrom`.
  - Existing fact + new value → supersession edges both ways, both
    facts in `state[]`.
  - Existing fact + identical value → no-op.
  - Haiku emits near-duplicate subject (e.g. `pkg-mgr` vs
    `pkg-manager`) → insert-as-new + logger warning. (Exact dedup via
    casing / whitespace is normalized; true near-dupes are not
    silently merged.)
  - Event appended to `recent`.
- `rollEvents`:
  - Event older than `eventHorizonDays` → moved to
    `weekly[weekOfMonday]`, grouped by Monday in `cfg.timezone`.
  - Today's event stays in `recent`.
- `renderMarkdown`:
  - Snapshot test against golden fixtures.
  - No superseded facts → `### Previously` section omitted.
  - Empty store → both rendered strings are empty (no header-only
    output); `session-start` emits nothing instead of bare headers.
- `readTemporal` / `writeTemporal`:
  - Missing file → empty store, no throw.
  - Atomic rename on write.
  - Version mismatch → throw with migration message.

**`tests/entrypoints/consolidate.test.ts`** — parser tests mirroring the
existing `parseConsolidateResponse` style:

- Valid JSON → parsed.
- ` ```json ` fence → unwrapped.
- Malformed JSON → throws with 120-char snippet.
- Missing `newFacts` or `newEvents` → throws.
- Extra keys → ignored.

**`tests/entrypoints/consolidate.integration.test.ts`** — end-to-end
with mocked `callHaiku`:

- Fixture: one episode with a contradiction, `temporal.json` with the
  prior fact.
- Run `main()`.
- Assert: on-disk `temporal.json` has both facts + supersession edges,
  episode deleted, rendered `.md` files match golden, token counts
  logged.

**`tests/entrypoints/session-start.test.ts`** — add cases for
`temporal.json` present (renders new blocks) and absent (legacy
fallback fires).

## Error handling

Existing non-blocking philosophy preserved:

- `readTemporal` parse failure → log, treat as empty store, do NOT
  delete episodes. Next run retries.
- Haiku returns malformed JSON → log parse error, exit 1, do NOT
  delete episodes, do NOT overwrite `temporal.json`. Consolidation
  is idempotent; it will retry on the next `SessionStart`.
- Merge detects a near-duplicate subject → log warning, insert as new
  subject. Does not block.
- `writeTemporal` partial failure → atomic rename prevents corruption.
  If rename itself fails, old file kept, log, exit 1.

**Golden rule:** `consolidate` never deletes episode files unless the
new `temporal.json` was successfully written. This preserves the audit
trail on every failure mode.

## Acceptance criteria

- [ ] `temporal.json` is the source of truth for short-term and
      long-term memory; `short-term-memory.md` and
      `long-term-memory.md` are regenerated on each `consolidate`.
- [ ] `prompts/consolidate.prompt.md` is rewritten as a strict-JSON
      extraction prompt with a subject glossary.
- [ ] `src/helpers/temporal.ts` implements `readTemporal`,
      `writeTemporal`, `mergeExtracted`, `rollEvents`, `renderMarkdown`,
      `currentSubjects`.
- [ ] `src/entrypoints/consolidate.ts` uses Haiku for extraction only;
      all merge / supersession / rollup logic is deterministic code.
- [ ] `src/entrypoints/session-start.ts` prefers `temporal.json`,
      falls back to legacy `.md` files when absent.
- [ ] Tests cover: merge semantics, event rollup, render snapshots,
      parser edge cases, end-to-end contradiction flow, session-start
      migration path.
- [ ] `CLAUDE.md` documents the state-vs-event model, the new file
      layout (with `temporal.json` in the Naming Convention table),
      and the rule that `short-term-memory.md` / `long-term-memory.md`
      are machine-generated.
- [ ] Consolidate never deletes episode files on any failure path.

## Explicitly deferred

- Auto-purge of old superseded facts. Re-evaluate when a project's
  `temporal.json` exceeds ~1MB or injected block exceeds ~2k tokens.
- Contradiction detection in `compact` (working → episodic). Same-day
  contradictions are iteration, not drift.
- Surfacing ambiguous conflicts in `session-handover.md`. Out of scope
  for v1; newer-wins is sufficient.
- Vector embeddings / semantic similarity for subject matching. Not
  needed at current scale.
- User-facing conflict-resolution UI.
