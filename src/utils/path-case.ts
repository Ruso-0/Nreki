/**
 * path-case.ts — one spelling per file on case-insensitive file systems.
 *
 * Windows (and macOS by default) open D:\Proj\src\a.ts and d:\proj\SRC\A.ts as
 * the same file, but NREKI's index is keyed by path strings. VS Code starts
 * MCP servers in `d:\…` (lower-case drive letter) and terminals in `D:\…`, so
 * one project's .nreki.db held every file twice. Measured on a real project
 * (2026-11-27): 186 rows for 93 files; fast_grep, context, references and the
 * heavy-file list showed each hit twice, and the copy under the other
 * spelling never updated, so a renamed file and edited text stayed findable.
 *
 * Nothing here follows a link: a path is only ever re-spelled (letter case,
 * Unicode form), never sent somewhere else.
 */

import fs from "fs";
import path from "path";

/** True on platforms whose default file systems ignore case. */
export function caseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
    return platform === "win32" || platform === "darwin";
}

/** `d:\x` → `D:\x`: the spelling Windows itself reports for a drive. */
function upperDrive(p: string): string {
    return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p;
}

/** Equal but for letter case and Unicode form (macOS keeps names decomposed, NFD). */
function sameButCase(a: string, b: string): boolean {
    const x = a.normalize("NFC");
    const y = b.normalize("NFC");
    return x.length === y.length && x.toLowerCase() === y.toLowerCase();
}

function realNative(p: string): string | null {
    try { return fs.realpathSync.native(p); } catch { return null; }
}

/** The real path, but only when it is the same path spelled otherwise. */
function sameSpelling(p: string): string | null {
    const real = realNative(p);
    // Never a link, junction, subst drive or 8.3 short name: only spelling may change.
    return real !== null && sameButCase(real, p) ? real : null;
}

/** How folder `dir` lists `name` (the entry's own name: a link is named, not followed). */
function entrySpelling(dir: string, name: string): string {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return name; }
    if (names.includes(name)) return name;
    // Only when the folder answers to the typed name: on a case-sensitive volume `p` is not `P`.
    if (!fs.existsSync(path.join(dir, name))) return name;
    return names.find(n => sameButCase(n, name)) ?? name;
}

/**
 * `p` resolved and spelled as it is on disk: each existing part's real case,
 * upper-case drive letter. Below a link, junction or 8.3 short name each part
 * takes the spelling its folder lists (a short name such as RUNNER~1 has no
 * long-name match and stays as written). A missing tail is kept as written.
 * Case-sensitive platforms get `path.resolve(p)` unchanged.
 */
export function onDiskCase(p: string, platform: NodeJS.Platform = process.platform): string {
    const resolved = path.resolve(p);
    if (!caseInsensitiveFs(platform)) return resolved;
    const tail: string[] = [];
    let cur = resolved;
    for (;;) {
        const real = sameSpelling(cur);
        if (real !== null) {
            let out = real;
            for (const name of tail.reverse()) out = path.join(out, entrySpelling(out, name));
            return out;
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        tail.push(path.basename(cur));
        cur = parent;
    }
    return platform === "win32" ? upperDrive(resolved) : resolved;
}

/** True when `a` and `b` are the same existing file or folder (device + file id). */
function sameEntry(a: string, b: string): boolean {
    try {
        const x = fs.statSync(a, { bigint: true });
        const y = fs.statSync(b, { bigint: true });
        return x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
    } catch {
        return false;
    }
}

const realRoots = new Map<string, string | null>();
function realRootOf(root: string): string | null {
    let real = realRoots.get(root);
    if (real === undefined) {
        real = realNative(root);
        if (realRoots.size >= 32) realRoots.clear();
        realRoots.set(root, real);
    }
    return real;
}

/**
 * `p` (inside the on-disk-spelled `root`) spelled as on disk, in one system
 * call when nothing on the way is a link or a short name. When the root itself
 * is reached through one (CI temp folders: C:\Users\RUNNER~1\…; macOS /tmp →
 * /private/tmp; a junctioned project), the part below the root is spelled from
 * the real path relative to the root's real path, and only when that real tail
 * is the typed tail re-spelled: a link below the root keeps the typed spelling.
 * safePath runs once per file of an index walk: no folder listing here.
 */
export function onDiskCaseUnder(root: string, p: string, platform: NodeJS.Platform = process.platform): string {
    const resolved = path.resolve(p);
    if (!caseInsensitiveFs(platform)) return resolved;
    const whole = sameSpelling(resolved);
    if (whole !== null) return whole;
    const lowerRoot = root.toLowerCase();
    const lower = resolved.toLowerCase();
    const prefix = lowerRoot.endsWith(path.sep) ? lowerRoot : lowerRoot + path.sep;
    if (lower !== lowerRoot && !lower.startsWith(prefix)) return onDiskCase(resolved, platform);
    // The typed root part takes the root's spelling only when the disk says it IS
    // the root: a case-sensitive volume (APFS can be one) has /p and /P side by side.
    const head = resolved.slice(0, root.length);
    if (head !== root && !sameEntry(head, root)) return resolved;
    if (lower === lowerRoot) return root;
    const typed = root + resolved.slice(root.length);
    const realRoot = realRootOf(root);
    if (realRoot === null) return typed;
    const realPrefix = (realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep).toLowerCase();
    const missing: string[] = [];
    let cur = resolved;
    while (cur.length > root.length) {
        const real = realNative(cur);
        if (real === null) {
            missing.unshift(path.basename(cur));
            cur = path.dirname(cur);
            continue;
        }
        if (!real.toLowerCase().startsWith(realPrefix)) return typed;
        const realTail = real.slice(realRoot.length);
        return sameButCase(realTail, cur.slice(root.length)) ? path.join(root + realTail, ...missing) : typed;
    }
    return typed;
}
