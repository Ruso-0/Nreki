#!/usr/bin/env node

/**
 * index.ts - NREKI MCP Server entry point.
 *
 * Exposes 3 router tools to Claude Code (replaces 16 individual tools):
 *
 *   1. nreki_navigate - AST-powered code navigation, semantic search, and refactor analysis
 *   2. nreki_code     - Read, compress, surgically edit, and batch edit code files
 *   3. nreki_guard    - Safety controls, session monitoring, and persistent memory
 *
 * Middleware (runs automatically, not exposed as tools):
 *   - AST Validation: validates code before disk writes (inside nreki_code edit/batch_edit)
 *   - Circuit Breaker: detects and stops infinite failure loops
 *   - File Lock: prevents concurrent edit corruption
 *
 * All processing is local. Zero cloud dependencies.
 */

// First import: switches to NREKI_PROJECT_ROOT before any module reads process.cwd().
import "./bootstrap-root.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import os from "os";
import path from "path";
import fs from "fs";

import { NrekiEngine } from "./engine.js";
import { TokenMonitor } from "./monitor.js";
import { AstSandbox } from "./ast-sandbox.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
    handleNavigate,
    handleCode,
    handleGuard,
    type RouterDependencies,
    type NavigateParams,
    type CodeParams,
    type GuardParams,
} from "./router.js";
import { wrapWithCircuitBreaker } from "./middleware/circuit-breaker.js";
import { CognitiveEnforcer } from "./hooks/cognitive-enforcer.js";
import { NrekiKernel } from "./kernel/nreki-kernel.js";
import { ChronosMemory } from "./chronos-memory.js";
import { logger } from "./utils/logger.js";
import { unsafeWriteTarget, writeStateFile } from "./utils/path-jail.js";
import { upgradeEnforcerHook } from "./init/hook-upgrade.js";
import { detectMode as detectModePure } from "./detect-mode.js";
import { startNativeEditServer, type NativeEditServer } from "./hooks/native-edit-ipc.js";
import { validateNativeEdit } from "./hooks/native-edit-validator.js";
import { ensureHologramReady } from "./handlers/code/kernel-bridge.js";
import {
    decideProjectRoot,
    hasProjectMarker,
    inferProjectRootFromPath,
    isNonProjectLaunchDir,
    isSameOrInside,
    pickRootsFromMcpRoots,
    sameDir,
} from "./project-root.js";

// Patch 7 (v10.6.1): shape of .claude/settings.json. Kept loose on unknown
// keys because Anthropic may add fields; the init command only reads/writes
// the `hooks.PreToolUse` matcher list.
interface ClaudeSettings {
    hooks?: {
        PreToolUse?: Array<{
            matcher: string;
            hooks: Array<{ type: string; command: string }>;
        }>;
    };
    [key: string]: unknown;
}

// ─── Performance Mode Auto-Detection ────────────────────────────────

// Bounded DFS. Uses stack.pop() which is O(1) in V8.
// Array.shift() is O(N) in V8 because it reindexes the contiguous memory block.
// Do not change pop() to shift().
export function detectMode(dir: string): "syntax" | "file" | "project" | "hologram" {
    return detectModePure(dir);
}

// ─── CLI Flag Parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
const VERSION = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")
).version;

if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
    console.log(`
NREKI v${VERSION} - Semantic validation MCP server for AI coding agents

Usage:
  npx nreki                               Start MCP server (default)
  npx nreki init [options]                Install NREKI globally for your user across
                                          Claude Code, Antigravity, Cursor, Codex & VS Code
                                          (opens a setup box for your Voyage API key)
  npx nreki key                           Open the Voyage API key setup box anytime
  npx nreki deinit [--global]             Safely remove NREKI hooks and MCP registrations
  npx nreki trust-db                      Review and restore quarantined engrams/notes/pins
                                          (interactive terminal only)

\`init\` options:
  --global, -g          Install globally at user scope for all agents (default in a terminal;
                        no per-project .mcp.json approval needed)
  --project, --local    Install inside this project folder only
  --agent <names>       Agents to install for, comma-separated:
                        claude | codex | antigravity | cursor | cline | copilot | generic
  --voyage              Turn on Voyage semantic search in the registrations
  --no-voyage           Turn it off again
  --prompt              Always open the Voyage API key setup box
  --no-prompt           Never open the Voyage API key setup box
  --no-mcp              Write the instructions only, do not register the MCP server
  --force               Rewrite existing NREKI blocks and replace custom "nreki" MCP entries
  --dry-run             Print plan only, no filesystem writes

Environment:
  NREKI_PROJECT_ROOT    Absolute path of the project folder (optional; global servers auto-detect
                        the open workspace via MCP roots/list or project_root)

Global flags:
  --help, -h            Show this help message
  --version, -v         Show version
    `);
    process.exit(0);
}

// ─── Uninstall Subcommand (deinit) ───────────────────────────────
// Safely removes NREKI hooks before npm uninstall to prevent
// orphaned PreToolUse references from bricking Claude Code tools.
// Idempotent — safe to run multiple times or when nothing is installed.
if (args[0] === "deinit") {
    logger.info("Uninstalling NREKI hooks and configuration...");
    const cwd = process.cwd();
    let modified = false;
    // Never through a symbolic link, never outside the project (unsafeWriteTarget).
    const touchable = (p: string): boolean => {
        const why = unsafeWriteTarget(cwd, p);
        if (why) logger.warn(`${path.relative(cwd, p)} is ${why}: not touched.`);
        return why === null;
    };

    // 1. Clean settings.json — remove PreToolUse entries referencing nreki-enforcer
    const claudeSettingsPath = path.join(cwd, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath) && touchable(claudeSettingsPath)) {
        try {
            const raw = fs.readFileSync(claudeSettingsPath, "utf-8").replace(/^\uFEFF/, "");
            const settings = JSON.parse(raw) as ClaudeSettings;

            if (settings?.hooks?.PreToolUse && Array.isArray(settings.hooks.PreToolUse)) {
                const originalLen = settings.hooks.PreToolUse.length;
                settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((h) => {
                    if (!h.hooks || !Array.isArray(h.hooks)) return true;
                    return !h.hooks.some((cmd) =>
                        typeof cmd.command === "string" && cmd.command.includes("nreki-enforcer.mjs")
                    );
                });

                if (settings.hooks.PreToolUse.length !== originalLen) {
                    if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
                    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

                    if (Object.keys(settings).length === 0) {
                        // Only NREKI's hooks were in it (init creates it when absent).
                        fs.unlinkSync(claudeSettingsPath);
                        logger.info("Deleted .claude/settings.json (it only held NREKI's hooks)");
                    } else {
                        fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
                        logger.info("Removed NREKI hooks from .claude/settings.json");
                    }
                    modified = true;
                }
            }
        } catch (err) {
            logger.error(`Failed to clean settings.json: ${(err as Error).message}`);
        }
    }

    // 2. Delete enforcer hook script
    const hookPath = path.join(cwd, ".claude", "hooks", "nreki-enforcer.mjs");
    if (fs.existsSync(hookPath) && touchable(hookPath)) {
        try {
            fs.unlinkSync(hookPath);
            const { removeEmptyDirs } = await import("./init/mcp-register.js");
            removeEmptyDirs(cwd, path.dirname(hookPath));
            logger.info("Deleted .claude/hooks/nreki-enforcer.mjs");
            modified = true;
        } catch (err) {
            logger.error(`Failed to delete hook script: ${(err as Error).message}`);
        }
    }

    // 3-4. Instruction files `init` wrote: NREKI's block in CLAUDE.md, AGENTS.md and
    //      .github/copilot-instructions.md (the user's content is kept), and the
    //      files NREKI owns (Claude skill, Cursor rule, Cline rule).
    try {
        const { removeInstructions } = await import("./init/init-runner.js");
        for (const action of removeInstructions(cwd)) {
            if (action.op === "removed") {
                logger.info(`${action.path}: ${action.note}`);
                modified = true;
            } else {
                logger.warn(`${action.path}: ${action.note}`);
            }
        }
    } catch (err) {
        logger.error(`Failed to clean instruction files: ${(err as Error).message}`);
    }

    // 5. Clean SKILL.md — strip only NREKI block, preserve user own rules
    const skillMdPath = path.join(cwd, "SKILL.md");
    if (fs.existsSync(skillMdPath) && touchable(skillMdPath)) {
        try {
            const content = fs.readFileSync(skillMdPath, "utf-8").replace(/^\uFEFF/, "");
            const nrekiMarker = "name: nreki-optimizer";
            const nrekiIdx = content.indexOf(nrekiMarker);
            if (nrekiIdx !== -1) {
                // Back up to include the YAML front-matter "---" fence line if it precedes our marker
                let stripFrom = nrekiIdx;
                const before = content.substring(0, nrekiIdx);
                const lastFence = before.lastIndexOf("---");
                if (lastFence !== -1 && before.substring(lastFence).trim() === "---") {
                    stripFrom = lastFence;
                }
                const cleanedContent = content.substring(0, stripFrom).trim();
                if (cleanedContent === "") {
                    fs.unlinkSync(skillMdPath);
                    logger.info("Deleted empty SKILL.md");
                } else {
                    fs.writeFileSync(skillMdPath, cleanedContent + "\n", "utf-8");
                    logger.info("Removed NREKI instructions from SKILL.md");
                }
                modified = true;
            }
        } catch (err) {
            logger.error(`Failed to clean SKILL.md: ${(err as Error).message}`);
        }
    }

    // 6. Clean .nreki/sessions — remove stale session markers
    const sessionsDir = path.join(cwd, ".nreki", "sessions");
    if (fs.existsSync(sessionsDir) && touchable(sessionsDir)) {
        try {
            fs.rmSync(sessionsDir, { recursive: true, force: true });
            logger.info("Removed .nreki/sessions markers");
            modified = true;
        } catch (err) {
            logger.error(`Failed to clean session markers: ${(err as Error).message}`);
        }
    }

    // 7. Remove the MCP server entries `nreki init` wrote (only entries that launch
    //    the nreki package; a user's own "nreki" entry is left alone).
    {
        const { MCP_HOSTS, unregisterMcp } = await import("./init/mcp-register.js");
        for (const host of MCP_HOSTS) {
            try {
                const removed = unregisterMcp(host, cwd);
                if (!removed) continue;
                if (removed.op === "removed") {
                    logger.info(`Removed NREKI MCP registration from ${removed.path} (${removed.note})`);
                    modified = true;
                } else {
                    logger.warn(`${removed.path}: ${removed.note}`);
                }
            } catch (err) {
                logger.error(`Failed to clean ${host} MCP registration: ${(err as Error).message}`);
            }
        }
    }

    // 8. When `--global` / `-g` / `--all` is passed, also remove user-scoped registrations.
    if (args.includes("--global") || args.includes("-g") || args.includes("--all")) {
        try {
            const { unregisterGlobalAll } = await import("./init/global-register.js");
            const userHome = process.env.NREKI_USER_HOME ? path.resolve(process.env.NREKI_USER_HOME) : os.homedir();
            for (const removed of unregisterGlobalAll(userHome)) {
                if (removed.op === "removed") {
                    logger.info(`Removed global registration ${removed.path} (${removed.note})`);
                    modified = true;
                } else {
                    logger.warn(`${removed.path}: ${removed.note}`);
                }
            }
        } catch (err) {
            logger.error(`Failed to clean global registrations: ${(err as Error).message}`);
        }
    }

    if (modified) {
        logger.info("NREKI deinit complete. Your environment is clean.");
    } else {
        logger.info("No active NREKI configuration found. Nothing to clean.");
    }

    process.exit(0);
}

// ─── trust-db Subcommand (NREKI-SEC-06) ─────────────────────────────
// A person reviews and restores memory quarantined because it was not signed
// on this machine (interactive terminal only; see init/trust-db.ts).
if (args[0] === "trust-db") {
    const { runTrustDbCli } = await import("./init/trust-db.js");
    process.exit(await runTrustDbCli(process.cwd()));
}

// ─── Voyage Key Subcommand (`npx nreki key`) ────────────────────────
if (args[0] === "key") {
    try {
        const { promptForVoyage } = await import("./init/voyage-prompt.js");
        const { runInit, formatAction } = await import("./init/init-runner.js");
        const answer = await promptForVoyage();
        for (const line of answer.lines) process.stderr.write(`${line}\n`);
        if (answer.voyage !== undefined) {
            const userHome = process.env.NREKI_USER_HOME ? path.resolve(process.env.NREKI_USER_HOME) : os.homedir();
            // cwd = home: changing the key only updates the user-scope entries; it
            // must not migrate the .mcp.json of whatever folder `key` runs in.
            const result = runInit({ global: true, home: userHome, cwd: userHome, voyage: answer.voyage });
            for (const action of result.actions) {
                if (action.op !== "skipped") process.stderr.write(`  ${formatAction(action)}\n`);
            }
        }
        process.exit(0);
    } catch (err) {
        process.stderr.write(`nreki key failed: ${(err as Error).message}\n`);
        process.exit(1);
    }
}

// ─── Init Subcommand ────────────────────────────────────────────────

if (args[0] === "init") {
    const { parseInitArgs, runInit, formatAction } = await import("./init/init-runner.js");
    const parsed = parseInitArgs(args.slice(1));
    if (parsed.error) {
        process.stderr.write(`nreki init: ${parsed.error}\n`);
        process.stderr.write(
            "\nUsage: nreki init [--global|--project] [--agent <claude,codex,antigravity,cursor,cline,copilot,generic>]" +
            " [--voyage|--no-voyage] [--prompt|--no-prompt] [--no-mcp] [--force] [--dry-run]\n",
        );
        process.exit(2);
    }

    try {
        const opts = parsed.opts;
        const userHome = process.env.NREKI_USER_HOME ? path.resolve(process.env.NREKI_USER_HOME) : os.homedir();
        opts.home = userHome;

        // In a person's terminal, default to the user-scope install so Claude Code,
        // Antigravity, Cursor, and Codex work across all projects without per-repo
        // `.mcp.json` approval prompts (`--project` opts into repo-local).
        // --prompt/--no-prompt only control the Voyage box, never the scope.
        const { initTerminalDefaults, promptForVoyage } = await import("./init/voyage-prompt.js");
        const defaults = initTerminalDefaults(opts);
        opts.global = defaults.global;
        const interactive = defaults.showVoyageBox;

        const voyageLines: string[] = [];
        if (interactive && !opts.dryRun && opts.mcp !== false && opts.voyage !== false) {
            const { availableVoyageKey } = await import("./utils/voyage-key.js");
            if (!(opts.voyage === true && availableVoyageKey() !== null)) {
                const answer = await promptForVoyage();
                if (answer.voyage !== undefined) opts.voyage = answer.voyage;
                voyageLines.push(...answer.lines);
            }
        }

        const result = runInit(opts);
        for (const line of voyageLines) process.stderr.write(`${line}\n`);
        process.stderr.write(`nreki init: ${result.reason}\n`);
        process.stderr.write(`  agents: ${result.agents.join(", ")}${parsed.opts.dryRun ? " (dry-run)" : ""}\n`);
        for (const action of result.actions) {
            process.stderr.write(`  ${formatAction(action)}\n`);
        }
        if (result.notes.length > 0) {
            process.stderr.write("\nNext:\n");
            for (const note of result.notes) process.stderr.write(`  - ${note}\n`);
        }
        if (result.agent === "generic" && !parsed.opts.agent) {
            process.stderr.write(
                "\nNo agent detected in this project or on this computer. If you use Claude Code / Codex /\n" +
                "Antigravity / Cursor / Cline / Copilot, re-run with --agent <name>.\n",
            );
        }
        process.exit(0);
    } catch (err) {
        process.stderr.write(`nreki init failed: ${(err as Error).message}\n`);
        process.exit(1);
    }
}

// ─── Dynamic Workspace Runtime (supports Global MCP + MCP roots/list) ───────

/**
 * Who chose the workspace. It bounds every read and write (safePath), so a tool
 * argument may only move it when the host did not choose: "env" (pinned by
 * NREKI_PROJECT_ROOT), "roots" (the client's MCP roots) and "launch" (started in
 * a folder with a project marker) hold; "guess" (started in an unmarked folder)
 * and "explicit" (named by project_root or a path) can be replaced.
 */
type WorkspaceSource = "env" | "roots" | "launch" | "guess" | "explicit";

interface WorkspaceRuntime {
    root: string;
    source: WorkspaceSource;
    deps: RouterDependencies;
    liveBooted: boolean;
    /** Session marker, native-edit endpoint and hook upgrade (may run before connect). */
    bootLive: () => Promise<void>;
    /** File watcher and WASM preload: only once the transport is connected (v11.2.1). */
    startBackground: () => void;
    shutdown: () => void;
}

const pinnedByEnv = decideProjectRoot(process.env.NREKI_PROJECT_ROOT).kind === "apply";
let currentWorkspace: WorkspaceRuntime | null = null;
let liveTransportConnected = false;
let transportReady = false;
let clientRootDirs: string[] = [];
let switchChain: Promise<void> = Promise.resolve();
let rootsSync: Promise<void> | null = null;

async function buildWorkspaceRuntime(targetDir: string, source: WorkspaceSource): Promise<WorkspaceRuntime> {
    const root = path.resolve(targetDir);
    if (path.resolve(process.cwd()) !== root) process.chdir(root);

    const engine = new NrekiEngine({
        dbPath: path.join(root, ".nreki.db"),
        watchPaths: [root],
    });
    engine.setMetadata("nreki_session_start", new Date().toISOString());

    const monitor = new TokenMonitor();
    const sandbox = new AstSandbox();
    const circuitBreaker = new CircuitBreaker(root);
    const chronos = new ChronosMemory(root);

    let kernel: NrekiKernel | undefined;
    let nrekiMode: "syntax" | "file" | "project" | "hologram" = "syntax";

    const hasTsConfig = fs.existsSync(path.join(root, "tsconfig.json")) ||
                        fs.existsSync(path.join(root, "jsconfig.json"));
    const hasGoProject = fs.existsSync(path.join(root, "go.mod"));
    const pyMarkers = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];
    const hasPyProject = pyMarkers.some(f => fs.existsSync(path.join(root, f)));

    if (hasTsConfig || hasPyProject || hasGoProject) {
        nrekiMode = detectMode(root);
        if (nrekiMode === "syntax") {
            logger.info("SYNTAX mode. Kernel disabled. Layer 1 AST only.");
        } else {
            const envs = [
                hasTsConfig ? "TS/JS" : "",
                hasPyProject ? "Python" : "",
                hasGoProject ? "Go" : "",
            ].filter(Boolean).join(", ");
            logger.info(`${nrekiMode.toUpperCase()} mode detected (${envs}). Kernel boots on first edit.`);
            kernel = new NrekiKernel();
        }
    } else {
        logger.info(
            "No project markers found (tsconfig.json / pyproject.toml / go.mod). " +
            "Semantic verification disabled. Operating in Tree-sitter-only mode (Layer 1).",
        );
    }

    if (kernel) {
        if (hasGoProject) {
            try {
                const { GoLspSidecar } = await import("./kernel/backends/go-sidecar.js");
                kernel.registerSidecar(".go", new GoLspSidecar(root));
                logger.info("Go project detected (go.mod). gopls sidecar registered.");
            } catch (err) {
                logger.error(`Failed to load Go sidecar: ${(err as Error).message}`);
            }
        }
        if (hasPyProject) {
            try {
                const { PythonLspSidecar } = await import("./kernel/backends/python-sidecar.js");
                const pySidecar = new PythonLspSidecar(root);
                kernel.registerSidecar(".py", pySidecar);
                logger.info(`Python project detected. ${pySidecar.command[0]} sidecar registered.`);
            } catch (err) {
                logger.error(`Failed to load Python sidecar: ${(err as Error).message}`);
            }
        }
    }

    const enforcer = new CognitiveEnforcer(root);
    const deps: RouterDependencies = { engine, monitor, sandbox, circuitBreaker, kernel, chronos, nrekiMode, enforcer };
    engine.onExternalBatchChange(async files => { await kernel?.notifyExternalChange(files); });

    let nativeEdits: NativeEditServer | undefined;
    let removeSessionMarker: (() => void) | null = null;
    let closed = false;
    let backgroundStarted = false;

    const runtime: WorkspaceRuntime = {
        root,
        source,
        deps,
        liveBooted: false,
        bootLive: async () => {
            if (runtime.liveBooted || closed) return;
            runtime.liveBooted = true;

            // ─── SESSION MARKER (read by the Claude Code enforcer hook) ───
            const sessionMarker = path.join(root, ".nreki", "sessions", String(process.pid));
            try {
                if (!unsafeWriteTarget(root, sessionMarker)) {
                    const sessionsDir = path.dirname(sessionMarker);
                    if (fs.existsSync(sessionsDir)) {
                        for (const entry of fs.readdirSync(sessionsDir)) {
                            if (!/^\d+$/.test(entry)) continue;
                            const pid = Number(entry);
                            if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
                            try {
                                process.kill(pid, 0);
                            } catch (err) {
                                if ((err as NodeJS.ErrnoException).code === "ESRCH") {
                                    const stale = path.join(sessionsDir, entry);
                                    if (!unsafeWriteTarget(root, stale)) {
                                        try { fs.unlinkSync(stale); } catch { /* raced */ }
                                    }
                                }
                            }
                        }
                    }
                    if (process.env.NREKI_NATIVE_PREFLIGHT === "1") {
                        try {
                            nativeEdits = await startNativeEditServer(root, request => validateNativeEdit(request, deps));
                        } catch (ipcErr) {
                            logger.warn(`Native edit IPC server unavailable (falling back to session-only marker): ${(ipcErr as Error).message}`);
                        }
                    }
                }
                writeStateFile(root, sessionMarker, JSON.stringify({
                    startedAt: new Date().toISOString(), token: nativeEdits?.token,
                }));
                fs.chmodSync(sessionMarker, 0o600);
                removeSessionMarker = () => { try { fs.unlinkSync(sessionMarker); } catch { /* already gone */ } };
            } catch {
                try { nativeEdits?.close(); } catch { /* already closed */ }
            }

            // ─── AUTO-PATCH SECURITY HOOK (v10.x) ───
            try {
                const upgrade = upgradeEnforcerHook(root, () => fs.readFileSync(
                    new URL("../templates/hooks/nreki-enforcer.mjs", import.meta.url), "utf-8",
                ));
                if (upgrade === "upgraded") logger.info("Auto-patched legacy nreki-enforcer hook for security.");
                if (upgrade === "unsafe-path") logger.warn(".claude/hooks/nreki-enforcer.mjs is a symbolic link or leaves the project: not upgraded.");
            } catch { /* Fail silently, never block boot */ }
        },
        // v11.2.1: the watcher's first directory walk must never run before the
        // MCP handshake (Claude Code reported the silence as "connection closed:
        // EOF"), and it is not awaited: tool handlers index on first use.
        startBackground: () => {
            if (backgroundStarted || closed) return;
            backgroundStarted = true;

            const watcherReady = engine.startWatcher();
            watcherReady.then(
                () => logger.info("File watcher started (reactive mode)."),
                (err: Error) => logger.error(`File watcher failed (non-fatal): ${err.message}`),
            );

            if (nrekiMode === "hologram" && kernel) {
                setImmediate(async () => {
                    if (closed) return;
                    try {
                        await ensureHologramReady(kernel!, nrekiMode, root);
                        logger.info("WASM parser pre-loaded. JIT Holography ready.");
                    } catch (err) {
                        logger.warn(`WASM pre-load failed: ${(err as Error).message}`);
                    }
                });
            }
        },
        shutdown: () => {
            if (closed) return;
            closed = true;
            try {
                if (kernel && kernel.isBooted()) {
                    chronos.syncTechDebt(
                        kernel.getInitialErrorCount(),
                        kernel.getCurrentErrorCount(),
                    );
                }
                chronos.forcePersist();
            } catch { /* never block shutdown on telemetry */ }
            try { removeSessionMarker?.(); } catch { /* already gone */ }
            try { nativeEdits?.close(); } catch { /* already closed */ }
            try { engine.shutdown(); } catch { /* swallow */ }
            // A switched-away workspace must not keep its gopls/pyright running
            // until the process exits (their exit hooks only fire then).
            if (kernel) void kernel.shutdownSidecars().catch(() => { /* best effort */ });
        },
    };
    return runtime;
}

function switchWorkspace(targetDir: string, source: WorkspaceSource): Promise<void> {
    const next = switchChain.then(async () => {
        const resolved = path.resolve(targetDir);
        if (currentWorkspace && sameDir(currentWorkspace.root, resolved)) {
            if (liveTransportConnected && !currentWorkspace.liveBooted) {
                await currentWorkspace.bootLive();
            }
            if (transportReady) currentWorkspace.startBackground();
            return;
        }
        if (currentWorkspace) {
            currentWorkspace.shutdown();
            currentWorkspace = null;
        }
        currentWorkspace = await buildWorkspaceRuntime(resolved, source);
        if (liveTransportConnected) {
            await currentWorkspace.bootLive();
        }
        if (transportReady) currentWorkspace.startBackground();
        logger.info(`Workspace bound to ${resolved}`);
    });
    switchChain = next.catch((err) => {
        logger.error(`Workspace switch failed: ${(err as Error).message}`);
    });
    return next;
}

/**
 * The workspace a `project_root` (or a path's enclosing project) may bind, or
 * why not. Inside the current workspace: keep it. Otherwise it must be inside
 * one of the client's MCP roots; when the host chose the folder (pinned, its
 * MCP roots, or started in a project) it cannot be left; a folder named by the model is
 * never the home folder, a folder above it, a hidden folder in it or a system
 * folder (a prompt injection would otherwise point NREKI at ~/.claude or ~/.ssh).
 */
function workspaceTarget(requested: string): { dir: string; source: WorkspaceSource } | { error: string } {
    const dir = path.resolve(requested);
    if (currentWorkspace && isSameOrInside(dir, currentWorkspace.root)) {
        return { dir: currentWorkspace.root, source: currentWorkspace.source };
    }
    if (clientRootDirs.length > 0) {
        const root = clientRootDirs.find((r) => isSameOrInside(dir, r));
        if (root) return { dir: root, source: "roots" };
        return {
            error: `project_root "${dir}" is outside the workspace folders your editor shared with NREKI ` +
                `(${clientRootDirs.join(", ")}). Open that folder in your editor to work on it.`,
        };
    }
    if (currentWorkspace && currentWorkspace.source !== "guess" && currentWorkspace.source !== "explicit") {
        const chosenBy = currentWorkspace.source === "launch" ? "the project it was started in"
            : currentWorkspace.source === "env" ? "the project NREKI_PROJECT_ROOT names"
            : "the project your editor opened";
        return {
            error: `NREKI is bound to ${currentWorkspace.root}, ${chosenBy}; ` +
                `project_root "${dir}" is outside it. Open that folder in your editor to work on it.`,
        };
    }
    if (isNonProjectLaunchDir(dir)) {
        return {
            error: `project_root "${dir}" is a home, hidden or system folder, not a project. ` +
                "Pass the absolute path of the project folder.",
        };
    }
    return { dir, source: "explicit" };
}

// Boot immediately when started inside a folder that can be a project (or pinned
// by NREKI_PROJECT_ROOT). When a global host launches NREKI inside its own config
// dir (`~/.gemini/config/plugins/nreki`, `~`, `/`, etc.), defer until MCP
// roots/list or `project_root` arrives so that folder is never polluted.
if (pinnedByEnv) {
    currentWorkspace = await buildWorkspaceRuntime(process.cwd(), "env");
} else if (!isNonProjectLaunchDir(process.cwd())) {
    currentWorkspace = await buildWorkspaceRuntime(process.cwd(), hasProjectMarker(process.cwd()) ? "launch" : "guess");
}

const server = new McpServer({
    name: "NREKI",
    version: VERSION,
}, {
    instructions: 'Start tasks with nreki_navigate action:"context" query:"<task>".\n'
        + 'Use native Edit for single-file changes; use nreki_code action:"batch_edit" when changing signatures across files or renaming, including every affected caller in the same batch.\n'
        + 'batch_edit rejects new errors before writing; follow its [Validated] footer and run required tests/checkers.',
});

logger.info(
    "NREKI edit-safety MCP. Retrieval via search (BM25 + topology, optional Voyage semantic index) + fast_grep (RAM-resident). "
    + "v11.0.0 removed ONNX embeddings; v12.0.0 removed hybrid_search.",
);

// ─── Tool 1: nreki_navigate ───────────────────────────────────────────

const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const MISSING_WORKSPACE = "NREKI was started outside a workspace without MCP roots. Re-run this call with " +
    "project_root:\"<absolute workspace path>\" once to bind the active project.";

/** The dependencies of the workspace this call runs in, or why there is none. */
async function resolveWorkspaceDeps(rawArgs: Record<string, unknown>): Promise<RouterDependencies | string> {
    if (rootsSync) await rootsSync;
    await switchChain;
    if (!pinnedByEnv) {
        let requested: string | null = null;
        const explicit = optStr(rawArgs.project_root)?.trim();
        if (explicit) {
            const d = decideProjectRoot(explicit);
            if (d.kind === "apply") requested = d.dir;
        } else if (!currentWorkspace) {
            const firstEditPath = Array.isArray(rawArgs.edits) && rawArgs.edits[0] && typeof rawArgs.edits[0] === "object"
                ? optStr((rawArgs.edits[0] as Record<string, unknown>).path)
                : undefined;
            requested = inferProjectRootFromPath(optStr(rawArgs.path) ?? firstEditPath);
        }
        if (requested) {
            const target = workspaceTarget(requested);
            if ("error" in target) return target.error;
            await switchWorkspace(target.dir, target.source);
        }
    }
    return currentWorkspace?.deps ?? MISSING_WORKSPACE;
}

function workspaceError(text: string) {
    return { isError: true, content: [{ type: "text" as const, text }] };
}

server.registerTool(
    "nreki_navigate",
    {
        description:
            "Find code. context: query = the task; returns the code it names (symbols verbatim, other mentions, importers) in one call. " +
            "fast_grep: exact text -> file:line [symbol]. search: concept search. definition/references: by symbol. outline: symbols of path. " +
            "type_shape: resolved TS type. prepare_refactor: occurrences to rename. map: repo overview (large). " +
            "orphan_oracle: unreachable files. type_graph: code using type_name. Also: token_budget (context), depth, kind, project_root.",
        inputSchema: z.object({
            action: z.enum(["context", "search", "definition", "references", "outline", "map", "prepare_refactor", "orphan_oracle", "type_shape", "fast_grep", "type_graph"]),
            query: z.string().optional(),
            symbol: z.string().optional(),
            path: z.string().optional(),
            limit: z.number().optional(),
            project_root: z.string().optional(),
        }).passthrough(),
    },
    async (args) => {
        const a: Record<string, unknown> = args;
        const activeDeps = await resolveWorkspaceDeps(a);
        if (typeof activeDeps === "string") return workspaceError(activeDeps);
        const params: NavigateParams = {
            action: args.action, query: args.query, symbol: args.symbol, path: args.path, limit: args.limit,
            include_raw: optBool(a.include_raw), kind: optStr(a.kind), signatures: optBool(a.signatures),
            refresh: optBool(a.refresh), auto_context: optBool(a.auto_context), depth: optStr(a.depth),
            type_name: optStr(a.type_name), walk_depth: optNum(a.walk_depth), direction: optStr(a.direction),
            max_nodes: optNum(a.max_nodes), token_budget: optNum(a.token_budget),
        };
        return wrapWithCircuitBreaker(
            activeDeps.circuitBreaker,
            "nreki_navigate",
            args.action,
            () => handleNavigate(args.action, params, activeDeps),
            undefined, undefined, activeDeps.chronos,
        );
    },
);

// ─── Tool 2: nreki_code ───────────────────────────────────────────────

server.registerTool(
    "nreki_code",
    {
        description:
            "Read and edit code. read: whole file; with focus:\"a,b\" only those symbols (also compress focus). " +
            "edit/batch_edit: change or delete (new_code:\"\") a symbol by name; syntax and types are checked before writing, nothing is written on error. " +
            "mode patch: replace search_text with replace_text inside the symbol (cheapest). undo: revert the last edit of path. " +
            "filter_output: shrink terminal text (output). Also: compress:true or level for skeletons, project_root.",
        inputSchema: z.object({
            action: z.enum(["read", "compress", "edit", "batch_edit", "undo", "filter_output"]),
            path: z.string().optional(),
            symbol: z.string().optional(),
            focus: z.string().optional(),
            mode: z.enum(["replace", "insert_before", "insert_after", "patch"]).optional(),
            new_code: z.string().optional(),
            search_text: z.string().optional(),
            replace_text: z.string().optional(),
            edits: z.preprocess(
                (val) => (typeof val === "string" ? JSON.parse(val) : val),
                z.array(z.object({
                    path: z.string(),
                    symbol: z.string(),
                    new_code: z.string().optional(),
                    mode: z.enum(["replace", "insert_before", "insert_after", "patch"]).optional(),
                    search_text: z.string().optional(),
                    replace_text: z.string().optional(),
                }))
            ).optional(),
            output: z.string().optional(),
            project_root: z.string().optional(),
        }).passthrough(),
    },
    async (args) => {
        const a: Record<string, unknown> = args;
        const activeDeps = await resolveWorkspaceDeps(a);
        if (typeof activeDeps === "string") return workspaceError(activeDeps);
        const params: CodeParams = {
            action: args.action, path: args.path, symbol: args.symbol, focus: args.focus, mode: args.mode,
            new_code: args.new_code, search_text: args.search_text, replace_text: args.replace_text,
            edits: args.edits, output: args.output,
            compress: optBool(a.compress), level: optStr(a.level), tier: optNum(a.tier), max_lines: optNum(a.max_lines),
            auto_context: optBool(a.auto_context), compute_diff: optBool(a.compute_diff),
            _nreki_bypass: optStr(a._nreki_bypass), max_cross_file: optNum(a.max_cross_file),
        };
        return wrapWithCircuitBreaker(
            activeDeps.circuitBreaker,
            "nreki_code",
            args.action,
            () => handleCode(args.action, params, activeDeps),
            args.path ?? args.edits?.[0]?.path,
            args.symbol ?? args.edits?.[0]?.symbol,
            activeDeps.chronos,
        );
    },
);

// ─── Tool 3: nreki_guard ──────────────────────────────────────────────

server.registerTool(
    "nreki_guard",
    {
        description:
            "Session memory. pin/unpin (index): standing rules. set_plan (text = plan file). memorize (text): notes that survive context compaction. " +
            "engram (path, symbol, text): note on a symbol. status/report: token use. reset: clear the circuit breaker. audit. Also: project_root.",
        inputSchema: z.object({
            action: z.enum(["pin", "unpin", "status", "report", "reset", "set_plan", "memorize", "audit", "engram"]),
            text: z.string().optional(),
            path: z.string().optional(),
            symbol: z.string().optional(),
            index: z.number().optional(),
            project_root: z.string().optional(),
        }).passthrough(),
    },
    async (args) => {
        const a: Record<string, unknown> = args;
        const activeDeps = await resolveWorkspaceDeps(a);
        if (typeof activeDeps === "string") return workspaceError(activeDeps);
        const { action, text, index, path: guardPath, symbol } = args;
        const params: GuardParams = { action, text, index, id: optStr(a.id), path: guardPath, symbol };
        return wrapWithCircuitBreaker(
            activeDeps.circuitBreaker,
            "nreki_guard",
            action,
            () => handleGuard(action, params, activeDeps),
            undefined, undefined, activeDeps.chronos,
        );
    },
);

// ─── Server Startup ─────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    let _shuttingDown = false;

    const gracefulShutdown = () => {
        if (_shuttingDown) return;
        _shuttingDown = true;
        try { currentWorkspace?.shutdown(); } catch { /* swallow */ }
        process.exit(0);
    };

    process.on("SIGINT",  gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGHUP",  gracefulShutdown);
    process.on("exit", () => { try { currentWorkspace?.shutdown(); } catch { /* swallow */ } });

    process.stdin.on("close", gracefulShutdown);
    process.stdin.on("end",   gracefulShutdown);

    // ─── Parent Process Watchdog ────────────────────────────────────
    const initialPpid = process.ppid;
    if (initialPpid && initialPpid !== 1) {
        const PARENT_CHECK_MS = 3000;
        const parentWatchdog = setInterval(() => {
            if (_shuttingDown) {
                clearInterval(parentWatchdog);
                return;
            }
            try {
                process.kill(initialPpid, 0);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === "EPERM" || code === "EACCES") {
                    return;
                }
                clearInterval(parentWatchdog);
                gracefulShutdown();
            }
        }, PARENT_CHECK_MS);
        parentWatchdog.unref();
    }

    // The client's roots bound the workspace from now on (see workspaceTarget).
    // A root that is the home folder, above it or hidden in it is not a project.
    const syncClientRoots = async (): Promise<void> => {
        if (pinnedByEnv) return;
        if (!server.server.getClientCapabilities()?.roots) return;
        try {
            const res = await server.server.listRoots({}, { timeout: 2500 });
            clientRootDirs = pickRootsFromMcpRoots(res?.roots).filter((dir) => !isNonProjectLaunchDir(dir));
            const current = currentWorkspace;
            if (clientRootDirs.length === 0) return;
            if (current && clientRootDirs.some((r) => isSameOrInside(current.root, r))) return;
            await switchWorkspace(clientRootDirs[0], "roots");
        } catch (err) {
            logger.warn(`MCP roots/list unavailable: ${(err as Error).message}`);
        }
    };

    // Tool calls wait for a roots sync in flight (resolveWorkspaceDeps), the first
    // one and each roots/list_changed, instead of running in the old workspace.
    const trackRootsSync = (): Promise<void> => {
        const p = syncClientRoots().finally(() => {
            if (rootsSync === p) rootsSync = null;
        });
        rootsSync = p;
        return p;
    };

    server.server.oninitialized = () => {
        if (!pinnedByEnv && server.server.getClientCapabilities()?.roots) void trackRootsSync();
    };

    server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
        await trackRootsSync();
    });

    liveTransportConnected = true;
    if (currentWorkspace) {
        await currentWorkspace.bootLive();
    }

    await server.connect(transport);

    // v11.2.1: the file watcher starts only after the handshake (not awaited).
    transportReady = true;
    currentWorkspace?.startBackground();
}

// v11.2.1: defensive process-level handlers. The MCP transport speaks
// JSON-RPC over stdio, so any unhandled rejection or uncaught exception
// that escapes a tool handler would otherwise terminate the process and
// surface to Claude Code as a "connection closed: EOF" crash. We log to
// stderr (never stdout — would corrupt JSON-RPC) and keep serving.
process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logger.error(`Unhandled promise rejection (suppressed to keep MCP alive): ${detail}`);
});
process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception (suppressed to keep MCP alive): ${err.stack ?? err.message}`);
});

main().catch((err) => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
