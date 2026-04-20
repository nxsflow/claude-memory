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
    // Collect placeholders in the ORIGINAL template; if a substituted value
    // (e.g. a conversation extract or prior memory entry) happens to contain
    // `{{FOO}}` literally, that is user content, not a template error.
    const templateMatches = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)];
    const missing = [
        ...new Set(
            templateMatches
                .map((m) => m[1])
                .filter((k): k is string => k !== undefined && !(k in vars)),
        ),
    ];

    if (missing.length > 0) {
        throw new Error(
            `Unsubstituted template placeholders: ${missing.join(", ")}`,
        );
    }

    return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
        return vars[key] ?? match;
    });
}
