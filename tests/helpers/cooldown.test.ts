import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCoolingDown, markCooldown } from "../../src/helpers/cooldown.ts";

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cm-cd-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

function markerPath(): string {
    return path.join(tmpDir, "cooldown.marker");
}

describe("isCoolingDown", () => {
    it("returns false when marker is missing", () => {
        expect(isCoolingDown(markerPath(), 100)).toBe(false);
    });

    it("returns true immediately after markCooldown", () => {
        markCooldown(markerPath());
        expect(isCoolingDown(markerPath(), 100)).toBe(true);
    });

    it("returns false when marker timestamp is older than threshold", () => {
        const oldTimestamp = Math.floor(Date.now() / 1000) - 200;
        writeFileSync(markerPath(), String(oldTimestamp));
        expect(isCoolingDown(markerPath(), 100)).toBe(false);
    });
});

describe("markCooldown", () => {
    it("writes current unix timestamp to the marker file", () => {
        const before = Math.floor(Date.now() / 1000);
        markCooldown(markerPath());
        const after = Math.floor(Date.now() / 1000);
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        const written = Number(readFileSync(markerPath(), "utf8").trim());
        expect(written).toBeGreaterThanOrEqual(before);
        expect(written).toBeLessThanOrEqual(after);
    });
});
