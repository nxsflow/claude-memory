import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
    EventRecord,
    ExtractedPayload,
    StateFact,
    TemporalStore,
} from "./types.ts";

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

// readTemporal uses silent-empty-store semantics on malformed JSON by design:
// the spec (docs/superpowers/specs/2026-04-20-temporal-memory-design.md)
// authorizes consolidate to recover by overwriting on the next run. Version
// mismatch, however, is fatal — it signals a migration that the caller must
// handle. Missing file also returns EMPTY_STORE because a fresh install has
// no state yet.
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

export function normalizeSubject(raw: string): string {
    return raw
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
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

    return next;
}

export function weekOfMonday(date: string): string {
    const [y, m, d] = date.split("-").map(Number);
    const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
    const day = dt.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
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
                    {
                        ...next,
                        events: {
                            recent: [],
                            weekly: [...weeklyById.values()],
                        },
                    },
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
