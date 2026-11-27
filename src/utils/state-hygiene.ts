/**
 * state-hygiene.ts — keep NREKI's own files out of the way of the project.
 *
 * .nreki.db and .nreki/ hold this machine's index, caches and memory, signed
 * with this user's key (utils/trust.ts): on any other clone they are
 * quarantined, never read. Measured on a real project (2026-11-27): both were
 * committed (3 MB, +1 MB in one session, so every session left the work tree
 * dirty), and a 1.5 MB `.nreki.db.<hex>.tmp` from an interrupted save had sat
 * in the root for two days.
 *
 *   - `ensureGitExcludes` lists them in the clone's own `.git/info/exclude`
 *     (never committed, so the project's .gitignore is not touched) and puts a
 *     `*` .gitignore inside `.nreki/` (which also covers a project that is a
 *     folder of a larger repository).
 *   - `trackedNrekiState` finds them in the git index when they were committed
 *     anyway, by reading `.git/index`: running git here would let a repository's
 *     own config (core.fsmonitor and friends) run a program.
 *   - `removeStaleTemps` deletes temporaries left by interrupted atomic writes.
 * Every write goes through the state-file guards: never through a link, never
 * outside the project.
 */

import fs from "fs";
import path from "path";
import { removeStateFile, unsafeWriteTarget, writeStateFile } from "./path-jail.js";

const EXCLUDE_MARKER = "# NREKI: this machine's index and memory";
const EXCLUDE_BLOCK = [
    `${EXCLUDE_MARKER} (signed per user: useless to other clones)`,
    "/.nreki.db",
    "/.nreki.db.*",
    "/.nreki/",
];
/** A temporary this old was abandoned (a live atomic write renames within milliseconds). */
const STALE_TEMP_MS = 10 * 60 * 1000;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;

/** `.git` as a plain folder of `root` (a worktree's or submodule's `.git` file points outside: left alone). */
function gitDirOf(root: string): string | null {
    const dir = path.join(root, ".git");
    try {
        return fs.lstatSync(dir).isDirectory() ? dir : null;
    } catch {
        return null;
    }
}

export type ExcludeResult = "added" | "present" | "no-git" | "refused";

/** Make git ignore NREKI's state in this clone (see the module comment). Never throws. */
export function ensureGitExcludes(root: string): ExcludeResult {
    let result: ExcludeResult = "no-git";
    try {
        const nrekiDir = path.join(root, ".nreki");
        const ignoreFile = path.join(nrekiDir, ".gitignore");
        if (fs.existsSync(nrekiDir) && !fs.existsSync(ignoreFile) && !unsafeWriteTarget(root, ignoreFile)) {
            writeStateFile(root, ignoreFile, "# NREKI state: signed per user, never commit it\n*\n");
        }
    } catch { /* best effort */ }
    try {
        const gitDir = gitDirOf(root);
        if (!gitDir) return result;
        const exclude = path.join(gitDir, "info", "exclude");
        if (unsafeWriteTarget(root, exclude)) return "refused";
        let current = "";
        try { current = fs.readFileSync(exclude, "utf8"); } catch { /* git creates it lazily */ }
        const lines = current.split(/\r?\n/).map(l => l.trim());
        const covers = (re: RegExp) => lines.some(l => re.test(l));
        if (current.includes(EXCLUDE_MARKER) || (covers(/^\/?\.nreki\.db\*?$/) && covers(/^\/?\.nreki\/?\*{0,2}$/))) {
            return "present";
        }
        const eol = current.includes("\r\n") ? "\r\n" : "\n";
        const sep = current.length === 0 || current.endsWith("\n") ? "" : eol;
        writeStateFile(root, exclude, current + sep + EXCLUDE_BLOCK.join(eol) + eol);
        result = "added";
    } catch {
        result = "refused";
    }
    return result;
}

/** Paths named in a version 2/3 git index for which `want` is true; null when the index is not readable as one. */
export function indexedPaths(buf: Buffer, want: (p: string) => boolean): string[] | null {
    if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "DIRC") return null;
    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) return null; // v4 prefix-compresses the names
    const count = buf.readUInt32BE(8);
    const out: string[] = [];
    let off = 12;
    for (let i = 0; i < count; i++) {
        if (off + 62 > buf.length) return null;
        const flags = buf.readUInt16BE(off + 60);
        const nameStart = off + 62 + (version === 3 && (flags & 0x4000) !== 0 ? 2 : 0);
        const nul = buf.indexOf(0, nameStart);
        if (nul < 0) return null;
        const name = buf.toString("utf8", nameStart, nul);
        if (name.length === 0) return null;
        // A control character in a name: not a v2/v3 SHA-1 index after all (e.g. SHA-256 object names).
        for (let k = 0; k < name.length; k++) if (name.charCodeAt(k) < 0x20) return null;
        if (want(name)) out.push(name);
        off += (nul - off + 8) & ~7; // entry padded with 1–8 NULs to a multiple of 8
    }
    return out;
}

/** Which of `rels` (project-relative, `/`) git tracks in this project, read from the index. */
export function trackedAmong(root: string, rels: readonly string[]): string[] {
    const gitDir = gitDirOf(root);
    if (!gitDir || rels.length === 0) return [];
    try {
        const index = path.join(gitDir, "index");
        if (fs.lstatSync(index).size > MAX_INDEX_BYTES) return [];
        const wanted = new Set(rels);
        return [...new Set(indexedPaths(fs.readFileSync(index), p => wanted.has(p)) ?? [])];
    } catch {
        return [];
    }
}

/** NREKI state files git tracks in this project (empty when none, or when it cannot tell). */
export function trackedNrekiState(root: string): string[] {
    const gitDir = gitDirOf(root);
    if (!gitDir) return [];
    try {
        const index = path.join(gitDir, "index");
        if (fs.lstatSync(index).size > MAX_INDEX_BYTES) return [];
        const isState = (p: string) => p === ".nreki.db" || p.startsWith(".nreki.db.") || p.startsWith(".nreki/");
        // A file in a merge conflict has one entry per stage.
        return [...new Set(indexedPaths(fs.readFileSync(index), isState) ?? [])];
    } catch {
        return [];
    }
}

/**
 * Delete temporaries of NREKI's atomic writes that a crash or a failed rename
 * left behind: `.nreki.db.<8 hex>.tmp` in the root and `*.tmp` in `.nreki/`,
 * only when older than 10 minutes. Returns how many were removed. Never throws.
 */
export function removeStaleTemps(root: string, now: number = Date.now()): number {
    let removed = 0;
    const sweep = (dir: string, pattern: RegExp) => {
        let names: string[];
        try { names = fs.readdirSync(dir); } catch { return; }
        for (const name of names) {
            if (!pattern.test(name)) continue;
            const file = path.join(dir, name);
            try {
                const st = fs.lstatSync(file);
                if (!st.isFile() || now - st.mtimeMs < STALE_TEMP_MS) continue;
            } catch { continue; }
            if (removeStateFile(root, file)) removed++;
        }
    };
    sweep(root, /^\.nreki\.db\.[0-9a-f]{8}\.tmp$/);
    const nrekiDir = path.join(root, ".nreki");
    try {
        if (fs.lstatSync(nrekiDir).isDirectory()) sweep(nrekiDir, /\.tmp$/);
    } catch { /* no .nreki yet */ }
    return removed;
}
