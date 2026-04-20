// src/entrypoints/consolidate.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync6, rmSync } from "node:fs";
import path7 from "node:path";

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
function writeDerivedMemoryFiles(dataDir, rendered) {
  ensureDir(dataDir);
  atomicWrite(path3.join(dataDir, "short-term-memory.md"), rendered.shortTerm);
  atomicWrite(path3.join(dataDir, "long-term-memory.md"), rendered.longTerm);
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
  const templateMatches = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)];
  const missing = [
    ...new Set(
      templateMatches.map((m) => m[1]).filter((k) => k !== void 0 && !(k in vars))
    )
  ];
  if (missing.length > 0) {
    throw new Error(
      `Unsubstituted template placeholders: ${missing.join(", ")}`
    );
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    return vars[key] ?? match;
  });
}

// src/helpers/temporal.ts
import {
  existsSync as existsSync6,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync5,
  renameSync as renameSync2,
  writeFileSync as writeFileSync3
} from "node:fs";
import path6 from "node:path";
var EMPTY_STORE = {
  version: 1,
  state: [],
  events: { recent: [], weekly: [] }
};
function isTemporalStore(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.state)) return false;
  if (typeof v.events !== "object" || v.events === null) return false;
  const events = v.events;
  if (!Array.isArray(events.recent)) return false;
  if (!Array.isArray(events.weekly)) return false;
  return true;
}
function readTemporal(dataDir) {
  const filePath = path6.join(dataDir, "temporal.json");
  if (!existsSync6(filePath)) return EMPTY_STORE;
  let raw;
  try {
    raw = readFileSync5(filePath, "utf8");
  } catch {
    return EMPTY_STORE;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_STORE;
  }
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && parsed.version !== 1) {
    throw new Error(
      `temporal.json has unsupported version: ${parsed.version}. Migration required.`
    );
  }
  if (!isTemporalStore(parsed)) return EMPTY_STORE;
  return parsed;
}
function writeTemporal(dataDir, store) {
  mkdirSync3(dataDir, { recursive: true });
  const filePath = path6.join(dataDir, "temporal.json");
  const tmp = `${filePath}.tmp`;
  writeFileSync3(tmp, `${JSON.stringify(store, null, 2)}
`, "utf8");
  renameSync2(tmp, filePath);
}
function nextId(store, prefix) {
  const ids = [
    ...store.state.map((s) => s.id),
    ...store.events.recent.map((e) => e.id),
    ...store.events.weekly.map((w) => w.id)
  ];
  let max = 0;
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}
function normalizeSubject(raw) {
  return raw.trim().replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function cloneStore(store) {
  return {
    version: 1,
    state: store.state.map((s) => ({
      ...s,
      supersedes: s.supersedes?.slice()
    })),
    events: {
      recent: store.events.recent.map((e) => ({ ...e })),
      weekly: store.events.weekly.map((w) => ({ ...w }))
    }
  };
}
function findCurrentFact(state, subject) {
  return state.find(
    (s) => s.subject === subject && s.supersededBy === void 0
  );
}
function mergeExtracted(store, today, payload) {
  const next = cloneStore(store);
  for (const { subject: rawSubject, value } of payload.newFacts) {
    const subject = normalizeSubject(rawSubject);
    if (subject === "") continue;
    const current = findCurrentFact(next.state, subject);
    if (current === void 0) {
      next.state.push({
        id: nextId(next, "s"),
        subject,
        value,
        validFrom: today
      });
      continue;
    }
    if (current.value === value) continue;
    const newFact = {
      id: nextId(next, "s"),
      subject,
      value,
      validFrom: today,
      supersedes: [current.id]
    };
    current.supersededBy = newFact.id;
    current.supersededOn = today;
    next.state.push(newFact);
  }
  for (const { date, summary } of payload.newEvents) {
    const duplicate = next.events.recent.some(
      (e) => e.date === date && e.summary === summary
    );
    if (duplicate) continue;
    next.events.recent.push({
      id: nextId(next, "e"),
      date,
      summary
    });
  }
  return next;
}
function weekOfMonday(date) {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const day = dt.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  dt.setUTCDate(dt.getUTCDate() - diff);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function daysBetween(from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const a = Date.UTC(fy ?? 1970, (fm ?? 1) - 1, fd ?? 1);
  const b = Date.UTC(ty ?? 1970, (tm ?? 1) - 1, td ?? 1);
  return Math.floor((b - a) / 864e5);
}
function currentSubjects(store) {
  const subjects = /* @__PURE__ */ new Set();
  for (const s of store.state) {
    if (s.supersededBy === void 0) subjects.add(s.subject);
  }
  return [...subjects].sort();
}
function renderShortTerm(store) {
  const current = store.state.filter((s) => s.supersededBy === void 0).sort((a, b) => a.subject.localeCompare(b.subject));
  const superseded = store.state.filter(
    (s) => s.supersededOn !== void 0
  ).sort((a, b) => b.supersededOn.localeCompare(a.supersededOn));
  const recent = [...store.events.recent].sort(
    (a, b) => b.date.localeCompare(a.date)
  );
  if (current.length === 0 && superseded.length === 0 && recent.length === 0) {
    return "";
  }
  const lines = ["# Short-Term Memory", ""];
  if (current.length > 0) {
    lines.push("## State");
    for (const s of current) {
      lines.push(`- ${s.subject}: ${s.value}  (since ${s.validFrom})`);
    }
    lines.push("");
  }
  if (superseded.length > 0) {
    lines.push("### Previously (superseded \u2014 do not follow)");
    for (const s of superseded) {
      lines.push(
        `- ${s.subject}: ${s.value}  (${s.validFrom} \u2192 ${s.supersededOn})`
      );
    }
    lines.push("");
  }
  if (recent.length > 0) {
    lines.push("## Recent events");
    for (const e of recent) {
      lines.push(`- ${e.date}: ${e.summary}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderLongTerm(store) {
  const weekly = [...store.events.weekly].sort(
    (a, b) => b.weekOf.localeCompare(a.weekOf)
  );
  if (weekly.length === 0) return "";
  const lines = ["# Long-Term Memory", ""];
  for (const w of weekly) {
    lines.push(`## Week of ${w.weekOf}`);
    lines.push(`- ${w.summary}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function renderMarkdown(store, _today) {
  return {
    shortTerm: renderShortTerm(store),
    longTerm: renderLongTerm(store)
  };
}
function rollEvents(store, today, horizonDays) {
  const next = cloneStore(store);
  const stayRecent = [];
  const toRoll = [];
  for (const event of next.events.recent) {
    const age = daysBetween(event.date, today);
    if (age <= horizonDays) {
      stayRecent.push(event);
    } else {
      toRoll.push(event);
    }
  }
  if (toRoll.length === 0) {
    return {
      ...next,
      events: { recent: stayRecent, weekly: next.events.weekly }
    };
  }
  const weeklyById = new Map(next.events.weekly.map((w) => [w.weekOf, w]));
  for (const event of toRoll) {
    const wk = weekOfMonday(event.date);
    const existing = weeklyById.get(wk);
    if (existing !== void 0) {
      existing.summary = `${existing.summary} \xB7 ${event.date}: ${event.summary}`;
    } else {
      const created = {
        id: nextId(
          {
            ...next,
            events: {
              recent: [],
              weekly: [...weeklyById.values()]
            }
          },
          "w"
        ),
        weekOf: wk,
        summary: `${event.date}: ${event.summary}`
      };
      weeklyById.set(wk, created);
    }
  }
  const weekly = [...weeklyById.values()].sort(
    (a, b) => a.weekOf.localeCompare(b.weekOf)
  );
  return { ...next, events: { recent: stayRecent, weekly } };
}

// src/entrypoints/consolidate.ts
function parseExtractResponse(raw) {
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
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const snippet = raw.slice(0, 120).replace(/\n/g, "\\n");
    throw new Error(`Invalid JSON in Haiku response: "${snippet}"`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Haiku response is not an object");
  }
  const obj = parsed;
  if (!Array.isArray(obj.newFacts)) {
    throw new Error("Missing or non-array newFacts in response");
  }
  if (!Array.isArray(obj.newEvents)) {
    throw new Error("Missing or non-array newEvents in response");
  }
  const newFacts = obj.newFacts.map((item, i) => {
    if (typeof item !== "object" || item === null || typeof item.subject !== "string" || typeof item.value !== "string") {
      throw new Error(`newFacts[${i}] missing subject or value`);
    }
    const rec = item;
    return { subject: rec.subject, value: rec.value };
  });
  const newEvents = obj.newEvents.map((item, i) => {
    if (typeof item !== "object" || item === null || typeof item.date !== "string" || typeof item.summary !== "string") {
      throw new Error(`newEvents[${i}] missing date or summary`);
    }
    const rec = item;
    return { date: rec.date, summary: rec.summary };
  });
  return { newFacts, newEvents };
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
  const lockPath = path7.join(dataDir, "tmp", "consolidate.lock");
  mkdirSync4(path7.join(dataDir, "tmp"), { recursive: true });
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
        content = readFileSync6(filePath, "utf8");
      } catch {
        content = "";
      }
      return `## ${date}
${content}`;
    }).join("\n\n");
    const store = readTemporal(dataDir);
    const glossary = currentSubjects(store);
    const glossaryText = glossary.length > 0 ? glossary.map((s) => `- ${s}`).join("\n") : "(none yet)";
    const template = loadPrompt(pluginDir, "consolidate");
    const rendered = renderPrompt(template, {
      EPISODES: episodesText,
      SUBJECT_GLOSSARY: glossaryText
    });
    let response;
    try {
      response = await callHaiku(rendered);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `haiku error: ${msg}`);
      return 1;
    }
    let extracted;
    try {
      extracted = parseExtractResponse(response.text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `parse error: ${msg}`);
      return 1;
    }
    const merged = rollEvents(
      mergeExtracted(store, today, extracted),
      today,
      cfg.eventHorizonDays
    );
    try {
      writeTemporal(dataDir, merged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("consolidate", `writeTemporal failed: ${msg}`);
      return 1;
    }
    const rendered_md = renderMarkdown(merged, today);
    writeDerivedMemoryFiles(dataDir, rendered_md);
    const estTokens = (s) => Math.ceil(s.length / 4);
    const shortTok = estTokens(rendered_md.shortTerm);
    const longTok = estTokens(rendered_md.longTerm);
    if (shortTok > cfg.tokenSoftCap.shortTerm) {
      logger.log(
        "consolidate",
        `shortTerm soft cap exceeded: ~${shortTok} > ${cfg.tokenSoftCap.shortTerm} tokens`
      );
    }
    if (longTok > cfg.tokenSoftCap.longTerm) {
      logger.log(
        "consolidate",
        `longTerm soft cap exceeded: ~${longTok} > ${cfg.tokenSoftCap.longTerm} tokens`
      );
    }
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
  parseExtractResponse
};
