/**
 * trust-db.ts — `nreki trust-db`: a PERSON adopts quarantined NREKI memory.
 *
 * Unsigned state (written by NREKI <= 12.0.0, copied from another machine, or
 * shipped with a repository) is moved to .nreki/quarantine/ and never loaded
 * (utils/trust.ts). This command shows what a quarantined database / pins
 * file contains and, after "yes" typed in an interactive terminal, copies its
 * engrams, memorize notes and plan pointer into the current signed database
 * and re-signs its pins. Without a TTY it refuses: an agent's shell tool has
 * none, so a planted instruction cannot make the agent trust planted memory.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import initSqlJs from "sql.js";
import { NrekiDB } from "../database.js";
import { adoptPins, type PinnedRule } from "../pin-memory.js";
import { safePath } from "../utils/path-jail.js";
import { ENGRAM_MAX_CHARS } from "../utils/engram-identity.js";

export interface QuarantinedEngram { path: string; symbol: string; astHash: string; insight: string }

export interface QuarantineReport {
    db?: { file: string; engrams: QuarantinedEngram[]; scratchpad: string | null; plan: string | null };
    pins?: { file: string; pins: PinnedRule[] };
}

const quarantineDir = (root: string) => path.join(root, ".nreki", "quarantine");

function newest(dir: string, prefix: string): string | null {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return null; }
    const hits = entries.filter(e => e.startsWith(prefix)).sort();
    return hits.length > 0 ? path.join(dir, hits[hits.length - 1]) : null;
}

/** What the newest quarantined database and pins file contain (read-only). */
export async function inspectQuarantine(projectRoot: string): Promise<QuarantineReport> {
    const report: QuarantineReport = {};
    const dir = quarantineDir(projectRoot);

    const dbFile = newest(dir, ".nreki.db.");
    if (dbFile) {
        const SQL = await initSqlJs();
        const db = new SQL.Database(fs.readFileSync(dbFile));
        try {
            const rows = (sql: string) => { try { return db.exec(sql)[0]?.values ?? []; } catch { return []; } };
            const meta = (key: string): string | null => {
                try {
                    const stmt = db.prepare("SELECT value FROM metadata WHERE key = ?");
                    try {
                        stmt.bind([key]);
                        return stmt.step() ? String(stmt.get()[0]) : null;
                    } finally {
                        stmt.free();
                    }
                } catch { return null; }
            };
            report.db = {
                file: dbFile,
                engrams: rows("SELECT path, symbol_name, ast_hash, insight FROM engrams").map(r => ({
                    path: String(r[0]), symbol: String(r[1]), astHash: String(r[2]), insight: String(r[3]),
                })),
                scratchpad: meta("nreki_scratchpad"),
                plan: meta("nreki_master_plan"),
            };
        } finally {
            db.close();
        }
    }

    const pinsFile = newest(dir, "pins.json.");
    if (pinsFile) {
        try {
            const raw = JSON.parse(fs.readFileSync(pinsFile, "utf-8")) as unknown;
            const list = Array.isArray(raw) ? raw : (raw as { pins?: unknown })?.pins;
            if (Array.isArray(list)) {
                const pins = list.filter((p): p is PinnedRule =>
                    typeof p === "object" && p !== null && typeof (p as PinnedRule).text === "string" &&
                    typeof (p as PinnedRule).id === "string" && !Object.hasOwn(p, "__proto__"));
                report.pins = { file: pinsFile, pins };
            }
        } catch { /* unreadable: nothing to offer */ }
    }
    return report;
}

/** PIDs of NREKI servers alive for this project (they hold the DB in RAM and would overwrite it). */
export function liveServers(projectRoot: string): number[] {
    const dir = path.join(projectRoot, ".nreki", "sessions");
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    return entries.map(e => Number.parseInt(e, 10)).filter(pid => {
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
        try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
    });
}

/** Copy the reviewed quarantined memory into the current signed state. Existing entries win. */
export async function adoptQuarantine(
    projectRoot: string,
    report: QuarantineReport,
    dbPath: string = path.join(projectRoot, ".nreki.db"),
): Promise<{ engrams: number; notes: boolean; plan: boolean; pins: number; rejected: string[] }> {
    const live = liveServers(projectRoot);
    if (live.length > 0) {
        throw new Error(`a NREKI server is running for this project (pid ${live.join(", ")}); close the agent session first`);
    }
    const result = { engrams: 0, notes: false, plan: false, pins: 0, rejected: [] as string[] };

    // Everything adopted must be something the normal tools would have accepted
    // (S-03): inside the project, within the same size limits, no control chars.
    if (report.db) {
        const db = new NrekiDB(dbPath, projectRoot);
        await db.initialize();
        try {
            for (const e of report.db.engrams) {
                const label = `engram ${e.path} :: ${e.symbol}`;
                let abs: string;
                try { abs = safePath(projectRoot, e.path); } catch { result.rejected.push(`${label}: outside the project`); continue; }
                if (e.insight.length > ENGRAM_MAX_CHARS) { result.rejected.push(`${label}: longer than ${ENGRAM_MAX_CHARS} chars`); continue; }
                if (CONTROL_EXCEPT_NEWLINE.test(e.insight) || CONTROL_EXCEPT_NEWLINE.test(e.symbol)) {
                    result.rejected.push(`${label}: control characters`);
                    continue;
                }
                if (db.getEngramsForFile(abs).has(e.symbol)) continue;
                db.upsertEngram(abs, e.symbol, e.astHash, e.insight);
                result.engrams++;
            }
            const notes = report.db.scratchpad;
            if (notes !== null && db.getMetadata("nreki_scratchpad") === null) {
                if (notes.length > SCRATCHPAD_MAX_CHARS || CONTROL_EXCEPT_NEWLINE.test(notes)) {
                    result.rejected.push(`memorize notes: over ${SCRATCHPAD_MAX_CHARS} chars or control characters`);
                } else {
                    db.setMetadata("nreki_scratchpad", notes);
                    result.notes = true;
                }
            }
            const plan = report.db.plan;
            if (plan !== null && db.getMetadata("nreki_master_plan") === null) {
                let inside = false;
                try { safePath(projectRoot, plan); inside = true; } catch { /* rejected below */ }
                if (inside) {
                    db.setMetadata("nreki_master_plan", plan);
                    result.plan = true;
                } else {
                    result.rejected.push(`plan pointer ${plan}: outside the project or a sensitive file`);
                }
            }
            db.save();
        } finally {
            db.close();
        }
    }

    if (report.pins) {
        const r = adoptPins(projectRoot, report.pins.pins);
        result.pins = r.adopted;
        result.rejected.push(...r.rejected.map(reason => `pin: ${reason}`));
    }

    // Adopted files leave the quarantine so they are not offered again.
    const adopted = path.join(quarantineDir(projectRoot), "adopted");
    fs.mkdirSync(adopted, { recursive: true });
    for (const f of [report.db?.file, report.pins?.file]) {
        if (f) try { fs.renameSync(f, path.join(adopted, path.basename(f))); } catch { /* best effort */ }
    }
    return result;
}

const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const SCRATCHPAD_MAX_CHARS = 5000;

/**
 * Untrusted text for the terminal: nothing is truncated (the person approves
 * exactly what they read) and every control character is made visible, so an
 * ESC/CR sequence cannot rewrite or hide part of the preview (S-03).
 */
export function showUntrusted(s: string): string {
    return s
        .replace(/\r\n|\n/g, "⏎ ")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** CLI entry. Returns the process exit code. */
export async function runTrustDbCli(projectRoot: string): Promise<number> {
    const out = (s: string) => process.stdout.write(s + "\n");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write(
            "nreki trust-db must be run by a person in an interactive terminal: it restores memory that the agent " +
            "will treat as its own notes.\n",
        );
        return 2;
    }
    const report = await inspectQuarantine(projectRoot);
    if (!report.db && !report.pins) {
        out("Nothing in .nreki/quarantine to restore.");
        return 0;
    }
    if (report.db) {
        out(`Quarantined database: ${report.db.file}`);
        out(`  ${report.db.engrams.length} engram(s):`);
        for (const e of report.db.engrams) out(`    ${showUntrusted(e.path)} :: ${showUntrusted(e.symbol)} — ${showUntrusted(e.insight)}`);
        if (report.db.scratchpad) out(`  memorize notes: ${showUntrusted(report.db.scratchpad)}`);
        if (report.db.plan) out(`  plan file: ${showUntrusted(report.db.plan)}`);
    }
    if (report.pins) {
        out(`Quarantined pins: ${report.pins.file}`);
        for (const p of report.pins.pins) out(`    • ${showUntrusted(p.text)}`);
    }
    out("\nRestore ONLY if you (or your own agent sessions) wrote ALL of the above.");
    out("Anything the normal tools would refuse (too long, outside the project, control characters) is skipped.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => rl.question("Type yes to restore: ", resolve));
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
        out("Nothing restored.");
        return 0;
    }
    try {
        const r = await adoptQuarantine(projectRoot, report);
        out(`Restored ${r.engrams} engram(s)${r.notes ? ", memorize notes" : ""}${r.plan ? ", plan pointer" : ""}` +
            `${report.pins ? `, ${r.pins} pin(s)` : ""}.`);
        for (const why of r.rejected) out(`  skipped — ${showUntrusted(why)}`);
        return 0;
    } catch (err) {
        process.stderr.write(`nreki trust-db: ${(err as Error).message}\n`);
        return 1;
    }
}
