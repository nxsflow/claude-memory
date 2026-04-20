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
