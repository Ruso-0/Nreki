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
import { z } from "zod";
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
  npx nreki init [options]                Install NREKI in this project: instructions for
                                          each agent + its MCP server registration
  npx nreki deinit                        Safely remove NREKI hooks and MCP registrations
  npx nreki trust-db                      Review and restore quarantined engrams/notes/pins
                                          (interactive terminal only)

\`init\` options:
  --agent <names>       Agents to install for, comma-separated:
                        claude | codex | antigravity | cursor | cline | copilot | generic
                        (default: every agent configured in this project; without any,
                         every agent installed on this computer; else generic AGENTS.md)
  --voyage              Turn on Voyage semantic search in the registrations
                        (this project's code is sent to Voyage once to be indexed)
  --no-voyage           Turn it off again
  --no-prompt           Do not show the Voyage key box (it only appears in an
                        interactive terminal; the key is saved in ~/.nreki/voyage.key)
  --no-mcp              Write the instructions only, do not register the MCP server
  --force               Rewrite existing NREKI blocks and replace a "nreki" MCP entry
                        NREKI did not write
  --dry-run             Print plan only, no filesystem writes

Environment:
  NREKI_PROJECT_ROOT    Absolute path of the project folder, for MCP hosts that start
                        servers in another folder (set by \`init\` for Cursor and VS Code)

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

// ─── Init Subcommand ────────────────────────────────────────────────

if (args[0] === "init") {
    // v11.3.0: agent-aware init. Detects Claude Code / Cursor / Cline /
    // Copilot via filesystem signals and only writes the files that
    // agent actually reads. --agent overrides detection, --force
    // rewrites existing NREKI blocks, --dry-run previews the plan.
    const { parseInitArgs, runInit, formatAction } = await import("./init/init-runner.js");
    const parsed = parseInitArgs(args.slice(1));
    if (parsed.error) {
        process.stderr.write(`nreki init: ${parsed.error}\n`);
        process.stderr.write(
            "\nUsage: nreki init [--agent <claude,codex,antigravity,cursor,cline,copilot,generic>]" +
            " [--voyage|--no-voyage] [--no-prompt] [--no-mcp] [--force] [--dry-run]\n",
        );
        process.exit(2);
    }

    try {
        // The Voyage box: only in an interactive terminal (an agent running init
        // must never get a window it cannot answer), and only when it matters.
        const opts = parsed.opts;
        const voyageLines: string[] = [];
        const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI;
        if (interactive && opts.prompt !== false && !opts.dryRun && opts.mcp !== false && opts.voyage !== false) {
            const { availableVoyageKey } = await import("./utils/voyage-key.js");
            if (!(opts.voyage === true && availableVoyageKey() !== null)) {
                const { promptForVoyage } = await import("./init/voyage-prompt.js");
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

// ─── Initialization ─────────────────────────────────────────────────

const engine = new NrekiEngine({
    dbPath: path.join(process.cwd(), ".nreki.db"),
    watchPaths: [process.cwd()],
});

// Track session start so pressure is per-session, not historical.
engine.setMetadata("nreki_session_start", new Date().toISOString());

const monitor = new TokenMonitor();
const sandbox = new AstSandbox();
const circuitBreaker = new CircuitBreaker();
const chronos = new ChronosMemory(process.cwd());

// ─── NREKI Kernel & Sidecars (Multi-Language Auto-Detect) ──────────
let kernel: NrekiKernel | undefined;
let nrekiMode: "syntax" | "file" | "project" | "hologram" = "syntax";

const cwd = process.cwd();
const hasTsConfig = fs.existsSync(path.join(cwd, "tsconfig.json")) ||
                    fs.existsSync(path.join(cwd, "jsconfig.json"));
const hasGoProject = fs.existsSync(path.join(cwd, "go.mod"));
const pyMarkers = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];
const hasPyProject = pyMarkers.some(f => fs.existsSync(path.join(cwd, f)));

if (hasTsConfig || hasPyProject || hasGoProject) {
    nrekiMode = detectMode(cwd);

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
        "Semantic verification disabled. Operating in Tree-sitter-only mode (Layer 1)."
    );
}

// ─── LSP Sidecars (auto-detect Go and Python projects) ──────────
// Keep awaited sequential imports — prevents race condition where
// first edit arrives before sidecar is registered.
if (kernel) {
    if (hasGoProject) {
        try {
            const { GoLspSidecar } = await import("./kernel/backends/go-sidecar.js");
            kernel.registerSidecar(".go", new GoLspSidecar(cwd));
            logger.info("Go project detected (go.mod). gopls sidecar registered.");
        } catch (err) {
            logger.error(`Failed to load Go sidecar: ${(err as Error).message}`);
        }
    }

    if (hasPyProject) {
        try {
            const { PythonLspSidecar } = await import("./kernel/backends/python-sidecar.js");
            const pySidecar = new PythonLspSidecar(cwd);
            kernel.registerSidecar(".py", pySidecar);
            logger.info(`Python project detected. ${pySidecar.command[0]} sidecar registered.`);
        } catch (err) {
            logger.error(`Failed to load Python sidecar: ${(err as Error).message}`);
        }
    }
}

const enforcer = new CognitiveEnforcer(process.cwd());
const deps: RouterDependencies = { engine, monitor, sandbox, circuitBreaker, kernel, chronos, nrekiMode, enforcer };
engine.onExternalBatchChange(async files => { await kernel?.notifyExternalChange(files); });

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

// Tool definitions are paid on EVERY model request (Claude Code) or printed by
// the agent to learn the calls (Codex code mode: ~1k tokens each time in the
// 2026-11-13 A/B). Only everyday parameters are declared; the advanced ones are
// still accepted (passthrough), validated by the handlers, and named in the
// descriptions. Usage guidance lives in AGENTS.md/CLAUDE.md.
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

server.registerTool(
    "nreki_navigate",
    {
        description:
            "Find code. context: query = the task; returns the code it names (symbols verbatim, other mentions, importers) in one call. " +
            "fast_grep: exact text -> file:line [symbol]. search: concept search. definition/references: by symbol. outline: symbols of path. " +
            "type_shape: resolved TS type. prepare_refactor: occurrences to rename. map: repo overview (large). " +
            "orphan_oracle: unreachable files. type_graph: code using type_name. Also: token_budget (context), depth, kind.",
        inputSchema: z.object({
            action: z.enum(["context", "search", "definition", "references", "outline", "map", "prepare_refactor", "orphan_oracle", "type_shape", "fast_grep", "type_graph"]),
            query: z.string().optional(),
            symbol: z.string().optional(),
            path: z.string().optional(),
            limit: z.number().optional(),
        }).passthrough(),
    },
    async (args) => {
        const a: Record<string, unknown> = args;
        const params: NavigateParams = {
            action: args.action, query: args.query, symbol: args.symbol, path: args.path, limit: args.limit,
            include_raw: optBool(a.include_raw), kind: optStr(a.kind), signatures: optBool(a.signatures),
            refresh: optBool(a.refresh), auto_context: optBool(a.auto_context), depth: optStr(a.depth),
            type_name: optStr(a.type_name), walk_depth: optNum(a.walk_depth), direction: optStr(a.direction),
            max_nodes: optNum(a.max_nodes), token_budget: optNum(a.token_budget),
        };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_navigate",
            args.action,
            () => handleNavigate(args.action, params, deps),
            undefined, undefined, chronos,
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
            "filter_output: shrink terminal text (output). Also: compress:true or level for skeletons.",
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
        }).passthrough(),
    },
    async (args) => {
        const a: Record<string, unknown> = args;
        const params: CodeParams = {
            action: args.action, path: args.path, symbol: args.symbol, focus: args.focus, mode: args.mode,
            new_code: args.new_code, search_text: args.search_text, replace_text: args.replace_text,
            edits: args.edits, output: args.output,
            compress: optBool(a.compress), level: optStr(a.level), tier: optNum(a.tier), max_lines: optNum(a.max_lines),
            auto_context: optBool(a.auto_context), compute_diff: optBool(a.compute_diff),
            _nreki_bypass: optStr(a._nreki_bypass), max_cross_file: optNum(a.max_cross_file),
        };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_code",
            args.action,
            () => handleCode(args.action, params, deps),
            // batch_edit names its targets in edits: without them the breaker told
            // the agent to rewrite "the failing symbol" in "the current file".
            args.path ?? args.edits?.[0]?.path,
            args.symbol ?? args.edits?.[0]?.symbol,
            chronos,
        );
    },
);

// ─── Tool 3: nreki_guard ──────────────────────────────────────────────

server.registerTool(
    "nreki_guard",
    {
        description:
            "Session memory. pin/unpin (index): standing rules. set_plan (text = plan file). memorize (text): notes that survive context compaction. " +
            "engram (path, symbol, text): note on a symbol. status/report: token use. reset: clear the circuit breaker. audit.",
        inputSchema: z.object({
            action: z.enum(["pin", "unpin", "status", "report", "reset", "set_plan", "memorize", "audit", "engram"]),
            text: z.string().optional(),
            path: z.string().optional(),
            symbol: z.string().optional(),
            index: z.number().optional(),
        }).passthrough(),
    },
    async (args) => {
        const a: Record<string, unknown> = args;
        const { action, text, index, path: guardPath, symbol } = args;
        const params: GuardParams = { action, text, index, id: optStr(a.id), path: guardPath, symbol };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_guard",
            action,
            () => handleGuard(action, params, deps),
            undefined, undefined, chronos,
        );
    },
);

// ─── Server Startup ─────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    let nativeEdits: NativeEditServer | undefined;

    // Graceful shutdown 100% SÍNCRONO.
    // Async en shutdown path = riesgo de zombie atascado en event loop.
    // El verdadero GC es process.exit(0) — el SO mata in-flight
    // requests instantáneo (post v11.0.0 amputación: ya sin ONNX).
    let _shuttingDown = false;
    // Set once the session marker is written (below). The marker announces the
    // native-edit endpoint, so it is removed BEFORE the endpoint closes: a reader
    // never finds a marker pointing at a closed endpoint, and "endpoint gone"
    // implies "marker gone" (the built-server test raced on slow CI runners).
    let removeSessionMarker: (() => void) | null = null;

    const gracefulShutdown = () => {
        if (_shuttingDown) return;
        _shuttingDown = true;

        try {
            if (kernel && kernel.isBooted()) {
                chronos.syncTechDebt(
                    kernel.getInitialErrorCount(),
                    kernel.getCurrentErrorCount(),
                );
            }
            chronos.forcePersist();  // sync, ~2-5ms, dentro de ventana de gracia del SO
        } catch { /* never block shutdown on telemetry */ }

        try { removeSessionMarker?.(); } catch { /* already gone */ }
        try { nativeEdits?.close(); } catch { /* already closed */ }
        try { engine.shutdown(); } catch { /* swallow */ }

        process.exit(0);
    };

    process.on("SIGINT",  gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGHUP",  gracefulShutdown);  // higiene POSIX

    // Bala de plata multiplataforma: detecta orfandad cuando padre
    // cierra terminal en Windows (donde SIGHUP no llega). stdin es
    // EventEmitter — múltiples listeners sin colisión con SDK.
    process.stdin.on("close", gracefulShutdown);
    process.stdin.on("end",   gracefulShutdown);

    // ─── Parent Process Watchdog ────────────────────────────────────
    // Fallback final cuando los signals/events del SO fallan en
    // X-close de Windows o SIGKILL abrupto del cliente MCP.
    // Verificado empíricamente: process.stdin EOF y SIGHUP NO se
    // disparan al cerrar consola PowerShell con X (PID 16696
    // sobrevivió al test manual). Polling activo del ppid es el
    // único mecanismo confiable cross-platform.
    const initialPpid = process.ppid;
    if (initialPpid && initialPpid !== 1) {
        const PARENT_CHECK_MS = 3000;
        const parentWatchdog = setInterval(() => {
            if (_shuttingDown) {
                clearInterval(parentWatchdog);
                return;
            }
            try {
                // kill(0) verifica existencia sin enviar señal de terminación.
                process.kill(initialPpid, 0);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                // EPERM/EACCES: padre VIVO pero SO/AV deniega inspección.
                // NO disparar shutdown — falso positivo letal.
                if (code === "EPERM" || code === "EACCES") {
                    return;
                }
                // ESRCH (No such process) o cualquier otro: padre muerto.
                clearInterval(parentWatchdog);
                gracefulShutdown();
            }
        }, PARENT_CHECK_MS);

        // Vital: permite que el event loop termine si MCP cierra limpio.
        // Sin unref(), el setInterval mantiene NREKI vivo eternamente
        // bloqueando el shutdown ordenado del cliente.
        parentWatchdog.unref();
    }

    // ─── SESSION MARKER (read by the Claude Code enforcer hook) ───
    // The hook only steers native reads while a NREKI server is alive for this
    // project; without a live marker it fails open (NREKI-SEC-04).
    const sessionMarker = path.join(process.cwd(), ".nreki", "sessions", String(process.pid));
    try {
        // Never through a `.nreki` link shipped with the repository (writeStateFile).
        // No TCP port: a project-scoped pipe/socket with a fresh session secret.
        if (!unsafeWriteTarget(cwd, sessionMarker)) {
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
                            if (!unsafeWriteTarget(cwd, stale)) {
                                try { fs.unlinkSync(stale); } catch { /* raced */ }
                            }
                        }
                    }
                }
            }
            if (process.env.NREKI_NATIVE_PREFLIGHT === "1") {
                try {
                    nativeEdits = await startNativeEditServer(cwd, request => validateNativeEdit(request, deps));
                } catch (ipcErr) {
                    logger.warn(`Native edit IPC server unavailable (falling back to session-only marker): ${(ipcErr as Error).message}`);
                }
            }
        }
        writeStateFile(cwd, sessionMarker, JSON.stringify({
            startedAt: new Date().toISOString(), token: nativeEdits?.token,
        }));
        fs.chmodSync(sessionMarker, 0o600);
        removeSessionMarker = () => { try { fs.unlinkSync(sessionMarker); } catch { /* already gone */ } };
        process.on("exit", () => {
            removeSessionMarker?.();
            try { nativeEdits?.close(); } catch { /* already closed */ }
        });
    } catch {
        try { nativeEdits?.close(); } catch { /* already closed */ }
        // Read-only checkout or linked .nreki: retain the hook's legacy fail-open behavior.
    }

    // ─── AUTO-PATCH SECURITY HOOK (v10.x) ───
    // v11.3.0: enforcer template now lives at templates/hooks/nreki-enforcer.mjs
    // (read at runtime) instead of being inlined as a TS string literal.
    // v12.1.0: also upgrade the unmodified v1 enforcer (MultiEdit bypass, symlinks,
    // hard block when NREKI is down) and the unreleased v2 (blocked edits and
    // partial reads, costing turns) to v3. Hooks the user customized are left alone.
    // Only a stock NREKI hook, never through a symbolic link (see hook-upgrade.ts).
    try {
        const upgrade = upgradeEnforcerHook(process.cwd(), () => fs.readFileSync(
            new URL("../templates/hooks/nreki-enforcer.mjs", import.meta.url), "utf-8",
        ));
        if (upgrade === "upgraded") logger.info("Auto-patched legacy nreki-enforcer hook for security.");
        if (upgrade === "unsafe-path") logger.warn(".claude/hooks/nreki-enforcer.mjs is a symbolic link or leaves the project: not upgraded.");
    } catch { /* Fail silently, never block boot */ }

    // Connect and serve
    await server.connect(transport);

    // v11.2.1: do NOT block server startup on the file watcher's initial
    // scan. chokidar's ready event waits for the directory walk to settle,
    // which on real projects with heavy non-ignored trees can take tens of
    // seconds — during which the MCP transport is alive but the watcher
    // CPU work prevents tool handlers from making forward progress, and
    // Claude Code surfaces the silence as "connection closed: EOF". The
    // watcher is for reactive re-indexing; tool handlers call
    // engine.indexDirectory() directly on first use and do not depend on
    // it being ready.
    if (engine) {
        const watcherReady = engine.startWatcher();
        watcherReady.then(
            () => logger.info("File watcher started (reactive mode)."),
            (err: Error) => logger.error(`File watcher failed (non-fatal): ${err.message}`),
        );
    }

    // Engine initialization is lazy - each tool calls engine.initialize()
    // (db + parser). v11.0.0: single init path post-embeddings amputation.
    // This keeps the MCP handshake under 100ms.

    // JIT Holography: pre-load WASM parser (~50ms) without scanning project
    if (nrekiMode === "hologram" && kernel) {
        setImmediate(async () => {
            try {
                await ensureHologramReady(kernel!, nrekiMode, cwd);
                logger.info("WASM parser pre-loaded. JIT Holography ready.");
            } catch (err) {
                logger.warn(`WASM pre-load failed: ${(err as Error).message}`);
            }
        });
    }
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
