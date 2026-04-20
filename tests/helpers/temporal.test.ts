import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    currentSubjects,
    EMPTY_STORE,
    mergeExtracted,
    nextId,
    normalizeSubject,
    readTemporal,
    renderMarkdown,
    rollEvents,
    weekOfMonday,
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
            state: [
                {
                    id: "s99",
                    subject: "a",
                    value: "x",
                    validFrom: "2026-01-01",
                },
            ],
        };
        expect(nextId(store, "e")).toBe("e1");
    });
});

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
            newFacts: [
                { subject: "pkg-manager", value: "npm (migrated from pnpm)" },
            ],
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

describe("weekOfMonday", () => {
    it("returns the date itself for a Monday", () => {
        expect(weekOfMonday("2026-03-09")).toBe("2026-03-09"); // Monday
    });

    it("returns the Monday for a Sunday", () => {
        expect(weekOfMonday("2026-03-15")).toBe("2026-03-09"); // Sunday
    });

    it("returns the Monday for a Friday", () => {
        expect(weekOfMonday("2026-04-17")).toBe("2026-04-13"); // Friday
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
        expect(result.events.recent.map((e) => e.id)).toEqual([
            "e1",
            "e2",
            "e3",
        ]);
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
                weekly: [
                    { id: "w1", weekOf: "2026-04-13", summary: "Mon thing" },
                ],
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
        const { shortTerm, longTerm } = renderMarkdown(
            EMPTY_STORE,
            "2026-04-20",
        );
        expect(shortTerm).toBe("");
        expect(longTerm).toBe("");
    });

    it("sorts current state alphabetically by subject", () => {
        const store: TemporalStore = {
            ...EMPTY_STORE,
            state: [
                {
                    id: "s1",
                    subject: "z-last",
                    value: "x",
                    validFrom: "2026-04-01",
                },
                {
                    id: "s2",
                    subject: "a-first",
                    value: "y",
                    validFrom: "2026-04-01",
                },
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
