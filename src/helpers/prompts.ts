import { readFileSync } from "node:fs";
import path from "node:path";

type PromptName = "save" | "compact" | "consolidate" | "preamble";

function resolvePromptPath(pluginDir: string, name: PromptName): string {
    const filename =
        name === "preamble" ? "session-preamble.md" : `${name}.prompt.md`;
    return path.join(pluginDir, "prompts", filename);
}

export function loadPrompt(pluginDir: string, name: PromptName): string {
    const filePath = resolvePromptPath(pluginDir, name);
    try {
        return readFileSync(filePath, "utf8");
    } catch {
        throw new Error(`Prompt file not found: ${filePath}`);
    }
}

export function renderPrompt(
    template: string,
    vars: Record<string, string>,
): string {
    const result = template.replace(
        /\{\{([A-Z_]+)\}\}/g,
        (match, key: string) => {
            return vars[key] ?? match;
        },
    );

    const allMatches = [...result.matchAll(/\{\{([A-Z_]+)\}\}/g)];
    const remaining = [
        ...new Set(
            allMatches
                .map((m) => m[1])
                .filter((k): k is string => k !== undefined),
        ),
    ];

    if (remaining.length > 0) {
        throw new Error(
            `Unsubstituted template placeholders: ${remaining.join(", ")}`,
        );
    }

    return result;
}
