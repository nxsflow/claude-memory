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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    appendEpisode,
    appendWorking,
    clearWorking,
    consumeHandover,
    listEpisodes,
    loadLastSave,
    readEpisode,
    readHandover,
    readLastEntry,
    readLongTerm,
    readShortTerm,
    readWorking,
    saveLastSave,
    writeLongTerm,
    writeShortTerm,
} from "../../src/helpers/memory-files.ts";

let dataDir: string;

beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "cm-memfiles-"));
});

afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readWorking
// ---------------------------------------------------------------------------
describe("readWorking", () => {
    it("returns empty string when dir does not exist", () => {
        const missing = path.join(dataDir, "no-such-dir");
        expect(readWorking(missing)).toBe("");
    });

    it("returns empty string when file does not exist but dir does", () => {
        expect(readWorking(dataDir)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// appendWorking
// ---------------------------------------------------------------------------
describe("appendWorking", () => {
    it("creates the file on first append", () => {
        appendWorking(dataDir, "entry one");
        const content = readFileSync(
            path.join(dataDir, "working-memory.md"),
            "utf8",
        );
        expect(content).toBe("entry one");
    });

    it("creates dataDir if missing", () => {
        const newDir = path.join(dataDir, "auto-created");
        appendWorking(newDir, "hi");
        expect(existsSync(path.join(newDir, "working-memory.md"))).toBe(true);
    });

    it("separates a second append with a blank line", () => {
        appendWorking(dataDir, "first");
        appendWorking(dataDir, "second");
        const content = readFileSync(
            path.join(dataDir, "working-memory.md"),
            "utf8",
        );
        expect(content).toBe("first\n\nsecond");
    });
});

// ---------------------------------------------------------------------------
// clearWorking
// ---------------------------------------------------------------------------
describe("clearWorking", () => {
    it("truncates the file to empty but keeps it on disk", () => {
        appendWorking(dataDir, "something");
        clearWorking(dataDir);
        const filePath = path.join(dataDir, "working-memory.md");
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// readEpisode
// ---------------------------------------------------------------------------
describe("readEpisode", () => {
    it("returns empty string when episodic dir does not exist", () => {
        expect(readEpisode(dataDir, "2026-04-19")).toBe("");
    });

    it("returns empty string when file does not exist", () => {
        expect(readEpisode(dataDir, "2026-04-19")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// appendEpisode
// ---------------------------------------------------------------------------
describe("appendEpisode", () => {
    it("creates episodic-memory/ dir and writes content", () => {
        appendEpisode(dataDir, "2026-04-19", "day one");
        const filePath = path.join(dataDir, "episodic-memory", "2026-04-19.md");
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toBe("day one");
    });

    it("separates second append with blank line", () => {
        appendEpisode(dataDir, "2026-04-19", "first");
        appendEpisode(dataDir, "2026-04-19", "second");
        const content = readFileSync(
            path.join(dataDir, "episodic-memory", "2026-04-19.md"),
            "utf8",
        );
        expect(content).toBe("first\n\nsecond");
    });
});

// ---------------------------------------------------------------------------
// listEpisodes
// ---------------------------------------------------------------------------
describe("listEpisodes", () => {
    it("returns empty array when episodic dir does not exist", () => {
        expect(listEpisodes(dataDir)).toEqual([]);
    });

    it("returns entries sorted by date ascending", () => {
        appendEpisode(dataDir, "2026-04-19", "a");
        appendEpisode(dataDir, "2026-04-17", "b");
        appendEpisode(dataDir, "2026-04-18", "c");
        const result = listEpisodes(dataDir);
        expect(result.map((e) => e.date)).toEqual([
            "2026-04-17",
            "2026-04-18",
            "2026-04-19",
        ]);
    });

    it("includes correct path for each entry", () => {
        appendEpisode(dataDir, "2026-04-19", "a");
        const result = listEpisodes(dataDir);
        expect(result[0]?.path).toBe(
            path.join(dataDir, "episodic-memory", "2026-04-19.md"),
        );
    });

    it("filters out excludeDate", () => {
        appendEpisode(dataDir, "2026-04-19", "a");
        appendEpisode(dataDir, "2026-04-18", "b");
        const result = listEpisodes(dataDir, { excludeDate: "2026-04-18" });
        expect(result.map((e) => e.date)).toEqual(["2026-04-19"]);
    });

    it("ignores files not matching YYYY-MM-DD.md", () => {
        appendEpisode(dataDir, "2026-04-19", "a");
        // Write a non-matching file into episodic-memory/
        writeFileSync(
            path.join(dataDir, "episodic-memory", "notes.md"),
            "ignored",
        );
        const result = listEpisodes(dataDir);
        expect(result).toHaveLength(1);
        expect(result[0]?.date).toBe("2026-04-19");
    });
});

// ---------------------------------------------------------------------------
// readShortTerm / writeShortTerm
// ---------------------------------------------------------------------------
describe("readShortTerm / writeShortTerm", () => {
    it("returns empty string when file does not exist", () => {
        expect(readShortTerm(dataDir)).toBe("");
    });

    it("round-trips content", () => {
        writeShortTerm(dataDir, "short term content");
        expect(readShortTerm(dataDir)).toBe("short term content");
    });

    it("creates dataDir if missing", () => {
        const newDir = path.join(dataDir, "auto-created");
        writeShortTerm(newDir, "hello");
        expect(readShortTerm(newDir)).toBe("hello");
    });

    it("leaves no .tmp file after write", () => {
        writeShortTerm(dataDir, "content");
        const tmpFile = path.join(dataDir, "short-term-memory.md.tmp");
        expect(existsSync(tmpFile)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// readLongTerm / writeLongTerm
// ---------------------------------------------------------------------------
describe("readLongTerm / writeLongTerm", () => {
    it("returns empty string when file does not exist", () => {
        expect(readLongTerm(dataDir)).toBe("");
    });

    it("round-trips content", () => {
        writeLongTerm(dataDir, "long term content");
        expect(readLongTerm(dataDir)).toBe("long term content");
    });

    it("leaves no .tmp file after write", () => {
        writeLongTerm(dataDir, "content");
        const tmpFile = path.join(dataDir, "long-term-memory.md.tmp");
        expect(existsSync(tmpFile)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// readHandover / consumeHandover
// ---------------------------------------------------------------------------
describe("readHandover / consumeHandover", () => {
    it("returns empty string when file does not exist", () => {
        expect(readHandover(dataDir)).toBe("");
    });

    it("after consumeHandover the file exists but is empty", () => {
        writeFileSync(
            path.join(dataDir, "session-handover.md"),
            "handover data",
        );
        consumeHandover(dataDir);
        const filePath = path.join(dataDir, "session-handover.md");
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, "utf8")).toBe("");
    });

    it("consumeHandover is a no-op when file is missing", () => {
        expect(() => consumeHandover(dataDir)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// readLastEntry
// ---------------------------------------------------------------------------
describe("readLastEntry", () => {
    it("returns last ## block from working memory", () => {
        const content = "## 10:00 | main\nline1\n\n## 11:00 | main\nline2";
        writeFileSync(path.join(dataDir, "working-memory.md"), content);
        expect(readLastEntry(dataDir)).toBe("## 11:00 | main\nline2");
    });

    it("returns (no previous entry) when no ## header found", () => {
        writeFileSync(path.join(dataDir, "working-memory.md"), "plain text");
        expect(readLastEntry(dataDir)).toBe("(no previous entry)");
    });

    it("returns (no previous entry) when file is missing", () => {
        expect(readLastEntry(dataDir)).toBe("(no previous entry)");
    });
});

// ---------------------------------------------------------------------------
// loadLastSave / saveLastSave
// ---------------------------------------------------------------------------
describe("loadLastSave / saveLastSave", () => {
    it("returns null when file does not exist", () => {
        expect(loadLastSave(dataDir)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
        const dir = path.join(dataDir, "tmp");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "last-save.json"), "not json");
        expect(loadLastSave(dataDir)).toBeNull();
    });

    it("returns null when JSON is missing required fields", () => {
        const dir = path.join(dataDir, "tmp");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "last-save.json"), '{"foo":"bar"}');
        expect(loadLastSave(dataDir)).toBeNull();
    });

    it("round-trips a valid last-save", () => {
        saveLastSave(dataDir, "session-abc", 42);
        const result = loadLastSave(dataDir);
        expect(result).toEqual({ session: "session-abc", line: 42 });
    });

    it("saveLastSave creates tmp/ dir if missing", () => {
        saveLastSave(dataDir, "s1", 1);
        expect(existsSync(path.join(dataDir, "tmp", "last-save.json"))).toBe(
            true,
        );
    });

    it("subsequent saveLastSave overwrites previous value", () => {
        saveLastSave(dataDir, "s1", 10);
        saveLastSave(dataDir, "s2", 20);
        expect(loadLastSave(dataDir)).toEqual({ session: "s2", line: 20 });
    });

    it("leaves no .tmp file after saveLastSave", () => {
        saveLastSave(dataDir, "s1", 1);
        expect(
            existsSync(path.join(dataDir, "tmp", "last-save.json.tmp")),
        ).toBe(false);
    });
});
