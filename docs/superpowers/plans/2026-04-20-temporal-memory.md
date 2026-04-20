# Temporal Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #1 — introduce a structured JSON store (`temporal.json`) as the source of truth for short-term/long-term memory, with state-vs-event separation, deterministic contradiction detection, and supersession-aware injection.

**Architecture:** A new `temporal.ts` helper owns the pure data-transform layer (read/write, merge, roll, render). `consolidate` is rewritten so Haiku only extracts `{newFacts, newEvents}` — all merge/supersession logic is deterministic TypeScript. `session-start` prefers the derived view from `temporal.json`, with a legacy `.md` fallback for migration.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Node 20+, vitest, biome (4-space indent), pure ESM, no runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-20-temporal-memory-design.md`.

---

## File Structure

**Create:**

- `src/helpers/temporal.ts` — pure functions + I/O for the temporal store.
- `tests/helpers/temporal.test.ts` — unit tests for temporal.ts.
- `tests/fixtures/temporal/` — golden fixtures for `renderMarkdown` snapshot tests.
- `tests/entrypoints/consolidate.integration.test.ts` — end-to-end flow with mocked Haiku.

**Modify:**

- `src/helpers/types.ts` — add `StateFact`, `EventRecord`, `WeeklyRecord`, `TemporalStore`, `ExtractedPayload`.
- `prompts/consolidate.prompt.md` — rewrite as extraction prompt.
- `src/entrypoints/consolidate.ts` — rewrite `main()`, replace `parseConsolidateResponse` with `parseExtractResponse`.
- `tests/entrypoints/consolidate.test.ts` — replace `parseConsolidateResponse` tests with `parseExtractResponse`.
- `src/entrypoints/session-start.ts` — prefer `temporal.json`, fall back to legacy `.md`.
- `tests/entrypoints/session-start.test.ts` — add new-path + migration-fallback cases.
- `CLAUDE.md` — document the state/event model and the machine-generated `.md` files.

**Boundaries:**

- `temporal.ts` is pure + I/O only — no prompt rendering, no Haiku calls, no logging. All logging stays in entrypoints.
- Subject normalization (kebab-case) lives inside `mergeExtracted` — one canonical place.
- IDs are generated in `temporal.ts`, never by Haiku.

---

## Task 1: Types scaffolding

**Files:**

- Modify: `src/helpers/types.ts`
- Test: (types are compile-time; covered by downstream tasks)

- [ ] **Step 1: Add temporal types to types.ts**

Append to `src/helpers/types.ts`:

```typescript
export interface StateFact {
  id: string;
  subject: string;
  value: string;
  validFrom: string;
  supersededBy?: string;
  supersededOn?: string;
  supersedes?: string[];
}

export interface EventRecord {
  id: string;
  date: string;
  summary: string;
}

export interface WeeklyRecord {
  id: string;
  weekOf: string;
  summary: string;
}

export interface TemporalStore {
  version: 1;
  state: StateFact[];
  events: {
    recent: EventRecord[];
    weekly: WeeklyRecord[];
  };
}

export interface ExtractedPayload {
  newFacts: { subject: string; value: string }[];
  newEvents: { date: string; summary: string }[];
}
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/helpers/types.ts
git commit -m "feat(types): add temporal store types"
```

---

## Task 2: Temporal store I/O + ID helper

**Files:**

- Create: `src/helpers/temporal.ts`
- Create: `tests/helpers/temporal.test.ts`

- [ ] **Step 1: Write failing tests for I/O + ID helper**

Create `tests/helpers/temporal.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_STORE,
  nextId,
  readTemporal,
  writeTemporal,
} from "../../src/helpers/temporal.ts";
import type { TemporalStore } from "../../src/helpers/types.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "cm-temporal-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("readTemporal", () => {
  it("returns empty store when file is missing", () => {
    expect(readTemporal(dataDir)).toEqual(EMPTY_STORE);
  });

  it("reads a valid store", () => {
    const store: TemporalStore = {
      version: 1,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
        },
      ],
      events: { recent: [], weekly: [] },
    };
    writeFileSync(
      path.join(dataDir, "temporal.json"),
      JSON.stringify(store),
      "utf8",
    );
    expect(readTemporal(dataDir)).toEqual(store);
  });

  it("throws a migration error on version mismatch", () => {
    writeFileSync(
      path.join(dataDir, "temporal.json"),
      JSON.stringify({
        version: 99,
        state: [],
        events: { recent: [], weekly: [] },
      }),
      "utf8",
    );
    expect(() => readTemporal(dataDir)).toThrow(/version/);
  });

  it("returns empty store on malformed JSON (does not throw)", () => {
    writeFileSync(path.join(dataDir, "temporal.json"), "not json", "utf8");
    expect(readTemporal(dataDir)).toEqual(EMPTY_STORE);
  });
});

describe("writeTemporal", () => {
  it("writes the store via atomic rename", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "test-runner",
          value: "vitest",
          validFrom: "2026-04-20",
        },
      ],
    };
    writeTemporal(dataDir, store);
    const raw = readFileSync(path.join(dataDir, "temporal.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(store);
  });

  it("creates the data directory if missing", () => {
    const nested = path.join(dataDir, "nested");
    writeTemporal(nested, EMPTY_STORE);
    expect(readTemporal(nested)).toEqual(EMPTY_STORE);
  });
});

describe("nextId", () => {
  it("returns 's1' for empty state", () => {
    expect(nextId(EMPTY_STORE, "s")).toBe("s1");
  });

  it("returns max+1 across state prefix", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        { id: "s1", subject: "a", value: "x", validFrom: "2026-01-01" },
        { id: "s7", subject: "b", value: "y", validFrom: "2026-01-02" },
        { id: "s3", subject: "c", value: "z", validFrom: "2026-01-03" },
      ],
    };
    expect(nextId(store, "s")).toBe("s8");
  });

  it("returns max+1 across recent events", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [{ id: "e4", date: "2026-04-18", summary: "x" }],
        weekly: [{ id: "w2", weekOf: "2026-03-09", summary: "y" }],
      },
    };
    expect(nextId(store, "e")).toBe("e5");
    expect(nextId(store, "w")).toBe("w3");
  });

  it("ignores ids from other prefixes", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [{ id: "s99", subject: "a", value: "x", validFrom: "2026-01-01" }],
    };
    expect(nextId(store, "e")).toBe("e1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/helpers/temporal.test.ts`
Expected: FAIL — module not found at `src/helpers/temporal.ts`.

- [ ] **Step 3: Create temporal.ts with I/O + ID helper**

Create `src/helpers/temporal.ts`:

```typescript
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { TemporalStore } from "./types.ts";

export const EMPTY_STORE: TemporalStore = {
  version: 1,
  state: [],
  events: { recent: [], weekly: [] },
};

function isTemporalStore(value: unknown): value is TemporalStore {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.state)) return false;
  if (typeof v.events !== "object" || v.events === null) return false;
  const events = v.events as Record<string, unknown>;
  if (!Array.isArray(events.recent)) return false;
  if (!Array.isArray(events.weekly)) return false;
  return true;
}

export function readTemporal(dataDir: string): TemporalStore {
  const filePath = path.join(dataDir, "temporal.json");
  if (!existsSync(filePath)) return EMPTY_STORE;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return EMPTY_STORE;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STORE;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    (parsed as Record<string, unknown>).version !== 1
  ) {
    throw new Error(
      `temporal.json has unsupported version: ${(parsed as Record<string, unknown>).version}. Migration required.`,
    );
  }

  if (!isTemporalStore(parsed)) return EMPTY_STORE;

  return parsed;
}

export function writeTemporal(dataDir: string, store: TemporalStore): void {
  mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, "temporal.json");
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

export function nextId(store: TemporalStore, prefix: "s" | "e" | "w"): string {
  const ids: string[] = [
    ...store.state.map((s) => s.id),
    ...store.events.recent.map((e) => e.id),
    ...store.events.weekly.map((w) => w.id),
  ];

  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/helpers/temporal.test.ts`
Expected: PASS — all tests in `readTemporal`, `writeTemporal`, `nextId` groups green.

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/helpers/temporal.ts tests/helpers/temporal.test.ts
git commit -m "feat(temporal): add store I/O + monotonic id helper"
```

---

## Task 3: `mergeExtracted` — state-fact supersession

**Files:**

- Modify: `src/helpers/temporal.ts`
- Modify: `tests/helpers/temporal.test.ts`

- [ ] **Step 1: Add failing tests for state-fact merging**

Append to `tests/helpers/temporal.test.ts`:

```typescript
import {
  mergeExtracted,
  normalizeSubject,
} from "../../src/helpers/temporal.ts";

describe("normalizeSubject", () => {
  it("lowercases + kebab-cases camelCase", () => {
    expect(normalizeSubject("pkgManager")).toBe("pkg-manager");
  });

  it("replaces whitespace/underscores with hyphens", () => {
    expect(normalizeSubject("test_runner name")).toBe("test-runner-name");
  });

  it("collapses repeated separators and trims", () => {
    expect(normalizeSubject("  --Foo__bar--  ")).toBe("foo-bar");
  });
});

describe("mergeExtracted: state facts", () => {
  it("inserts a new fact into an empty store", () => {
    const store = EMPTY_STORE;
    const result = mergeExtracted(store, "2026-04-20", {
      newFacts: [{ subject: "pkg-manager", value: "pnpm" }],
      newEvents: [],
    });
    expect(result.state).toEqual([
      {
        id: "s1",
        subject: "pkg-manager",
        value: "pnpm",
        validFrom: "2026-04-20",
      },
    ]);
  });

  it("normalizes subject keys before comparing", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
        },
      ],
    };
    // Haiku returned "pkgManager" — should match existing "pkg-manager"
    const result = mergeExtracted(store, "2026-04-20", {
      newFacts: [{ subject: "pkgManager", value: "pnpm" }],
      newEvents: [],
    });
    expect(result.state.length).toBe(1);
  });

  it("is a no-op when value is unchanged", () => {
    const existing: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
        },
      ],
    };
    const result = mergeExtracted(existing, "2026-04-20", {
      newFacts: [{ subject: "pkg-manager", value: "pnpm" }],
      newEvents: [],
    });
    expect(result.state).toEqual(existing.state);
  });

  it("marks supersession when value changes", () => {
    const existing: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
        },
      ],
    };
    const result = mergeExtracted(existing, "2026-04-01", {
      newFacts: [{ subject: "pkg-manager", value: "npm (migrated from pnpm)" }],
      newEvents: [],
    });
    expect(result.state).toEqual([
      {
        id: "s1",
        subject: "pkg-manager",
        value: "pnpm",
        validFrom: "2026-03-12",
        supersededBy: "s2",
        supersededOn: "2026-04-01",
      },
      {
        id: "s2",
        subject: "pkg-manager",
        value: "npm (migrated from pnpm)",
        validFrom: "2026-04-01",
        supersedes: ["s1"],
      },
    ]);
  });

  it("ignores already-superseded facts when finding current value", () => {
    const existing: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "yarn",
          validFrom: "2026-01-01",
          supersededBy: "s2",
          supersededOn: "2026-03-12",
        },
        {
          id: "s2",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
          supersedes: ["s1"],
        },
      ],
    };
    const result = mergeExtracted(existing, "2026-04-01", {
      newFacts: [{ subject: "pkg-manager", value: "npm" }],
      newEvents: [],
    });
    // s2 (current) is superseded; s1 (already superseded) is untouched.
    const s1 = result.state.find((s) => s.id === "s1");
    const s2 = result.state.find((s) => s.id === "s2");
    const s3 = result.state.find((s) => s.id === "s3");
    expect(s1?.supersededBy).toBe("s2");
    expect(s2?.supersededBy).toBe("s3");
    expect(s2?.supersededOn).toBe("2026-04-01");
    expect(s3?.value).toBe("npm");
    expect(s3?.supersedes).toEqual(["s2"]);
  });

  it("processes multiple new facts atomically (ids do not collide)", () => {
    const result = mergeExtracted(EMPTY_STORE, "2026-04-20", {
      newFacts: [
        { subject: "pkg-manager", value: "npm" },
        { subject: "test-runner", value: "vitest" },
      ],
      newEvents: [],
    });
    const ids = result.state.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("does not mutate the input store", () => {
    const existing: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
        },
      ],
    };
    const snapshot = structuredClone(existing);
    mergeExtracted(existing, "2026-04-01", {
      newFacts: [{ subject: "pkg-manager", value: "npm" }],
      newEvents: [],
    });
    expect(existing).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/helpers/temporal.test.ts -t "mergeExtracted|normalizeSubject"`
Expected: FAIL — `mergeExtracted` and `normalizeSubject` not exported.

- [ ] **Step 3: Implement `normalizeSubject` + state branch of `mergeExtracted`**

In `src/helpers/temporal.ts`, replace the existing type import line

```typescript
import type { TemporalStore } from "./types.ts";
```

with:

```typescript
import type {
  EventRecord,
  ExtractedPayload,
  StateFact,
  TemporalStore,
} from "./types.ts";
```

Then append to the file:

```typescript
export function normalizeSubject(raw: string): string {
  return raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // camelCase → kebab
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cloneStore(store: TemporalStore): TemporalStore {
  return {
    version: 1,
    state: store.state.map((s) => ({
      ...s,
      supersedes: s.supersedes?.slice(),
    })),
    events: {
      recent: store.events.recent.map((e) => ({ ...e })),
      weekly: store.events.weekly.map((w) => ({ ...w })),
    },
  };
}

function findCurrentFact(
  state: StateFact[],
  subject: string,
): StateFact | undefined {
  return state.find(
    (s) => s.subject === subject && s.supersededBy === undefined,
  );
}

export function mergeExtracted(
  store: TemporalStore,
  today: string,
  payload: ExtractedPayload,
): TemporalStore {
  const next = cloneStore(store);

  for (const { subject: rawSubject, value } of payload.newFacts) {
    const subject = normalizeSubject(rawSubject);
    if (subject === "") continue;

    const current = findCurrentFact(next.state, subject);

    if (current === undefined) {
      next.state.push({
        id: nextId(next, "s"),
        subject,
        value,
        validFrom: today,
      });
      continue;
    }

    if (current.value === value) continue;

    const newFact: StateFact = {
      id: nextId(next, "s"),
      subject,
      value,
      validFrom: today,
      supersedes: [current.id],
    };
    current.supersededBy = newFact.id;
    current.supersededOn = today;
    next.state.push(newFact);
  }

  // Event branch is implemented in Task 4.

  return next;
}
```

- [ ] **Step 4: Run tests to verify state-fact tests pass**

Run: `npx vitest run tests/helpers/temporal.test.ts -t "mergeExtracted: state facts|normalizeSubject"`
Expected: PASS on all state-fact and normalizeSubject tests.

- [ ] **Step 5: Run full temporal suite to verify nothing regressed**

Run: `npx vitest run tests/helpers/temporal.test.ts`
Expected: PASS on all existing tests; only event-related tests (added in Task 4) would still fail if present.

- [ ] **Step 6: Commit**

```bash
git add src/helpers/temporal.ts tests/helpers/temporal.test.ts
git commit -m "feat(temporal): merge state facts with supersession detection"
```

---

## Task 4: `mergeExtracted` — event branch

**Files:**

- Modify: `src/helpers/temporal.ts`
- Modify: `tests/helpers/temporal.test.ts`

- [ ] **Step 1: Add failing tests for event appending**

Append to `tests/helpers/temporal.test.ts`:

```typescript
describe("mergeExtracted: events", () => {
  it("appends a new event to recent", () => {
    const result = mergeExtracted(EMPTY_STORE, "2026-04-20", {
      newFacts: [],
      newEvents: [{ date: "2026-04-20", summary: "hello" }],
    });
    expect(result.events.recent).toEqual([
      { id: "e1", date: "2026-04-20", summary: "hello" },
    ]);
  });

  it("assigns monotonic event ids", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [{ id: "e4", date: "2026-04-18", summary: "old" }],
        weekly: [],
      },
    };
    const result = mergeExtracted(store, "2026-04-20", {
      newFacts: [],
      newEvents: [
        { date: "2026-04-20", summary: "a" },
        { date: "2026-04-20", summary: "b" },
      ],
    });
    const ids = result.events.recent.map((e) => e.id);
    expect(ids).toEqual(["e4", "e5", "e6"]);
  });

  it("does not duplicate an identical event (same date + summary)", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [{ id: "e1", date: "2026-04-20", summary: "hello" }],
        weekly: [],
      },
    };
    const result = mergeExtracted(store, "2026-04-20", {
      newFacts: [],
      newEvents: [{ date: "2026-04-20", summary: "hello" }],
    });
    expect(result.events.recent).toEqual(store.events.recent);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/helpers/temporal.test.ts -t "mergeExtracted: events"`
Expected: FAIL — events array remains empty.

- [ ] **Step 3: Implement event branch in `mergeExtracted`**

In `src/helpers/temporal.ts`, replace the `// Event branch is implemented in Task 4.` comment inside `mergeExtracted` with:

```typescript
for (const { date, summary } of payload.newEvents) {
  const duplicate = next.events.recent.some(
    (e) => e.date === date && e.summary === summary,
  );
  if (duplicate) continue;

  next.events.recent.push({
    id: nextId(next, "e"),
    date,
    summary,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/helpers/temporal.test.ts`
Expected: PASS — every `mergeExtracted` test green, including the new event tests.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/temporal.ts tests/helpers/temporal.test.ts
git commit -m "feat(temporal): append events with dedup in mergeExtracted"
```

---

## Task 5: `rollEvents`

**Files:**

- Modify: `src/helpers/temporal.ts`
- Modify: `tests/helpers/temporal.test.ts`

- [ ] **Step 1: Add failing tests for `rollEvents`**

Append to `tests/helpers/temporal.test.ts`:

```typescript
import { rollEvents, weekOfMonday } from "../../src/helpers/temporal.ts";

describe("weekOfMonday", () => {
  it("returns the date itself for a Monday", () => {
    expect(weekOfMonday("2026-03-09")).toBe("2026-03-09"); // 2026-03-09 is a Monday
  });

  it("returns the Monday for a Sunday", () => {
    expect(weekOfMonday("2026-03-15")).toBe("2026-03-09"); // 2026-03-15 is a Sunday
  });

  it("returns the Monday for a Friday", () => {
    expect(weekOfMonday("2026-04-17")).toBe("2026-04-13"); // 2026-04-17 is a Friday
  });
});

describe("rollEvents", () => {
  it("keeps events within the horizon in recent", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [
          { id: "e1", date: "2026-04-20", summary: "today" },
          { id: "e2", date: "2026-04-19", summary: "yesterday" },
          { id: "e3", date: "2026-04-17", summary: "3 days ago" },
        ],
        weekly: [],
      },
    };
    const result = rollEvents(store, "2026-04-20", 3);
    expect(result.events.recent.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(result.events.weekly).toEqual([]);
  });

  it("rolls events older than horizon into weekly", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [
          { id: "e1", date: "2026-04-20", summary: "today" },
          { id: "e2", date: "2026-04-16", summary: "4 days ago" },
        ],
        weekly: [],
      },
    };
    const result = rollEvents(store, "2026-04-20", 3);
    expect(result.events.recent.map((e) => e.id)).toEqual(["e1"]);
    expect(result.events.weekly.length).toBe(1);
    const week = result.events.weekly[0];
    expect(week?.weekOf).toBe("2026-04-13");
    expect(week?.summary).toContain("4 days ago");
  });

  it("merges events from the same week into one weekly entry", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [
          { id: "e1", date: "2026-04-13", summary: "Mon" },
          { id: "e2", date: "2026-04-15", summary: "Wed" },
          { id: "e3", date: "2026-04-17", summary: "Fri" },
        ],
        weekly: [],
      },
    };
    const result = rollEvents(store, "2026-04-30", 3);
    expect(result.events.recent).toEqual([]);
    expect(result.events.weekly.length).toBe(1);
    const summary = result.events.weekly[0]?.summary ?? "";
    expect(summary).toContain("Mon");
    expect(summary).toContain("Wed");
    expect(summary).toContain("Fri");
  });

  it("appends to an existing weekly entry for the same week", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [{ id: "e2", date: "2026-04-15", summary: "Wed" }],
        weekly: [{ id: "w1", weekOf: "2026-04-13", summary: "Mon thing" }],
      },
    };
    const result = rollEvents(store, "2026-04-30", 3);
    expect(result.events.weekly.length).toBe(1);
    const summary = result.events.weekly[0]?.summary ?? "";
    expect(summary).toContain("Mon thing");
    expect(summary).toContain("Wed");
  });

  it("sorts weekly entries ascending by weekOf", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [
          { id: "e1", date: "2026-04-01", summary: "A" },
          { id: "e2", date: "2026-03-10", summary: "B" },
          { id: "e3", date: "2026-03-20", summary: "C" },
        ],
        weekly: [],
      },
    };
    const result = rollEvents(store, "2026-04-30", 3);
    const weeks = result.events.weekly.map((w) => w.weekOf);
    expect(weeks).toEqual([...weeks].sort());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/helpers/temporal.test.ts -t "rollEvents|weekOfMonday"`
Expected: FAIL — `rollEvents` and `weekOfMonday` not exported.

- [ ] **Step 3: Implement `weekOfMonday` + `rollEvents`**

Append to `src/helpers/temporal.ts`:

```typescript
export function weekOfMonday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  // getUTCDay: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const day = dt.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  dt.setUTCDate(dt.getUTCDate() - diff);

  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy ?? 1970, (fm ?? 1) - 1, fd ?? 1);
  const b = Date.UTC(ty ?? 1970, (tm ?? 1) - 1, td ?? 1);
  return Math.floor((b - a) / 86_400_000);
}

export function rollEvents(
  store: TemporalStore,
  today: string,
  horizonDays: number,
): TemporalStore {
  const next = cloneStore(store);
  const stayRecent: EventRecord[] = [];
  const toRoll: EventRecord[] = [];

  for (const event of next.events.recent) {
    const age = daysBetween(event.date, today);
    if (age <= horizonDays) {
      stayRecent.push(event);
    } else {
      toRoll.push(event);
    }
  }

  if (toRoll.length === 0) {
    return {
      ...next,
      events: { recent: stayRecent, weekly: next.events.weekly },
    };
  }

  const weeklyById = new Map(next.events.weekly.map((w) => [w.weekOf, w]));

  for (const event of toRoll) {
    const wk = weekOfMonday(event.date);
    const existing = weeklyById.get(wk);
    if (existing !== undefined) {
      existing.summary = `${existing.summary} · ${event.date}: ${event.summary}`;
    } else {
      const created = {
        id: nextId(
          { ...next, events: { recent: [], weekly: [...weeklyById.values()] } },
          "w",
        ),
        weekOf: wk,
        summary: `${event.date}: ${event.summary}`,
      };
      weeklyById.set(wk, created);
    }
  }

  const weekly = [...weeklyById.values()].sort((a, b) =>
    a.weekOf.localeCompare(b.weekOf),
  );

  return { ...next, events: { recent: stayRecent, weekly } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/helpers/temporal.test.ts -t "rollEvents|weekOfMonday"`
Expected: PASS on all `rollEvents` and `weekOfMonday` tests.

- [ ] **Step 5: Commit**

```bash
git add src/helpers/temporal.ts tests/helpers/temporal.test.ts
git commit -m "feat(temporal): roll aged recent events into weekly buckets"
```

---

## Task 6: `renderMarkdown` + `currentSubjects`

**Files:**

- Modify: `src/helpers/temporal.ts`
- Modify: `tests/helpers/temporal.test.ts`
- Create: `tests/fixtures/temporal/rendered-shortTerm.md`
- Create: `tests/fixtures/temporal/rendered-longTerm.md`

- [ ] **Step 1: Create golden fixture for short-term render**

Create `tests/fixtures/temporal/rendered-shortTerm.md`:

```markdown
# Short-Term Memory

## State
- ci-provider: github-actions  (since 2026-03-12)
- pkg-manager: npm (migrated from pnpm)  (since 2026-04-01)
- test-runner: vitest  (since 2026-03-12)

### Previously (superseded — do not follow)
- pkg-manager: pnpm  (2026-03-12 → 2026-04-01)

## Recent events
- 2026-04-01: pnpm→npm migration
- 2026-03-30: biome 4-space
```

- [ ] **Step 2: Create golden fixture for long-term render**

Create `tests/fixtures/temporal/rendered-longTerm.md`:

```markdown
# Long-Term Memory

## Week of 2026-03-09
- Set up vitest harness; 118 tests green.
```

- [ ] **Step 3: Add failing tests for `renderMarkdown` + `currentSubjects`**

Append to `tests/helpers/temporal.test.ts`:

```typescript
import { currentSubjects, renderMarkdown } from "../../src/helpers/temporal.ts";

const FIXTURE_DIR = path.resolve("tests/fixtures/temporal");

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8").trim();
}

describe("currentSubjects", () => {
  it("returns only non-superseded subjects, sorted", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
          supersededBy: "s2",
          supersededOn: "2026-04-01",
        },
        {
          id: "s2",
          subject: "pkg-manager",
          value: "npm",
          validFrom: "2026-04-01",
          supersedes: ["s1"],
        },
        {
          id: "s3",
          subject: "test-runner",
          value: "vitest",
          validFrom: "2026-03-12",
        },
      ],
    };
    expect(currentSubjects(store)).toEqual(["pkg-manager", "test-runner"]);
  });

  it("returns empty array for empty store", () => {
    expect(currentSubjects(EMPTY_STORE)).toEqual([]);
  });
});

describe("renderMarkdown", () => {
  const RICH_STORE: TemporalStore = {
    version: 1,
    state: [
      {
        id: "s1",
        subject: "pkg-manager",
        value: "pnpm",
        validFrom: "2026-03-12",
        supersededBy: "s4",
        supersededOn: "2026-04-01",
      },
      {
        id: "s2",
        subject: "test-runner",
        value: "vitest",
        validFrom: "2026-03-12",
      },
      {
        id: "s3",
        subject: "ci-provider",
        value: "github-actions",
        validFrom: "2026-03-12",
      },
      {
        id: "s4",
        subject: "pkg-manager",
        value: "npm (migrated from pnpm)",
        validFrom: "2026-04-01",
        supersedes: ["s1"],
      },
    ],
    events: {
      recent: [
        { id: "e1", date: "2026-04-01", summary: "pnpm→npm migration" },
        { id: "e2", date: "2026-03-30", summary: "biome 4-space" },
      ],
      weekly: [
        {
          id: "w1",
          weekOf: "2026-03-09",
          summary: "Set up vitest harness; 118 tests green.",
        },
      ],
    },
  };

  it("renders short-term matching golden fixture", () => {
    const { shortTerm } = renderMarkdown(RICH_STORE, "2026-04-20");
    expect(shortTerm.trim()).toBe(readFixture("rendered-shortTerm.md"));
  });

  it("renders long-term matching golden fixture", () => {
    const { longTerm } = renderMarkdown(RICH_STORE, "2026-04-20");
    expect(longTerm.trim()).toBe(readFixture("rendered-longTerm.md"));
  });

  it("omits the Previously section when no superseded facts exist", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "npm",
          validFrom: "2026-04-01",
        },
      ],
    };
    const { shortTerm } = renderMarkdown(store, "2026-04-20");
    expect(shortTerm).not.toContain("Previously");
  });

  it("returns empty strings for an empty store", () => {
    const { shortTerm, longTerm } = renderMarkdown(EMPTY_STORE, "2026-04-20");
    expect(shortTerm).toBe("");
    expect(longTerm).toBe("");
  });

  it("sorts current state alphabetically by subject", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        { id: "s1", subject: "z-last", value: "x", validFrom: "2026-04-01" },
        { id: "s2", subject: "a-first", value: "y", validFrom: "2026-04-01" },
      ],
    };
    const { shortTerm } = renderMarkdown(store, "2026-04-20");
    const zIdx = shortTerm.indexOf("z-last");
    const aIdx = shortTerm.indexOf("a-first");
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(zIdx);
  });

  it("sorts superseded entries most-recent-first", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      state: [
        {
          id: "s1",
          subject: "a",
          value: "old",
          validFrom: "2026-01-01",
          supersededBy: "s2",
          supersededOn: "2026-02-01",
        },
        {
          id: "s2",
          subject: "a",
          value: "mid",
          validFrom: "2026-02-01",
          supersedes: ["s1"],
          supersededBy: "s3",
          supersededOn: "2026-04-01",
        },
        {
          id: "s3",
          subject: "a",
          value: "new",
          validFrom: "2026-04-01",
          supersedes: ["s2"],
        },
      ],
    };
    const { shortTerm } = renderMarkdown(store, "2026-04-20");
    const midIdx = shortTerm.indexOf("mid");
    const oldIdx = shortTerm.indexOf("old");
    expect(midIdx).toBeLessThan(oldIdx);
  });

  it("sorts recent events reverse-chronologically", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [
          { id: "e1", date: "2026-03-30", summary: "older" },
          { id: "e2", date: "2026-04-01", summary: "newer" },
        ],
        weekly: [],
      },
    };
    const { shortTerm } = renderMarkdown(store, "2026-04-20");
    const newerIdx = shortTerm.indexOf("newer");
    const olderIdx = shortTerm.indexOf("older");
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("sorts weekly long-term reverse-chronologically", () => {
    const store: TemporalStore = {
      ...EMPTY_STORE,
      events: {
        recent: [],
        weekly: [
          { id: "w1", weekOf: "2026-03-09", summary: "early" },
          { id: "w2", weekOf: "2026-03-16", summary: "late" },
        ],
      },
    };
    const { longTerm } = renderMarkdown(store, "2026-04-20");
    const lateIdx = longTerm.indexOf("late");
    const earlyIdx = longTerm.indexOf("early");
    expect(lateIdx).toBeLessThan(earlyIdx);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/helpers/temporal.test.ts -t "renderMarkdown|currentSubjects"`
Expected: FAIL — functions not exported.

- [ ] **Step 5: Implement `currentSubjects` + `renderMarkdown`**

Append to `src/helpers/temporal.ts`:

```typescript
export function currentSubjects(store: TemporalStore): string[] {
  const subjects = new Set<string>();
  for (const s of store.state) {
    if (s.supersededBy === undefined) subjects.add(s.subject);
  }
  return [...subjects].sort();
}

function renderShortTerm(store: TemporalStore): string {
  const current = store.state
    .filter((s) => s.supersededBy === undefined)
    .sort((a, b) => a.subject.localeCompare(b.subject));

  const superseded = store.state
    .filter(
      (s): s is StateFact & { supersededOn: string } =>
        s.supersededOn !== undefined,
    )
    .sort((a, b) => b.supersededOn.localeCompare(a.supersededOn));

  const recent = [...store.events.recent].sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  if (current.length === 0 && superseded.length === 0 && recent.length === 0) {
    return "";
  }

  const lines: string[] = ["# Short-Term Memory", ""];

  if (current.length > 0) {
    lines.push("## State");
    for (const s of current) {
      lines.push(`- ${s.subject}: ${s.value}  (since ${s.validFrom})`);
    }
    lines.push("");
  }

  if (superseded.length > 0) {
    lines.push("### Previously (superseded — do not follow)");
    for (const s of superseded) {
      lines.push(
        `- ${s.subject}: ${s.value}  (${s.validFrom} → ${s.supersededOn})`,
      );
    }
    lines.push("");
  }

  if (recent.length > 0) {
    lines.push("## Recent events");
    for (const e of recent) {
      lines.push(`- ${e.date}: ${e.summary}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderLongTerm(store: TemporalStore): string {
  const weekly = [...store.events.weekly].sort((a, b) =>
    b.weekOf.localeCompare(a.weekOf),
  );
  if (weekly.length === 0) return "";

  const lines: string[] = ["# Long-Term Memory", ""];
  for (const w of weekly) {
    lines.push(`## Week of ${w.weekOf}`);
    lines.push(`- ${w.summary}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderMarkdown(
  store: TemporalStore,
  _today: string,
): { shortTerm: string; longTerm: string } {
  return {
    shortTerm: renderShortTerm(store),
    longTerm: renderLongTerm(store),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/helpers/temporal.test.ts`
Expected: PASS — all temporal tests green, including new renderMarkdown + currentSubjects cases.

- [ ] **Step 7: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: exits 0 for both.

- [ ] **Step 8: Commit**

```bash
git add src/helpers/temporal.ts tests/helpers/temporal.test.ts tests/fixtures/temporal
git commit -m "feat(temporal): render markdown views + current subject glossary"
```

---

## Task 7: Rewrite `consolidate.prompt.md`

**Files:**

- Modify: `prompts/consolidate.prompt.md`

- [ ] **Step 1: Replace the prompt file wholesale**

Overwrite `prompts/consolidate.prompt.md` with:

`````markdown
You extract structured facts from engineering episodes. You do NOT edit, summarise, or reflow existing memory. You produce strict JSON.

## Input

### Episodes (paragraphs to extract from)

{{EPISODES}}

### Known state subjects (reuse these when applicable)

{{SUBJECT_GLOSSARY}}

## What is a state fact vs an event

**STATE FACT** — a durable fact about HOW the project IS configured or WHAT convention applies. Examples:

- "package manager is npm"
- "test runner is vitest"
- "CI runs on GitHub Actions"
- "indent style is 4-space"

State facts have a SUBJECT (kebab-case) and a VALUE. If the subject already appears in the glossary, REUSE the exact key. Only invent a new subject when no existing one fits.

**EVENT** — a thing that HAPPENED on a specific day. Examples:

- "fixed pagination off-by-one"
- "migrated pnpm→npm" (this is an event even though it IS ALSO evidence of a state change — the state change gets captured separately as a state fact)

Events have a DATE (YYYY-MM-DD from the episode's `## YYYY-MM-DD` header) and a SUMMARY (≤ 20 words).

## Rules

1. Prefer reusing subject keys from the glossary. Only invent a new subject when no existing one fits.
2. A single episode can produce zero or many state facts and zero or many events.
3. Ignore iteration / debugging noise that is not a deliverable.
4. Do NOT emit supersession markers or IDs — that is code's job, not yours.
5. Values are ≤ 60 chars. Summaries are ≤ 20 words.
6. Emit state facts about DURABLE configuration, not about today's events. "Migrated to npm" is an event; "npm (migrated from pnpm)" is the new state fact's value.

## Output

Return EXACTLY this JSON and nothing else. No prose before or after. A single ` ```json ` code fence is acceptable.

```json
{
  "newFacts": [{ "subject": "kebab-case", "value": "short string" }],
  "newEvents": [{ "date": "YYYY-MM-DD", "summary": "short string" }]
}
```

Both arrays may be empty. Keys `newFacts` and `newEvents` MUST always be present.
`````

- [ ] **Step 2: Verify the template still renders**

Run: `npx vitest run tests/helpers/prompts.test.ts`
Expected: PASS — existing template-rendering tests unchanged.

- [ ] **Step 3: Commit**

```bash
git add prompts/consolidate.prompt.md
git commit -m "feat(prompts): rewrite consolidate as strict-JSON extraction prompt"
```

---

## Task 8: `parseExtractResponse` + parser tests

**Files:**

- Modify: `src/entrypoints/consolidate.ts`
- Modify: `tests/entrypoints/consolidate.test.ts`

- [ ] **Step 1: Add failing parser tests**

Replace the entire contents of `tests/entrypoints/consolidate.test.ts` with a minimal scaffold that covers the new parser only. (The integration test moves to its own file in Task 9.)

````typescript
import { describe, expect, it } from "vitest";
import { parseExtractResponse } from "../../src/entrypoints/consolidate.ts";

describe("parseExtractResponse", () => {
  it("parses valid bare JSON", () => {
    const raw = `{"newFacts":[{"subject":"pkg-manager","value":"npm"}],"newEvents":[]}`;
    expect(parseExtractResponse(raw)).toEqual({
      newFacts: [{ subject: "pkg-manager", value: "npm" }],
      newEvents: [],
    });
  });

  it("unwraps ```json fence", () => {
    const raw = '```json\n{"newFacts":[],"newEvents":[]}\n```';
    expect(parseExtractResponse(raw)).toEqual({ newFacts: [], newEvents: [] });
  });

  it("unwraps plain ``` fence", () => {
    const raw = '```\n{"newFacts":[],"newEvents":[]}\n```';
    expect(parseExtractResponse(raw)).toEqual({ newFacts: [], newEvents: [] });
  });

  it("throws on malformed JSON with a 120-char snippet", () => {
    const raw = "not-json-at-all";
    expect(() => parseExtractResponse(raw)).toThrow(/not-json-at-all/);
  });

  it("throws when newFacts is missing", () => {
    expect(() => parseExtractResponse(`{"newEvents":[]}`)).toThrow(/newFacts/);
  });

  it("throws when newEvents is missing", () => {
    expect(() => parseExtractResponse(`{"newFacts":[]}`)).toThrow(/newEvents/);
  });

  it("ignores extra top-level keys (forward-compat)", () => {
    const raw = `{"newFacts":[],"newEvents":[],"notes":"ignored"}`;
    expect(parseExtractResponse(raw)).toEqual({ newFacts: [], newEvents: [] });
  });

  it("throws when newFacts item is malformed", () => {
    const raw = `{"newFacts":[{"subject":"x"}],"newEvents":[]}`;
    expect(() => parseExtractResponse(raw)).toThrow();
  });

  it("throws when newEvents item is malformed", () => {
    const raw = `{"newFacts":[],"newEvents":[{"date":"2026-04-20"}]}`;
    expect(() => parseExtractResponse(raw)).toThrow();
  });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/entrypoints/consolidate.test.ts`
Expected: FAIL — `parseExtractResponse` not exported.

- [ ] **Step 3: Replace the parser in `consolidate.ts`**

Open `src/entrypoints/consolidate.ts` and replace the entire `parseConsolidateResponse` function (lines 21-67 in the current file) with:

````typescript
import type { ExtractedPayload } from "../helpers/types.ts";

export function parseExtractResponse(raw: string): ExtractedPayload {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1);
    }
    const closingFence = text.lastIndexOf("```");
    if (closingFence !== -1) {
      text = text.slice(0, closingFence);
    }
    text = text.trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const snippet = raw.slice(0, 120).replace(/\n/g, "\\n");
    throw new Error(`Invalid JSON in Haiku response: "${snippet}"`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Haiku response is not an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.newFacts)) {
    throw new Error("Missing or non-array newFacts in response");
  }
  if (!Array.isArray(obj.newEvents)) {
    throw new Error("Missing or non-array newEvents in response");
  }

  const newFacts = obj.newFacts.map((item, i) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).subject !== "string" ||
      typeof (item as Record<string, unknown>).value !== "string"
    ) {
      throw new Error(`newFacts[${i}] missing subject or value`);
    }
    const rec = item as { subject: string; value: string };
    return { subject: rec.subject, value: rec.value };
  });

  const newEvents = obj.newEvents.map((item, i) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).date !== "string" ||
      typeof (item as Record<string, unknown>).summary !== "string"
    ) {
      throw new Error(`newEvents[${i}] missing date or summary`);
    }
    const rec = item as { date: string; summary: string };
    return { date: rec.date, summary: rec.summary };
  });

  return { newFacts, newEvents };
}
````

Also remove the old `parseConsolidateResponse` export (and any lingering internal references; Task 9 rewrites `main()` to call `parseExtractResponse`).

- [ ] **Step 4: Run parser tests to verify pass**

Run: `npx vitest run tests/entrypoints/consolidate.test.ts`
Expected: PASS on all `parseExtractResponse` tests.

- [ ] **Step 5: Typecheck will fail until Task 9**

Run: `npm run typecheck`
Expected: MAY FAIL — `main()` still references the removed `parseConsolidateResponse` and old helpers. This is resolved in Task 9.

- [ ] **Step 6: Do NOT commit yet** — Task 9 completes the consolidate rewrite. Committing a half-rewritten entrypoint would leave HEAD broken. Continue directly to Task 9.

---

## Task 9: Rewrite `consolidate.ts` main() + integration test

**Files:**

- Modify: `src/entrypoints/consolidate.ts`
- Modify: `src/helpers/memory-files.ts`
- Create: `tests/entrypoints/consolidate.integration.test.ts`

- [ ] **Step 1: Add `eventHorizonDays` + `tokenSoftCap` to config**

Edit `src/helpers/types.ts` — update the `Config` interface:

```typescript
export interface Config {
  cooldowns: { saveSeconds: number; compactSeconds: number };
  thresholds: { minHumanMessages: number; deltaLinesTrigger: number };
  features: { recovery: boolean };
  timezone: string;
  eventHorizonDays: number;
  tokenSoftCap: { shortTerm: number; longTerm: number };
}
```

Edit `src/helpers/config.ts` — extend `DEFAULTS` and the `loadConfig` merge:

```typescript
const DEFAULTS: Config = {
  cooldowns: { saveSeconds: 120, compactSeconds: 3600 },
  thresholds: { minHumanMessages: 3, deltaLinesTrigger: 50 },
  features: { recovery: true },
  timezone: "UTC",
  eventHorizonDays: 3,
  tokenSoftCap: { shortTerm: 800, longTerm: 600 },
};
```

Also extend the `Partial<Config>` shape in `loadConfig` so `tokenSoftCap` merges per-key:

```typescript
const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config> & {
  cooldowns?: Partial<Config["cooldowns"]>;
  thresholds?: Partial<Config["thresholds"]>;
  features?: Partial<Config["features"]>;
  tokenSoftCap?: Partial<Config["tokenSoftCap"]>;
};
return {
  ...DEFAULTS,
  ...raw,
  cooldowns: { ...DEFAULTS.cooldowns, ...(raw.cooldowns ?? {}) },
  thresholds: { ...DEFAULTS.thresholds, ...(raw.thresholds ?? {}) },
  features: { ...DEFAULTS.features, ...(raw.features ?? {}) },
  tokenSoftCap: { ...DEFAULTS.tokenSoftCap, ...(raw.tokenSoftCap ?? {}) },
};
```

- [ ] **Step 2: Rewrite `consolidate.ts` main()**

Replace the entire `src/entrypoints/consolidate.ts` body below the `parseExtractResponse` function with:

```typescript
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../helpers/config.ts";
import { callHaiku } from "../helpers/haiku.ts";
import { acquireLock } from "../helpers/lock.ts";
import { createLogger } from "../helpers/logger.ts";
import {
  listEpisodes,
  writeDerivedMemoryFiles,
} from "../helpers/memory-files.ts";
import { resolvePaths } from "../helpers/paths.ts";
import { loadPrompt, renderPrompt } from "../helpers/prompts.ts";
import {
  currentSubjects,
  mergeExtracted,
  readTemporal,
  renderMarkdown,
  rollEvents,
  writeTemporal,
} from "../helpers/temporal.ts";

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  void argv;

  const { pluginDir, dataDir } = resolvePaths();
  const cfg = loadConfig(pluginDir);
  const logger = createLogger(dataDir, cfg.timezone);

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const episodes = listEpisodes(dataDir, { excludeDate: today });
  if (episodes.length === 0) {
    logger.log("consolidate", "no past episodes, skip");
    return 0;
  }

  const lockPath = path.join(dataDir, "tmp", "consolidate.lock");
  mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

  let releaseLock: (() => void) | undefined;
  try {
    releaseLock = await acquireLock(lockPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("consolidate", msg);
    return 0;
  }

  try {
    const episodesText = episodes
      .map(({ date, path: filePath }) => {
        let content = "";
        try {
          content = readFileSync(filePath, "utf8");
        } catch {
          content = "";
        }
        return `## ${date}\n${content}`;
      })
      .join("\n\n");

    const store = readTemporal(dataDir);
    const glossary = currentSubjects(store);
    const glossaryText =
      glossary.length > 0
        ? glossary.map((s) => `- ${s}`).join("\n")
        : "(none yet)";

    const template = loadPrompt(pluginDir, "consolidate");
    const rendered = renderPrompt(template, {
      EPISODES: episodesText,
      SUBJECT_GLOSSARY: glossaryText,
    });

    let response: Awaited<ReturnType<typeof callHaiku>>;
    try {
      response = await callHaiku(rendered);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `haiku error: ${msg}`);
      return 1;
    }

    let extracted: ReturnType<typeof parseExtractResponse>;
    try {
      extracted = parseExtractResponse(response.text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `parse error: ${msg}`);
      return 1;
    }

    const merged = rollEvents(
      mergeExtracted(store, today, extracted),
      today,
      cfg.eventHorizonDays,
    );

    try {
      writeTemporal(dataDir, merged);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `writeTemporal failed: ${msg}`);
      return 1;
    }

    const rendered_md = renderMarkdown(merged, today);
    writeDerivedMemoryFiles(dataDir, rendered_md);

    // Soft-cap warning: ~4 chars per token is a fine heuristic for English markdown.
    const estTokens = (s: string) => Math.ceil(s.length / 4);
    const shortTok = estTokens(rendered_md.shortTerm);
    const longTok = estTokens(rendered_md.longTerm);
    if (shortTok > cfg.tokenSoftCap.shortTerm) {
      logger.log(
        "consolidate",
        `shortTerm soft cap exceeded: ~${shortTok} > ${cfg.tokenSoftCap.shortTerm} tokens`,
      );
    }
    if (longTok > cfg.tokenSoftCap.longTerm) {
      logger.log(
        "consolidate",
        `longTerm soft cap exceeded: ~${longTok} > ${cfg.tokenSoftCap.longTerm} tokens`,
      );
    }

    for (const { path: filePath } of episodes) {
      rmSync(filePath, { force: true });
    }

    logger.logTokens("consolidate", {
      input: response.tokensIn,
      output: response.tokensOut,
      cache: response.tokensCache,
      costUsd: response.costUsd,
    });

    return 0;
  } finally {
    releaseLock?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(process.exit)
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 3: Add `writeDerivedMemoryFiles` to `memory-files.ts`**

Append to `src/helpers/memory-files.ts`:

```typescript
export function writeDerivedMemoryFiles(
  dataDir: string,
  rendered: { shortTerm: string; longTerm: string },
): void {
  ensureDir(dataDir);
  atomicWrite(path.join(dataDir, "short-term-memory.md"), rendered.shortTerm);
  atomicWrite(path.join(dataDir, "long-term-memory.md"), rendered.longTerm);
}
```

- [ ] **Step 4: Create integration test**

Create `tests/entrypoints/consolidate.integration.test.ts`:

```typescript
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockedFunction,
  vi,
} from "vitest";
import type { HaikuResponse, TemporalStore } from "../../src/helpers/types.ts";

vi.mock("../../src/helpers/haiku.ts", () => ({
  callHaiku: vi.fn(),
}));

import { main } from "../../src/entrypoints/consolidate.ts";
import { callHaiku } from "../../src/helpers/haiku.ts";

const mockCallHaiku = callHaiku as MockedFunction<typeof callHaiku>;

let projectDir: string;
let pluginDir: string;
let dataDir: string;
let originalEnv: NodeJS.ProcessEnv;

function setup(): void {
  projectDir = mkdtempSync(path.join(tmpdir(), "cm-consol-int-proj-"));
  pluginDir = mkdtempSync(path.join(tmpdir(), "cm-consol-int-plug-"));
  dataDir = path.join(projectDir, ".claude-memory");

  const promptsDir = path.join(pluginDir, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  const real = readFileSync(
    path.resolve("prompts/consolidate.prompt.md"),
    "utf8",
  );
  writeFileSync(path.join(promptsDir, "consolidate.prompt.md"), real, "utf8");

  originalEnv = { ...process.env };
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PLUGIN_ROOT = pluginDir;
}

function teardown(): void {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(pluginDir, { recursive: true, force: true });
  process.env = originalEnv;
  mockCallHaiku.mockReset();
}

function writeEpisode(date: string, content: string): void {
  const dir = path.join(dataDir, "episodic-memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${date}.md`), content, "utf8");
}

function writeTemporal(store: TemporalStore): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, "temporal.json"),
    JSON.stringify(store),
    "utf8",
  );
}

function haikuResp(payload: unknown): HaikuResponse {
  return {
    text: JSON.stringify(payload),
    isSkip: false,
    tokensIn: 100,
    tokensOut: 50,
    tokensCache: 0,
    costUsd: 0.001,
  };
}

describe("consolidate integration", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("detects a contradiction and writes supersession edges", async () => {
    writeTemporal({
      version: 1,
      state: [
        {
          id: "s1",
          subject: "pkg-manager",
          value: "pnpm",
          validFrom: "2026-03-12",
        },
      ],
      events: { recent: [], weekly: [] },
    });
    writeEpisode(
      "2026-04-18",
      "Migrated from pnpm to npm. Fixed pagination off-by-one.",
    );

    mockCallHaiku.mockResolvedValueOnce(
      haikuResp({
        newFacts: [
          { subject: "pkg-manager", value: "npm (migrated from pnpm)" },
        ],
        newEvents: [
          {
            date: "2026-04-18",
            summary: "pnpm→npm migration; paginator off-by-one",
          },
        ],
      }),
    );

    const exit = await main();
    expect(exit).toBe(0);

    const temporal = JSON.parse(
      readFileSync(path.join(dataDir, "temporal.json"), "utf8"),
    ) as TemporalStore;
    const s1 = temporal.state.find((s) => s.id === "s1");
    const s2 = temporal.state.find((s) => s.id === "s2");
    expect(s1?.supersededBy).toBe("s2");
    expect(s2?.supersedes).toEqual(["s1"]);

    // Episode deleted
    expect(
      existsSync(path.join(dataDir, "episodic-memory", "2026-04-18.md")),
    ).toBe(false);

    // Derived markdown files populated
    const shortTerm = readFileSync(
      path.join(dataDir, "short-term-memory.md"),
      "utf8",
    );
    expect(shortTerm).toContain("npm (migrated from pnpm)");
    expect(shortTerm).toContain("Previously (superseded — do not follow)");
    expect(shortTerm).toContain("pnpm");
  });

  it("does not delete episodes if Haiku JSON is malformed", async () => {
    writeEpisode("2026-04-18", "something happened");
    mockCallHaiku.mockResolvedValueOnce({
      text: "not json at all",
      isSkip: false,
      tokensIn: 10,
      tokensOut: 10,
      tokensCache: 0,
      costUsd: 0,
    });

    const exit = await main();
    expect(exit).toBe(1);

    expect(
      existsSync(path.join(dataDir, "episodic-memory", "2026-04-18.md")),
    ).toBe(true);
    expect(existsSync(path.join(dataDir, "temporal.json"))).toBe(false);
  });

  it("creates temporal.json on first run when absent", async () => {
    writeEpisode("2026-04-18", "Set up vitest");
    mockCallHaiku.mockResolvedValueOnce(
      haikuResp({
        newFacts: [{ subject: "test-runner", value: "vitest" }],
        newEvents: [{ date: "2026-04-18", summary: "Set up vitest harness" }],
      }),
    );

    const exit = await main();
    expect(exit).toBe(0);
    expect(existsSync(path.join(dataDir, "temporal.json"))).toBe(true);
  });
});
```

- [ ] **Step 5: Run integration tests**

Run: `npx vitest run tests/entrypoints/consolidate.integration.test.ts`
Expected: PASS all three cases.

- [ ] **Step 6: Run the full test suite + typecheck + lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green. If any other test file referenced the removed `parseConsolidateResponse`, fix it by renaming the import to `parseExtractResponse` (signature is compatible for the simple call sites) OR deleting the stale test case.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: exits 0; new `dist/entrypoints/consolidate.mjs` produced.

- [ ] **Step 8: Commit**

```bash
git add src/entrypoints/consolidate.ts src/helpers/memory-files.ts src/helpers/types.ts src/helpers/config.ts tests/entrypoints/consolidate.test.ts tests/entrypoints/consolidate.integration.test.ts
git commit -m "feat(consolidate): extract→merge pipeline with temporal.json as source of truth"
```

---

## Task 10: `session-start` prefers temporal.json, falls back to legacy

**Files:**

- Modify: `src/entrypoints/session-start.ts`
- Modify: `tests/entrypoints/session-start.test.ts`

- [ ] **Step 1: Add failing tests for the new + migration paths**

Open `tests/entrypoints/session-start.test.ts`. Append two new test cases:

```typescript
describe("session-start with temporal.json", () => {
  it("renders from temporal.json when present (ignores legacy .md)", async () => {
    // Assumes the existing setup() helper in this file creates dataDir.
    // Write a temporal.json with a superseded fact.
    writeFileSync(
      path.join(dataDir, "temporal.json"),
      JSON.stringify({
        version: 1,
        state: [
          {
            id: "s1",
            subject: "pkg-manager",
            value: "pnpm",
            validFrom: "2026-03-12",
            supersededBy: "s2",
            supersededOn: "2026-04-01",
          },
          {
            id: "s2",
            subject: "pkg-manager",
            value: "npm",
            validFrom: "2026-04-01",
            supersedes: ["s1"],
          },
        ],
        events: { recent: [], weekly: [] },
      }),
      "utf8",
    );

    // Write a stale legacy file that should NOT appear.
    writeFileSync(
      path.join(dataDir, "short-term-memory.md"),
      "# Short-Term Memory\n\n## 2026-01-01\nstale content",
      "utf8",
    );

    const { stdout } = await runSessionStart();
    expect(stdout).toContain("pkg-manager: npm");
    expect(stdout).toContain("Previously (superseded — do not follow)");
    expect(stdout).not.toContain("stale content");
  });

  it("falls back to legacy .md files when temporal.json is absent", async () => {
    writeFileSync(
      path.join(dataDir, "short-term-memory.md"),
      "# Short-Term Memory\n\n## 2026-01-01\nlegacy content",
      "utf8",
    );

    const { stdout } = await runSessionStart();
    expect(stdout).toContain("legacy content");
  });
});
```

(If the existing test file does not already expose `dataDir` / `runSessionStart` helpers, adapt by inlining the setup — follow the pattern already present in the file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/entrypoints/session-start.test.ts -t "temporal.json"`
Expected: FAIL — session-start currently emits legacy `.md` only.

- [ ] **Step 3: Modify `session-start.ts`**

In `src/entrypoints/session-start.ts`, add imports near the top:

```typescript
import { readTemporal, renderMarkdown } from "../helpers/temporal.ts";
```

Replace the block that builds `memoryFiles` and emits them (currently lines 173-211) with:

```typescript
// 6. Emit memory sections wrapped in "=== MEMORY ==="
const alwaysFiles = [
  path.join(dataDir, "agent-role.md"),
  path.join(dataDir, "core-memories.md"),
  path.join(dataDir, "session-handover.md"),
  path.join(dataDir, "episodic-memory", `${today}.md`),
  path.join(dataDir, "working-memory.md"),
];

const alwaysResults = alwaysFiles.map((filePath) => {
  if (!existsSync(filePath)) return { filePath, hasContent: false };
  try {
    const content = readFileSync(filePath, "utf8");
    return { filePath, hasContent: content.trim().length > 0 };
  } catch {
    return { filePath, hasContent: false };
  }
});

// Prefer temporal.json; fall back to legacy short/long-term .md files.
let temporalShortTerm = "";
let temporalLongTerm = "";
let usedTemporal = false;
try {
  const store = readTemporal(dataDir);
  if (
    store.state.length > 0 ||
    store.events.recent.length > 0 ||
    store.events.weekly.length > 0
  ) {
    const r = renderMarkdown(store, today);
    temporalShortTerm = r.shortTerm;
    temporalLongTerm = r.longTerm;
    usedTemporal = true;
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  logger.log("session-start", `readTemporal failed: ${msg}`);
}

const legacyShortPath = path.join(dataDir, "short-term-memory.md");
const legacyLongPath = path.join(dataDir, "long-term-memory.md");

const legacyShort =
  !usedTemporal && existsSync(legacyShortPath)
    ? readFileSync(legacyShortPath, "utf8")
    : "";
const legacyLong =
  !usedTemporal && existsSync(legacyLongPath)
    ? readFileSync(legacyLongPath, "utf8")
    : "";

const shortTermContent = usedTemporal ? temporalShortTerm : legacyShort;
const longTermContent = usedTemporal ? temporalLongTerm : legacyLong;

const anyContent =
  alwaysResults.some((r) => r.hasContent) ||
  shortTermContent.trim().length > 0 ||
  longTermContent.trim().length > 0;

if (anyContent) {
  process.stdout.write("=== MEMORY ===\n\n");
  for (const { filePath } of alwaysResults) {
    try {
      emitFile(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("session-start", `emitFile failed for ${filePath}: ${msg}`);
    }
  }
  if (shortTermContent.trim().length > 0) {
    process.stdout.write("--- short-term-memory.md ---\n");
    process.stdout.write(shortTermContent);
    if (!shortTermContent.endsWith("\n")) process.stdout.write("\n");
    process.stdout.write("\n");
  }
  if (longTermContent.trim().length > 0) {
    process.stdout.write("--- long-term-memory.md ---\n");
    process.stdout.write(longTermContent);
    if (!longTermContent.endsWith("\n")) process.stdout.write("\n");
    process.stdout.write("\n");
  }
}
```

- [ ] **Step 4: Run the new tests to verify pass**

Run: `npx vitest run tests/entrypoints/session-start.test.ts -t "temporal.json"`
Expected: PASS on both the `temporal.json` present and absent cases.

- [ ] **Step 5: Run the full session-start suite**

Run: `npx vitest run tests/entrypoints/session-start.test.ts`
Expected: PASS — existing cases (preamble, episodic, etc.) still green.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/entrypoints/session-start.ts tests/entrypoints/session-start.test.ts
git commit -m "feat(session-start): prefer temporal.json, legacy .md fallback"
```

---

## Task 11: Update CLAUDE.md

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Naming Convention table**

In `CLAUDE.md`, replace the Naming Convention table with:

```markdown
| Name              | File                                           | Written by                                   |
| ----------------- | ---------------------------------------------- | -------------------------------------------- |
| working memory    | `.claude-memory/working-memory.md`             | `save`                                       |
| episodic memory   | `.claude-memory/episodic-memory/YYYY-MM-DD.md` | `compact`                                    |
| temporal store    | `.claude-memory/temporal.json`                 | `consolidate`                                |
| short-term memory | `.claude-memory/short-term-memory.md`          | `consolidate` (derived from `temporal.json`) |
| long-term memory  | `.claude-memory/long-term-memory.md`           | `consolidate` (derived from `temporal.json`) |

Plus `core-memories.md`, `agent-role.md`, and `session-handover.md` (one-shot, cleared after injection).
```

- [ ] **Step 2: Add a state/event model section**

After the Naming Convention table, insert:

```markdown
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
```

- [ ] **Step 3: Update the Files of Note section**

In the `## Files of Note` section, add a line about `temporal.ts`:

```markdown
- `src/helpers/temporal.ts` — owns the `temporal.json` data model:
  read/write, merge (with contradiction detection), event roll-up,
  and render-to-markdown. Pure functions + I/O only; no Haiku calls.
```

- [ ] **Step 4: Verify lint on the markdown**

Run: `npm run lint`
Expected: exits 0 (biome ignores markdown by default; this step confirms no stray source edits).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document temporal.json and state/event model"
```

---

## Final Verification

- [ ] **Step 1: Full gate**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all exit 0. Roughly 118 (existing) + 30–40 (new) tests green.

- [ ] **Step 2: Acceptance-criteria walkthrough**

Cross-check each acceptance criterion in `docs/superpowers/specs/2026-04-20-temporal-memory-design.md`:

- [ ] `temporal.json` is source of truth → Task 2, 9.
- [ ] `consolidate.prompt.md` is a strict-JSON extraction prompt → Task 7.
- [ ] `src/helpers/temporal.ts` implements all six exports → Tasks 2-6.
- [ ] `consolidate.ts` uses Haiku for extraction only → Task 9.
- [ ] `session-start.ts` prefers `temporal.json`, falls back to legacy → Task 10.
- [ ] Tests cover merge, rollup, render, parser, E2E, migration → Tasks 2-6, 8, 9, 10.
- [ ] `CLAUDE.md` documents state-vs-event model + machine-generated files → Task 11.
- [ ] Consolidate never deletes episodes on failure → Task 9 integration test.

- [ ] **Step 3: Manual smoke test**

Reinstall the plugin into this repo (or ensure `/reload-plugins` picks up the latest build), then:

1. Create `.claude-memory/episodic-memory/2026-04-19.md` with a dummy contradiction:

   ```text
   Switched test runner from vitest to jest for the frontend module.
   ```

2. Pre-populate `.claude-memory/temporal.json` with `test-runner: vitest`.
3. Start a fresh session; confirm the consolidate background job runs (check `.claude-memory/logs/autonomous/`).
4. Start another session; the injected `=== MEMORY ===` block should show `test-runner: jest` as current and `test-runner: vitest` under "Previously".

If the smoke test passes, the feature is ready for release.
