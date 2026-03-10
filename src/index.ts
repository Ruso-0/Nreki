#!/usr/bin/env node

/**
 * index.ts — TokenGuard v3.0 MCP Server entry point.
 *
 * Exposes 3 router tools to Claude Code (replaces 16 individual tools):
 *
 *   1. tg_navigate — AST-powered code navigation and semantic search
 *   2. tg_code     — Read, compress, and surgically edit code files
 *   3. tg_guard    — Safety controls, session monitoring, and persistent memory
 *
 * Middleware (runs automatically, not exposed as tools):
 *   - AST Validation: validates code before disk writes (inside tg_code edit)
 *   - Circuit Breaker: detects and stops infinite failure loops
 *
 * All processing is local. Zero cloud dependencies.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";

import { TokenGuardEngine } from "./engine.js";
import { TokenMonitor } from "./monitor.js";
import { AstSandbox } from "./ast-sandbox.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
    handleNavigate,
    handleCode,
    handleGuard,
    type RouterDependencies,
} from "./router.js";
import { wrapWithCircuitBreaker } from "./middleware/circuit-breaker.js";

// ─── CLI Flag Parsing ───────────────────────────────────────────────

const args = process.argv.slice(2);
const enableEmbeddings = args.includes("--enable-embeddings");

// ─── Initialization ─────────────────────────────────────────────────

const engine = new TokenGuardEngine({
    dbPath: path.join(process.cwd(), ".tokenguard.db"),
    watchPaths: [process.cwd()],
    enableEmbeddings,
});

const monitor = new TokenMonitor();
const sandbox = new AstSandbox();
const circuitBreaker = new CircuitBreaker();

const deps: RouterDependencies = { engine, monitor, sandbox, circuitBreaker };

const server = new McpServer({
    name: "TokenGuard",
    version: "3.0.0",
});

if (!enableEmbeddings) {
    console.error(
        "[TokenGuard] Running in Lite mode (BM25 keyword search only). " +
        "Run with --enable-embeddings for semantic search.",
    );
}

// ─── Tool 1: tg_navigate ───────────────────────────────────────────

server.tool(
    "tg_navigate",
    "AST-powered code navigation and semantic search. Use for finding code, understanding project structure, and locating symbols.",
    {
        action: z
            .enum(["search", "definition", "references", "outline", "map"])
            .describe(
                "search: hybrid semantic+keyword search across codebase. " +
                "definition: go-to-definition by symbol name. " +
                "references: find all usages of a symbol. " +
                "outline: list all symbols in a file. " +
                "map: full repo structure map with pinned rules.",
            ),
        target: z
            .string()
            .optional()
            .describe(
                "For search: the query string. " +
                "For definition/references: the symbol name. " +
                "For outline: the file path. " +
                "For map: optional — leave empty for full map.",
            ),
        options: z
            .record(z.unknown())
            .optional()
            .describe(
                "Optional parameters. " +
                "For search: {limit?: number, include_raw?: boolean}. " +
                "For definition: {kind?: string}. " +
                "For outline: {signatures?: boolean}. " +
                "For map: {refresh?: boolean}.",
            ),
    },
    async ({ action, target, options }) => {
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "tg_navigate",
            action,
            () => handleNavigate(action, target, options as Record<string, unknown> | undefined, deps),
        );
    },
);

// ─── Tool 2: tg_code ───────────────────────────────────────────────

server.tool(
    "tg_code",
    "Read, compress, and surgically edit code files. " +
    "All edits are automatically validated via AST before writing to disk — " +
    "if syntax is invalid, the edit is blocked and you get the exact error. " +
    "Undo reverts the last edit.",
    {
        action: z
            .enum(["read", "compress", "edit", "undo", "terminal"])
            .describe(
                "read: read file with optional compression. " +
                "compress: compress file/directory with full control. " +
                "edit: surgically edit a function/class by name (auto-validated). " +
                "undo: revert last edit. " +
                "terminal: filter noisy terminal output.",
            ),
        path: z
            .string()
            .optional()
            .describe("File or directory path."),
        options: z
            .record(z.unknown())
            .optional()
            .describe(
                "For read: {compress?: boolean, level?: 'light'|'medium'|'aggressive'}. " +
                "For compress: {level?: string, focus?: string, tier?: number}. " +
                "For edit: {symbol: string, new_code: string}. " +
                "For terminal: {command: string, output: string, max_lines?: number}.",
            ),
    },
    async ({ action, path: filePath, options }) => {
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "tg_code",
            action,
            () => handleCode(action, filePath, options as Record<string, unknown> | undefined, deps),
            filePath,
        );
    },
);

// ─── Tool 3: tg_guard ──────────────────────────────────────────────

server.tool(
    "tg_guard",
    "Safety controls, session monitoring, and persistent memory. " +
    "Pin rules that persist across messages, check token burn rate, " +
    "and get session reports.",
    {
        action: z
            .enum(["pin", "unpin", "status", "report"])
            .describe(
                "pin: add a persistent rule (injected into every map response). " +
                "unpin: remove a pinned rule. " +
                "status: token burn rate and alerts. " +
                "report: full session savings receipt.",
            ),
        options: z
            .record(z.unknown())
            .optional()
            .describe(
                "For pin: {text: string}. " +
                "For unpin: {index: number} or {id: string}. " +
                "For status/report: no options needed.",
            ),
    },
    async ({ action, options }) => {
        return wrapWithCircuitBreaker(
            circuitBreaker,
            "tg_guard",
            action,
            () => handleGuard(action, options as Record<string, unknown> | undefined, deps),
        );
    },
);

// ─── Server Startup ─────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();

    // Graceful shutdown
    process.on("SIGINT", () => {
        engine.shutdown();
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        engine.shutdown();
        process.exit(0);
    });

    // Connect and serve
    await server.connect(transport);

    // Engine initialization is lazy — each tool calls engine.initialize()
    // (fast: db + parser) or engine.initializeEmbedder() (full: + ONNX model)
    // as needed. This keeps the MCP handshake under 100ms.
}

main().catch((err) => {
    console.error(`[TokenGuard] Fatal error: ${err.message}`);
    process.exit(1);
});
