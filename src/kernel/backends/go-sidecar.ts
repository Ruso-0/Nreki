/**
 * go-sidecar.ts — Go LSP Sidecar (gopls)
 *
 * Spawns gopls as a child process for semantic validation of Go files.
 * Boot requires `gopls` in PATH (install: go install golang.org/x/tools/gopls@latest).
 * If gopls is not found, the sidecar fails gracefully and the kernel
 * falls back to Layer 1 (AST syntax only) for Go files.
 *
 * Capabilities:
 *   - Auto-healing: gopls "Add import" quickfixes, applied by the kernel
 *     (verified against gopls v0.24: tests/lsp-real-gopls.test.ts)
 *   - TTRD: syntactic signature check only (gopls hover is imprecise for type contracts)
 *   - Diagnostics are pulled: the `pullDiagnostics` setting makes gopls
 *     advertise textDocument/diagnostic (v0.17+; older versions ignore it and
 *     the base class falls back to published diagnostics)
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import * as fs from "fs";
import * as path from "path";
import { LspSidecarBase } from "./lsp-sidecar-base.js";

export class GoLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string) {
        super(projectRoot, ["gopls", "serve"], "go");
    }

    protected override initializationOptions(): Record<string, unknown> {
        return { pullDiagnostics: true };
    }

    /**
     * A Go package is every .go file of a directory: they share one namespace
     * without importing each other, so no import graph lists them. Changing
     * `Greet` in lib.go breaks its caller in main.go, and gopls only reports
     * the documents that are open.
     */
    public override companionFiles(filePath: string): string[] {
        const self = path.resolve(filePath);
        const dir = path.dirname(self);
        const same = process.platform === "win32"
            ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
            : (a: string, b: string) => a === b;
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter(e => e.isFile() && e.name.endsWith(".go"))
                .map(e => path.join(dir, e.name))
                .filter(p => !same(p, self))
                .sort()
                .map(p => this.toPosix(p));
        } catch {
            return [];
        }
    }
}
