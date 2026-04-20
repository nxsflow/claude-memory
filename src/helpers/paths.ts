import { existsSync } from "node:fs";
import path from "node:path";

export function resolvePaths(): {
    projectDir: string;
    pluginDir: string;
    dataDir: string;
} {
    const pluginDir =
        process.env.CLAUDE_PLUGIN_ROOT ??
        derivePluginDir() ??
        fail("Cannot resolve plugin root");

    const projectDir =
        process.env.CLAUDE_PROJECT_DIR ??
        deriveProjectDir(pluginDir) ??
        fail(
            "CLAUDE_PROJECT_DIR is not set and plugin is not in a local .claude/claude-memory/ layout",
        );

    return {
        projectDir,
        pluginDir,
        dataDir: path.join(projectDir, ".claude-memory"),
    };
}

function derivePluginDir(): string | null {
    const candidate = path.resolve(import.meta.dirname, "..", "..");
    return existsSync(path.join(candidate, "package.json")) ? candidate : null;
}

function deriveProjectDir(pluginDir: string): string | null {
    if (pluginDir.endsWith("/.claude/claude-memory")) {
        return path.resolve(pluginDir, "..", "..");
    }
    return null;
}

function fail(msg: string): never {
    throw new Error(`FATAL: ${msg}`);
}

export function memoryPath(dataDir: string, file: string): string {
    return path.join(dataDir, file);
}

export function episodicFile(dataDir: string, date: string): string {
    return path.join(dataDir, "episodic-memory", `${date}.md`);
}

export function sessionJsonlDir(projectDir: string): string {
    const slug = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
    return path.join(process.env.HOME ?? "", ".claude", "projects", slug);
}
