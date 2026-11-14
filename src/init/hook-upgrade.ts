/**
 * hook-upgrade.ts — upgrade the stock NREKI enforcer hook when the server starts.
 *
 * The old check rewrote `.claude/hooks/nreki-enforcer.mjs` whenever it did not
 * contain "cwdPosix": any file at that path, including a hook the user wrote,
 * and, through a symbolic link shipped in a cloned repository, a file outside
 * the project (`-> ~/.bashrc`). Now only a hook NREKI wrote is upgraded (the
 * v1 stock hook, which every pre-v3 NREKI hook contains, or the v2 one), and
 * never through a link.
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
    if (current.includes("nreki-enforcer:v3")) return "current";
    // v1 stock (and every older NREKI hook) carries this matcher; v2 is tagged.
    const isStockV1 = !current.includes("nreki-enforcer:v") && current.includes("/^(Write|Edit|Replace)(File)?$/i");
    const isV2 = current.includes("nreki-enforcer:v2");
    if (!isStockV1 && !isV2) return "not-nreki";
    fs.writeFileSync(hookPath, upstreamHook(), "utf-8");
    return "upgraded";
}
