import { execSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../helpers/config.ts";
import { isCoolingDown, markCooldown } from "../helpers/cooldown.ts";
import { callHaiku } from "../helpers/haiku.ts";
import { extractExchanges } from "../helpers/jsonl.ts";
import { acquireLock } from "../helpers/lock.ts";
import { createLogger } from "../helpers/logger.ts";
import {
    appendWorking,
    loadLastSave,
    readLastEntry,
    saveLastSave,
} from "../helpers/memory-files.ts";
import { resolvePaths, sessionJsonlDir } from "../helpers/paths.ts";
import { loadPrompt, renderPrompt } from "../helpers/prompts.ts";

export async function main(
    argv: string[] = process.argv.slice(2),
): Promise<number> {
    // 1. Resolve paths
    const { projectDir, pluginDir, dataDir } = resolvePaths();

    // 2. Load config
    const cfg = loadConfig(pluginDir);

    // 3. Create logger
    const logger = createLogger(dataDir, cfg.timezone);

    // 4. Parse args
    let dryRun = false;
    let force = false;
    let sessionId: string | undefined;

    for (const arg of argv) {
        if (arg === "--dry") {
            dryRun = true;
        } else if (arg === "--force") {
            force = true;
        } else {
            if (!/^[a-f0-9-]+$/.test(arg)) {
                logger.log("save", `invalid session id: ${arg}`);
                return 1;
            }
            sessionId = arg;
        }
    }

    // 5. Find session JSONL
    const sessionsDir = sessionJsonlDir(projectDir);
    let jsonlPath: string;
    let actualSessionId: string;

    if (sessionId !== undefined) {
        jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
        try {
            statSync(jsonlPath);
        } catch {
            logger.log("save", `session file not found: ${jsonlPath}`);
            return 1;
        }
        actualSessionId = sessionId;
    } else {
        let files: string[];
        try {
            files = readdirSync(sessionsDir)
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) => ({
                    name: f,
                    mtime: statSync(path.join(sessionsDir, f)).mtimeMs,
                }))
                .sort((a, b) => b.mtime - a.mtime)
                .map((f) => f.name);
        } catch {
            files = [];
        }

        if (files.length === 0) {
            logger.log("save", "no session files found, skip");
            return 0;
        }

        const firstFile = files[0];
        if (firstFile === undefined) {
            logger.log("save", "no session files found, skip");
            return 0;
        }

        jsonlPath = path.join(sessionsDir, firstFile);
        actualSessionId = firstFile.replace(/\.jsonl$/, "");
    }

    // 6. Acquire lock
    const lockPath = path.join(dataDir, "tmp", "save.lock");
    mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

    let releaseLock: (() => void) | undefined;
    try {
        releaseLock = await acquireLock(lockPath);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("save", msg);
        return 0;
    }

    try {
        // 7. Cooldown check
        const cooldownMarker = path.join(dataDir, "tmp", "last-save-ts");
        if (!force && !dryRun) {
            if (isCoolingDown(cooldownMarker, cfg.cooldowns.saveSeconds)) {
                logger.log(
                    "save",
                    `cooldown ${cfg.cooldowns.saveSeconds}s, skip`,
                );
                return 0;
            }
        }

        // 8. Extract
        const lastSave = loadLastSave(dataDir);
        const sinceLine =
            lastSave !== null && lastSave.session === actualSessionId
                ? lastSave.line
                : 0;

        const { exchanges, lastLine, humanCount } = extractExchanges(
            jsonlPath,
            sinceLine,
        );

        // Mark cooldown immediately after extraction
        markCooldown(cooldownMarker);

        // 9. No exchanges
        if (exchanges.length === 0) {
            logger.log("save", "0 exchanges, skip");
            return 0;
        }

        // 10. Min human messages threshold
        if (!force && !dryRun && humanCount < cfg.thresholds.minHumanMessages) {
            logger.log(
                "save",
                `only ${humanCount} human messages (min ${cfg.thresholds.minHumanMessages}), skip`,
            );
            return 0;
        }

        // 11. Dry run
        if (dryRun) {
            const separator = "-".repeat(40);
            console.log("=== DRY RUN: save extract ===");
            for (const exchange of exchanges) {
                console.log(separator);
                console.log(`[${exchange.role.toUpperCase()}]`);
                console.log(exchange.text);
            }
            console.log(separator);
            return 0;
        }

        // 12. Read last entry
        const lastEntry = readLastEntry(dataDir);

        // 13. Branch + time
        let branch = "unknown";
        try {
            branch = execSync("git branch --show-current", {
                cwd: projectDir,
                encoding: "utf8",
            }).trim();
            if (!branch) branch = "unknown";
        } catch {
            // leave as "unknown"
        }

        const hhmm = new Intl.DateTimeFormat("en-GB", {
            timeZone: cfg.timezone,
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }).format(new Date());

        // 14. Build prompt
        const template = loadPrompt(pluginDir, "save");
        const extractText = exchanges
            .map((e) => `[${e.role.toUpperCase()}]\n${e.text}`)
            .join("\n\n");
        const rendered = renderPrompt(template, {
            TIME: hhmm,
            BRANCH: branch,
            LAST_ENTRY: lastEntry,
            EXTRACT: extractText,
        });

        // 15. Call haiku
        let response: Awaited<ReturnType<typeof callHaiku>>;
        try {
            response = await callHaiku(rendered);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("save", `haiku error: ${msg}`);
            return 1;
        }

        // 16. SKIP response
        if (response.isSkip) {
            saveLastSave(dataDir, actualSessionId, lastLine);
            logger.log("save", "SKIP");
            return 0;
        }

        // 17. Validate response format
        if (!/^## \d{2}:\d{2} \| /.test(response.text)) {
            logger.log(
                "save",
                `warning: unexpected response format: ${response.text.slice(0, 80)}`,
            );
        }

        // 18. Append to working memory, save last-save, log tokens
        appendWorking(dataDir, response.text);
        saveLastSave(dataDir, actualSessionId, lastLine);
        logger.logTokens("save", {
            input: response.tokensIn,
            output: response.tokensOut,
            cache: response.tokensCache,
            costUsd: response.costUsd,
        });

        // 19. Compact check
        const compactMarker = path.join(dataDir, "tmp", "last-compact-ts");
        if (!isCoolingDown(compactMarker, cfg.cooldowns.compactSeconds)) {
            const compactScript = path.join(
                pluginDir,
                "dist",
                "entrypoints",
                "compact.mjs",
            );
            const child = spawn("node", [compactScript], {
                detached: true,
                stdio: "ignore",
            });
            child.unref();
            logger.log("save", "compact dispatched");
        }

        return 0;
    } finally {
        // 20. Release lock
        releaseLock?.();
    }
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
