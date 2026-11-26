/**
 * project-root.ts — NREKI_PROJECT_ROOT names the project folder explicitly.
 *
 * NREKI treats the folder it starts in (process.cwd()) as the project. Some
 * MCP hosts start servers elsewhere: measured on 2026-11-26, Antigravity starts
 * a global plugin's server in the plugin's own folder, and Cursor and VS Code
 * do not document the folder they use. `nreki init` therefore pins the project
 * in each registration, either with the host's own `cwd` field or with
 * NREKI_PROJECT_ROOT, and the server switches to that folder before any module
 * reads process.cwd() (see bootstrap-root.ts).
 */

import fs from "fs";
import path from "path";

export type ProjectRootDecision =
    | { kind: "unset" }
    | { kind: "apply"; dir: string }
    | { kind: "ignore"; reason: string };

function isDirectory(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Decide what to do with a NREKI_PROJECT_ROOT value. An unusable value is
 * ignored with a reason instead of failing the server: the host may not have
 * expanded a variable such as ${workspaceFolder}.
 */
export function decideProjectRoot(
    raw: string | undefined,
    statDir: (p: string) => boolean = isDirectory,
): ProjectRootDecision {
    const value = (raw ?? "").trim();
    if (!value) return { kind: "unset" };
    if (value.includes("${")) {
        return { kind: "ignore", reason: `NREKI_PROJECT_ROOT="${value}" was not expanded by the MCP host` };
    }
    if (!path.isAbsolute(value)) {
        return { kind: "ignore", reason: `NREKI_PROJECT_ROOT must be an absolute path (got "${value}")` };
    }
    if (!statDir(value)) {
        return { kind: "ignore", reason: `NREKI_PROJECT_ROOT "${value}" is not an existing folder` };
    }
    return { kind: "apply", dir: path.resolve(value) };
}

/**
 * Switch to NREKI_PROJECT_ROOT when it names an existing folder. Writes to
 * stderr only: stdout carries the MCP protocol.
 */
export function applyProjectRoot(env: NodeJS.ProcessEnv = process.env): ProjectRootDecision {
    const decision = decideProjectRoot(env.NREKI_PROJECT_ROOT);
    if (decision.kind === "apply") {
        if (path.resolve(process.cwd()) !== decision.dir) process.chdir(decision.dir);
    } else if (decision.kind === "ignore") {
        process.stderr.write(`[NREKI] ${decision.reason}; using ${process.cwd()} as the project.\n`);
    }
    return decision;
}
