// src/entrypoints/consolidate.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync5, rmSync } from "node:fs";
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

// src/helpers/haiku.ts
import { spawn } from "node:child_process";
var DEFAULT_TIMEOUT_MS = 6e4;
var SIGKILL_DELAY_MS = 2e3;
var CLI_ARGS = [
  "-p",
  "--model",
  "haiku",
  "--allowedTools",
  "",
  "--max-turns",
  "1",
  "--output-format",
  "json",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--strict-mcp-config"
];
function buildEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}
function extractText(result) {
  if (typeof result.result === "string") {
    return result.result;
  }
  const message = result.message;
  if (message !== null && typeof message === "object") {
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block !== null && typeof block === "object") {
          const text = block.text;
          if (typeof text === "string") {
            return text;
          }
        }
      }
    }
  }
  return void 0;
}
function parseResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Haiku response was not JSON: ${raw.slice(0, 200)}`);
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  const text = extractText(result);
  if (text === void 0) {
    throw new Error("Haiku response had no text");
  }
  const trimmed = text.trim();
  const usage = result.usage !== null && typeof result.usage === "object" ? result.usage : {};
  const tokensIn = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const tokensOut = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const tokensCache = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const costUsd = typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
  return {
    text: trimmed,
    isSkip: trimmed.startsWith("SKIP"),
    tokensIn,
    tokensOut,
    tokensCache,
    costUsd
  };
}
async function callHaiku(prompt, opts) {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn("claude", CLI_ARGS, {
      cwd: "/tmp",
      env: buildEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.write(prompt);
    child.stdin.end();
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, SIGKILL_DELAY_MS);
      if (typeof killTimer === "object" && killTimer !== null) {
        killTimer.unref?.();
      }
      reject(new Error(`callHaiku timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === "object" && timer !== null) {
      timer.unref?.();
    }
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `claude exited with exit ${code ?? "null"}${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`
          )
        );
        return;
      }
      try {
        resolve(parseResponse(stdoutBuf));
      } catch (err) {
        reject(err);
      }
    });
  });
}

// src/helpers/lock.ts
import {
  closeSync,
  existsSync as existsSync2,
  openSync,
  readFileSync as readFileSync2,
  unlinkSync,
  writeFileSync
} from "node:fs";
async function acquireLock(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, "wx");
    writeFileSync(lockPath, String(process.pid));
    closeSync(fd);
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      let holderPid = 0;
      try {
        holderPid = Number(readFileSync2(lockPath, "utf8").trim());
      } catch {
      }
      let holderAlive = false;
      if (holderPid > 0) {
        try {
          process.kill(holderPid, 0);
          holderAlive = true;
        } catch (killErr) {
          if (killErr !== null && typeof killErr === "object" && "code" in killErr && killErr.code === "ESRCH") {
            holderAlive = false;
          } else {
            holderAlive = true;
          }
        }
      }
      if (holderAlive) {
        throw new Error(`locked by PID ${holderPid}`);
      }
      writeFileSync(lockPath, String(process.pid));
    } else {
      throw err;
    }
  }
  let released = false;
  function release() {
    if (released) return;
    released = true;
    try {
      if (existsSync2(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
    }
  }
  process.on("exit", release);
  return release;
}

// src/helpers/logger.ts
import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync as existsSync3,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync as unlinkSync2
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
    if (!existsSync3(logsDir)) {
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
        if (existsSync3(tarPath)) {
          for (const file of group) {
            unlinkSync2(path2.join(logsDir, file));
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
  existsSync as existsSync4,
  mkdirSync as mkdirSync2,
  readdirSync as readdirSync2,
  readFileSync as readFileSync3,
  renameSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import path3 from "node:path";
function safeRead(filePath) {
  if (!existsSync4(filePath)) return "";
  try {
    return readFileSync3(filePath, "utf8");
  } catch {
    return "";
  }
}
function ensureDir(dir) {
  mkdirSync2(dir, { recursive: true });
}
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`;
  writeFileSync2(tmp, content, "utf8");
  renameSync(tmp, filePath);
}
function listEpisodes(dataDir, options) {
  const episodicDir = path3.join(dataDir, "episodic-memory");
  if (!existsSync4(episodicDir)) return [];
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
function readShortTerm(dataDir) {
  return safeRead(path3.join(dataDir, "short-term-memory.md"));
}
function writeShortTerm(dataDir, content) {
  ensureDir(dataDir);
  atomicWrite(path3.join(dataDir, "short-term-memory.md"), content);
}
function readLongTerm(dataDir) {
  return safeRead(path3.join(dataDir, "long-term-memory.md"));
}
function writeLongTerm(dataDir, content) {
  ensureDir(dataDir);
  atomicWrite(path3.join(dataDir, "long-term-memory.md"), content);
}

// src/helpers/paths.ts
import { existsSync as existsSync5 } from "node:fs";
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
  return existsSync5(path4.join(candidate, "package.json")) ? candidate : null;
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

// src/helpers/prompts.ts
import { readFileSync as readFileSync4 } from "node:fs";
import path5 from "node:path";
function resolvePromptPath(pluginDir, name) {
  const filename = name === "preamble" ? "session-preamble.md" : `${name}.prompt.md`;
  return path5.join(pluginDir, "prompts", filename);
}
function loadPrompt(pluginDir, name) {
  const filePath = resolvePromptPath(pluginDir, name);
  try {
    return readFileSync4(filePath, "utf8");
  } catch {
    throw new Error(`Prompt file not found: ${filePath}`);
  }
}
function renderPrompt(template, vars) {
  const result = template.replace(
    /\{\{([A-Z_]+)\}\}/g,
    (match, key) => {
      return vars[key] ?? match;
    }
  );
  const allMatches = [...result.matchAll(/\{\{([A-Z_]+)\}\}/g)];
  const remaining = [
    ...new Set(
      allMatches.map((m) => m[1]).filter((k) => k !== void 0)
    )
  ];
  if (remaining.length > 0) {
    throw new Error(
      `Unsubstituted template placeholders: ${remaining.join(", ")}`
    );
  }
  return result;
}

// src/entrypoints/consolidate.ts
function parseConsolidateResponse(raw) {
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
  const SHORT_MARKER = "===SHORT-TERM===";
  const LONG_MARKER = "===LONG-TERM===";
  const shortIdx = text.indexOf(SHORT_MARKER);
  const longIdx = text.indexOf(LONG_MARKER);
  if (shortIdx === -1) {
    const snippet = raw.slice(0, 120).replace(/\n/g, "\\n");
    throw new Error(
      `Missing ===SHORT-TERM=== marker in response. Got: "${snippet}"`
    );
  }
  if (longIdx === -1) {
    const snippet = raw.slice(0, 120).replace(/\n/g, "\\n");
    throw new Error(
      `Missing ===LONG-TERM=== marker in response. Got: "${snippet}"`
    );
  }
  const shortTerm = text.slice(shortIdx + SHORT_MARKER.length, longIdx).trim();
  const longTerm = text.slice(longIdx + LONG_MARKER.length).trim();
  return { shortTerm, longTerm };
}
async function main(argv = process.argv.slice(2)) {
  void argv;
  const { pluginDir, dataDir } = resolvePaths();
  const cfg = loadConfig(pluginDir);
  const logger = createLogger(dataDir, cfg.timezone);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: cfg.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(/* @__PURE__ */ new Date());
  const episodes = listEpisodes(dataDir, { excludeDate: today });
  if (episodes.length === 0) {
    logger.log("consolidate", "no past episodes, skip");
    return 0;
  }
  const lockPath = path6.join(dataDir, "tmp", "consolidate.lock");
  mkdirSync3(path6.join(dataDir, "tmp"), { recursive: true });
  let releaseLock;
  try {
    releaseLock = await acquireLock(lockPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("consolidate", msg);
    return 0;
  }
  try {
    const episodesText = episodes.map(({ date, path: filePath }) => {
      let content = "";
      try {
        content = readFileSync5(filePath, "utf8");
      } catch {
        content = "";
      }
      return `=== ${date} ===
${content}`;
    }).join("\n\n");
    const shortTerm = readShortTerm(dataDir);
    const longTerm = readLongTerm(dataDir);
    const template = loadPrompt(pluginDir, "consolidate");
    const rendered = renderPrompt(template, {
      EPISODES: episodesText,
      SHORT_TERM: shortTerm,
      LONG_TERM: longTerm
    });
    let response;
    try {
      response = await callHaiku(rendered);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `haiku error: ${msg}`);
      return 1;
    }
    let parsed;
    try {
      parsed = parseConsolidateResponse(response.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `parse error: ${msg}`);
      return 1;
    }
    writeShortTerm(dataDir, parsed.shortTerm);
    writeLongTerm(dataDir, parsed.longTerm);
    for (const { path: filePath } of episodes) {
      rmSync(filePath, { force: true });
    }
    logger.logTokens("consolidate", {
      input: response.tokensIn,
      output: response.tokensOut,
      cache: response.tokensCache,
      costUsd: response.costUsd
    });
    return 0;
  } finally {
    releaseLock?.();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(process.exit).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
export {
  main,
  parseConsolidateResponse
};
