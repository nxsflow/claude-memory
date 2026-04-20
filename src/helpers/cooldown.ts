import { readFileSync, writeFileSync } from "node:fs";

export function markCooldown(markerPath: string): void {
    writeFileSync(markerPath, String(Math.floor(Date.now() / 1000)));
}

export function isCoolingDown(markerPath: string, seconds: number): boolean {
    try {
        const raw = readFileSync(markerPath, "utf8").trim();
        const marker = Number.parseInt(raw, 10);
        if (Number.isNaN(marker)) return false;
        const now = Math.floor(Date.now() / 1000);
        return now - marker < seconds;
    } catch {
        return false;
    }
}
