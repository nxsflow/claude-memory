import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPrompt, renderPrompt } from "../../src/helpers/prompts.ts";

let pluginDir: string;

beforeEach(() => {
    pluginDir = mkdtempSync(path.join(tmpdir(), "cm-prompts-"));
    mkdirSync(path.join(pluginDir, "prompts"));
});
afterEach(() => rmSync(pluginDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// loadPrompt
// ---------------------------------------------------------------------------

describe("loadPrompt", () => {
    it("reads save.prompt.md and returns its content", () => {
        const content = "This is the save prompt.\n";
        writeFileSync(
            path.join(pluginDir, "prompts", "save.prompt.md"),
            content,
        );
        expect(loadPrompt(pluginDir, "save")).toBe(content);
    });

    it("reads compact.prompt.md for compact name", () => {
        const content = "This is the compact prompt.";
        writeFileSync(
            path.join(pluginDir, "prompts", "compact.prompt.md"),
            content,
        );
        expect(loadPrompt(pluginDir, "compact")).toBe(content);
    });

    it("reads consolidate.prompt.md for consolidate name", () => {
        const content = "Consolidate me.";
        writeFileSync(
            path.join(pluginDir, "prompts", "consolidate.prompt.md"),
            content,
        );
        expect(loadPrompt(pluginDir, "consolidate")).toBe(content);
    });

    it("reads session-preamble.md for preamble name", () => {
        const content = "Preamble content here.";
        writeFileSync(
            path.join(pluginDir, "prompts", "session-preamble.md"),
            content,
        );
        expect(loadPrompt(pluginDir, "preamble")).toBe(content);
    });

    it("throws with path in message when file is missing", () => {
        expect(() => loadPrompt(pluginDir, "save")).toThrow(
            path.join(pluginDir, "prompts", "save.prompt.md"),
        );
    });
});

// ---------------------------------------------------------------------------
// renderPrompt
// ---------------------------------------------------------------------------

describe("renderPrompt", () => {
    it("substitutes a single placeholder", () => {
        expect(renderPrompt("Hello {{NAME}}!", { NAME: "World" })).toBe(
            "Hello World!",
        );
    });

    it("substitutes all occurrences of the same placeholder", () => {
        expect(renderPrompt("{{A}} and {{A}}", { A: "x" })).toBe("x and x");
    });

    it("substitutes multiple different placeholders", () => {
        expect(
            renderPrompt("Hello {{NAME}}, {{GREETING}}!", {
                NAME: "World",
                GREETING: "hi",
            }),
        ).toBe("Hello World, hi!");
    });

    it("throws on unsubstituted placeholder, mentioning the key", () => {
        expect(() => renderPrompt("{{A}} and {{B}}", { A: "x" })).toThrow("B");
    });

    it("ignores extra keys in vars", () => {
        expect(renderPrompt("{{A}}", { A: "x", B: "y" })).toBe("x");
    });
});
