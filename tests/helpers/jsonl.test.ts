import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractExchanges, formatToolUse } from "../../src/helpers/jsonl.ts";

const FIXTURE = path.resolve(
    import.meta.dirname,
    "../fixtures/sample-session.jsonl",
);

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cm-jsonl-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// formatToolUse
// ---------------------------------------------------------------------------

describe("formatToolUse", () => {
    it("Edit/Read/Write → extracts filename from file_path", () => {
        expect(
            formatToolUse({
                name: "Read",
                input: { file_path: "/src/LoginForm.php" },
            }),
        ).toBe("[TOOL: Read LoginForm.php]");
        expect(
            formatToolUse({
                name: "Edit",
                input: { file_path: "/a/b/foo.ts" },
            }),
        ).toBe("[TOOL: Edit foo.ts]");
        expect(
            formatToolUse({ name: "Write", input: { file_path: "/bar.js" } }),
        ).toBe("[TOOL: Write bar.js]");
    });

    it("Bash → includes command up to 80 chars", () => {
        expect(
            formatToolUse({ name: "Bash", input: { command: "npm test" } }),
        ).toBe("[TOOL: Bash `npm test`]");
    });

    it("Bash → truncates command at 80 chars", () => {
        const long = "x".repeat(100);
        const result = formatToolUse({
            name: "Bash",
            input: { command: long },
        });
        expect(result).toBe(`[TOOL: Bash \`${"x".repeat(80)}\`]`);
    });

    it("Grep → includes pattern", () => {
        expect(
            formatToolUse({ name: "Grep", input: { pattern: "handleSubmit" } }),
        ).toBe("[TOOL: Grep 'handleSubmit']");
    });

    it("Glob → includes pattern", () => {
        expect(
            formatToolUse({ name: "Glob", input: { pattern: "**/*.ts" } }),
        ).toBe("[TOOL: Glob '**/*.ts']");
    });

    it("other tools → just name", () => {
        expect(formatToolUse({ name: "SomeTool" })).toBe("[TOOL: SomeTool]");
        expect(formatToolUse({})).toBe("[TOOL: ?]");
    });

    it("missing inputs fall back to ?", () => {
        expect(formatToolUse({ name: "Read" })).toBe("[TOOL: Read ?]");
        expect(formatToolUse({ name: "Bash" })).toBe("[TOOL: Bash `?`]");
        expect(formatToolUse({ name: "Grep" })).toBe("[TOOL: Grep '?']");
    });
});

// ---------------------------------------------------------------------------
// extractExchanges — sample-session.jsonl
// ---------------------------------------------------------------------------

describe("extractExchanges — sample fixture", () => {
    it("returns 7 exchanges from line 0", () => {
        const { exchanges, lastLine, humanCount } = extractExchanges(
            FIXTURE,
            0,
        );
        expect(exchanges).toHaveLength(7);
        expect(lastLine).toBe(10);
        expect(humanCount).toBe(3);
    });

    it("exchanges[0] is user greeting", () => {
        const { exchanges } = extractExchanges(FIXTURE, 0);
        expect(exchanges[0]?.role).toBe("user");
        expect(exchanges[0]?.text).toBe("Hello, can you help me fix a bug?");
    });

    it("exchanges[3] contains text + tool annotations (line 6 assistant array)", () => {
        const { exchanges } = extractExchanges(FIXTURE, 0);
        const ex = exchanges[3];
        expect(ex?.role).toBe("assistant");
        expect(ex?.text).toContain("Let me check the form code.");
        expect(ex?.text).toContain("[TOOL: Read LoginForm.php]");
        expect(ex?.text).toContain("[TOOL: Grep 'handleSubmit']");
    });

    it("exchanges[4] contains Edit and Bash tool annotations (line 8 assistant array)", () => {
        const { exchanges } = extractExchanges(FIXTURE, 0);
        const ex = exchanges[4];
        expect(ex?.role).toBe("assistant");
        expect(ex?.text).toContain("[TOOL: Edit LoginForm.php]");
        expect(ex?.text).toContain(
            "[TOOL: Bash `php -f test.php --filter=loginTest`]",
        );
    });

    it("sinceLine=5 returns only exchanges from lines 6–10", () => {
        const { exchanges } = extractExchanges(FIXTURE, 5);
        // line 6: assistant array, line 7: isMeta skipped, line 8: assistant array, line 9: user, line 10: assistant
        expect(exchanges).toHaveLength(4);
    });
});

// ---------------------------------------------------------------------------
// extractExchanges — corrupt lines
// ---------------------------------------------------------------------------

describe("extractExchanges — corrupt lines", () => {
    it("silently skips corrupt lines and parses valid ones", () => {
        const valid1 = JSON.stringify({
            type: "user",
            message: { content: "hello" },
        });
        const valid2 = JSON.stringify({
            type: "assistant",
            message: { content: "world" },
        });
        const file = path.join(tmpDir, "test.jsonl");
        writeFileSync(file, `${[valid1, "garbage!!!{[", valid2].join("\n")}\n`);

        const { exchanges, lastLine } = extractExchanges(file, 0);
        expect(exchanges).toHaveLength(2);
        expect(lastLine).toBe(3);
    });
});
