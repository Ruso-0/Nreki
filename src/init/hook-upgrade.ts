/**
 * hook-upgrade.ts — upgrade the stock NREKI enforcer hook when the server starts.
 *
 * The old check rewrote `.claude/hooks/nreki-enforcer.mjs` whenever it did not
 * contain "cwdPosix": any file at that path, including a hook the user wrote,
 * and, through a symbolic link shipped in a cloned repository, a file outside
 * the project (`-> ~/.bashrc`). Now only a hook NREKI wrote is upgraded (the
 * v1 stock hook, which every pre-v3 NREKI hook contains, or a tagged v2/v3/v4
 * one), and never through a link.
 */

import fs from "fs";
import path from "path";
import { unsafeWriteTarget } from "../utils/path-jail.js";

export const HOOK_REL_PATH = path.join(".claude", "hooks", "nreki-enforcer.mjs");

export type HookUpgrade = "absent" | "current" | "upgraded" | "not-nreki" | "unsafe-path";

export function upgradeEnforcerHook(cwd: string, upstreamHook: () => string): HookUpgrade {
    const hookPath = path.join(cwd, HOOK_REL_PATH);
    if (unsafeWriteTarget(cwd, HOOK_REL_PATH)) return fs.existsSync(hookPath) ? "unsafe-path" : "absent";
    if (!fs.existsSync(hookPath)) return "absent";
    const current = fs.readFileSync(hookPath, "utf-8");
    if (current.includes("nreki-enforcer:v5")) return "current";
    // Tagged v2-v4 hooks are stock; v3 wrote state through a `.nreki` link,
    // v4 fixed that, and v5 adds native-edit validation.
    const isStockV1 = !current.includes("nreki-enforcer:v") && current.includes("/^(Write|Edit|Replace)(File)?$/i");
    const isTagged = /nreki-enforcer:v[234]\b/.test(current);
    if (!isStockV1 && !isTagged) return "not-nreki";
    fs.writeFileSync(hookPath, upstreamHook(), "utf-8");
    return "upgraded";
}
