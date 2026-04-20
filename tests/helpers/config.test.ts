import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/helpers/config.ts";

let plugin: string;

beforeEach(() => {
    plugin = mkdtempSync(path.join(tmpdir(), "cm-cfg-"));
});
afterEach(() => rmSync(plugin, { recursive: true, force: true }));

describe("loadConfig", () => {
    it("returns defaults when config.json is missing", () => {
        const c = loadConfig(plugin);
        expect(c.cooldowns.saveSeconds).toBe(120);
        expect(c.cooldowns.compactSeconds).toBe(3600);
        expect(c.features.recovery).toBe(true);
        expect(c.timezone).toBe("UTC");
    });

    it("merges user overrides with defaults", () => {
        writeFileSync(
            path.join(plugin, "config.json"),
            JSON.stringify({
                cooldowns: { saveSeconds: 30 },
                timezone: "Europe/Paris",
            }),
        );
        const c = loadConfig(plugin);
        expect(c.cooldowns.saveSeconds).toBe(30);
        expect(c.cooldowns.compactSeconds).toBe(3600); // default preserved
        expect(c.timezone).toBe("Europe/Paris");
    });
});
