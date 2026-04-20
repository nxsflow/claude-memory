import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    EMPTY_STORE,
    mergeExtracted,
    nextId,
    normalizeSubject,
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
