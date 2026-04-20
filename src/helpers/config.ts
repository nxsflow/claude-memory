import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./types.ts";

const DEFAULTS: Config = {
    cooldowns: { saveSeconds: 120, compactSeconds: 3600 },
    thresholds: { minHumanMessages: 3, deltaLinesTrigger: 50 },
    features: { recovery: true },
    timezone: "UTC",
};

export function loadConfig(pluginDir: string): Config {
    const file = path.join(pluginDir, "config.json");
    if (!existsSync(file)) return DEFAULTS;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config> & {
        cooldowns?: Partial<Config["cooldowns"]>;
        thresholds?: Partial<Config["thresholds"]>;
        features?: Partial<Config["features"]>;
    };
    return {
        ...DEFAULTS,
        ...raw,
        cooldowns: { ...DEFAULTS.cooldowns, ...(raw.cooldowns ?? {}) },
        thresholds: { ...DEFAULTS.thresholds, ...(raw.thresholds ?? {}) },
        features: { ...DEFAULTS.features, ...(raw.features ?? {}) },
    };
}
