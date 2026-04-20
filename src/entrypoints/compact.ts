import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../helpers/config.ts";
import { markCooldown } from "../helpers/cooldown.ts";
import { callHaiku } from "../helpers/haiku.ts";
import { acquireLock } from "../helpers/lock.ts";
import { createLogger } from "../helpers/logger.ts";
import {
    appendEpisode,
    clearWorking,
    readWorking,
} from "../helpers/memory-files.ts";
import { resolvePaths } from "../helpers/paths.ts";
import { loadPrompt, renderPrompt } from "../helpers/prompts.ts";

export async function main(
    argv: string[] = process.argv.slice(2),
): Promise<number> {
    // argv accepted for forward compatibility but unused
    void argv;

    // 1. Resolve paths
    const { pluginDir, dataDir } = resolvePaths();

    // 2. Load config
    const cfg = loadConfig(pluginDir);

    // 3. Create logger
    const logger = createLogger(dataDir, cfg.timezone);

    // 3. Acquire lock
    const lockPath = path.join(dataDir, "tmp", "compact.lock");
    mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

    let releaseLock: (() => void) | undefined;
    try {
        releaseLock = await acquireLock(lockPath);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("compact", msg);
        return 0;
    }

    try {
        // 4. Read working memory
        const workingContent = readWorking(dataDir);
        if (!workingContent.trim()) {
            logger.log("compact", "working empty, skip");
            return 0;
        }

        // 5. Current date in configured timezone
        const date = new Intl.DateTimeFormat("en-CA", {
            timeZone: cfg.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date());

        // 6. Build prompt
        const template = loadPrompt(pluginDir, "compact");
        const rendered = renderPrompt(template, {
            WORKING_MEMORY: workingContent,
        });

        // 7. Call haiku
        let response: Awaited<ReturnType<typeof callHaiku>>;
        try {
            response = await callHaiku(rendered);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("compact", `haiku error: ${msg}`);
            return 1;
        }

        // 8. Append to episodic memory
        appendEpisode(dataDir, date, response.text);

        // 9. Clear working memory
        clearWorking(dataDir);

        // 10. Mark cooldown
        const compactMarker = path.join(dataDir, "tmp", "last-compact-ts");
        markCooldown(compactMarker);

        // 11. Log tokens
        logger.logTokens("compact", {
            input: response.tokensIn,
            output: response.tokensOut,
            cache: response.tokensCache,
            costUsd: response.costUsd,
        });

        return 0;
    } finally {
        // Release lock
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
