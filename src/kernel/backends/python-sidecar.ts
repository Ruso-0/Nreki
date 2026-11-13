/**
 * python-sidecar.ts — Python LSP Sidecar (basedpyright / pyright fallback)
 *
 * Spawns a Python LSP server as a child process for semantic validation.
 * PREFERS basedpyright-langserver (exposes auto-import codeActions via
 * standard LSP — unlocks full auto-healing). Falls back to pyright-
 * langserver if basedpyright is not installed (validation only, no healing).
 *
 * Capabilities:
 *   - supportsAutoHealing: true when basedpyright is active, false otherwise
 *   - supportsTTRD: false (both servers return imprecise hover for type contracts)
 *   - Diagnostics are pulled: pyright registers textDocument/diagnostic
 *     dynamically and then stops publishing (verified against pyright 1.1.414:
 *     tests/lsp-real-pyright.test.ts; basedpyright not verified)
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { LspSidecarBase } from "./lsp-sidecar-base.js";
import { logger } from "../../utils/logger.js";
import { resolveExecutable } from "../../utils/safe-exec.js";

/**
 * Is basedpyright-langserver installed in a TRUSTED PATH entry?
 *
 * NREKI-SEC-03: this used to run `spawnSync("basedpyright --version",
 * { shell: true })` at MCP server start-up — no cwd, no env filter. On
 * Windows cmd.exe searches the current directory (the repository) first, so
 * a cloned repo shipping `basedpyright.cmd` got code execution with the full
 * process.env (API keys, tokens) before the user did anything. Resolving the
 * binary from PATH ourselves executes nothing.
 */
function isBasedPyrightAvailable(projectRoot: string): boolean {
    return resolveExecutable("basedpyright-langserver", { projectRoot }) !== null;
}

export class PythonLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string) {
        const isBased = isBasedPyrightAvailable(projectRoot);
        const cmd = isBased
            ? ["basedpyright-langserver", "--stdio"]
            : ["pyright-langserver", "--stdio"];

        super(projectRoot, cmd, "python");

        if (!isBased) {
            logger.warn(
                "basedpyright not found. Falling back to pyright (Python Auto-Healing disabled — validation only). " +
                "Install basedpyright for full healing: npm install -g basedpyright"
            );
        }
    }
}
