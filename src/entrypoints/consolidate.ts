import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../helpers/config.ts";
import { callHaiku } from "../helpers/haiku.ts";
import { acquireLock } from "../helpers/lock.ts";
import { createLogger } from "../helpers/logger.ts";
import {
    listEpisodes,
    readLongTerm,
    readShortTerm,
    writeLongTerm,
    writeShortTerm,
} from "../helpers/memory-files.ts";
import { resolvePaths } from "../helpers/paths.ts";
import { loadPrompt, renderPrompt } from "../helpers/prompts.ts";

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

export function parseConsolidateResponse(raw: string): {
    shortTerm: string;
    longTerm: string;
} {
    // Strip optional code fences that Haiku sometimes wraps around the output
    let text = raw.trim();
    if (text.startsWith("```")) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline !== -1) {
            // Drop the opening fence line (e.g. "```" or "```markdown")
            text = text.slice(firstNewline + 1);
        }
        // Drop matching closing fence
        const closingFence = text.lastIndexOf("```");
        if (closingFence !== -1) {
            text = text.slice(0, closingFence);
        }
        text = text.trim();
    }

    const SHORT_MARKER = "===SHORT-TERM===";
    const LONG_MARKER = "===LONG-TERM===";

    const shortIdx = text.indexOf(SHORT_MARKER);
    const longIdx = text.indexOf(LONG_MARKER);

    if (shortIdx === -1) {
        const snippet = raw.slice(0, 120).replace(/\n/g, "\\n");
        throw new Error(
            `Missing ===SHORT-TERM=== marker in response. Got: "${snippet}"`,
        );
    }

    if (longIdx === -1) {
        const snippet = raw.slice(0, 120).replace(/\n/g, "\\n");
        throw new Error(
            `Missing ===LONG-TERM=== marker in response. Got: "${snippet}"`,
        );
    }

    const shortTerm = text
        .slice(shortIdx + SHORT_MARKER.length, longIdx)
        .trim();
    const longTerm = text.slice(longIdx + LONG_MARKER.length).trim();

    return { shortTerm, longTerm };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

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

    // 4. Compute today in configured timezone (YYYY-MM-DD)
    const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: cfg.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());

    // 5. List past episodes (exclude today)
    const episodes = listEpisodes(dataDir, { excludeDate: today });

    if (episodes.length === 0) {
        logger.log("consolidate", "no past episodes, skip");
        return 0;
    }

    // 6. Acquire lock
    const lockPath = path.join(dataDir, "tmp", "consolidate.lock");
    mkdirSync(path.join(dataDir, "tmp"), { recursive: true });

    let releaseLock: (() => void) | undefined;
    try {
        releaseLock = await acquireLock(lockPath);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log("consolidate", msg);
        return 0;
    }

    try {
        // 7. Build episodes text
        const episodesText = episodes
            .map(({ date, path: filePath }) => {
                let content = "";
                try {
                    content = readFileSync(filePath, "utf8");
                } catch {
                    content = "";
                }
                return `=== ${date} ===\n${content}`;
            })
            .join("\n\n");

        // 8. Read short-term and long-term memory
        const shortTerm = readShortTerm(dataDir);
        const longTerm = readLongTerm(dataDir);

        // 9. Build and render prompt
        const template = loadPrompt(pluginDir, "consolidate");
        const rendered = renderPrompt(template, {
            EPISODES: episodesText,
            SHORT_TERM: shortTerm,
            LONG_TERM: longTerm,
        });

        // 10. Call haiku
        let response: Awaited<ReturnType<typeof callHaiku>>;
        try {
            response = await callHaiku(rendered);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("consolidate", `haiku error: ${msg}`);
            return 1;
        }

        // 11. Parse response
        let parsed: { shortTerm: string; longTerm: string };
        try {
            parsed = parseConsolidateResponse(response.text);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("consolidate", `parse error: ${msg}`);
            return 1;
        }

        // 12. Write short-term and long-term memory
        writeShortTerm(dataDir, parsed.shortTerm);
        writeLongTerm(dataDir, parsed.longTerm);

        // 13. Delete consumed episode files
        for (const { path: filePath } of episodes) {
            rmSync(filePath, { force: true });
        }

        // 14. Log tokens
        logger.logTokens("consolidate", {
            input: response.tokensIn,
            output: response.tokensOut,
            cache: response.tokensCache,
            costUsd: response.costUsd,
        });

        return 0;
    } finally {
        // 15. Release lock
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
