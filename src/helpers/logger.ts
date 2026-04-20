import { execSync } from "node:child_process";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
} from "node:fs";
import path from "node:path";

export interface Logger {
    log(component: string, message: string): void;
    logTokens(
        component: string,
        tk: {
            input: number;
            output: number;
            cache: number;
            costUsd: number;
        },
    ): void;
    rotateOldLogs(): void;
}

function formatTime(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(date);
}

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function yearMonth(filename: string): string {
    // memory-YYYY-MM-DD.log -> YYYY-MM
    const m = filename.match(/memory-(\d{4}-\d{2})-\d{2}\.log$/);
    return m?.[1] ?? "unknown";
}

export function createLogger(dataDir: string, timezone: string): Logger {
    const logsDir = path.join(dataDir, "logs");

    function ensureLogsDir(): void {
        if (!existsSync(logsDir)) {
            mkdirSync(logsDir, { recursive: true });
        }
    }

    function currentLogFile(): string {
        return path.join(logsDir, `memory-${formatDate(new Date())}.log`);
    }

    function log(component: string, message: string): void {
        ensureLogsDir();
        const time = formatTime(new Date(), timezone);
        appendFileSync(currentLogFile(), `${time} [${component}] ${message}\n`);
    }

    function logTokens(
        component: string,
        tk: {
            input: number;
            output: number;
            cache: number;
            costUsd: number;
        },
    ): void {
        log(
            component,
            `tokens: ${tk.input}+${tk.cache}cache→${tk.output}out ($${tk.costUsd})`,
        );
    }

    function rotateOldLogs(): void {
        try {
            ensureLogsDir();
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
            const now = Date.now();
            const files = readdirSync(logsDir).filter((f) =>
                f.match(/^memory-\d{4}-\d{2}-\d{2}\.log$/),
            );

            // Group old files by year-month
            const byMonth = new Map<string, string[]>();
            for (const file of files) {
                const fullPath = path.join(logsDir, file);
                const stat = statSync(fullPath);
                if (now - stat.mtimeMs > sevenDaysMs) {
                    const ym = yearMonth(file);
                    const group = byMonth.get(ym) ?? [];
                    group.push(file);
                    byMonth.set(ym, group);
                }
            }

            for (const [ym, group] of byMonth.entries()) {
                const tarName = `logs-${ym}.tar.gz`;
                const tarPath = path.join(logsDir, tarName);
                const fileList = group.join(" ");
                execSync(`tar -czf ${tarName} ${fileList}`, { cwd: logsDir });
                // verify tar was created before removing originals
                if (existsSync(tarPath)) {
                    for (const file of group) {
                        unlinkSync(path.join(logsDir, file));
                    }
                }
            }
        } catch (err) {
            process.stderr.write(
                `[logger] rotateOldLogs error: ${String(err)}\n`,
            );
        }
    }

    return { log, logTokens, rotateOldLogs };
}
