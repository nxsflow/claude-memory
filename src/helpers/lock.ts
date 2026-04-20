import {
    closeSync,
    existsSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";

export async function acquireLock(lockPath: string): Promise<() => void> {
    let fd: number | undefined;
    try {
        fd = openSync(lockPath, "wx");
        // Successfully created — write our PID
        writeFileSync(lockPath, String(process.pid));
        closeSync(fd);
    } catch (err: unknown) {
        if (
            err !== null &&
            typeof err === "object" &&
            "code" in err &&
            err.code === "EEXIST"
        ) {
            // Lock file exists — check if the holder is still alive
            let holderPid = 0;
            try {
                holderPid = Number(readFileSync(lockPath, "utf8").trim());
            } catch {
                // unreadable — treat as stale
            }

            let holderAlive = false;
            if (holderPid > 0) {
                try {
                    process.kill(holderPid, 0);
                    holderAlive = true;
                } catch (killErr: unknown) {
                    if (
                        killErr !== null &&
                        typeof killErr === "object" &&
                        "code" in killErr &&
                        killErr.code === "ESRCH"
                    ) {
                        holderAlive = false;
                    } else {
                        // EPERM means process exists but we can't signal it
                        holderAlive = true;
                    }
                }
            }

            if (holderAlive) {
                throw new Error(`locked by PID ${holderPid}`);
            }

            // Stale lock — overwrite it
            writeFileSync(lockPath, String(process.pid));
        } else {
            throw err;
        }
    }

    let released = false;

    function release(): void {
        if (released) return;
        released = true;
        try {
            if (existsSync(lockPath)) {
                unlinkSync(lockPath);
            }
        } catch {
            // best effort
        }
    }

    process.on("exit", release);

    return release;
}
