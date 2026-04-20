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
import { markCooldown } from "../../src/helpers/cooldown.ts";
import { sessionJsonlDir } from "../../src/helpers/paths.ts";
import type { HaikuResponse } from "../../src/helpers/types.ts";

vi.mock("../../src/helpers/haiku.ts", () => ({
    callHaiku: vi.fn(),
}));

// Mock child_process.spawn to prevent actual compact dispatch
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        spawn: vi.fn(() => ({
            unref: vi.fn(),
        })),
    };
});

import { main } from "../../src/entrypoints/save.ts";
import { callHaiku } from "../../src/helpers/haiku.ts";

const mockCallHaiku = callHaiku as MockedFunction<typeof callHaiku>;

// Sample JSONL with 3 human messages and 2 assistant messages
const SAMPLE_JSONL = [
    JSON.stringify({
        type: "user",
        isMeta: false,
        message: { content: "What is the capital of France?" },
    }),
    JSON.stringify({
        type: "assistant",
        isMeta: false,
        message: {
            content: [
                { type: "text", text: "Paris is the capital of France." },
            ],
        },
    }),
    JSON.stringify({
        type: "user",
        isMeta: false,
        message: { content: "Can you help me fix this bug?" },
    }),
    JSON.stringify({
        type: "assistant",
        isMeta: false,
        message: {
            content: [{ type: "text", text: "Sure, let me look at the code." }],
        },
    }),
    JSON.stringify({
        type: "user",
        isMeta: false,
        message: { content: "Great, it works now!" },
    }),
].join("\n");

const VALID_HAIKU_RESPONSE: HaikuResponse = {
    text: "## 10:30 | main\nDid thing",
    isSkip: false,
    tokensIn: 100,
    tokensOut: 20,
    tokensCache: 0,
    costUsd: 0.001,
};

const SKIP_HAIKU_RESPONSE: HaikuResponse = {
    text: "SKIP",
    isSkip: true,
    tokensIn: 50,
    tokensOut: 5,
    tokensCache: 0,
    costUsd: 0.0005,
};

let projectDir: string;
let pluginDir: string;
let dataDir: string;
let sessionsDir: string;
let sessionFile: string;
let originalEnv: NodeJS.ProcessEnv;

function setupDirs(): void {
    projectDir = mkdtempSync(path.join(tmpdir(), "cm-save-proj-"));
    pluginDir = mkdtempSync(path.join(tmpdir(), "cm-save-plug-"));
    dataDir = path.join(projectDir, ".claude-memory");

    // Copy save prompt into pluginDir
    const promptsDir = path.join(pluginDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const realPrompt = readFileSync(
        path.join(
            new URL(".", import.meta.url).pathname,
            "../../prompts/save.prompt.md",
        ),
        "utf8",
    );
    writeFileSync(path.join(promptsDir, "save.prompt.md"), realPrompt);

    // Create sessions dir and session file
    sessionsDir = sessionJsonlDir(projectDir);
    mkdirSync(sessionsDir, { recursive: true });
    sessionFile = path.join(sessionsDir, "abc123def.jsonl");
    writeFileSync(sessionFile, SAMPLE_JSONL);

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
    // Restore env
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

describe("save entrypoint", () => {
    it("happy path (new entry): writes working-memory and updates last-save", async () => {
        mockCallHaiku.mockResolvedValueOnce(VALID_HAIKU_RESPONSE);

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).toHaveBeenCalledOnce();

        const working = readFileSync(
            path.join(dataDir, "working-memory.md"),
            "utf8",
        );
        expect(working).toContain("## 10:30 | main");

        const lastSaveRaw = readFileSync(
            path.join(dataDir, "tmp", "last-save.json"),
            "utf8",
        );
        const lastSave = JSON.parse(lastSaveRaw) as {
            session: string;
            line: number;
        };
        expect(lastSave.session).toBe("abc123def");
        expect(lastSave.line).toBeGreaterThan(0);
    });

    it("SKIP response: working-memory untouched but last-save updated", async () => {
        mockCallHaiku.mockResolvedValueOnce(SKIP_HAIKU_RESPONSE);

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).toHaveBeenCalledOnce();

        // working-memory should not exist or be empty
        const workingPath = path.join(dataDir, "working-memory.md");
        if (existsSync(workingPath)) {
            expect(readFileSync(workingPath, "utf8")).toBe("");
        }

        // last-save.json should be updated
        expect(existsSync(path.join(dataDir, "tmp", "last-save.json"))).toBe(
            true,
        );
    });

    it("cooldown: exits 0 without calling haiku when marker is fresh", async () => {
        const marker = path.join(dataDir, "tmp", "last-save-ts");
        markCooldown(marker);

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();
    });

    it("--force bypasses cooldown", async () => {
        const marker = path.join(dataDir, "tmp", "last-save-ts");
        markCooldown(marker);
        mockCallHaiku.mockResolvedValueOnce(VALID_HAIKU_RESPONSE);

        const code = await runMain(["--force"]);

        expect(code).toBe(0);
        expect(mockCallHaiku).toHaveBeenCalledOnce();
    });

    it("--dry mode: does not call haiku, does not write working-memory, prints extract", async () => {
        const code = await runMain(["--dry"]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();

        const workingPath = path.join(dataDir, "working-memory.md");
        expect(existsSync(workingPath)).toBe(false);
    });

    it("below min human messages: exits 0 without calling haiku", async () => {
        // Overwrite JSONL with only 1 human message
        const fewMessages = [
            JSON.stringify({
                type: "user",
                isMeta: false,
                message: { content: "One message only" },
            }),
            JSON.stringify({
                type: "assistant",
                isMeta: false,
                message: { content: [{ type: "text", text: "OK" }] },
            }),
        ].join("\n");
        writeFileSync(sessionFile, fewMessages);

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();
    });

    it("no sessions found: returns 0 gracefully", async () => {
        // Remove session file
        rmSync(sessionFile);

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();
    });

    it("second save appends with blank-line separator", async () => {
        mockCallHaiku
            .mockResolvedValueOnce(VALID_HAIKU_RESPONSE)
            .mockResolvedValueOnce({
                ...VALID_HAIKU_RESPONSE,
                text: "## 11:00 | main\nDid another thing",
            });

        // First save
        await runMain(["--force"]);

        // Append new JSONL content so the second save has something to extract
        const newMessages = [
            "\n" +
                JSON.stringify({
                    type: "user",
                    isMeta: false,
                    message: { content: "New question after first save?" },
                }),
            JSON.stringify({
                type: "assistant",
                isMeta: false,
                message: { content: [{ type: "text", text: "New answer." }] },
            }),
            JSON.stringify({
                type: "user",
                isMeta: false,
                message: { content: "Follow up question." },
            }),
            JSON.stringify({
                type: "assistant",
                isMeta: false,
                message: {
                    content: [{ type: "text", text: "Follow up answer." }],
                },
            }),
            JSON.stringify({
                type: "user",
                isMeta: false,
                message: { content: "Third question after first save." },
            }),
        ].join("\n");
        writeFileSync(sessionFile, SAMPLE_JSONL + newMessages);

        // Second save — force to bypass cooldown
        const code = await runMain(["--force"]);

        expect(code).toBe(0);
        expect(mockCallHaiku).toHaveBeenCalledTimes(2);

        const working = readFileSync(
            path.join(dataDir, "working-memory.md"),
            "utf8",
        );
        expect(working).toContain("## 10:30 | main");
        expect(working).toContain("## 11:00 | main");
        // Should have blank-line separator between entries
        expect(working).toMatch(/Did thing\n\n## 11:00/);
    });
});
