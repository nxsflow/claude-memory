import { describe, expect, it } from "vitest";
import {
    episodicFile,
    memoryPath,
    resolvePaths,
} from "../../src/helpers/paths.ts";

describe("resolvePaths", () => {
    it("uses CLAUDE_PROJECT_DIR and CLAUDE_PLUGIN_ROOT when both set", () => {
        process.env.CLAUDE_PROJECT_DIR = "/tmp/proj";
        process.env.CLAUDE_PLUGIN_ROOT = "/tmp/plugin";
        const { projectDir, pluginDir, dataDir } = resolvePaths();
        expect(projectDir).toBe("/tmp/proj");
        expect(pluginDir).toBe("/tmp/plugin");
        expect(dataDir).toBe("/tmp/proj/.claude-memory");
    });

    it("throws when CLAUDE_PROJECT_DIR is unset and no local layout", () => {
        delete process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PLUGIN_ROOT = "/tmp/not-local";
        expect(() => resolvePaths()).toThrow(/CLAUDE_PROJECT_DIR/);
    });
});

describe("memoryPath", () => {
    it("joins dataDir and file", () => {
        expect(memoryPath("/a/b", "x.md")).toBe("/a/b/x.md");
    });
});

describe("episodicFile", () => {
    it("returns episodic-memory/<date>.md under dataDir", () => {
        expect(episodicFile("/a/b", "2026-04-19")).toBe(
            "/a/b/episodic-memory/2026-04-19.md",
        );
    });
});
