/**
 * NREKI LSP Proxy v2 — Design A (Jherson's version + go.mod fix)
 * 
 * 60 lines of core logic. Zero bloat.
 * Validates Go type errors in RAM via gopls.
 *
 * Usage: npx tsx scripts/poc-lsp-proxy-v2.ts
 * Requires: gopls (go install golang.org/x/tools/gopls@latest)
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

class LspProxy {
    private proc;
    private buffer = '';
    private msgId = 1;
    private resolvers = new Map<number, (v: any) => void>();
    private diagnostics = new Map<string, any[]>();

    constructor() {
        this.proc = spawn('gopls', ['serve'], { env: process.env });
        this.proc.stdout!.on('data', (data: Buffer) => {
            this.buffer += data.toString();
            this.processBuffer();
        });
    }

    private processBuffer() {
        while (true) {
            const match = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
            if (!match) break;
            const len = parseInt(match[1], 10);
            const start = match.index! + match[0].length;
            if (this.buffer.length < start + len) break;

            const msg = JSON.parse(this.buffer.substring(start, start + len));
            this.buffer = this.buffer.substring(start + len);

            if (msg.id !== undefined && this.resolvers.has(msg.id)) {
                this.resolvers.get(msg.id)!(msg.result);
                this.resolvers.delete(msg.id);
            } else if (msg.method === 'textDocument/publishDiagnostics') {
                this.diagnostics.set(msg.params.uri, msg.params.diagnostics);
            }
        }
    }

    async send(method: string, params: any) {
        const id = this.msgId++;
        const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        const payload = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
        this.proc.stdin!.write(payload);
        return new Promise(resolve => this.resolvers.set(id, resolve));
    }

    notify(method: string, params: any) {
        const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
        const payload = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`;
        this.proc.stdin!.write(payload);
    }

    getDiagnostics(uri: string) {
        return this.diagnostics.get(uri) || [];
    }

    async collectDiagnostics(waitTimeMs = 2000) {
        await new Promise(r => setTimeout(r, waitTimeMs));
    }

    kill() { this.proc.kill(); }
}

// ─── File URI helper (Windows: file:///C:/... , Linux: file:///tmp/...) ───
function toFileUri(p: string): string {
    const normalized = p.replace(/\\/g, '/');
    return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

async function runPoC() {
    const t0 = performance.now();
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║  NREKI LSP Proxy v2 — Go Type Validation via gopls      ║");
    console.log("║  Design A: Zero Source on Disk. Deterministic.           ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");

    // ── Workspace scaffold: go.mod on disk (30 bytes), .go files in RAM ──
    const tmpDir = mkdtempSync(join(tmpdir(), 'nreki-lsp-'));
    writeFileSync(join(tmpDir, 'go.mod'), 'module nreki-virtual\n\ngo 1.22\n');
    const workspaceUri = toFileUri(tmpDir);
    console.log(`[0] Workspace: ${tmpDir} (go.mod only, 30 bytes)`);

    const lsp = new LspProxy();

    await lsp.send('initialize', {
        processId: process.pid,
        rootUri: workspaceUri,
        capabilities: {
            textDocument: {
                publishDiagnostics: { relatedInformation: true },
                synchronization: { dynamicRegistration: false },
            },
        },
        workspaceFolders: [{ uri: workspaceUri, name: 'nreki-virtual' }],
    });
    lsp.notify('initialized', {});

    // 1. OPEN VIRTUAL FILES IN RAM (cross-file resolution, zero disk)
    console.log("[1/4] Injecting virtual files into gopls RAM...");
    lsp.notify('textDocument/didOpen', {
        textDocument: {
            uri: `${workspaceUri}/math.go`, languageId: 'go', version: 1,
            text: "package main\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n"
        }
    });

    const mainUri = `${workspaceUri}/main.go`;
    lsp.notify('textDocument/didOpen', {
        textDocument: {
            uri: mainUri, languageId: 'go', version: 1,
            text: "package main\n\nfunc main() {\n\tAdd(1, 2)\n}\n"
        }
    });

    // 2. BASELINE
    console.log("[2/4] Waiting for gopls cross-file semantic analysis...");
    await lsp.collectDiagnostics();
    const baselineErrors = lsp.getDiagnostics(mainUri).filter((d: any) => d.severity === 1).length;
    console.log(`      Baseline Errors: ${baselineErrors}`);

    // 3. AI EDIT — inject type error
    console.log("[3/4] AI proposes edit: Add(1, 2) → Add(\"hello\", 2)");
    lsp.notify('textDocument/didChange', {
        textDocument: { uri: mainUri, version: 2 },
        contentChanges: [{ text: "package main\n\nfunc main() {\n\tAdd(\"hello\", 2)\n}\n" }]
    });

    // 4. VERDICT
    console.log("[4/4] Computing Δ(P,E)...");
    await lsp.collectDiagnostics();
    const postDiags = lsp.getDiagnostics(mainUri);
    const postErrors = postDiags.filter((d: any) => d.severity === 1);
    const delta = postErrors.length - baselineErrors;
    const latency = (performance.now() - t0).toFixed(2);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  NREKI LSP PROXY — INTERCEPT RESULT");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    console.log(`  Language:         Go`);
    console.log(`  LSP Server:       gopls`);
    console.log(`  Source on Disk:   0 .go files (100% virtual via didOpen)`);
    console.log(`  Baseline Errors:  ${baselineErrors}`);
    console.log(`  Post-Edit Errors: ${postErrors.length}`);
    console.log(`  Δ(P,E):           ${delta > 0 ? '+' : ''}${delta}`);
    console.log(`  Latency:          ${latency}ms\n`);

    if (delta > 0) {
        console.log("  ╔═══════════════════════════════════════════════════════╗");
        console.log("  ║  VERDICT: REJECTED — Type error detected in RAM      ║");
        console.log("  ║  verdict(P,E) = SAFE ⟹ |Δ(P,E)| = 0               ║");
        console.log(`  ║  |Δ(P,E)| = ${delta} > 0 → EDIT BLOCKED                    ║`);
        console.log("  ╚═══════════════════════════════════════════════════════╝\n");
        console.log("  Errors detected:");
        for (const d of postErrors) {
            console.log(`    → L${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.message}`);
        }
    } else {
        console.log("  ╔═══════════════════════════════════════════════════════╗");
        console.log("  ║  VERDICT: APPROVED — No new errors                   ║");
        console.log("  ╚═══════════════════════════════════════════════════════╝");
    }

    console.log('\n  "No adivinamos si el código funciona;');
    console.log('   garantizamos matemáticamente que la entropía');
    console.log('   de errores no aumenta." — NREKI Manifesto\n');
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Cleanup
    lsp.kill();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log("  Temp workspace cleaned. Zero trace on disk.\n");

    process.exit(delta > 0 ? 2 : 0);
}

runPoC();
