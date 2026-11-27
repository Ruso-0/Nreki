/**
 * hook-upgrade.ts — upgrade the stock NREKI enforcer hook when the server starts.
 *
 * The old check rewrote `.claude/hooks/nreki-enforcer.mjs` whenever it did not
 * contain "cwdPosix": any file at that path, including a hook the user wrote,
 * and, through a symbolic link shipped in a cloned repository, a file outside
 * the project (`-> ~/.bashrc`). Now only a hook NREKI wrote is upgraded (the
 * v1 stock hook, which every pre-v3 NREKI hook contains, or a tagged one), and
 * never through a link. A hook tagged with a NEWER version than this server's
 * (written by a newer `nreki init`) is left alone: an older server never
 * downgrades it.
 */

import fs from "fs";
import path from "path";
import { unsafeWriteTarget } from "../utils/path-jail.js";

export const HOOK_REL_PATH = path.join(".claude", "hooks", "nreki-enforcer.mjs");

export type HookUpgrade = "absent" | "current" | "upgraded" | "not-nreki" | "unsafe-path";

/** The `nreki-enforcer:vN` tag of a hook file, or null when it carries none. */
export function hookVersion(text: string): number | null {
    const m = /nreki-enforcer:v(\d+)\b/.exec(text);
    return m ? Number(m[1]) : null;
}

export function upgradeEnforcerHook(cwd: string, upstreamHook: () => string): HookUpgrade {
    const hookPath = path.join(cwd, HOOK_REL_PATH);
    if (unsafeWriteTarget(cwd, HOOK_REL_PATH)) return fs.existsSync(hookPath) ? "unsafe-path" : "absent";
    if (!fs.existsSync(hookPath)) return "absent";
    const current = fs.readFileSync(hookPath, "utf-8");
    const up = upstreamHook();
    const mine = hookVersion(current);
    const theirs = hookVersion(up) ?? 0;
    // An early v5 build lacked linked-package Read support (pnpm stores, junctions).
    const needsLinkedPkgPatch = up.includes("isLinkedPackageRead") && !current.includes("isLinkedPackageRead");
    if (mine !== null && (mine > theirs || (mine === theirs && !needsLinkedPkgPatch))) return "current";
    // Tagged hooks are stock; v3 wrote state through a `.nreki` link, v4 fixed
    // that, v5 added native-edit validation, v6 shell dumps and de-duplication.
    const isStockV1 = mine === null && current.includes("/^(Write|Edit|Replace)(File)?$/i");
    if (mine === null && !isStockV1) return "not-nreki";
    fs.writeFileSync(hookPath, up, "utf-8");
    return "upgraded";
}
