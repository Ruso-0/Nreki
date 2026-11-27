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
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export type ProjectRootDecision =
    | { kind: "unset" }
    | { kind: "apply"; dir: string }
    | { kind: "ignore"; reason: string };

function isDirectory(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFileOrDir(p: string): boolean {
    try { fs.statSync(p); return true; } catch { return false; }
}

const PROJECT_MARKERS = [
    ".git",
    "tsconfig.json",
    "jsconfig.json",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "Pipfile",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "AGENTS.md",
    "CLAUDE.md",
    ".nreki.db",
];

function normCompare(p: string, platform: NodeJS.Platform = process.platform): string {
    const resolved = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/**
 * Convert an MCP root URI (`file:///...`) or absolute path to a local folder,
 * or null when it is not an existing local directory.
 */
export function rootUriToDir(
    uri: string | undefined,
    statDir: (p: string) => boolean = isDirectory,
): string | null {
    const raw = (uri ?? "").trim();
    if (!raw) return null;
    let candidate: string;
    if (/^file:\/\//i.test(raw)) {
        try {
            candidate = fileURLToPath(raw);
        } catch {
            return null;
        }
    } else if (path.isAbsolute(raw)) {
        candidate = raw;
    } else {
        return null;
    }
    const resolved = path.resolve(candidate);
    return statDir(resolved) ? resolved : null;
}

/** Pick the first valid local directory from an MCP `roots/list` response. */
export function pickRootFromMcpRoots(
    roots: ReadonlyArray<{ uri: string; name?: string }> | undefined,
    statDir: (p: string) => boolean = isDirectory,
): string | null {
    if (!roots) return null;
    for (const root of roots) {
        const dir = rootUriToDir(root?.uri, statDir);
        if (dir) return dir;
    }
    return null;
}

/**
 * True when `dir` is an MCP host's own config/system folder rather than a user
 * project (e.g. `~/.gemini/config/plugins/nreki`, `~`, `_npx`, `System32`).
 * When launched there without `NREKI_PROJECT_ROOT`, NREKI waits for MCP `roots`
 * or `project_root` instead of creating `.nreki.db` inside the config folder.
 */
export function isNonProjectLaunchDir(
    dir: string,
    home: string = os.homedir(),
    platform: NodeJS.Platform = process.platform,
): boolean {
    const d = normCompare(dir, platform);
    const h = normCompare(home, platform);
    if (d === h) return true;
    for (const dot of [".gemini", ".claude", ".cursor", ".codex", ".nreki"]) {
        const prefix = `${h}/${dot}`;
        if (d === prefix || d.startsWith(`${prefix}/`)) return true;
    }
    if (/(?:^|\/)_npx(?:\/|$)/i.test(d)) return true;
    if (platform === "win32" && /\/windows\/(?:system32|syswow64)(?:\/|$)/i.test(d)) return true;
    return false;
}

/**
 * Walk up from an absolute file or folder path to locate its enclosing project
 * root (stopping before the user's home directory and filesystem root).
 */
export function inferProjectRootFromPath(
    targetPath: string | undefined,
    home: string = os.homedir(),
    platform: NodeJS.Platform = process.platform,
): string | null {
    const raw = (targetPath ?? "").trim();
    if (!raw || !path.isAbsolute(raw)) return null;
    let current = path.resolve(raw);
    if (!isDirectory(current)) current = path.dirname(current);
    if (!isDirectory(current)) return null;

    const homeNorm = normCompare(home, platform);
    const startDir = current;
    for (;;) {
        const curNorm = normCompare(current, platform);
        if (curNorm === homeNorm || isNonProjectLaunchDir(current, home, platform)) break;
        if (PROJECT_MARKERS.some((m) => isFileOrDir(path.join(current, m)))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return isNonProjectLaunchDir(startDir, home, platform) ? null : startDir;
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
