/**
 * ts-corsa-sidecar.ts — TypeScript Corsa Backend (tsgo via LSP)
 *
 * PLACEHOLDER for Microsoft's Project Corsa (TypeScript 7.0).
 * Corsa rewrites the TypeScript compiler in Go with a native LSP server.
 * When Corsa ships, this backend replaces TypeScriptStradaBackend
 * via hot-swap — the kernel doesn't change a single line.
 *
 * The Strangler Fig pattern makes this possible:
 *   v7.x: TypeScriptStradaBackend (ts.createProgram in-process)
 *   v8.x: TypeScriptCorsaBackend (tsgo via JSON-RPC, out-of-process)
 *
 * Expected command: ["tsgo", "--lsp"] or ["typescript-language-server", "--stdio"]
 * Boot: spawns tsgo as child process
 * Validate: textDocument/diagnostic (pull model, deterministic)
 * Auto-heal: textDocument/codeAction (same as Go/Python sidecars)
 *
 * Status: WAITING FOR MICROSOFT TO SHIP CORSA
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { LspSidecarBase } from "./lsp-sidecar-base.js";

export class TypeScriptCorsaBackend extends LspSidecarBase {
    constructor(projectRoot: string) {
        // "tsgo" is the expected binary name for Project Corsa.
        // Falls back gracefully if not installed (isDead = true).
        super(projectRoot, ["tsgo", "--lsp"], "typescript");
    }
}
