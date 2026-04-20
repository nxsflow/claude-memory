import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../src/helpers/lock.ts";

let tmpDir: string;

beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cm-lock-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

function lockPath(): string {
    return path.join(tmpDir, "test.lock");
}

describe("acquireLock", () => {
    it("fresh acquire succeeds and writes current PID", async () => {
        const lp = lockPath();
        const release = await acquireLock(lp);
        expect(existsSync(lp)).toBe(true);
        const pid = Number(readFileSync(lp, "utf8").trim());
        expect(pid).toBe(process.pid);
        release();
    });

    it("second acquire throws while first still held", async () => {
        const lp = lockPath();
        const release = await acquireLock(lp);
        await expect(acquireLock(lp)).rejects.toThrow(/locked by PID/);
        release();
    });

    it("release function deletes the lock file", async () => {
        const lp = lockPath();
        const release = await acquireLock(lp);
        expect(existsSync(lp)).toBe(true);
        release();
        expect(existsSync(lp)).toBe(false);
    });

    it("acquire succeeds again after release", async () => {
        const lp = lockPath();
        const release1 = await acquireLock(lp);
        release1();
        const release2 = await acquireLock(lp);
        expect(existsSync(lp)).toBe(true);
        release2();
    });

    it("stale lock with non-existent PID is taken over", async () => {
        const { writeFileSync } = await import("node:fs");
        const lp = lockPath();
        // Write a lock with a PID that almost certainly doesn't exist
        writeFileSync(lp, "999999");
        const release = await acquireLock(lp);
        const pid = Number(readFileSync(lp, "utf8").trim());
        expect(pid).toBe(process.pid);
        release();
    });
});
