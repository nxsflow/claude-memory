// src/entrypoints/session-start.ts
import { spawn } from "node:child_process";
import {
  existsSync as existsSync5,
  mkdirSync as mkdirSync3,
  readdirSync as readdirSync3,
  readFileSync as readFileSync4,
  statSync as statSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
import path6 from "node:path";

// src/helpers/config.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
var DEFAULTS = {
  cooldowns: { saveSeconds: 120, compactSeconds: 3600 },
  thresholds: { minHumanMessages: 3, deltaLinesTrigger: 50 },
  features: { recovery: true },
  timezone: "UTC"
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
    features: { ...DEFAULTS.features, ...raw.features ?? {} }
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
function listEpisodes(dataDir, options) {
  const episodicDir = path3.join(dataDir, "episodic-memory");
  if (!existsSync3(episodicDir)) return [];
  const datePattern = /^(\d{4}-\d{2}-\d{2})\.md$/;
  const entries = [];
  for (const filename of readdirSync2(episodicDir)) {
    const match = datePattern.exec(filename);
    if (match === null) continue;
    const date = match[1];
    if (date === void 0) continue;
    if (options?.excludeDate === date) continue;
    entries.push({ date, path: path3.join(episodicDir, filename) });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}
function consumeHandover(dataDir) {
  const filePath = path3.join(dataDir, "session-handover.md");
  if (!existsSync3(filePath)) return;
  writeFileSync(filePath, "", "utf8");
}
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

// src/helpers/prompts.ts
import { readFileSync as readFileSync3 } from "node:fs";
import path5 from "node:path";
function resolvePromptPath(pluginDir, name) {
  const filename = name === "preamble" ? "session-preamble.md" : `${name}.prompt.md`;
  return path5.join(pluginDir, "prompts", filename);
}
function loadPrompt(pluginDir, name) {
  const filePath = resolvePromptPath(pluginDir, name);
  try {
    return readFileSync3(filePath, "utf8");
  } catch {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
}

// src/entrypoints/session-start.ts
function emitFile(filePath) {
  if (!existsSync5(filePath)) return false;
  let content;
  try {
    content = readFileSync4(filePath, "utf8");
  } catch {
    return false;
  }
  if (!content.trim()) return false;
  const basename = path6.basename(filePath);
  process.stdout.write(`--- ${basename} ---
`);
  process.stdout.write(content);
  if (!content.endsWith("\n")) {
    process.stdout.write("\n");
  }
  process.stdout.write("\n");
  return true;
}
async function main() {
  let projectDir;
  let pluginDir;
  let dataDir;
  try {
    const resolved = resolvePaths();
    projectDir = resolved.projectDir;
    pluginDir = resolved.pluginDir;
    dataDir = resolved.dataDir;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`session-start: ${msg}
`);
    return 0;
  }
  let cfg;
  try {
    cfg = loadConfig(pluginDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`session-start: loadConfig failed: ${msg}
`);
    return 0;
  }
  const logger = createLogger(dataDir, cfg.timezone);
  try {
    mkdirSync3(path6.join(dataDir, "tmp"), { recursive: true });
    mkdirSync3(path6.join(dataDir, "logs", "autonomous"), {
      recursive: true
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("session-start", `mkdir failed: ${msg}`);
  }
  try {
    const gitignorePath = path6.join(dataDir, ".gitignore");
    if (!existsSync5(gitignorePath)) {
      writeFileSync2(gitignorePath, "*\n", "utf8");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("session-start", `gitignore create failed: ${msg}`);
  }
  if (cfg.features.recovery) {
    try {
      const sessionsDir = sessionJsonlDir(projectDir);
      if (existsSync5(sessionsDir)) {
        const jsonlFiles = readdirSync3(sessionsDir).filter((f) => f.endsWith(".jsonl")).map((f) => ({
          name: f,
          mtime: statSync2(path6.join(sessionsDir, f)).mtimeMs
        })).sort((a, b) => b.mtime - a.mtime);
        if (jsonlFiles.length >= 2) {
          const prevFile = jsonlFiles[1];
          if (prevFile !== void 0) {
            const prevSessionId = prevFile.name.replace(
              /\.jsonl$/,
              ""
            );
            const lastSave = loadLastSave(dataDir);
            if (lastSave?.session !== prevSessionId) {
              const saveScript = path6.join(
                pluginDir,
                "dist",
                "entrypoints",
                "save.mjs"
              );
              const child = spawn(
                "node",
                [saveScript, prevSessionId, "--force"],
                {
                  cwd: pluginDir,
                  detached: true,
                  stdio: "ignore",
                  env: process.env
                }
              );
              child.unref();
              logger.log(
                "session-start",
                `recovery: ${prevSessionId}`
              );
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("session-start", `recovery check failed: ${msg}`);
    }
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.timezone
  }).format(/* @__PURE__ */ new Date());
  try {
    const preamble = loadPrompt(pluginDir, "preamble");
    process.stdout.write(preamble);
    if (!preamble.endsWith("\n")) {
      process.stdout.write("\n");
    }
    process.stdout.write("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("session-start", `preamble load failed: ${msg}`);
  }
  const memoryFiles = [
    path6.join(dataDir, "agent-role.md"),
    path6.join(dataDir, "core-memories.md"),
    path6.join(dataDir, "session-handover.md"),
    path6.join(dataDir, "episodic-memory", `${today}.md`),
    path6.join(dataDir, "working-memory.md"),
    path6.join(dataDir, "short-term-memory.md"),
    path6.join(dataDir, "long-term-memory.md")
  ];
  const fileResults = memoryFiles.map((filePath) => {
    if (!existsSync5(filePath)) return { filePath, hasContent: false };
    try {
      const content = readFileSync4(filePath, "utf8");
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.log(
          "session-start",
          `emitFile failed for ${filePath}: ${msg}`
        );
      }
    }
  }
  try {
    consumeHandover(dataDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("session-start", `consumeHandover failed: ${msg}`);
  }
  try {
    const pastEpisodes = listEpisodes(dataDir, { excludeDate: today });
    if (pastEpisodes.length > 0) {
      const consolidateScript = path6.join(
        pluginDir,
        "dist",
        "entrypoints",
        "consolidate.mjs"
      );
      const child = spawn("node", [consolidateScript], {
        cwd: pluginDir,
        detached: true,
        stdio: "ignore",
        env: process.env
      });
      child.unref();
      process.stdout.write("=== MEMORY CONSOLIDATION ===\n");
      process.stdout.write(
        `${pastEpisodes.length} day(s) of past episodes \u2014 consolidation running in background.
`
      );
      process.stdout.write("\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("session-start", `consolidation trigger failed: ${msg}`);
  }
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
