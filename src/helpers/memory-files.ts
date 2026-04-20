import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import type { LastSave } from "./types.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeRead(filePath: string): string {
    if (!existsSync(filePath)) return "";
    try {
        return readFileSync(filePath, "utf8");
    } catch {
        return "";
    }
}

function ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, content: string): void {
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Working memory
// ---------------------------------------------------------------------------

export function readWorking(dataDir: string): string {
    return safeRead(path.join(dataDir, "working-memory.md"));
}

export function appendWorking(dataDir: string, entry: string): void {
    ensureDir(dataDir);
    const filePath = path.join(dataDir, "working-memory.md");
    const existing = safeRead(filePath);
    const prefix = existing.length > 0 ? "\n\n" : "";
    appendFileSync(filePath, `${prefix}${entry}`, "utf8");
}

export function clearWorking(dataDir: string): void {
    writeFileSync(path.join(dataDir, "working-memory.md"), "", "utf8");
}

// ---------------------------------------------------------------------------
// Episodic memory
// ---------------------------------------------------------------------------

export function readEpisode(dataDir: string, date: string): string {
    return safeRead(path.join(dataDir, "episodic-memory", `${date}.md`));
}

export function appendEpisode(
    dataDir: string,
    date: string,
    content: string,
): void {
    const episodicDir = path.join(dataDir, "episodic-memory");
    ensureDir(episodicDir);
    const filePath = path.join(episodicDir, `${date}.md`);
    const existing = safeRead(filePath);
    const prefix = existing.length > 0 ? "\n\n" : "";
    appendFileSync(filePath, `${prefix}${content}`, "utf8");
}

export function listEpisodes(
    dataDir: string,
    options?: { excludeDate?: string },
): { date: string; path: string }[] {
    const episodicDir = path.join(dataDir, "episodic-memory");
    if (!existsSync(episodicDir)) return [];

    const datePattern = /^(\d{4}-\d{2}-\d{2})\.md$/;
    const entries: { date: string; path: string }[] = [];

    for (const filename of readdirSync(episodicDir)) {
        const match = datePattern.exec(filename);
        if (match === null) continue;
        const date = match[1];
        if (date === undefined) continue;
        if (options?.excludeDate === date) continue;
        entries.push({ date, path: path.join(episodicDir, filename) });
    }

    entries.sort((a, b) => a.date.localeCompare(b.date));
    return entries;
}

// ---------------------------------------------------------------------------
// Short-term memory
// ---------------------------------------------------------------------------

export function readShortTerm(dataDir: string): string {
    return safeRead(path.join(dataDir, "short-term-memory.md"));
}

export function writeShortTerm(dataDir: string, content: string): void {
    ensureDir(dataDir);
    atomicWrite(path.join(dataDir, "short-term-memory.md"), content);
}

// ---------------------------------------------------------------------------
// Long-term memory
// ---------------------------------------------------------------------------

export function readLongTerm(dataDir: string): string {
    return safeRead(path.join(dataDir, "long-term-memory.md"));
}

export function writeLongTerm(dataDir: string, content: string): void {
    ensureDir(dataDir);
    atomicWrite(path.join(dataDir, "long-term-memory.md"), content);
}

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

export function readHandover(dataDir: string): string {
    return safeRead(path.join(dataDir, "session-handover.md"));
}

export function consumeHandover(dataDir: string): void {
    const filePath = path.join(dataDir, "session-handover.md");
    if (!existsSync(filePath)) return;
    writeFileSync(filePath, "", "utf8");
}

// ---------------------------------------------------------------------------
// Last entry
// ---------------------------------------------------------------------------

export function readLastEntry(dataDir: string): string {
    const content = readWorking(dataDir);
    if (content === "") return "(no previous entry)";

    const lines = content.split("\n");
    let lastHeaderIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.startsWith("## ")) {
            lastHeaderIndex = i;
        }
    }
    if (lastHeaderIndex === -1) return "(no previous entry)";

    return lines.slice(lastHeaderIndex).join("\n");
}

// ---------------------------------------------------------------------------
// Last save
// ---------------------------------------------------------------------------

export function loadLastSave(dataDir: string): LastSave | null {
    const filePath = path.join(dataDir, "tmp", "last-save.json");
    if (!existsSync(filePath)) return null;
    try {
        const raw = readFileSync(filePath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("session" in parsed) ||
            !("line" in parsed) ||
            typeof (parsed as Record<string, unknown>).session !== "string" ||
            typeof (parsed as Record<string, unknown>).line !== "number"
        ) {
            return null;
        }
        return parsed as LastSave;
    } catch {
        return null;
    }
}

export function saveLastSave(
    dataDir: string,
    session: string,
    line: number,
): void {
    const tmpDir = path.join(dataDir, "tmp");
    ensureDir(tmpDir);
    atomicWrite(
        path.join(tmpDir, "last-save.json"),
        JSON.stringify({ session, line }),
    );
}
