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
import type { HaikuResponse, TemporalStore } from "../../src/helpers/types.ts";

vi.mock("../../src/helpers/haiku.ts", () => ({
    callHaiku: vi.fn(),
}));

import { main } from "../../src/entrypoints/consolidate.ts";
import { callHaiku } from "../../src/helpers/haiku.ts";

const mockCallHaiku = callHaiku as MockedFunction<typeof callHaiku>;

let projectDir: string;
let pluginDir: string;
let dataDir: string;
let originalEnv: NodeJS.ProcessEnv;

function setup(): void {
    projectDir = mkdtempSync(path.join(tmpdir(), "cm-consol-int-proj-"));
    pluginDir = mkdtempSync(path.join(tmpdir(), "cm-consol-int-plug-"));
    dataDir = path.join(projectDir, ".claude-memory");

    const promptsDir = path.join(pluginDir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const real = readFileSync(
        path.resolve("prompts/consolidate.prompt.md"),
        "utf8",
    );
    writeFileSync(path.join(promptsDir, "consolidate.prompt.md"), real, "utf8");

    originalEnv = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    process.env.CLAUDE_PLUGIN_ROOT = pluginDir;
}

function teardown(): void {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
    process.env = originalEnv;
    mockCallHaiku.mockReset();
}

function writeEpisode(date: string, content: string): void {
    const dir = path.join(dataDir, "episodic-memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${date}.md`), content, "utf8");
}

function writeTemporal(store: TemporalStore): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
        path.join(dataDir, "temporal.json"),
        JSON.stringify(store),
        "utf8",
    );
}

function haikuResp(payload: unknown): HaikuResponse {
    return {
        text: JSON.stringify(payload),
        isSkip: false,
        tokensIn: 100,
        tokensOut: 50,
        tokensCache: 0,
        costUsd: 0.001,
    };
}

describe("consolidate integration", () => {
    beforeEach(setup);
    afterEach(teardown);

    it("detects a contradiction and writes supersession edges", async () => {
        writeTemporal({
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
        });
        writeEpisode(
            "2026-04-18",
            "Migrated from pnpm to npm. Fixed pagination off-by-one.",
        );

        mockCallHaiku.mockResolvedValueOnce(
            haikuResp({
                newFacts: [
                    {
                        subject: "pkg-manager",
                        value: "npm (migrated from pnpm)",
                    },
                ],
                newEvents: [
                    {
                        date: "2026-04-18",
                        summary: "pnpm→npm migration; paginator off-by-one",
                    },
                ],
            }),
        );

        const exit = await main();
        expect(exit).toBe(0);

        const temporal = JSON.parse(
            readFileSync(path.join(dataDir, "temporal.json"), "utf8"),
        ) as TemporalStore;
        const s1 = temporal.state.find((s) => s.id === "s1");
        const s2 = temporal.state.find((s) => s.id === "s2");
        expect(s1?.supersededBy).toBe("s2");
        expect(s2?.supersedes).toEqual(["s1"]);

        expect(
            existsSync(path.join(dataDir, "episodic-memory", "2026-04-18.md")),
        ).toBe(false);

        const shortTerm = readFileSync(
            path.join(dataDir, "short-term-memory.md"),
            "utf8",
        );
        expect(shortTerm).toContain("npm (migrated from pnpm)");
        expect(shortTerm).toContain("Previously (superseded — do not follow)");
        expect(shortTerm).toContain("pnpm");
    });

    it("does not delete episodes if Haiku JSON is malformed", async () => {
        writeEpisode("2026-04-18", "something happened");
        mockCallHaiku.mockResolvedValueOnce({
            text: "not json at all",
            isSkip: false,
            tokensIn: 10,
            tokensOut: 10,
            tokensCache: 0,
            costUsd: 0,
        });

        const exit = await main();
        expect(exit).toBe(1);

        expect(
            existsSync(path.join(dataDir, "episodic-memory", "2026-04-18.md")),
        ).toBe(true);
        expect(existsSync(path.join(dataDir, "temporal.json"))).toBe(false);
    });

    it("creates temporal.json on first run when absent", async () => {
        writeEpisode("2026-04-18", "Set up vitest");
        mockCallHaiku.mockResolvedValueOnce(
            haikuResp({
                newFacts: [{ subject: "test-runner", value: "vitest" }],
                newEvents: [
                    { date: "2026-04-18", summary: "Set up vitest harness" },
                ],
            }),
        );

        const exit = await main();
        expect(exit).toBe(0);
        expect(existsSync(path.join(dataDir, "temporal.json"))).toBe(true);
    });
});
