import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadConfig } from "../helpers/config.ts";
import { createLogger } from "../helpers/logger.ts";
import {
    consumeHandover,
    listEpisodes,
    loadLastSave,
} from "../helpers/memory-files.ts";
import { resolvePaths, sessionJsonlDir } from "../helpers/paths.ts";
import { loadPrompt } from "../helpers/prompts.ts";

// ---------------------------------------------------------------------------
// Internal helper — emit a file section to stdout if present and non-empty.
// Returns true if content was emitted.
// ---------------------------------------------------------------------------

function emitFile(filePath: string): boolean {
    if (!existsSync(filePath)) return false;
    let content: string;
    try {
        content = readFileSync(filePath, "utf8");
    } catch {
        return false;
    }
    if (!content.trim()) return false;

    const basename = path.basename(filePath);
    process.stdout.write(`--- ${basename} ---\n`);
    process.stdout.write(content);
    if (!content.endsWith("\n")) {
        process.stdout.write("\n");
    }
    process.stdout.write("\n");
    return true;
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
    // 1. Resolve paths + load config + create logger
    let projectDir: string;
    let pluginDir: string;
    let dataDir: string;

    try {
        const resolved = resolvePaths();
        projectDir = resolved.projectDir;
        pluginDir = resolved.pluginDir;
        dataDir = resolved.dataDir;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`session-start: ${msg}\n`);
        return 0;
    }

    let cfg: ReturnType<typeof loadConfig>;
    try {
        cfg = loadConfig(pluginDir);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`session-start: loadConfig failed: ${msg}\n`);
        return 0;
    }

    const logger = createLogger(dataDir, cfg.timezone);

    // 2. Ensure required directories exist
    try {
        mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
        mkdirSync(path.join(dataDir, "logs", "autonomous"), {
            recursive: true,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("session-start", `mkdir failed: ${msg}`);
    }

    // 3. Ensure dataDir/.gitignore exists with "*"
    try {
        const gitignorePath = path.join(dataDir, ".gitignore");
        if (!existsSync(gitignorePath)) {
            writeFileSync(gitignorePath, "*\n", "utf8");
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("session-start", `gitignore create failed: ${msg}`);
    }

    // 4. Recovery check
    if (cfg.features.recovery) {
        try {
            const sessionsDir = sessionJsonlDir(projectDir);
            if (existsSync(sessionsDir)) {
                const jsonlFiles = readdirSync(sessionsDir)
                    .filter((f) => f.endsWith(".jsonl"))
                    .map((f) => ({
                        name: f,
                        mtime: statSync(path.join(sessionsDir, f)).mtimeMs,
                    }))
                    .sort((a, b) => b.mtime - a.mtime);

                // We want the second-most-recent (index 1) — the previous session
                if (jsonlFiles.length >= 2) {
                    const prevFile = jsonlFiles[1];
                    if (prevFile !== undefined) {
                        const prevSessionId = prevFile.name.replace(
                            /\.jsonl$/,
                            "",
                        );
                        const lastSave = loadLastSave(dataDir);

                        if (lastSave?.session !== prevSessionId) {
                            const saveScript = path.join(
                                pluginDir,
                                "dist",
                                "entrypoints",
                                "save.mjs",
                            );
                            const child = spawn(
                                "node",
                                [saveScript, prevSessionId, "--force"],
                                {
                                    cwd: pluginDir,
                                    detached: true,
                                    stdio: "ignore",
                                    env: process.env,
                                },
                            );
                            child.unref();
                            logger.log(
                                "session-start",
                                `recovery: ${prevSessionId}`,
                            );
                        }
                    }
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("session-start", `recovery check failed: ${msg}`);
        }
    }

    // Compute today's date in the configured timezone (YYYY-MM-DD)
    const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: cfg.timezone,
    }).format(new Date());

    // 5. Emit history preamble
    try {
        const preamble = loadPrompt(pluginDir, "preamble");
        process.stdout.write(preamble);
        if (!preamble.endsWith("\n")) {
            process.stdout.write("\n");
        }
        process.stdout.write("\n");
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("session-start", `preamble load failed: ${msg}`);
    }

    // 6. Emit memory sections wrapped in "=== MEMORY ==="
    const memoryFiles = [
        path.join(dataDir, "agent-role.md"),
        path.join(dataDir, "core-memories.md"),
        path.join(dataDir, "session-handover.md"),
        path.join(dataDir, "episodic-memory", `${today}.md`),
        path.join(dataDir, "working-memory.md"),
        path.join(dataDir, "short-term-memory.md"),
        path.join(dataDir, "long-term-memory.md"),
    ];

    // Collect which files have content
    const fileResults: { filePath: string; hasContent: boolean }[] =
        memoryFiles.map((filePath) => {
            if (!existsSync(filePath)) return { filePath, hasContent: false };
            try {
                const content = readFileSync(filePath, "utf8");
                return { filePath, hasContent: content.trim().length > 0 };
            } catch {
                return { filePath, hasContent: false };
            }
        });

    const anyContent = fileResults.some((r) => r.hasContent);

    if (anyContent) {
        process.stdout.write("=== MEMORY ===\n\n");
        for (const { filePath } of fileResults) {
            try {
                emitFile(filePath);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.log(
                    "session-start",
                    `emitFile failed for ${filePath}: ${msg}`,
                );
            }
        }
    }

    // 6b. First-run bootstrap: if agent-role.md is absent or empty and an
    // example template ships with the plugin, ask the agent to author the
    // file from whatever context it already has. Skipped silently on every
    // subsequent session once the file has content.
    try {
        const agentRolePath = path.join(dataDir, "agent-role.md");
        let hasAgentRole = false;
        if (existsSync(agentRolePath)) {
            try {
                hasAgentRole =
                    readFileSync(agentRolePath, "utf8").trim().length > 0;
            } catch {
                hasAgentRole = false;
            }
        }

        if (!hasAgentRole) {
            const examplePath = path.join(pluginDir, "agent-role.example.md");
            if (existsSync(examplePath)) {
                const template = readFileSync(examplePath, "utf8");
                process.stdout.write("=== FIRST-RUN BOOTSTRAP ===\n");
                process.stdout.write(
                    `\`${agentRolePath}\` does not exist yet. Before responding to the user, create it using the template below as the starting structure, tailored from whatever context you already have about this user, this project, and how they work with you (CLAUDE.md, other memory, open files, recent commits).\n\n`,
                );
                process.stdout.write(
                    "Be honest: when you don't know something, leave that part close to the template wording or drop the section — do not invent details. The user will refine the file later.\n\n",
                );
                process.stdout.write("Template (agent-role.example.md):\n\n");
                process.stdout.write(template);
                if (!template.endsWith("\n")) {
                    process.stdout.write("\n");
                }
                process.stdout.write("\n");
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("session-start", `bootstrap check failed: ${msg}`);
    }

    // 7. Consume handover after emitting
    try {
        consumeHandover(dataDir);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("session-start", `consumeHandover failed: ${msg}`);
    }

    // 8. Consolidation trigger
    try {
        const pastEpisodes = listEpisodes(dataDir, { excludeDate: today });
        if (pastEpisodes.length > 0) {
            const consolidateScript = path.join(
                pluginDir,
                "dist",
                "entrypoints",
                "consolidate.mjs",
            );
            const child = spawn("node", [consolidateScript], {
                cwd: pluginDir,
                detached: true,
                stdio: "ignore",
                env: process.env,
            });
            child.unref();

            process.stdout.write("=== MEMORY CONSOLIDATION ===\n");
            process.stdout.write(
                `${pastEpisodes.length} day(s) of past episodes — consolidation running in background.\n`,
            );
            process.stdout.write("\n");
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("session-start", `consolidation trigger failed: ${msg}`);
    }

    return 0;
}

// Only run if invoked as script (not during tests)
if (import.meta.url === `file://${process.argv[1]}`) {
    main()
        .then(process.exit)
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
