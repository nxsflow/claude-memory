import { spawn } from "node:child_process";
import type { HaikuResponse } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const SIGKILL_DELAY_MS = 2_000;

const CLI_ARGS = [
    "-p",
    "--model",
    "haiku",
    "--allowedTools",
    "",
    "--max-turns",
    "1",
    "--output-format",
    "json",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
];

function buildEnv(): Record<string, string | undefined> {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    return env;
}

function extractText(result: Record<string, unknown>): string | undefined {
    if (typeof result.result === "string") {
        return result.result;
    }

    const message = result.message;
    if (message !== null && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") {
            return content;
        }
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block !== null && typeof block === "object") {
                    const text = (block as Record<string, unknown>).text;
                    if (typeof text === "string") {
                        return text;
                    }
                }
            }
        }
    }

    return undefined;
}

function parseResponse(raw: string): HaikuResponse {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Haiku response was not JSON: ${raw.slice(0, 200)}`);
    }

    const result: Record<string, unknown> = Array.isArray(parsed)
        ? (parsed[0] as Record<string, unknown>)
        : (parsed as Record<string, unknown>);

    const text = extractText(result);
    if (text === undefined) {
        throw new Error("Haiku response had no text");
    }

    const trimmed = text.trim();

    const usage =
        result.usage !== null && typeof result.usage === "object"
            ? (result.usage as Record<string, unknown>)
            : {};

    const tokensIn =
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const tokensOut =
        typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const tokensCache =
        typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : 0;
    const costUsd =
        typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;

    return {
        text: trimmed,
        isSkip: trimmed.startsWith("SKIP"),
        tokensIn,
        tokensOut,
        tokensCache,
        costUsd,
    };
}

export async function callHaiku(
    prompt: string,
    opts?: { timeoutMs?: number },
): Promise<HaikuResponse> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<HaikuResponse>((resolve, reject) => {
        const child = spawn("claude", CLI_ARGS, {
            cwd: "/tmp",
            env: buildEnv(),
            stdio: ["pipe", "pipe", "pipe"],
        });

        child.stdin.write(prompt);
        child.stdin.end();

        let stdoutBuf = "";
        let stderrBuf = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdoutBuf += chunk.toString("utf8");
        });

        child.stderr.on("data", (chunk: Buffer) => {
            stderrBuf += chunk.toString("utf8");
        });

        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;

            child.kill("SIGTERM");
            const killTimer = setTimeout(() => {
                child.kill("SIGKILL");
            }, SIGKILL_DELAY_MS);
            // Prevent the kill timer from holding the event loop open
            if (typeof killTimer === "object" && killTimer !== null) {
                (killTimer as NodeJS.Timeout).unref?.();
            }

            reject(new Error(`callHaiku timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        if (typeof timer === "object" && timer !== null) {
            (timer as NodeJS.Timeout).unref?.();
        }

        child.on("exit", (code: number | null) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;

            if (code !== 0) {
                reject(
                    new Error(
                        `claude exited with exit ${code ?? "null"}${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`,
                    ),
                );
                return;
            }

            try {
                resolve(parseResponse(stdoutBuf));
            } catch (err) {
                reject(err);
            }
        });
    });
}
