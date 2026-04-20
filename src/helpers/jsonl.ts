import { readFileSync } from "node:fs";
import type { Exchange } from "./types.ts";

export function formatToolUse(block: {
    name?: string;
    input?: Record<string, unknown>;
}): string {
    const name = block.name ?? "?";
    const input = block.input ?? {};
    if (name === "Edit" || name === "Read" || name === "Write") {
        const filePath = String(input.file_path ?? "?");
        const filename = filePath.split("/").pop() ?? "?";
        return `[TOOL: ${name} ${filename}]`;
    }
    if (name === "Bash") {
        const cmd = String(input.command ?? "?").slice(0, 80);
        return `[TOOL: Bash \`${cmd}\`]`;
    }
    if (name === "Grep" || name === "Glob") {
        return `[TOOL: ${name} '${String(input.pattern ?? "?")}']`;
    }
    return `[TOOL: ${name}]`;
}

interface ContentBlock {
    type?: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
}

interface SessionLine {
    type?: string;
    isMeta?: boolean;
    message?: {
        content?: string | ContentBlock[];
    };
}

function extractTexts(content: string | ContentBlock[]): string[] {
    const texts: string[] = [];

    if (typeof content === "string") {
        if (
            content.includes("<system-reminder>") ||
            content.includes("<command-name>") ||
            content.includes("<local-command")
        ) {
            return texts;
        }
        const trimmed = content.trim();
        if (trimmed) {
            texts.push(trimmed);
        }
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (block.type === "text") {
                const trimmed = (block.text ?? "").trim();
                if (trimmed) {
                    texts.push(trimmed);
                }
            } else if (block.type === "tool_use") {
                texts.push(
                    formatToolUse({
                        name: block.name,
                        input: block.input,
                    }),
                );
            }
        }
    }

    return texts;
}

export function extractExchanges(
    jsonlPath: string,
    sinceLine: number,
): {
    exchanges: Exchange[];
    lastLine: number;
    humanCount: number;
} {
    const raw = readFileSync(jsonlPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const lastLine = lines.length;

    const exchanges: Exchange[] = [];

    for (let i = sinceLine; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;

        let obj: SessionLine;
        try {
            obj = JSON.parse(line) as SessionLine;
        } catch {
            continue;
        }

        const msgType = obj.type;
        if (msgType !== "user" && msgType !== "assistant") continue;
        if (obj.isMeta === true) continue;

        const content = obj.message?.content;
        if (content === undefined) continue;

        const texts = extractTexts(content as string | ContentBlock[]);
        const joined = texts.join("\n");
        if (!joined) continue;

        exchanges.push({ role: msgType, text: joined });
    }

    const humanCount = exchanges.filter((e) => e.role === "user").length;

    return { exchanges, lastLine, humanCount };
}
