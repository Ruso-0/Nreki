/**
 * safe-exec.ts — Hardened child-process helpers for third-party binaries
 * (gopls, pyright, basedpyright) that NREKI launches against untrusted repos.
 *
 * Threat (NREKI-SEC-03): on Windows, both cmd.exe (`shell: true`) and libuv
 * (`shell: false`) search the CURRENT DIRECTORY before %PATH% when given a
 * bare command name, unless `NoDefaultCurrentDirectoryInExePath` is set in
 * the environment. NREKI spawns sidecars with `cwd` = the repository, so a
 * cloned repo shipping `gopls.exe` / `basedpyright.cmd` at its root would be
 * executed (verified empirically on Windows 11 + Node 24).
 *
 * Defenses:
 *   1. resolveExecutable(): resolve bare names to an ABSOLUTE path by walking
 *      PATH ourselves — never the cwd, never relative PATH entries, never
 *      `node_modules` bin dirs inside the project (injected by npm/npx exec).
 *   2. buildSafeChildEnv(): allowlisted env (no secrets) + the Windows system
 *      variables runtimes need (SystemRoot for Winsock, LOCALAPPDATA for the Go
 *      build cache) + NoDefaultCurrentDirectoryInExePath=1 so grandchildren
 *      (e.g. the .cmd shim resolving `node`, pyright resolving `python`) also
 *      skip the cwd.
 *   3. spawnResolved(): .cmd/.bat go through an explicit absolute cmd.exe;
 *      everything else is spawned directly without a shell.
 *   4. killProcessTree(): `taskkill /T /F` on Windows (killing the cmd.exe
 *      wrapper alone orphans the real server).
 */

import fs from "fs";
import path from "path";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "child_process";

const IS_WIN = process.platform === "win32";

/** Windows system variables that native runtimes need to function. Not secrets. */
const WINDOWS_SYSTEM_ENV_KEYS = [
    "SystemRoot", "windir", "ComSpec", "PATHEXT", "SystemDrive",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME",
    "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

/** Executable extensions we accept on Windows (intersection with PATHEXT). */
const WIN_EXEC_EXTS = [".exe", ".cmd", ".bat", ".com"];

function systemRoot(): string {
    return process.env.SystemRoot || process.env.windir || "C:\\Windows";
}

function normalizeForCompare(p: string): string {
    const resolved = path.resolve(p);
    return IS_WIN ? resolved.toLowerCase() : resolved;
}

function isInside(child: string, parent: string): boolean {
    const c = normalizeForCompare(child);
    const p = normalizeForCompare(parent);
    return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * A PATH entry inside the project is untrusted when it is the project root
 * itself or any `node_modules` directory (npm/npx/pnpm exec prepend
 * `<project>/node_modules/.bin`, whose contents a malicious repo can commit).
 * Other in-project entries (an activated `.venv/bin`, a direnv `PATH_add`)
 * exist only through an explicit user action and are kept.
 */
function isUntrustedProjectPathEntry(dir: string, projectRoot: string): boolean {
    if (!isInside(dir, projectRoot)) return false;
    if (normalizeForCompare(dir) === normalizeForCompare(projectRoot)) return true;
    const rel = path.relative(path.resolve(projectRoot), path.resolve(dir));
    return rel.split(/[\\/]/).some(seg => seg.toLowerCase() === "node_modules");
}

function isExecutableFile(p: string): boolean {
    try {
        if (!fs.statSync(p).isFile()) return false;
        if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function readEnvVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
    if (!IS_WIN) return env[name];
    // process.env is case-insensitive on Windows, plain objects are not.
    if (env[name] !== undefined) return env[name];
    const key = Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase());
    return key ? env[key] : undefined;
}

export interface ResolveOptions {
    /** Project root whose root dir and node_modules bins must never be used. */
    projectRoot?: string;
    /** Environment to read PATH/PATHEXT from. Defaults to process.env. */
    env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a command to an absolute executable path WITHOUT consulting the
 * current directory. Returns null when no trusted match exists.
 * Commands containing a path separator must already be absolute.
 */
export function resolveExecutable(command: string, opts: ResolveOptions = {}): string | null {
    if (!command) return null;
    if (/[\\/]/.test(command)) {
        return path.isAbsolute(command) && isExecutableFile(command) ? command : null;
    }

    const env = opts.env ?? process.env;
    const pathVar = readEnvVar(env, "PATH") ?? "";

    let candidates = [command];
    if (IS_WIN) {
        const pathext = (readEnvVar(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
            .split(";").map(e => e.trim().toLowerCase()).filter(e => WIN_EXEC_EXTS.includes(e));
        const exts = pathext.length > 0 ? pathext : [".exe", ".cmd", ".bat"];
        const lower = command.toLowerCase();
        candidates = exts.some(e => lower.endsWith(e)) ? [command] : exts.map(e => command + e);
    }

    for (const rawEntry of pathVar.split(path.delimiter)) {
        const dir = rawEntry.trim().replace(/^"(.*)"$/, "$1");
        // Empty / relative entries resolve against the cwd — the repository.
        if (!dir || !path.isAbsolute(dir)) continue;
        if (opts.projectRoot && isUntrustedProjectPathEntry(dir, opts.projectRoot)) continue;
        for (const name of candidates) {
            const full = path.join(dir, name);
            if (isExecutableFile(full)) return full;
        }
    }
    return null;
}

/**
 * Build a minimal child environment: allowlisted keys only (secrets such as
 * API keys and tokens are never forwarded), plus Windows system variables and
 * NoDefaultCurrentDirectoryInExePath=1 on Windows.
 */
export function buildSafeChildEnv(
    allowKeys: readonly string[],
    extra?: Record<string, string>,
): Record<string, string> {
    const wanted = IS_WIN ? [...allowKeys, ...WINDOWS_SYSTEM_ENV_KEYS] : [...allowKeys];
    const allow = new Set(wanted.map(k => (IS_WIN ? k.toUpperCase() : k)));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (allow.has(IS_WIN ? key.toUpperCase() : key)) env[key] = value;
    }
    if (IS_WIN) env.NoDefaultCurrentDirectoryInExePath = "1";
    return extra ? { ...env, ...extra } : env;
}

function quoteForCmd(arg: string): string {
    return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Spawn an already-resolved absolute executable. Windows batch shims
 * (.cmd/.bat) require a shell (Node refuses them otherwise, CVE-2024-27980);
 * they run through the absolute System32 cmd.exe with a single pre-quoted
 * command line, so no PATH/cwd lookup happens and no DEP0190 warning fires.
 */
export function spawnResolved(resolvedPath: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    if (IS_WIN && /\.(cmd|bat)$/i.test(resolvedPath)) {
        const cmdExe = path.join(systemRoot(), "System32", "cmd.exe");
        const commandLine = [`"${resolvedPath}"`, ...args.map(quoteForCmd)].join(" ");
        return spawn(commandLine, [], { ...options, shell: cmdExe });
    }
    return spawn(resolvedPath, [...args], { ...options, shell: false });
}

/** Kill a child and all of its descendants (best effort, synchronous). */
export function killProcessTree(proc: ChildProcess): void {
    if (!proc.pid) {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        return;
    }
    if (IS_WIN) {
        try {
            spawnSync(path.join(systemRoot(), "System32", "taskkill.exe"),
                ["/pid", String(proc.pid), "/T", "/F"],
                { windowsHide: true, stdio: "ignore", timeout: 5000 });
        } catch { /* fall through */ }
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        return;
    }
    // POSIX: the sidecar is spawned detached, so -pid targets its process group.
    try {
        process.kill(-proc.pid, "SIGKILL");
    } catch {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }
}
