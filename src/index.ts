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
import { detectMode as detectModePure } from "./detect-mode.js";

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
  npx @ruso-0/nreki                       Start MCP server (default)
  npx @ruso-0/nreki init [options]        Install per-agent instructions
  npx @ruso-0/nreki deinit                Safely remove NREKI hooks before uninstall

\`init\` options:
  --agent <name>        Force agent: claude | cursor | cline | copilot | generic
                        (default: auto-detect via .claude/, .cursor/, .clinerules,
                         .github/copilot-instructions.md; falls back to generic)
  --force               Rewrite existing NREKI block (default: skip if marker present)
  --dry-run             Print plan only, no filesystem writes

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

    // 1. Clean settings.json — remove PreToolUse entries referencing nreki-enforcer
    const claudeSettingsPath = path.join(cwd, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
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

                    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2), "utf-8");
                    logger.info("Removed NREKI hooks from .claude/settings.json");
                    modified = true;
                }
            }
        } catch (err) {
            logger.error(`Failed to clean settings.json: ${(err as Error).message}`);
        }
    }

    // 2. Delete enforcer hook script
    const hookPath = path.join(cwd, ".claude", "hooks", "nreki-enforcer.mjs");
    if (fs.existsSync(hookPath)) {
        try {
            fs.unlinkSync(hookPath);
            logger.info("Deleted .claude/hooks/nreki-enforcer.mjs");
            modified = true;
        } catch (err) {
            logger.error(`Failed to delete hook script: ${(err as Error).message}`);
        }
    }

    // 3. Clean CLAUDE.md — strip only NREKI block, preserve user's own rules
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
        try {
            const content = fs.readFileSync(claudeMdPath, "utf-8").replace(/^\uFEFF/, "");
            const markerIndex = content.indexOf("# NREKI ACTIVE");
            if (markerIndex !== -1) {
                const cleanedContent = content.substring(0, markerIndex).trim();
                if (cleanedContent === "") {
                    fs.unlinkSync(claudeMdPath);
                    logger.info("Deleted empty CLAUDE.md");
                } else {
                    fs.writeFileSync(claudeMdPath, cleanedContent + "\n", "utf-8");
                    logger.info("Removed NREKI instructions from CLAUDE.md");
                }
                modified = true;
            }
        } catch (err) {
            logger.error(`Failed to clean CLAUDE.md: ${(err as Error).message}`);
        }
    }

    // 4. Clean AGENTS.md — strip only NREKI block, preserve user own rules
    const agentsMdPath = path.join(cwd, "AGENTS.md");
    if (fs.existsSync(agentsMdPath)) {
        try {
            const content = fs.readFileSync(agentsMdPath, "utf-8").replace(/^\uFEFF/, "");
            const nrekiMarker = "# Instructions for AI coding agents consuming NREKI via MCP";
            const nrekiIdx = content.indexOf(nrekiMarker);
            if (nrekiIdx !== -1) {
                let stripFrom = nrekiIdx;
                const before = content.substring(0, nrekiIdx);
                const lastH1 = before.lastIndexOf("# AGENTS.md");
                if (lastH1 !== -1 && before.substring(lastH1).trim() === "# AGENTS.md") {
                    stripFrom = lastH1;
                }
                const cleanedContent = content.substring(0, stripFrom).trim();
                if (cleanedContent === "") {
                    fs.unlinkSync(agentsMdPath);
                    logger.info("Deleted empty AGENTS.md");
                } else {
                    fs.writeFileSync(agentsMdPath, cleanedContent + "\n", "utf-8");
                    logger.info("Removed NREKI instructions from AGENTS.md");
                }
                modified = true;
            }
        } catch (err) {
            logger.error(`Failed to clean AGENTS.md: ${(err as Error).message}`);
        }
    }

    // 5. Clean SKILL.md — strip only NREKI block, preserve user own rules
    const skillMdPath = path.join(cwd, "SKILL.md");
    if (fs.existsSync(skillMdPath)) {
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

    if (modified) {
        logger.info("NREKI deinit complete. Your environment is clean.");
    } else {
        logger.info("No active NREKI configuration found. Nothing to clean.");
    }

    process.exit(0);
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
            "\nUsage: nreki init [--agent <claude|cursor|cline|copilot|generic>] [--force] [--dry-run]\n",
        );
        process.exit(2);
    }

    try {
        const result = runInit(parsed.opts);
        process.stderr.write(`nreki init: ${result.reason}\n`);
        process.stderr.write(`  agent: ${result.agent}${parsed.opts.dryRun ? " (dry-run)" : ""}\n`);
        for (const action of result.actions) {
            process.stderr.write(`  ${formatAction(action)}\n`);
        }
        if (result.agent === "generic" && !parsed.opts.agent) {
            process.stderr.write(
                "\nNo agent-specific config detected. If you use Claude Code / Cursor / Cline / Copilot,\n" +
                "re-run with --agent <name> to install the agent-specific files.\n",
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

const server = new McpServer({
    name: "NREKI",
    version: VERSION,
});

logger.info(
    "NREKI edit-safety MCP. Retrieval via search (Type Ledger) + fast_grep (RAM-resident). "
    + "v11.0.0 amputated ONNX embeddings; v12.0.0 amputated hybrid_search/BM25.",
);

// ─── Tool 1: nreki_navigate ───────────────────────────────────────────

server.tool(
    "nreki_navigate",
    "AST-powered code navigation and semantic search. Use for finding code, understanding project structure, and locating symbols.",
    {
        action: z
            .enum(["search", "definition", "references", "outline", "map", "prepare_refactor", "orphan_oracle", "type_shape", "fast_grep", "type_graph"])
            .describe(
                "search: Type Ledger semantic + keyword fallback across codebase (single retriever). " +
                "definition: go-to-definition by symbol name. " +
                "references: find all usages of a symbol. " +
                "outline: list all symbols in a file. " +
                "map: full repo structure map with pinned rules. " +
                "prepare_refactor: analyze a symbol for safe renaming (classifies each occurrence as high-confidence or needs-review). " +
                "orphan_oracle: identify files with zero static reachability (candidates for dead code review). " +
                "type_shape: invoke TS compiler for exact resolved type shape without reading file (requires TypeScript project with tsconfig.json). " +
                "fast_grep: ultra-fast exact substring match returning AST-aware topological coordinates (replaces native grep). Best for finding hardcoded strings or exact syntax. " +
                "type_graph: walk the Type Ledger graph from a seed type (chunks that consume/produce it). Pure semantic walker. Requires type_name param.",
            ),
        query: z
            .string()
            .optional()
            .describe("For search and fast_grep: the query string."),
        symbol: z
            .string()
            .optional()
            .describe("For definition/references: the symbol name."),
        path: z
            .string()
            .optional()
            .describe("For outline: the file path."),
        limit: z
            .number()
            .optional()
            .describe("For search: max results to return (1-50, default 10)."),
        include_raw: z
            .boolean()
            .optional()
            .describe("For search: include full source code in results."),
        kind: z
            .string()
            .optional()
            .describe("For definition: filter by symbol kind (function, class, interface, etc.)."),
        signatures: z
            .boolean()
            .optional()
            .describe("For outline: if true, show full signatures for ALL symbols including [LOW]. Default false — LOW-risk symbols without engrams are collapsed into a name-only list."),
        refresh: z
            .boolean()
            .optional()
            .describe("For map: force regeneration, ignoring cache."),
        auto_context: z
            .boolean()
            .optional()
            .describe("Auto-inject signatures of imported dependencies. Set to false for pure output without context."),
        depth: z
            .enum(["skeleton", "full"])
            .optional()
            .describe("For map: 'skeleton' (default) shows only CORE/BRIDGE files with top exports. 'full' shows all files with topology metrics."),
        type_name: z
            .string()
            .optional()
            .describe("For type_graph: the seed type name to walk from (case-sensitive, must exist in Type Ledger)."),
        walk_depth: z
            .number()
            .optional()
            .describe("For type_graph: BFS depth, 1 (default) or 2 (max). K=1 returns chunks directly related to seed_type; K=2 expands one more hop via their other types."),
        direction: z
            .enum(["bidirectional", "consumers", "producers"])
            .optional()
            .describe("For type_graph: 'bidirectional' (default) returns both consumers and producers; 'consumers' only chunks that consume seed_type; 'producers' only chunks that produce it."),
        max_nodes: z
            .number()
            .optional()
            .describe("For type_graph: BFS hard cap, default 50, max 100. Anti-hub ordering applied before truncation."),
        token_budget: z
            .number()
            .optional()
            .describe("For type_graph: Knapsack rendering budget in estimated tokens, default 3000. Chunks beyond budget listed as shorthand-only overflow."),
    },
    async ({ action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh, auto_context, depth, type_name, walk_depth, direction, max_nodes, token_budget }) => {
        const params: NavigateParams = { action, query, symbol, path: navPath, limit, include_raw, kind, signatures, refresh, auto_context, depth, type_name, walk_depth, direction, max_nodes, token_budget };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_navigate",
            action,
            () => handleNavigate(action, params, deps),
            undefined, undefined, chronos,
        );
    },
);

// ─── Tool 2: nreki_code ───────────────────────────────────────────────

server.tool(
    "nreki_code",
    "Read, compress, and surgically edit code files. " +
    "All edits are automatically validated via AST before writing to disk - " +
    "if syntax is invalid, the edit is blocked and you get the exact error. " +
    "Undo reverts the last edit. filter_output strips noisy terminal output.",
    {
        action: z
            .enum(["read", "compress", "edit", "batch_edit", "undo", "filter_output"])
            .describe(
                "read: read file with optional compression. " +
                "compress: compress file/directory with full control. " +
                "edit: surgically edit a function/class by name (auto-validated). " +
                "batch_edit: atomically edit multiple symbols across multiple files (all-or-nothing). " +
                "undo: revert last edit. " +
                "filter_output: filter noisy terminal output (strips ANSI, deduplicates errors). Does NOT execute commands.",
            ),
        path: z
            .string()
            .optional()
            .describe("File or directory path (required for read, compress, edit, undo)."),
        symbol: z
            .string()
            .optional()
            .describe("For edit: the function/class/interface name to replace."),
        new_code: z
            .string()
            .optional()
            .describe("For edit: the complete replacement source code for the symbol."),
        compress: z
            .boolean()
            .optional()
            .describe("For read: enable auto-compression (default true)."),
        level: z
            .string()
            .optional()
            .describe("Compression level: 'light', 'medium', or 'aggressive'."),
        focus: z
            .string()
            .optional()
            .describe("For compress: focus query to rank chunks by relevance."),
        tier: z
            .number()
            .optional()
            .describe("For compress: legacy tier (1-3)."),
        output: z
            .string()
            .optional()
            .describe("For filter_output: the terminal output text to filter."),
        max_lines: z
            .number()
            .optional()
            .describe("For filter_output: max output lines (1-1000, default 100)."),
        mode: z
            .enum(["replace", "insert_before", "insert_after", "patch"])
            .optional()
            .describe(
                "CRITICAL: Use 'patch' for minor edits (<30% of the symbol body) with search_text/replace_text to minimize output tokens. " +
                "Use 'replace' ONLY for major structural rewrites. 'insert_before'/'insert_after' add code adjacent to the symbol."
            ),
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
        )
            .optional()
            .describe("For batch_edit: array of edits to apply atomically. Each edit specifies path, symbol, new_code, and optional mode."),
        auto_context: z
            .boolean()
            .optional()
            .describe("Auto-inject signatures of imported dependencies. Set to false for pure output without context."),
        compute_diff: z
            .boolean()
            .optional()
            .describe("Compute spectral topology diff (Fiedler value, circuit rank). Adds ~50-200ms latency for structural batches."),
        search_text: z
            .string()
            .optional()
            .describe("REQUIRED for mode:'patch'. The EXACT existing string to replace inside the symbol. Must include exact original indentation and be unique within the symbol."),
        replace_text: z
            .string()
            .optional()
            .describe("REQUIRED for mode:'patch'. The new string to insert. Must match original indentation style."),
        _nreki_bypass: z
            .string()
            .optional()
            .describe("INTERNAL SYSTEM STATE TOKEN. DO NOT USE. Triggers context penalties."),
        walk_depth: z
            .number()
            .optional()
            .describe("For compress: Phase 4 cross-file Type Ledger walk depth. Furia round 12 spec: K=1 ESTRICTO, max=1 (K=2 RECHAZADO). Default 1."),
        max_cross_file: z
            .number()
            .optional()
            .describe("For compress: Phase 4 hard cap on UNIQUE cross-file chunks injected via Type Ledger parafovea. Default 10, max 50, set to 0 to disable cross-file injection."),
    },
    async ({ action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines, mode, edits, auto_context, compute_diff, search_text, replace_text, _nreki_bypass, walk_depth, max_cross_file }) => {
        const params: CodeParams = { action, path: filePath, symbol, new_code, compress, level, focus, tier, output, max_lines, mode, edits, auto_context, compute_diff, search_text, replace_text, _nreki_bypass, walk_depth, max_cross_file };
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "nreki_code",
            action,
            () => handleCode(action, params, deps),
            filePath,
            symbol,
            chronos,
        );
    },
);

// ─── Tool 3: nreki_guard ──────────────────────────────────────────────

server.tool(
    "nreki_guard",
    "Safety controls, session monitoring, and persistent memory. " +
    "Pin rules that persist across messages, check token burn rate, " +
    "and get session reports.",
    {
        action: z
            .enum(["pin", "unpin", "status", "report", "reset", "set_plan", "memorize", "audit", "engram"])
            .describe(
                "pin: add a persistent rule (injected into every map response). " +
                "unpin: remove a pinned rule. " +
                "status: token burn rate and alerts. " +
                "report: full session savings receipt. " +
                "reset: clear circuit breaker state to resume editing. " +
                "set_plan: anchor a master plan file to prevent Claude from forgetting it during context compaction. " +
                "memorize: write your current progress/thoughts to NREKI's active memory. " +
                "audit: run AHI (Automated Hardening Index) audit on the project. " +
                "engram: save a long-term memory note about a symbol. Auto-appears in future outlines. Auto-deletes if code changes.",
            ),
        text: z
            .string()
            .optional()
            .describe("For pin: the rule text (max 200 chars). For set_plan: the file path to your plan. For memorize: your thoughts/progress to remember. For engram: the insight to save."),
        index: z
            .number()
            .optional()
            .describe("For unpin: the pin number to remove (1-based, as shown in map output)."),
        id: z
            .string()
            .optional()
            .describe("For unpin: the pin id to remove."),
        path: z
            .string()
            .optional()
            .describe("For engram: the file path containing the symbol."),
        symbol: z
            .string()
            .optional()
            .describe("For engram: the exact symbol name to anchor the memory to."),
    },
    async ({ action, text, index, id, path: guardPath, symbol }) => {
        const params: GuardParams = { action, text, index, id, path: guardPath, symbol };
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

    // Graceful shutdown 100% SÍNCRONO.
    // Async en shutdown path = riesgo de zombie atascado en event loop.
    // El verdadero GC es process.exit(0) — el SO mata in-flight
    // requests instantáneo (post v11.0.0 amputación: ya sin ONNX).
    let _shuttingDown = false;

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

    // ─── AUTO-PATCH SECURITY HOOK (v10.x) ───
    // v11.3.0: enforcer template now lives at templates/hooks/nreki-enforcer.mjs
    // (read at runtime) instead of being inlined as a TS string literal.
    try {
        const hookScriptPath = path.join(process.cwd(), ".claude", "hooks", "nreki-enforcer.mjs");
        if (fs.existsSync(hookScriptPath)) {
            const currentHook = fs.readFileSync(hookScriptPath, "utf-8");
            if (!currentHook.includes("cwdPosix")) {
                const upstreamHook = fs.readFileSync(
                    new URL("../templates/hooks/nreki-enforcer.mjs", import.meta.url),
                    "utf-8",
                );
                fs.writeFileSync(hookScriptPath, upstreamHook, "utf-8");
                logger.info("Auto-patched legacy nreki-enforcer hook for security.");
            }
        }
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
                const Parser = (await import("web-tree-sitter")).default;
                await Parser.init();
                const jitParser = new Parser();
                const wasmDir = path.join(
                    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
                    "..", "wasm",
                );
                const tsLangPath = path.join(wasmDir, "tree-sitter-typescript.wasm").replace(/\\/g, "/");
                const tsLanguage = await Parser.Language.load(tsLangPath);
                jitParser.setLanguage(tsLanguage);
                const { classifyAndGenerateShadow } = await import("./hologram/shadow-generator.js");
                kernel!.setJitParser(jitParser, tsLanguage);
                kernel!.setJitClassifier(classifyAndGenerateShadow);
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
