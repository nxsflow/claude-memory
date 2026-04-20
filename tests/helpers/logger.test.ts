import { execSync } from "node:child_process";
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/helpers/logger.ts";

let dataDir: string;

beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "cm-log-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function todayUTC(): string {
    return new Date().toISOString().slice(0, 10);
}

function logFile(): string {
    return path.join(dataDir, "logs", `memory-${todayUTC()}.log`);
}

describe("createLogger", () => {
    it("auto-creates logs dir if missing", () => {
        const logger = createLogger(dataDir, "UTC");
        logger.log("test", "hello");
        const content = readFileSync(logFile(), "utf8");
        expect(content).toContain("[test] hello");
    });

    it("log writes HH:MM:SS [component] message line", () => {
        const logger = createLogger(dataDir, "UTC");
        logger.log("comp", "msg");
        const lines = readFileSync(logFile(), "utf8")
            .split("\n")
            .filter(Boolean);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        const line = lines[0] ?? "";
        expect(line).toMatch(/^\d{2}:\d{2}:\d{2} \[comp\] msg$/);
    });

    it("logTokens emits token line with correct format", () => {
        const logger = createLogger(dataDir, "UTC");
        logger.logTokens("save", {
            input: 100,
            output: 50,
            cache: 200,
            costUsd: 0.0123,
        });
        const content = readFileSync(logFile(), "utf8");
        expect(content).toContain(
            "[save] tokens: 100+200cache→50out ($0.0123)",
        );
    });

    it("appends multiple log lines", () => {
        const logger = createLogger(dataDir, "UTC");
        logger.log("a", "first");
        logger.log("b", "second");
        const lines = readFileSync(logFile(), "utf8")
            .split("\n")
            .filter(Boolean);
        expect(lines.length).toBe(2);
        expect(lines[0]).toContain("[a] first");
        expect(lines[1]).toContain("[b] second");
    });

    it("rotateOldLogs tars files older than 7 days and removes originals", () => {
        // Skip if tar is not available
        try {
            execSync("tar --version", { stdio: "ignore" });
        } catch {
            return;
        }

        const logger = createLogger(dataDir, "UTC");
        // write a log entry to create the logs dir and today's file
        logger.log("test", "seed");

        const logsDir = path.join(dataDir, "logs");
        const oldDate = "2026-03-01";
        const oldFile = path.join(logsDir, `memory-${oldDate}.log`);
        // create an old log file
        writeFileSync(oldFile, "old entry\n");
        // set mtime to 8 days ago
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

        logger.rotateOldLogs();

        // old .log should be gone
        const remaining = readdirSync(logsDir);
        expect(remaining).not.toContain(`memory-${oldDate}.log`);
        // a tar.gz should exist for 2026-03
        const tars = remaining.filter((f) => f.endsWith(".tar.gz"));
        expect(tars.length).toBeGreaterThanOrEqual(1);
        expect(tars.some((t) => t.includes("2026-03"))).toBe(true);
    });
});
