/**
 * trust.ts — Did THIS user, on THIS machine, write this NREKI state file?
 *
 * NREKI keeps memory inside the project (.nreki.db: engrams, `memorize`
 * notes, plan pointer, index; .nreki/pins.json; .nreki/chronos-history.json)
 * and re-injects parts of it into the agent's context AS THE AGENT'S OWN
 * NOTES (outline/search engrams, map pins, the periodic memory payload). A
 * repository can ship those files, so a cloned repo could plant instructions
 * disguised as trusted memory. Every such file is therefore signed with an
 * HMAC whose key lives outside every project (~/.nreki/trust.key, 0600);
 * unsigned or foreign files are never loaded. `nreki trust-db` (interactive
 * terminal only) lets a person adopt a quarantined file after reviewing it.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger.js";

const KEY_HEX = /^[0-9a-f]{64}$/;
const TAG_HEX = /^[0-9a-f]{64}$/;

let cached: { dir: string; key: Buffer } | null = null;

/** Where the per-user key lives. NREKI_TRUST_DIR overrides it (tests, portable installs). */
export function trustDir(): string {
    return process.env.NREKI_TRUST_DIR || path.join(os.homedir(), ".nreki");
}

function loadOrCreateKey(): Buffer {
    const dir = trustDir();
    if (cached && cached.dir === dir) return cached.key;
    const file = path.join(dir, "trust.key");
    let key: Buffer;
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
            // "wx": exactly one process creates it; everyone else reads the winner's key.
            fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        const hex = fs.readFileSync(file, "utf8").trim();
        if (!KEY_HEX.test(hex)) throw new Error(`${file} is not a NREKI trust key`);
        key = Buffer.from(hex, "hex");
    } catch (err) {
        // Read-only home etc.: signatures still protect this process, but files
        // written now will not verify next run (they get quarantined, not trusted).
        logger.warn(`[NREKI] No persistent trust key (${(err as Error).message}); using a temporary one.`);
        key = crypto.randomBytes(32);
    }
    cached = { dir, key };
    return key;
}

/** HMAC-SHA256 of `payload`, domain-separated by `purpose` (e.g. "db", "pins"). */
export function signState(purpose: string, payload: string): string {
    return crypto.createHmac("sha256", loadOrCreateKey()).update(`nreki:${purpose}:v1\n`).update(payload).digest("hex");
}

export function verifyState(purpose: string, payload: string, tag: unknown): boolean {
    if (typeof tag !== "string" || !TAG_HEX.test(tag)) return false;
    const expected = Buffer.from(signState(purpose, payload), "hex");
    const got = Buffer.from(tag, "hex");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/**
 * `<project>/.nreki/quarantine/<name>.<timestamp>` — where unverified state is
 * moved. Works for files at the project root (.nreki.db) and inside .nreki/.
 */
export function quarantinePathFor(file: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const parent = path.dirname(file);
    const nrekiDir = path.basename(parent) === ".nreki" ? parent : path.join(parent, ".nreki");
    return path.join(nrekiDir, "quarantine", `${path.basename(file)}.${stamp}`);
}

/**
 * Move an unverified state file aside (never deleted: a person may adopt it
 * with `nreki trust-db`). Returns the new path, or null if it could not move.
 */
export function quarantineFile(file: string): string | null {
    const target = quarantinePathFor(file);
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch {
        return null;
    }
    try {
        fs.renameSync(file, target);
        return target;
    } catch {
        // Locked by another process (Windows): keep a copy; the caller stops reading the original.
        try {
            fs.copyFileSync(file, target);
            return target;
        } catch {
            return null;
        }
    }
}

/** Test hook: forget the cached key (e.g. after changing NREKI_TRUST_DIR). */
export function resetTrustKeyCache(): void {
    cached = null;
}
