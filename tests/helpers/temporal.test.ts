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
