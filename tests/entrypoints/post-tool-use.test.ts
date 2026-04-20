import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionJsonlDir } from "../../src/helpers/paths.ts";

// Mock child_process.spawn so no background processes fire
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        spawn: vi.fn(() => ({
            unref: vi.fn(),
            pid: 12345,
        })),
    };
});

import { spawn } from "node:child_process";
import { main } from "../../src/entrypoints/post-tool-use.ts";

let projectDir: string;
let pluginDir: string;
let dataDir: string;
let sessionsDir: string;
let originalEnv: NodeJS.ProcessEnv;

// Build a JSONL string with N lines (each a valid-ish JSON object)
function makeJsonl(lineCount: number): string {
    return Array.from({ length: lineCount }, (_, i) =>
        JSON.stringify({ type: "user", seq: i }),
    ).join("\n");
}

function setupDirs(): void {
    projectDir = mkdtempSync(path.join(tmpdir(), "cm-ptu-proj-"));
    pluginDir = mkdtempSync(path.join(tmpdir(), "cm-ptu-plug-"));
    dataDir = path.join(projectDir, ".claude-memory");

    sessionsDir = sessionJsonlDir(projectDir);
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
    mkdirSync(path.join(dataDir, "logs", "autonomous"), { recursive: true });

    // Write config with UTC timezone
    writeFileSync(
        path.join(pluginDir, "config.json"),
        JSON.stringify({ timezone: "UTC" }),
    );

    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.env.CLAUDE_PLUGIN_ROOT = pluginDir;
}

beforeEach(() => {
    originalEnv = { ...process.env };
    setupDirs();
    vi.mocked(spawn).mockClear();
});

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key];
        }
    }
    for (const [key, val] of Object.entries(originalEnv)) {
        process.env[key] = val;
    }
    if (existsSync(projectDir)) {
        rmSync(projectDir, { recursive: true, force: true });
    }
    if (existsSync(pluginDir)) {
        rmSync(pluginDir, { recursive: true, force: true });
    }
});

describe("post-tool-use entrypoint", () => {
    it("no sessions dir: return 0, spawn NOT called", async () => {
        // Remove the sessions dir that was created in setupDirs
        rmSync(sessionsDir, { recursive: true, force: true });

        const code = await main();

        expect(code).toBe(0);
        expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it("delta below threshold: spawn NOT called", async () => {
        // Write a JSONL with just 10 lines (well below default threshold 50)
        const sessionId = "session-below-abc";
        writeFileSync(
            path.join(sessionsDir, `${sessionId}.jsonl`),
            makeJsonl(10),
        );

        // Set last-save.json so lastLine = 9 → delta = 1, below 50
        writeFileSync(
            path.join(dataDir, "tmp", "last-save.json"),
            JSON.stringify({ session: sessionId, line: 9 }),
        );

        const code = await main();

        expect(code).toBe(0);
        expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it("delta above threshold: spawn called with save.mjs and session id", async () => {
        const sessionId = "session-above-xyz";
        // Write a JSONL with 60 lines (above threshold 50) and no last-save.json
        writeFileSync(
            path.join(sessionsDir, `${sessionId}.jsonl`),
            makeJsonl(60),
        );

        const code = await main();

        expect(code).toBe(0);
        expect(vi.mocked(spawn)).toHaveBeenCalled();

        const calls = vi.mocked(spawn).mock.calls;
        const saveCall = calls.find(
            (c) =>
                Array.isArray(c[1]) &&
                c[1].some((a: unknown) => String(a).includes("save.mjs")),
        );
        expect(saveCall).toBeDefined();
        expect(saveCall?.[1]).toContain(sessionId);
    });

    it("already-running save: PID file with live PID → spawn NOT called", async () => {
        const sessionId = "session-live-pid";
        writeFileSync(
            path.join(sessionsDir, `${sessionId}.jsonl`),
            makeJsonl(60),
        );

        // Write PID file with the current (alive) process PID
        writeFileSync(
            path.join(dataDir, "tmp", "save-session.pid"),
            String(process.pid),
        );

        const code = await main();

        expect(code).toBe(0);
        expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it("sweeps 0-byte autonomous logs older than 5s; keeps fresh empties and non-empty logs", async () => {
        const sessionId = "session-sweep-logs";
        writeFileSync(
            path.join(sessionsDir, `${sessionId}.jsonl`),
            makeJsonl(60),
        );

        const logDir = path.join(dataDir, "logs", "autonomous");
        const staleEmpty = path.join(logDir, "save-000001.log");
        const freshEmpty = path.join(logDir, "save-000002.log");
        const staleNonEmpty = path.join(logDir, "save-000003.log");

        writeFileSync(staleEmpty, "");
        writeFileSync(freshEmpty, "");
        writeFileSync(staleNonEmpty, "error trace\n");

        // Backdate the stale ones so they are older than the 5s sweep cutoff
        const oldTime = new Date(Date.now() - 60_000);
        utimesSync(staleEmpty, oldTime, oldTime);
        utimesSync(staleNonEmpty, oldTime, oldTime);

        await main();

        const remaining = readdirSync(logDir);
        expect(remaining).not.toContain(path.basename(staleEmpty));
        expect(remaining).toContain(path.basename(freshEmpty));
        expect(remaining).toContain(path.basename(staleNonEmpty));
    });

    it("stale PID file with dead process: spawn IS called; PID file updated", async () => {
        const sessionId = "session-stale-pid";
        writeFileSync(
            path.join(sessionsDir, `${sessionId}.jsonl`),
            makeJsonl(60),
        );

        // Use a very high PID that cannot be alive
        const deadPid = 999999;
        const pidFile = path.join(dataDir, "tmp", "save-session.pid");
        writeFileSync(pidFile, String(deadPid));

        const code = await main();

        expect(code).toBe(0);
        expect(vi.mocked(spawn)).toHaveBeenCalled();

        // PID file should be updated with the new (mocked) PID 12345
        expect(existsSync(pidFile)).toBe(true);
        const newPid = readFileSync(pidFile, "utf8").trim();
        expect(newPid).toBe("12345");
    });
});
