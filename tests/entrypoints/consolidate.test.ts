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
import type { HaikuResponse } from "../../src/helpers/types.ts";

vi.mock("../../src/helpers/haiku.ts", () => ({
    callHaiku: vi.fn(),
}));

import {
    main,
    parseConsolidateResponse,
} from "../../src/entrypoints/consolidate.ts";
import { callHaiku } from "../../src/helpers/haiku.ts";

const mockCallHaiku = callHaiku as MockedFunction<typeof callHaiku>;

const SHORT_TERM_CONTENT = "# Short-Term Memory\n\n## 2026-04-17\nDay summary.";
const LONG_TERM_CONTENT = "# Long-Term Memory\n\nWeek of 2026-04-13 summary.";

const VALID_HAIKU_RESPONSE: HaikuResponse = {
    text: `===SHORT-TERM===\n${SHORT_TERM_CONTENT}\n===LONG-TERM===\n${LONG_TERM_CONTENT}`,
    isSkip: false,
    tokensIn: 500,
    tokensOut: 100,
    tokensCache: 0,
    costUsd: 0.005,
};

let projectDir: string;
let pluginDir: string;
let dataDir: string;
let originalEnv: NodeJS.ProcessEnv;

function setupDirs(): void {
    projectDir = mkdtempSync(path.join(tmpdir(), "cm-consolidate-proj-"));
    pluginDir = mkdtempSync(path.join(tmpdir(), "cm-consolidate-plug-"));
    dataDir = path.join(projectDir, ".claude-memory");

    // Copy consolidate prompt into pluginDir
    const promptsDir = path.join(pluginDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const realPrompt = readFileSync(
        path.join(
            new URL(".", import.meta.url).pathname,
            "../../prompts/consolidate.prompt.md",
        ),
        "utf8",
    );
    writeFileSync(path.join(promptsDir, "consolidate.prompt.md"), realPrompt);

    // Create episodic-memory dir and tmp dir
    mkdirSync(path.join(dataDir, "episodic-memory"), { recursive: true });
    mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

    // Write config with UTC timezone so date math is predictable
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

// ---------------------------------------------------------------------------
// parseConsolidateResponse unit tests
// ---------------------------------------------------------------------------

describe("parseConsolidateResponse", () => {
    it("parses clean input correctly", () => {
        const raw =
            "===SHORT-TERM===\n# Short-Term Memory\ncontent\n===LONG-TERM===\n# Long-Term Memory\nother";
        const result = parseConsolidateResponse(raw);
        expect(result.shortTerm).toBe("# Short-Term Memory\ncontent");
        expect(result.longTerm).toBe("# Long-Term Memory\nother");
    });

    it("strips code fences and parses correctly", () => {
        const inner =
            "===SHORT-TERM===\n# Short-Term Memory\ncontent\n===LONG-TERM===\n# Long-Term Memory\nother";
        const raw = `\`\`\`\n${inner}\n\`\`\``;
        const result = parseConsolidateResponse(raw);
        expect(result.shortTerm).toBe("# Short-Term Memory\ncontent");
        expect(result.longTerm).toBe("# Long-Term Memory\nother");
    });

    it("throws when ===SHORT-TERM=== is missing", () => {
        const raw = "===LONG-TERM===\n# Long-Term Memory\nother";
        expect(() => parseConsolidateResponse(raw)).toThrow(/===SHORT-TERM===/);
    });

    it("throws when ===LONG-TERM=== is missing", () => {
        const raw = "===SHORT-TERM===\n# Short-Term Memory\ncontent";
        expect(() => parseConsolidateResponse(raw)).toThrow(/===LONG-TERM===/);
    });
});

// ---------------------------------------------------------------------------
// main integration tests
// ---------------------------------------------------------------------------

describe("consolidate entrypoint", () => {
    it("happy path: episodes merged, short/long-term written, episode files deleted", async () => {
        // Write two past episode files
        writeFileSync(
            path.join(dataDir, "episodic-memory", "2026-04-17.md"),
            "Work done on 2026-04-17.",
        );
        writeFileSync(
            path.join(dataDir, "episodic-memory", "2026-04-18.md"),
            "Work done on 2026-04-18.",
        );

        mockCallHaiku.mockResolvedValueOnce(VALID_HAIKU_RESPONSE);

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).toHaveBeenCalledOnce();

        // Short-term written
        const st = readFileSync(
            path.join(dataDir, "short-term-memory.md"),
            "utf8",
        );
        expect(st).toBe(SHORT_TERM_CONTENT);

        // Long-term written
        const lt = readFileSync(
            path.join(dataDir, "long-term-memory.md"),
            "utf8",
        );
        expect(lt).toBe(LONG_TERM_CONTENT);

        // Episode files deleted
        expect(
            existsSync(path.join(dataDir, "episodic-memory", "2026-04-17.md")),
        ).toBe(false);
        expect(
            existsSync(path.join(dataDir, "episodic-memory", "2026-04-18.md")),
        ).toBe(false);
    });

    it("today's episode is NOT consumed", async () => {
        // Compute today the same way the entrypoint does (UTC from config)
        const today = new Intl.DateTimeFormat("en-CA", {
            timeZone: "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date());

        writeFileSync(
            path.join(dataDir, "episodic-memory", "2026-04-17.md"),
            "Past work.",
        );
        writeFileSync(
            path.join(dataDir, "episodic-memory", `${today}.md`),
            "Today's work.",
        );

        mockCallHaiku.mockResolvedValueOnce(VALID_HAIKU_RESPONSE);

        const code = await runMain([]);

        expect(code).toBe(0);

        // Today's file must still exist
        expect(
            existsSync(path.join(dataDir, "episodic-memory", `${today}.md`)),
        ).toBe(true);

        // Past file must be deleted
        expect(
            existsSync(path.join(dataDir, "episodic-memory", "2026-04-17.md")),
        ).toBe(false);
    });

    it("no past episodes: returns 0 and does NOT call haiku", async () => {
        // Only today's file or nothing at all — episodic-memory dir already empty
        const today = new Intl.DateTimeFormat("en-CA", {
            timeZone: "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date());

        writeFileSync(
            path.join(dataDir, "episodic-memory", `${today}.md`),
            "Today only.",
        );

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();
    });

    it("malformed response: returns 1, files unchanged", async () => {
        writeFileSync(
            path.join(dataDir, "episodic-memory", "2026-04-17.md"),
            "Past work.",
        );

        mockCallHaiku.mockResolvedValueOnce({
            ...VALID_HAIKU_RESPONSE,
            text: "No markers here at all.",
        });

        const code = await runMain([]);

        expect(code).toBe(1);

        // Episode file still present (not consumed)
        expect(
            existsSync(path.join(dataDir, "episodic-memory", "2026-04-17.md")),
        ).toBe(true);

        // Memory files not written
        expect(existsSync(path.join(dataDir, "short-term-memory.md"))).toBe(
            false,
        );
        expect(existsSync(path.join(dataDir, "long-term-memory.md"))).toBe(
            false,
        );
    });

    it("lock held: returns 0 without calling haiku", async () => {
        writeFileSync(
            path.join(dataDir, "episodic-memory", "2026-04-17.md"),
            "Past work.",
        );

        // Write a live lock file (current PID)
        writeFileSync(
            path.join(dataDir, "tmp", "consolidate.lock"),
            String(process.pid),
        );

        const code = await runMain([]);

        expect(code).toBe(0);
        expect(mockCallHaiku).not.toHaveBeenCalled();
    });
});
