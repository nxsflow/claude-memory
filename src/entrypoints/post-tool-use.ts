import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadConfig } from "../helpers/config.ts";
import { createLogger } from "../helpers/logger.ts";
import { loadLastSave } from "../helpers/memory-files.ts";
import { resolvePaths, sessionJsonlDir } from "../helpers/paths.ts";

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
    // 1. Resolve paths + load config
    let projectDir: string;
    let pluginDir: string;
    let dataDir: string;

    try {
        const resolved = resolvePaths();
        projectDir = resolved.projectDir;
        pluginDir = resolved.pluginDir;
        dataDir = resolved.dataDir;
    } catch {
        return 0;
    }

    let cfg: ReturnType<typeof loadConfig>;
    try {
        cfg = loadConfig(pluginDir);
    } catch {
        return 0;
    }

    // 2. Create logger
    const logger = createLogger(dataDir, cfg.timezone);

    // 3. Locate the current session JSONL (newest by mtime)
    const sessionsDir = sessionJsonlDir(projectDir);
    if (!existsSync(sessionsDir)) {
        return 0;
    }

    let jsonlFiles: { name: string; mtime: number }[];
    try {
        jsonlFiles = readdirSync(sessionsDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({
                name: f,
                mtime: statSync(path.join(sessionsDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return 0;
    }

    if (jsonlFiles.length === 0) {
        return 0;
    }

    const newestFile = jsonlFiles[0];
    if (newestFile === undefined) {
        return 0;
    }

    const jsonlPath = path.join(sessionsDir, newestFile.name);
    const sessionId = newestFile.name.replace(/\.jsonl$/, "");

    // 4. Count lines
    let currentLines: number;
    try {
        const content = readFileSync(jsonlPath, "utf8");
        const lines = content.split("\n");
        // Subtract trailing empty line if present
        currentLines =
            lines.length > 0 && lines[lines.length - 1] === ""
                ? lines.length - 1
                : lines.length;
    } catch {
        return 0;
    }

    // 5. Derive last line from last-save.json
    const lastSave = loadLastSave(dataDir);
    const lastLine =
        lastSave !== null && lastSave.session === sessionId ? lastSave.line : 0;

    // 6. Compute delta
    const delta = currentLines - lastLine;

    // 7. Check if delta exceeds threshold
    if (delta <= cfg.thresholds.deltaLinesTrigger) {
        return 0;
    }

    // 8. Check if a save is already running via PID file
    const pidFile = path.join(dataDir, "tmp", "save-session.pid");
    if (existsSync(pidFile)) {
        try {
            const pidStr = readFileSync(pidFile, "utf8").trim();
            const pid = parseInt(pidStr, 10);
            if (!Number.isNaN(pid)) {
                try {
                    process.kill(pid, 0);
                    // Process is alive — skip spawning
                    logger.log("post-tool-use", "save already running");
                    return 0;
                } catch {
                    // Process is dead — stale PID file, proceed to spawn
                }
            }
        } catch {
            // Could not read PID file — proceed to spawn
        }
    }

    // 9. Spawn save in background
    const saveScript = path.join(pluginDir, "dist", "entrypoints", "save.mjs");

    // Build log file path with HHMMSS timestamp
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const logDir = path.join(dataDir, "logs", "autonomous");

    try {
        mkdirSync(logDir, { recursive: true });
    } catch {
        // best-effort
    }

    // Sweep 0-byte autonomous logs from prior runs — a silent save (skipped
    // via cooldown, lock, 0-exchanges, etc.) writes nothing to stdout/stderr
    // and leaves an empty file behind. Only remove files older than 5s so an
    // in-flight write from a concurrent run is never touched.
    try {
        const sweepCutoff = Date.now() - 5_000;
        for (const name of readdirSync(logDir)) {
            if (!name.endsWith(".log")) continue;
            const p = path.join(logDir, name);
            const st = statSync(p);
            if (st.size === 0 && st.mtimeMs < sweepCutoff) {
                unlinkSync(p);
            }
        }
    } catch {
        // best-effort
    }

    const logPath = path.join(logDir, `save-${hh}${mm}${ss}.log`);

    let logFd: number;
    try {
        logFd = openSync(logPath, "a");
    } catch {
        // Fall back to ignore if log file can't be opened
        logFd = -1;
    }

    const stdioOption =
        logFd >= 0
            ? (["ignore", logFd, logFd] as ["ignore", number, number])
            : "ignore";

    const child = spawn("node", [saveScript, sessionId], {
        cwd: pluginDir,
        detached: true,
        stdio: stdioOption,
        env: process.env,
    });
    child.unref();

    // Write child PID to PID file
    if (child.pid !== undefined) {
        try {
            mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
            writeFileSync(pidFile, String(child.pid), "utf8");
        } catch {
            // best-effort
        }
    }

    logger.log(
        "post-tool-use",
        `save dispatched: session=${sessionId} delta=${delta} pid=${child.pid}`,
    );

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
