import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake ChildProcess factory
// ---------------------------------------------------------------------------

interface FakeStdin {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
}

interface FakeChild {
    stdin: FakeStdin;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    on: (event: string, handler: (...args: unknown[]) => void) => FakeChild;
    _exitHandlers: Array<(code: number | null) => void>;
    _emitExit: (code: number | null) => void;
}

function makeFakeChild(
    stdoutData: string,
    exitCode: number,
    stderrData = "",
): FakeChild {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exitHandlers: Array<(code: number | null) => void> = [];

    const child: FakeChild = {
        stdin: {
            write: vi.fn(),
            end: vi.fn(),
        },
        stdout,
        stderr,
        kill: vi.fn(),
        on(event: string, handler: (...args: unknown[]) => void) {
            if (event === "exit") {
                exitHandlers.push(handler as (code: number | null) => void);
            }
            return this;
        },
        _exitHandlers: exitHandlers,
        _emitExit(code: number | null) {
            for (const h of exitHandlers) {
                h(code);
            }
        },
    };

    // Schedule async emission so callHaiku can attach listeners first
    setImmediate(() => {
        if (stderrData) {
            stderr.emit("data", Buffer.from(stderrData));
        }
        stderr.emit("end");
        stdout.emit("data", Buffer.from(stdoutData));
        stdout.emit("end");
        child._emitExit(exitCode);
    });

    return child;
}

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------

let spawnArgs: [string, string[], object] | null = null;
let fakeChild: FakeChild | null = null;

vi.mock("node:child_process", () => ({
    spawn: (cmd: string, args: string[], opts: object) => {
        spawnArgs = [cmd, args, opts];
        // biome-ignore lint/style/noNonNullAssertion: set by test before spawn is called
        return fakeChild!;
    },
}));

// ---------------------------------------------------------------------------
// Import under test (after mock is in place)
// ---------------------------------------------------------------------------

const { callHaiku } = await import("../../src/helpers/haiku.ts");

// ---------------------------------------------------------------------------
// Shared response fixture
// ---------------------------------------------------------------------------

const HAPPY_RESPONSE = JSON.stringify({
    result: "## 10:30 | main\nDid stuff",
    usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 200,
    },
    total_cost_usd: 0.005,
});

beforeEach(() => {
    spawnArgs = null;
    fakeChild = null;
});

afterEach(() => {
    vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("callHaiku", () => {
    it("1. happy path — single object response", async () => {
        fakeChild = makeFakeChild(HAPPY_RESPONSE, 0);

        const result = await callHaiku("test prompt");

        expect(result.text).toBe("## 10:30 | main\nDid stuff");
        expect(result.isSkip).toBe(false);
        expect(result.tokensIn).toBe(500);
        expect(result.tokensOut).toBe(100);
        expect(result.tokensCache).toBe(200);
        expect(result.costUsd).toBe(0.005);
    });

    it("2. happy path — array response (first element used)", async () => {
        fakeChild = makeFakeChild(`[${HAPPY_RESPONSE}]`, 0);

        const result = await callHaiku("test prompt");

        expect(result.text).toBe("## 10:30 | main\nDid stuff");
        expect(result.isSkip).toBe(false);
        expect(result.tokensIn).toBe(500);
        expect(result.tokensOut).toBe(100);
        expect(result.tokensCache).toBe(200);
        expect(result.costUsd).toBe(0.005);
    });

    it("3. SKIP detection — text starting with SKIP sets isSkip true", async () => {
        const skipResponse = JSON.stringify({
            result: "SKIP — duplicate",
            usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 0,
            },
            total_cost_usd: 0,
        });
        fakeChild = makeFakeChild(skipResponse, 0);

        const result = await callHaiku("check prompt");

        expect(result.isSkip).toBe(true);
        expect(result.text).toBe("SKIP — duplicate");
    });

    it("4. cache_read_input_tokens missing defaults to 0", async () => {
        const response = JSON.stringify({
            result: "some text",
            usage: {
                input_tokens: 300,
                output_tokens: 50,
                // cache_read_input_tokens intentionally absent
            },
            total_cost_usd: 0.002,
        });
        fakeChild = makeFakeChild(response, 0);

        const result = await callHaiku("prompt");

        expect(result.tokensCache).toBe(0);
    });

    it("5. non-zero exit — rejects with error including exit code and stderr", async () => {
        fakeChild = makeFakeChild("", 1, "something bad");

        const err = await callHaiku("prompt").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        const msg = (err as Error).message;
        expect(msg).toMatch(/exit 1/);
        expect(msg).toContain("something bad");
    });

    it("6. non-JSON stdout — rejects with 'not JSON' in message", async () => {
        fakeChild = makeFakeChild("not json garbage", 0);

        await expect(callHaiku("prompt")).rejects.toThrow(/not JSON/i);
    });

    it("7. spawn call arguments — correct CLI flags and options", async () => {
        fakeChild = makeFakeChild(HAPPY_RESPONSE, 0);

        await callHaiku("prompt");

        expect(spawnArgs).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
        const [cmd, args, opts] = spawnArgs!;

        expect(cmd).toBe("claude");
        expect(args).toContain("-p");
        expect(args).toContain("--model");
        expect(args).toContain("haiku");
        expect(args).toContain("--max-turns");
        expect(args).toContain("1");
        expect(args).toContain("--output-format");
        expect(args).toContain("json");
        expect(args).toContain("--strict-mcp-config");

        const options = opts as Record<string, unknown>;
        expect(options.cwd).toBe("/tmp");

        const env = options.env as Record<string, unknown>;
        expect(env).toBeDefined();
        expect(env.CLAUDECODE).toBeUndefined();
    });

    it("8. stdin receives the prompt and is closed", async () => {
        fakeChild = makeFakeChild(HAPPY_RESPONSE, 0);

        await callHaiku("my prompt");

        expect(fakeChild.stdin.write).toHaveBeenCalledWith("my prompt");
        expect(fakeChild.stdin.end).toHaveBeenCalled();
    });
});
