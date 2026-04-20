import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../helpers/config.ts";
import { callHaiku } from "../helpers/haiku.ts";
import { acquireLock } from "../helpers/lock.ts";
import { createLogger } from "../helpers/logger.ts";
import {
    listEpisodes,
    writeDerivedMemoryFiles,
} from "../helpers/memory-files.ts";
import { resolvePaths } from "../helpers/paths.ts";
import { loadPrompt, renderPrompt } from "../helpers/prompts.ts";
import {
    currentSubjects,
    mergeExtracted,
    readTemporal,
    renderMarkdown,
    rollEvents,
    writeTemporal,
} from "../helpers/temporal.ts";
import type { ExtractedPayload } from "../helpers/types.ts";

export function parseExtractResponse(raw: string): ExtractedPayload {
    let text = raw.trim();
    if (text.startsWith("```")) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline !== -1) {
            text = text.slice(firstNewline + 1);
        }
        const closingFence = text.lastIndexOf("```");
        if (closingFence !== -1) {
            text = text.slice(0, closingFence);
        }
        text = text.trim();
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        const snippet = raw.slice(0, 120).replace(/\n/g, "\\n");
        throw new Error(`Invalid JSON in Haiku response: "${snippet}"`);
    }

    if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Haiku response is not an object");
    }
    const obj = parsed as Record<string, unknown>;

    if (!Array.isArray(obj.newFacts)) {
        throw new Error("Missing or non-array newFacts in response");
    }
    if (!Array.isArray(obj.newEvents)) {
        throw new Error("Missing or non-array newEvents in response");
    }

    const newFacts = obj.newFacts.map((item, i) => {
        if (
            typeof item !== "object" ||
            item === null ||
            typeof (item as Record<string, unknown>).subject !== "string" ||
            typeof (item as Record<string, unknown>).value !== "string"
        ) {
            throw new Error(`newFacts[${i}] missing subject or value`);
        }
        const rec = item as { subject: string; value: string };
        return { subject: rec.subject, value: rec.value };
    });

    const newEvents = obj.newEvents.map((item, i) => {
        if (
            typeof item !== "object" ||
            item === null ||
            typeof (item as Record<string, unknown>).date !== "string" ||
            typeof (item as Record<string, unknown>).summary !== "string"
        ) {
            throw new Error(`newEvents[${i}] missing date or summary`);
        }
        const rec = item as { date: string; summary: string };
        return { date: rec.date, summary: rec.summary };
    });

    return { newFacts, newEvents };
}

export async function main(
    argv: string[] = process.argv.slice(2),
): Promise<number> {
    void argv;

    const { pluginDir, dataDir } = resolvePaths();
    const cfg = loadConfig(pluginDir);
    const logger = createLogger(dataDir, cfg.timezone);

    const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: cfg.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());

    const episodes = listEpisodes(dataDir, { excludeDate: today });
    if (episodes.length === 0) {
        logger.log("consolidate", "no past episodes, skip");
        return 0;
    }

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
        const episodesText = episodes
            .map(({ date, path: filePath }) => {
                let content = "";
                try {
                    content = readFileSync(filePath, "utf8");
                } catch {
                    content = "";
                }
                return `## ${date}\n${content}`;
            })
            .join("\n\n");

        const store = readTemporal(dataDir);
        const glossary = currentSubjects(store);
        const glossaryText =
            glossary.length > 0
                ? glossary.map((s) => `- ${s}`).join("\n")
                : "(none yet)";

        const template = loadPrompt(pluginDir, "consolidate");
        const rendered = renderPrompt(template, {
            EPISODES: episodesText,
            SUBJECT_GLOSSARY: glossaryText,
        });

        let response: Awaited<ReturnType<typeof callHaiku>>;
        try {
            response = await callHaiku(rendered);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("consolidate", `haiku error: ${msg}`);
            return 1;
        }

        let extracted: ExtractedPayload;
        try {
            extracted = parseExtractResponse(response.text);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("consolidate", `parse error: ${msg}`);
            return 1;
        }

        const merged = rollEvents(
            mergeExtracted(store, today, extracted),
            today,
            cfg.eventHorizonDays,
        );

        try {
            writeTemporal(dataDir, merged);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.log("consolidate", `writeTemporal failed: ${msg}`);
            return 1;
        }

        const rendered_md = renderMarkdown(merged, today);
        writeDerivedMemoryFiles(dataDir, rendered_md);

        const estTokens = (s: string) => Math.ceil(s.length / 4);
        const shortTok = estTokens(rendered_md.shortTerm);
        const longTok = estTokens(rendered_md.longTerm);
        if (shortTok > cfg.tokenSoftCap.shortTerm) {
            logger.log(
                "consolidate",
                `shortTerm soft cap exceeded: ~${shortTok} > ${cfg.tokenSoftCap.shortTerm} tokens`,
            );
        }
        if (longTok > cfg.tokenSoftCap.longTerm) {
            logger.log(
                "consolidate",
                `longTerm soft cap exceeded: ~${longTok} > ${cfg.tokenSoftCap.longTerm} tokens`,
            );
        }

        for (const { path: filePath } of episodes) {
            rmSync(filePath, { force: true });
        }

        logger.logTokens("consolidate", {
            input: response.tokensIn,
            output: response.tokensOut,
            cache: response.tokensCache,
            costUsd: response.costUsd,
        });

        return 0;
    } finally {
        releaseLock?.();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main()
        .then(process.exit)
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
