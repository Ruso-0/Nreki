import { describe, it, expect, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";
import { LspSidecarBase } from "../src/kernel/backends/lsp-sidecar-base.js";

// ─── Paths ──────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockServerPath = path.resolve(__dirname, "mock-lsp-server.ts");
const tsxCli = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

// ─── MockLspSidecar ─────────────────────────────────────────────────

class MockLspSidecar extends LspSidecarBase {
    /** Every request sent to the server, in order. */
    public readonly sent: string[] = [];

    constructor(projectRoot: string, scenario: string, env: Record<string, string> = {}) {
        super(
            projectRoot,
            [process.execPath, tsxCli, mockServerPath],
            "mock",
            { MOCK_LSP_SCENARIO: scenario, ...env },
        );
    }

    /** Read the protected capability flag through the subclass. */
    public hasPullDiagnostics(): boolean {
        return this.supportsPullDiagnostics;
    }

    protected override request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
        this.sent.push(method);
        return super.request(method, params, timeoutMs);
    }

    /** A raw request to the mock server (test hooks). */
    public ask(method: string): Promise<unknown> {
        return this.request(method, null);
    }
}

// ─── Helpers ────────────────────────────────────────────────────────

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "nreki-sidecar-test-"));
}

function cleanupDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("LspSidecarBase (mock LSP server)", () => {
    let sidecar: MockLspSidecar | undefined;
    let tmpDir: string;

    afterEach(async () => {
        if (sidecar) {
            try { await sidecar.shutdown(); } catch { /* already dead */ }
            sidecar = undefined;
        }
        if (tmpDir) cleanupDir(tmpDir);
    });

    // ─── Test 1: boot + shutdown lifecycle ──────────────────────────

    it("boot + shutdown lifecycle", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "clean");
        await sidecar.boot();

        expect(sidecar.isHealthy()).toBe(true);
        expect(sidecar.isDead).toBe(false);

        await sidecar.shutdown();

        expect(sidecar.isHealthy()).toBe(false);
        expect(sidecar.isDead).toBe(true);
        sidecar = undefined; // already shut down
    });

    // ─── Test 2: validateEdits returns errors for missing import ────

    it("validateEdits returns errors for missing import", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "missing_import");
        await sidecar.boot();

        const testFile = path.join(tmpDir, "test.py");
        const errors = await sidecar.validateEdits([
            { filePath: testFile, content: "json.loads(x)" },
        ]);

        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain("import");
    });

    // ─── Test 3: validateEdits returns empty for clean code ─────────

    it("validateEdits returns empty for clean code", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "clean");
        await sidecar.boot();

        const testFile = path.join(tmpDir, "test.py");
        const errors = await sidecar.validateEdits([
            { filePath: testFile, content: "x = 1" },
        ]);

        expect(errors.length).toBe(0);
    });

    // ─── Test 4: requestCodeActions returns safe fix ────────────────

    it("requestCodeActions returns safe fix", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "missing_import");
        await sidecar.boot();

        const testFile = path.join(tmpDir, "test.py");
        // Open the file first so LSP knows about it
        await sidecar.validateEdits([
            { filePath: testFile, content: "json.loads(x)" },
        ]);

        const fixes = await sidecar.requestCodeActions(testFile, {
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 10 },
            },
            message: "Module 'os' is not imported",
            code: "import-error",
            source: "mock",
        });

        expect(fixes.length).toBe(1);
        expect(fixes[0].title).toContain("import");
        // Patch 5 (v10.5.9): return shape is LspCodeAction[] — TextEdits live
        // under .edits[] so the kernel can apply the full action atomically.
        expect(fixes[0].edits.length).toBeGreaterThanOrEqual(1);
        expect(fixes[0].edits[0].newText).toContain("import os");
    });

    // ─── Test 5: requestCodeActions returns destructive fix ─────────

    it("requestCodeActions returns destructive fix", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "destructive");
        await sidecar.boot();

        const testFile = path.join(tmpDir, "test.py");
        await sidecar.validateEdits([
            { filePath: testFile, content: "x = 1\n\ndef unused():\n    pass\n" },
        ]);

        const fixes = await sidecar.requestCodeActions(testFile, {
            range: {
                start: { line: 2, character: 0 },
                end: { line: 4, character: 1 },
            },
            message: "Function 'unused' is defined but never used",
            source: "mock",
        });

        expect(fixes.length).toBe(1);
        expect(fixes[0].title.toLowerCase()).toContain("remove");
    });

    // ─── Test 6: pull diagnostics works when supported ──────────────

    it("pull diagnostics works when supported", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "missing_import");
        await sidecar.boot();

        // Mock server always returns diagnosticProvider in capabilities
        expect(sidecar.hasPullDiagnostics()).toBe(true);

        const testFile = path.join(tmpDir, "test.py");
        const errors = await sidecar.validateEdits([
            { filePath: testFile, content: "json.loads(x)" },
        ]);

        // Pull mode: deterministic, no settle timer
        expect(errors.length).toBe(1);
        expect(errors[0].message).toContain("import");
    });

    // ─── Test 7: JSON-RPC handles concatenated messages ─────────────

    it("JSON-RPC handles concatenated messages in single TCP chunk", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "multi_error");
        await sidecar.boot();

        // The mock server sends the first textDocument/diagnostic response
        // concatenated with a window/logMessage notification in a single
        // stdout.write(). If the parser can't handle concatenated frames,
        // this will hang (timeout) or return wrong results.

        const testFile = path.join(tmpDir, "test.py");
        const errors = await sidecar.validateEdits([
            { filePath: testFile, content: "json.loads(x)\nbad syntax" },
        ]);

        // multi_error scenario: 2 severity=1 diagnostics
        expect(errors.length).toBe(2);
        expect(errors[0].message).toContain("import");
        expect(errors[1].message).toContain("Unexpected token");
    });

    // ─── Requests FROM the server, and how diagnostics are delivered ────

    it("answers a request from the server and never takes it for the response to its own (same id)", async () => {
        tmpDir = createTempDir();
        // After each change the mock sends workspace/diagnostic/refresh carrying
        // the id of the pull the client is about to wait on.
        sidecar = new MockLspSidecar(tmpDir, "unfixable", { MOCK_LSP_SERVER_REQUESTS: "1" });
        await sidecar.boot();
        const testFile = path.join(tmpDir, "test.py");

        // Mistaken for the response, the server's request resolved the pull with
        // `undefined`: zero diagnostics, the edit passed.
        expect(await sidecar.validateEdits([{ filePath: testFile, content: "x" }])).toHaveLength(1);
        expect(await sidecar.validateEdits([{ filePath: testFile, content: "y" }])).toHaveLength(1);
        expect(await sidecar.ask("mock/clientReplies")).toBe(2); // both were answered
    });

    it("pulls from a server that answers textDocument/diagnostic without advertising it", async () => {
        tmpDir = createTempDir();
        // Like gopls without its setting, or pyright: no diagnosticProvider in
        // `initialize`, nothing published, but a pull is answered.
        sidecar = new MockLspSidecar(tmpDir, "unfixable", { MOCK_LSP_UNADVERTISED_PULL: "1" });
        await sidecar.boot();
        expect(sidecar.hasPullDiagnostics()).toBe(false);

        const errors = await sidecar.validateEdits([{ filePath: path.join(tmpDir, "test.py"), content: "x" }]);
        expect(errors).toHaveLength(1);
        expect(sidecar.hasPullDiagnostics()).toBe(true);
    });

    it("falls back to published diagnostics when the server refuses the pull, and stops asking", async () => {
        tmpDir = createTempDir();
        sidecar = new MockLspSidecar(tmpDir, "unfixable", { MOCK_LSP_PUSH: "1" });
        await sidecar.boot();
        const testFile = path.join(tmpDir, "test.py");
        const pulls = () => sidecar!.sent.filter(m => m === "textDocument/diagnostic").length;

        expect(await sidecar.validateEdits([{ filePath: testFile, content: "x" }])).toHaveLength(1);
        expect(sidecar.hasPullDiagnostics()).toBe(false);
        expect(pulls()).toBe(1); // the refused attempt

        expect(await sidecar.validateEdits([{ filePath: testFile, content: "y" }])).toHaveLength(1);
        expect(pulls()).toBe(1); // not asked again
    });
});
