// src/entrypoints/post-tool-use.ts
import { spawn } from "node:child_process";
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync3,
  openSync,
  readdirSync as readdirSync3,
  readFileSync as readFileSync3,
  statSync as statSync2,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import path5 from "node:path";

// src/helpers/config.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
var DEFAULTS = {
  cooldowns: { saveSeconds: 120, compactSeconds: 3600 },
  thresholds: { minHumanMessages: 3, deltaLinesTrigger: 50 },
  features: { recovery: true },
  timezone: "UTC",
  eventHorizonDays: 3,
  tokenSoftCap: { shortTerm: 800, longTerm: 600 }
};
function loadConfig(pluginDir) {
  const file = path.join(pluginDir, "config.json");
  if (!existsSync(file)) return DEFAULTS;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return {
    ...DEFAULTS,
    ...raw,
    cooldowns: { ...DEFAULTS.cooldowns, ...raw.cooldowns ?? {} },
    thresholds: { ...DEFAULTS.thresholds, ...raw.thresholds ?? {} },
    features: { ...DEFAULTS.features, ...raw.features ?? {} },
    tokenSoftCap: { ...DEFAULTS.tokenSoftCap, ...raw.tokenSoftCap ?? {} }
  };
}

// src/helpers/logger.ts
import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync as existsSync2,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import path2 from "node:path";
function formatTime(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}
function yearMonth(filename) {
  const m = filename.match(/memory-(\d{4}-\d{2})-\d{2}\.log$/);
  return m?.[1] ?? "unknown";
}
function createLogger(dataDir, timezone) {
  const logsDir = path2.join(dataDir, "logs");
  function ensureLogsDir() {
    if (!existsSync2(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }
  }
  function currentLogFile() {
    return path2.join(logsDir, `memory-${formatDate(/* @__PURE__ */ new Date())}.log`);
  }
  function log(component, message) {
    ensureLogsDir();
    const time = formatTime(/* @__PURE__ */ new Date(), timezone);
    appendFileSync(currentLogFile(), `${time} [${component}] ${message}
`);
  }
  function logTokens(component, tk) {
    log(
      component,
      `tokens: ${tk.input}+${tk.cache}cache\u2192${tk.output}out ($${tk.costUsd})`
    );
  }
  function rotateOldLogs() {
    try {
      ensureLogsDir();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1e3;
      const now = Date.now();
      const files = readdirSync(logsDir).filter(
        (f) => f.match(/^memory-\d{4}-\d{2}-\d{2}\.log$/)
      );
      const byMonth = /* @__PURE__ */ new Map();
      for (const file of files) {
        const fullPath = path2.join(logsDir, file);
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
        const tarPath = path2.join(logsDir, tarName);
        const fileList = group.join(" ");
        execSync(`tar -czf ${tarName} ${fileList}`, { cwd: logsDir });
        if (existsSync2(tarPath)) {
          for (const file of group) {
            unlinkSync(path2.join(logsDir, file));
          }
        }
      }
    } catch (err) {
      process.stderr.write(
        `[logger] rotateOldLogs error: ${String(err)}
`
      );
    }
  }
  return { log, logTokens, rotateOldLogs };
}

// src/helpers/memory-files.ts
import {
  appendFileSync as appendFileSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  readdirSync as readdirSync2,
  readFileSync as readFileSync2,
  renameSync,
  writeFileSync
} from "node:fs";
import path3 from "node:path";
function loadLastSave(dataDir) {
  const filePath = path3.join(dataDir, "tmp", "last-save.json");
  if (!existsSync3(filePath)) return null;
  try {
    const raw = readFileSync2(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("session" in parsed) || !("line" in parsed) || typeof parsed.session !== "string" || typeof parsed.line !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// src/helpers/paths.ts
import { existsSync as existsSync4 } from "node:fs";
import path4 from "node:path";
function resolvePaths() {
  const pluginDir = process.env.CLAUDE_PLUGIN_ROOT ?? derivePluginDir() ?? fail("Cannot resolve plugin root");
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? deriveProjectDir(pluginDir) ?? fail(
    "CLAUDE_PROJECT_DIR is not set and plugin is not in a local .claude/claude-memory/ layout"
  );
  return {
    projectDir,
    pluginDir,
    dataDir: path4.join(projectDir, ".claude-memory")
  };
}
function derivePluginDir() {
  const candidate = path4.resolve(import.meta.dirname, "..", "..");
  return existsSync4(path4.join(candidate, "package.json")) ? candidate : null;
}
function deriveProjectDir(pluginDir) {
  if (pluginDir.endsWith("/.claude/claude-memory")) {
    return path4.resolve(pluginDir, "..", "..");
  }
  return null;
}
function fail(msg) {
  throw new Error(`FATAL: ${msg}`);
}
function sessionJsonlDir(projectDir) {
  const slug = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
  return path4.join(process.env.HOME ?? "", ".claude", "projects", slug);
}

// src/entrypoints/post-tool-use.ts
async function main() {
  let projectDir;
  let pluginDir;
  let dataDir;
  try {
    const resolved = resolvePaths();
    projectDir = resolved.projectDir;
    pluginDir = resolved.pluginDir;
    dataDir = resolved.dataDir;
  } catch {
    return 0;
  }
  let cfg;
  try {
    cfg = loadConfig(pluginDir);
  } catch {
    return 0;
  }
  const logger = createLogger(dataDir, cfg.timezone);
  const sessionsDir = sessionJsonlDir(projectDir);
  if (!existsSync5(sessionsDir)) {
    return 0;
  }
  let jsonlFiles;
  try {
    jsonlFiles = readdirSync3(sessionsDir).filter((f) => f.endsWith(".jsonl")).map((f) => ({
      name: f,
      mtime: statSync2(path5.join(sessionsDir, f)).mtimeMs
    })).sort((a, b) => b.mtime - a.mtime);
  } catch {
    return 0;
  }
  if (jsonlFiles.length === 0) {
    return 0;
  }
  const newestFile = jsonlFiles[0];
  if (newestFile === void 0) {
    return 0;
  }
  const jsonlPath = path5.join(sessionsDir, newestFile.name);
  const sessionId = newestFile.name.replace(/\.jsonl$/, "");
  let currentLines;
  try {
    const content = readFileSync3(jsonlPath, "utf8");
    const lines = content.split("\n");
    currentLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  } catch {
    return 0;
  }
  const lastSave = loadLastSave(dataDir);
  const lastLine = lastSave !== null && lastSave.session === sessionId ? lastSave.line : 0;
  const delta = currentLines - lastLine;
  if (delta <= cfg.thresholds.deltaLinesTrigger) {
    return 0;
  }
  const pidFile = path5.join(dataDir, "tmp", "save-session.pid");
  if (existsSync5(pidFile)) {
    try {
      const pidStr = readFileSync3(pidFile, "utf8").trim();
      const pid = parseInt(pidStr, 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          logger.log("post-tool-use", "save already running");
          return 0;
        } catch {
        }
      }
    } catch {
    }
  }
  const saveScript = path5.join(pluginDir, "dist", "entrypoints", "save.mjs");
  const now = /* @__PURE__ */ new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const logDir = path5.join(dataDir, "logs", "autonomous");
  try {
    mkdirSync3(logDir, { recursive: true });
  } catch {
  }
  try {
    const sweepCutoff = Date.now() - 5e3;
    for (const name of readdirSync3(logDir)) {
      if (!name.endsWith(".log")) continue;
      const p = path5.join(logDir, name);
      const st = statSync2(p);
      if (st.size === 0 && st.mtimeMs < sweepCutoff) {
        unlinkSync2(p);
      }
    }
  } catch {
  }
  const logPath = path5.join(logDir, `save-${hh}${mm}${ss}.log`);
  let logFd;
  try {
    logFd = openSync(logPath, "a");
  } catch {
    logFd = -1;
  }
  const stdioOption = logFd >= 0 ? ["ignore", logFd, logFd] : "ignore";
  const child = spawn("node", [saveScript, sessionId], {
    cwd: pluginDir,
    detached: true,
    stdio: stdioOption,
    env: process.env
  });
  child.unref();
  if (child.pid !== void 0) {
    try {
      mkdirSync3(path5.join(dataDir, "tmp"), { recursive: true });
      writeFileSync2(pidFile, String(child.pid), "utf8");
    } catch {
    }
  }
  logger.log(
    "post-tool-use",
    `save dispatched: session=${sessionId} delta=${delta} pid=${child.pid}`
  );
  return 0;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(process.exit).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
export {
  main
};
