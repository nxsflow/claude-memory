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
import { main } from "../../src/entrypoints/session-start.ts";

let projectDir: string;
let pluginDir: string;
let dataDir: string;
let sessionsDir: string;
let originalEnv: NodeJS.ProcessEnv;
let stdoutChunks: string[];
let stdoutSpy: { mockRestore: () => void };

function setupDirs(): void {
    projectDir = mkdtempSync(path.join(tmpdir(), "cm-ss-proj-"));
    pluginDir = mkdtempSync(path.join(tmpdir(), "cm-ss-plug-"));
    dataDir = path.join(projectDir, ".claude-memory");

    // Copy session-preamble.md into pluginDir/prompts/
    const promptsDir = path.join(pluginDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const preamble = readFileSync(
        path.join(
            new URL(".", import.meta.url).pathname,
            "../../prompts/session-preamble.md",
        ),
        "utf8",
    );
    writeFileSync(path.join(promptsDir, "session-preamble.md"), preamble);

    // Create sessions dir
    sessionsDir = sessionJsonlDir(projectDir);
    mkdirSync(sessionsDir, { recursive: true });

    // Write config with UTC timezone and recovery enabled
    writeFileSync(
        path.join(pluginDir, "config.json"),
        JSON.stringify({ timezone: "UTC", features: { recovery: true } }),
    );

    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.env.CLAUDE_PLUGIN_ROOT = pluginDir;
}

beforeEach(() => {
    originalEnv = { ...process.env };
    setupDirs();
    vi.mocked(spawn).mockClear();

    stdoutChunks = [];
    stdoutSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: unknown): boolean => {
            if (typeof chunk === "string") {
                stdoutChunks.push(chunk);
            } else if (Buffer.isBuffer(chunk)) {
                stdoutChunks.push(chunk.toString("utf8"));
            }
            return true;
        });
});

afterEach(() => {
    stdoutSpy.mockRestore();
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

function getStdout(): string {
    return stdoutChunks.join("");
}

describe("session-start entrypoint", () => {
    it("no memory files: stdout has preamble but NO === MEMORY === section; no spawn calls; exit 0", async () => {
        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        // Preamble should be present
        expect(out).toContain("=== CLAUDE MEMORY ===");
        // No memory section header when nothing to show
        expect(out).not.toContain("=== MEMORY ===");

        expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it("with agent-role + working-memory: stdout contains === MEMORY === and both file sections", async () => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(
            path.join(dataDir, "agent-role.md"),
            "I am the assistant.",
        );
        writeFileSync(
            path.join(dataDir, "working-memory.md"),
            "## 10:00 | main\nSome work.",
        );

        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        expect(out).toContain("=== MEMORY ===");
        expect(out).toContain("--- agent-role.md ---");
        expect(out).toContain("I am the assistant.");
        expect(out).toContain("--- working-memory.md ---");
        expect(out).toContain("## 10:00 | main");
    });

    it("handover is consumed after emitting: file exists but is empty", async () => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(path.join(dataDir, "session-handover.md"), "hello");

        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        expect(out).toContain("hello");

        // File should be emptied (consumed), not deleted
        const handoverPath = path.join(dataDir, "session-handover.md");
        expect(existsSync(handoverPath)).toBe(true);
        expect(readFileSync(handoverPath, "utf8")).toBe("");
    });

    it("recovery triggered: spawn called for previous session id", async () => {
        // Create two JSONL files with different mtimes
        const olderSession = "session-older-abc";
        const newerSession = "session-newer-xyz";

        const olderPath = path.join(sessionsDir, `${olderSession}.jsonl`);
        const newerPath = path.join(sessionsDir, `${newerSession}.jsonl`);

        writeFileSync(olderPath, '{"type":"user"}\n');
        // Ensure mtime difference by writing newer after a brief wait
        // We manipulate mtime via utimes
        const { utimesSync } = await import("node:fs");
        const oldTime = new Date(Date.now() - 5000);
        utimesSync(olderPath, oldTime, oldTime);
        writeFileSync(newerPath, '{"type":"user"}\n');

        // No last-save.json → lastSave session is null → won't match older
        const code = await main();

        expect(code).toBe(0);

        // spawn should have been called with the older (previous) session id
        expect(vi.mocked(spawn)).toHaveBeenCalled();
        const calls = vi.mocked(spawn).mock.calls;
        // Find the call for save.mjs (not consolidate.mjs)
        const saveCall = calls.find(
            (c) =>
                typeof c[1] === "object" &&
                Array.isArray(c[1]) &&
                c[1].some((a: unknown) => String(a).includes("save.mjs")),
        );
        expect(saveCall).toBeDefined();
        expect(saveCall?.[1]).toContain(olderSession);
    });

    it("consolidation trigger: spawn called for consolidate.mjs; stdout contains consolidation banner", async () => {
        // Create a past episode file (not today)
        const episodicDir = path.join(dataDir, "episodic-memory");
        mkdirSync(episodicDir, { recursive: true });
        writeFileSync(
            path.join(episodicDir, "2026-04-17.md"),
            "Old episode content.",
        );

        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        expect(out).toContain("=== MEMORY CONSOLIDATION ===");
        expect(out).toContain("consolidation running in background");

        const calls = vi.mocked(spawn).mock.calls;
        const consolidateCall = calls.find(
            (c) =>
                typeof c[1] === "object" &&
                Array.isArray(c[1]) &&
                c[1].some((a: unknown) =>
                    String(a).includes("consolidate.mjs"),
                ),
        );
        expect(consolidateCall).toBeDefined();
    });

    it("agent-role.md missing but example present: emits first-run bootstrap with template", async () => {
        writeFileSync(
            path.join(pluginDir, "agent-role.example.md"),
            "# Agent Role\n\nI'm the dev partner on this team.\n",
        );

        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        expect(out).toContain("=== FIRST-RUN BOOTSTRAP ===");
        expect(out).toContain("agent-role.md");
        expect(out).toContain("I'm the dev partner on this team.");
    });

    it("agent-role.md missing and no example template: bootstrap section silently skipped", async () => {
        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        expect(out).not.toContain("=== FIRST-RUN BOOTSTRAP ===");
    });

    it("agent-role.md present: bootstrap NOT emitted even when example exists", async () => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(
            path.join(dataDir, "agent-role.md"),
            "I am the assistant.",
        );
        writeFileSync(
            path.join(pluginDir, "agent-role.example.md"),
            "# Template\n",
        );

        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        expect(out).not.toContain("=== FIRST-RUN BOOTSTRAP ===");
    });

    it("agent-role.md exists but is whitespace-only: bootstrap IS emitted", async () => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(path.join(dataDir, "agent-role.md"), "   \n\n  ");
        writeFileSync(
            path.join(pluginDir, "agent-role.example.md"),
            "# Agent Role\n",
        );

        const code = await main();

        expect(code).toBe(0);

        const out = getStdout();
        expect(out).toContain("=== FIRST-RUN BOOTSTRAP ===");
    });

    it("no paths resolvable: must not throw; returns 0", async () => {
        delete process.env.CLAUDE_PROJECT_DIR;
        delete process.env.CLAUDE_PLUGIN_ROOT;

        let code: number | undefined;
        await expect(async () => {
            code = await main();
        }).not.toThrow();

        expect(code).toBe(0);
    });
});

describe("session-start with temporal.json", () => {
    it("renders from temporal.json when present (ignores legacy .md)", async () => {
        // dataDir already created by setupDirs in beforeEach
        mkdirSync(dataDir, { recursive: true });
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

        // Stale legacy file that should NOT appear
        writeFileSync(
            path.join(dataDir, "short-term-memory.md"),
            "# Short-Term Memory\n\n## 2026-01-01\nstale content",
            "utf8",
        );

        await main();
        const stdout = stdoutChunks.join("");
        expect(stdout).toContain("pkg-manager: npm");
        expect(stdout).toContain("Previously (superseded — do not follow)");
        expect(stdout).not.toContain("stale content");
    });

    it("falls back to legacy .md files when temporal.json is absent", async () => {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(
            path.join(dataDir, "short-term-memory.md"),
            "# Short-Term Memory\n\n## 2026-01-01\nlegacy content",
            "utf8",
        );

        await main();
        const stdout = stdoutChunks.join("");
        expect(stdout).toContain("legacy content");
    });

    it("falls back to legacy .md when temporal.json has an unsupported version", async () => {
        mkdirSync(dataDir, { recursive: true });
        // readTemporal throws on version mismatch; session-start must catch
        // and fall through to the legacy emit path.
        writeFileSync(
            path.join(dataDir, "temporal.json"),
            JSON.stringify({
                version: 99,
                state: [],
                events: { recent: [], weekly: [] },
            }),
            "utf8",
        );
        writeFileSync(
            path.join(dataDir, "short-term-memory.md"),
            "# Short-Term Memory\n\n## 2026-01-01\nfallback content",
            "utf8",
        );

        await main();
        const stdout = stdoutChunks.join("");
        expect(stdout).toContain("fallback content");
    });
});
