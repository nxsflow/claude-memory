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
import { appendWorking } from "../../src/helpers/memory-files.ts";
import type { HaikuResponse } from "../../src/helpers/types.ts";

vi.mock("../../src/helpers/haiku.ts", () => ({
    callHaiku: vi.fn(),
}));

import { main } from "../../src/entrypoints/compact.ts";
import { callHaiku } from "../../src/helpers/haiku.ts";

const mockCallHaiku = callHaiku as MockedFunction<typeof callHaiku>;

const COMPACT_RESPONSE: HaikuResponse = {
    text: "## 10:30-10:45 | main\nCompacted work summary",
    isSkip: false,
    tokensIn: 200,
    tokensOut: 50,
    tokensCache: 0,
    costUsd: 0.002,
};

let projectDir: string;
let pluginDir: string;
let dataDir: string;
let originalEnv: NodeJS.ProcessEnv;

function setupDirs(): void {
    projectDir = mkdtempSync(path.join(tmpdir(), "cm-compact-proj-"));
    pluginDir = mkdtempSync(path.join(tmpdir(), "cm-compact-plug-"));
    dataDir = path.join(projectDir, ".claude-memory");

    // Copy compact prompt into pluginDir
    const promptsDir = path.join(pluginDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const realPrompt = readFileSync(
        path.join(
            new URL(".", import.meta.url).pathname,
            "../../prompts/compact.prompt.md",
        ),
        "utf8",
    );
    writeFileSync(path.join(promptsDir, "compact.prompt.md"), realPrompt);

    // Create tmp dir inside dataDir
    mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.env.CLAUDE_PLUGIN_ROOT = pluginDir;
}

beforeEach(() => {
    originalEnv = { ...process.env };
    setupDirs();
    mockCallHaiku.mockReset();
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
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
});

async function runMain(argv: string[] = []): Promise<number> {
    return main(argv);
}

describe("compact entrypoint", () => {
    it("happy path: episode file created, working-memory cleared", async () => {
        appendWorking(dataDir, "## 10:30 | main\nHello");
        mockCallHaiku.mockResolvedValueOnce(COMPACT_RESPONSE);

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).toHaveBeenCalledOnce();

        // Working memory should be cleared
        const working = readFileSync(
            path.join(dataDir, "working-memory.md"),
            "utf8",
        );
        expect(working).toBe("");

        // Episode file should exist with date
        const episodicDir = path.join(dataDir, "episodic-memory");
        expect(existsSync(episodicDir)).toBe(true);
        // Check at least one .md file exists in episodic dir
        const { readdirSync } = await import("node:fs");
        const episodeFiles = readdirSync(episodicDir).filter((f) =>
            f.endsWith(".md"),
        );
        expect(episodeFiles.length).toBeGreaterThan(0);
        const firstEpisodeFile = episodeFiles[0] ?? "";
        const episodeContent = readFileSync(
            path.join(episodicDir, firstEpisodeFile),
            "utf8",
        );
        expect(episodeContent).toContain("Compacted work summary");
    });

    it("empty working: returns 0 without calling haiku", async () => {
        // working-memory.md does not exist / is empty
        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();
    });

    it("second compact on same day appends to existing episode with blank-line separator", async () => {
        appendWorking(dataDir, "## 10:30 | main\nFirst entry");
        mockCallHaiku.mockResolvedValueOnce(COMPACT_RESPONSE);

        await runMain([]);

        // Rewrite working memory for second compact
        appendWorking(dataDir, "## 11:00 | main\nSecond entry");
        mockCallHaiku.mockResolvedValueOnce({
            ...COMPACT_RESPONSE,
            text: "## 11:00-11:15 | main\nSecond compacted summary",
        });

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).toHaveBeenCalledTimes(2);

        const { readdirSync } = await import("node:fs");
        const episodicDir = path.join(dataDir, "episodic-memory");
        const episodeFiles = readdirSync(episodicDir).filter((f) =>
            f.endsWith(".md"),
        );
        expect(episodeFiles.length).toBe(1);
        const firstFile = episodeFiles[0] ?? "";
        const content = readFileSync(path.join(episodicDir, firstFile), "utf8");
        expect(content).toContain("Compacted work summary");
        expect(content).toContain("Second compacted summary");
        expect(content).toMatch(/Compacted work summary\n\n## 11:00/);
    });

    it("lock held: second concurrent compact is a no-op", async () => {
        appendWorking(dataDir, "## 10:30 | main\nSome work");

        // Write a lock file with current PID to simulate live lock
        const lockPath = path.join(dataDir, "tmp", "compact.lock");
        writeFileSync(lockPath, String(process.pid));

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();
    });
});
