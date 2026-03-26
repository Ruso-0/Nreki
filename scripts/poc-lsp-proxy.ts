/**
 * NREKI LSP Proxy PoC — Go Type Validation via gopls in RAM
 *
 * Demonstrates NREKI intercepting a type error in Go code
 * WITHOUT touching disk. Uses LSP protocol (JSON-RPC over stdio)
 * to make gopls validate edits in its internal VFS.
 *
 * Flow:
 *   1. Spawn gopls as child process (stdio)
 *   2. initialize handshake
 *   3. didOpen: virtual Go file with valid code
 *   4. Wait for clean diagnostics (baseline)
 *   5. didChange: inject AI edit with type error
 *   6. Wait for error diagnostics (post-edit)
 *   7. Compare Δ(P,E) — if new errors > 0, REJECT
 *   8. didClose + shutdown
 *
 * Zero Disk Touch. The Go file never exists on the filesystem.
 *
 * Usage: npx tsx scripts/poc-lsp-proxy.ts
 * Requires: gopls installed (go install golang.org/x/tools/gopls@latest)
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0) + Claude Opus 4.6
 */

import { spawn, ChildProcess } from 'child_process';

// ─── JSON-RPC over stdio (LSP Transport Layer) ────────────────────

class LspClient {
    private proc: ChildProcess;
    private buffer = '';
    private contentLength = -1;
    private requestId = 0;
    private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private notificationHandlers = new Map<string, (params: any) => void>();

    constructor(command: string, args: string[] = []) {
        this.proc = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf-8')));
        this.proc.stderr!.on('data', (chunk: Buffer) => {
            // gopls logs to stderr — silent unless debugging
            const msg = chunk.toString('utf-8').trim();
            if (msg && process.env.LSP_DEBUG) console.error(`[gopls stderr] ${msg}`);
        });

        this.proc.on('exit', (code) => {
            for (const [, pending] of this.pendingRequests) {
                pending.reject(new Error(`LSP server exited with code ${code}`));
            }
        });
    }

    // Parse "Content-Length: N\r\n\r\n{json}" framing
    private onData(text: string): void {
        this.buffer += text;

        while (true) {
            if (this.contentLength === -1) {
                const headerEnd = this.buffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;

                const header = this.buffer.slice(0, headerEnd);
                const match = header.match(/Content-Length:\s*(\d+)/i);
                if (!match) {
                    // Skip malformed header
                    this.buffer = this.buffer.slice(headerEnd + 4);
                    continue;
                }

                this.contentLength = parseInt(match[1], 10);
                this.buffer = this.buffer.slice(headerEnd + 4);
            }

            if (Buffer.byteLength(this.buffer, 'utf-8') < this.contentLength) return;

            // Extract exactly contentLength bytes
            const bodyBytes = Buffer.from(this.buffer, 'utf-8').slice(0, this.contentLength);
            const body = bodyBytes.toString('utf-8');
            this.buffer = Buffer.from(this.buffer, 'utf-8').slice(this.contentLength).toString('utf-8');
            this.contentLength = -1;

            try {
                const msg = JSON.parse(body);
                this.dispatch(msg);
            } catch {
                console.error('[LSP] Failed to parse JSON:', body.slice(0, 200));
            }
        }
    }

    private dispatch(msg: any): void {
        if ('id' in msg && 'result' in msg || 'id' in msg && 'error' in msg) {
            // Response to a request
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                if (msg.error) pending.reject(new Error(`LSP error: ${JSON.stringify(msg.error)}`));
                else pending.resolve(msg.result);
            }
        } else if ('method' in msg && !('id' in msg)) {
            // Notification from server
            const handler = this.notificationHandlers.get(msg.method);
            if (handler) handler(msg.params);
        }
    }

    private send(payload: any): void {
        const body = JSON.stringify(payload);
        const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
        this.proc.stdin!.write(header + body);
    }

    // Send a request (expects response)
    request(method: string, params: any): Promise<any> {
        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    // Send a notification (no response expected)
    notify(method: string, params: any): void {
        this.send({ jsonrpc: '2.0', method, params });
    }

    // Register handler for server notifications
    onNotification(method: string, handler: (params: any) => void): void {
        this.notificationHandlers.set(method, handler);
    }

    // Wait for a specific notification to arrive
    waitForNotification(method: string, timeoutMs: number = 10000): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.notificationHandlers.delete(method);
                reject(new Error(`Timeout waiting for ${method} (${timeoutMs}ms)`));
            }, timeoutMs);

            this.onNotification(method, (params) => {
                clearTimeout(timer);
                resolve(params);
            });
        });
    }

    // Collect ALL diagnostics for a given URI (gopls may send multiple batches)
    collectDiagnostics(uri: string, settleMs: number = 2000): Promise<any[]> {
        return new Promise((resolve) => {
            let diagnostics: any[] = [];
            let settleTimer: NodeJS.Timeout;

            const resetTimer = () => {
                if (settleTimer) clearTimeout(settleTimer);
                settleTimer = setTimeout(() => {
                    this.notificationHandlers.delete('textDocument/publishDiagnostics');
                    resolve(diagnostics);
                }, settleMs);
            };

            this.onNotification('textDocument/publishDiagnostics', (params) => {
                if (params.uri === uri) {
                    diagnostics = params.diagnostics || [];
                    resetTimer();
                }
            });

            resetTimer();
        });
    }

    async shutdown(): Promise<void> {
        try {
            await this.request('shutdown', null);
            this.notify('exit', null);
        } catch {
            // Force kill if graceful shutdown fails
        }
        this.proc.kill('SIGTERM');
    }
}

// ─── LSP Diagnostic Types ─────────────────────────────────────────

interface LspDiagnostic {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
    message: string;
    source?: string;
}

// ─── The PoC ──────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  NREKI LSP Proxy PoC — Go Type Validation via gopls     ║');
    console.log('║  Zero Disk Touch. Deterministic. No LLM-as-Judge.       ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log();

    // ── Step 0: Check gopls is installed ──
    try {
        const { execSync } = await import('child_process');
        execSync('gopls version', { stdio: 'pipe' });
    } catch {
        console.error('ERROR: gopls not found. Install with:');
        console.error('  go install golang.org/x/tools/gopls@latest');
        process.exit(1);
    }

    const t0 = performance.now();

    // ── Step 0.5: Create minimal workspace scaffold ──
    // gopls reads go.mod from DISK during module initialization, not from
    // didOpen documents. We create a real temp dir with ONLY go.mod (30 bytes).
    // The .go source files remain 100% virtual via didOpen — never touch disk.
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nreki-lsp-'));
    const goModPath = path.join(tmpDir, 'go.mod');
    fs.writeFileSync(goModPath, 'module nreki-virtual\n\ngo 1.22\n');
    console.log(`[0.5/7] Workspace scaffold: ${tmpDir} (go.mod only, 30 bytes)`);

    // Convert to file URI (Windows: file:///C:/... , Linux: file:///tmp/...)
    const toFileUri = (p: string) => {
        const normalized = p.replace(/\\/g, '/');
        return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
    };
    const workspaceUri = toFileUri(tmpDir);

    // ── Step 1: Spawn gopls ──
    console.log('[1/7] Spawning gopls...');
    const lsp = new LspClient('gopls', ['serve']);

    // ── Step 2: Initialize handshake ──
    console.log('[2/7] LSP initialize handshake...');
    const initResult = await lsp.request('initialize', {
        processId: process.pid,
        rootUri: workspaceUri,
        capabilities: {
            textDocument: {
                publishDiagnostics: {
                    relatedInformation: true,
                },
                synchronization: {
                    dynamicRegistration: false,
                    didSave: false,
                    willSave: false,
                    willSaveWaitUntil: false,
                },
            },
            workspace: {
                workspaceFolders: true,
            },
        },
        workspaceFolders: [
            { uri: workspaceUri, name: 'nreki-virtual' },
        ],
    });
    lsp.notify('initialized', {});
    console.log(`       Server: ${initResult.serverInfo?.name ?? 'gopls'} ${initResult.serverInfo?.version ?? ''}`);

    // ── Virtual Go file URIs (inside the real workspace, but files don't exist on disk) ──
    const mainUri = `${workspaceUri}/main.go`;
    const mathUri = `${workspaceUri}/math.go`;

    // ── Step 3: Open virtual Go files ──
    console.log('[3/7] Opening virtual Go files (source code in RAM only)...');

    // File 1: math.go — exports a function with a strict signature
    const mathGoValid = [
        'package main',
        '',
        '// Add takes two integers and returns their sum.',
        'func Add(a int, b int) int {',
        '    return a + b',
        '}',
    ].join('\n');

    // File 2: main.go — calls Add correctly
    const mainGoValid = [
        'package main',
        '',
        'import "fmt"',
        '',
        'func main() {',
        '    result := Add(1, 2)',
        '    fmt.Println(result)',
        '}',
    ].join('\n');

    // didOpen both files — gopls builds the cross-file graph in memory
    // Order matters: math.go first so Add() is known when main.go loads
    lsp.notify('textDocument/didOpen', {
        textDocument: { uri: mathUri, languageId: 'go', version: 1, text: mathGoValid },
    });
    lsp.notify('textDocument/didOpen', {
        textDocument: { uri: mainUri, languageId: 'go', version: 1, text: mainGoValid },
    });

    // ── Step 4: Collect baseline diagnostics ──
    console.log('[4/7] Collecting baseline diagnostics...');
    const baselineDiags = await lsp.collectDiagnostics(mainUri, 3000);
    const baselineErrors = baselineDiags.filter((d: LspDiagnostic) => d.severity === 1);
    console.log(`       Baseline: ${baselineErrors.length} errors, ${baselineDiags.length} total diagnostics`);

    // ── Step 5: AI edit — inject type error via didChange ──
    console.log('[5/7] Injecting AI edit with type error (didChange)...');

    // The "AI" changes main.go: calls Add("hello", 2) instead of Add(1, 2)
    // This is a cross-file type error: math.go says Add(int, int),
    // but the edit passes a string.
    const mainGoBroken = [
        'package main',
        '',
        'import "fmt"',
        '',
        'func main() {',
        '    result := Add("hello", 2)  // TYPE ERROR: string != int',
        '    fmt.Println(result)',
        '}',
    ].join('\n');

    lsp.notify('textDocument/didChange', {
        textDocument: { uri: mainUri, version: 2 },
        contentChanges: [{ text: mainGoBroken }],
    });

    // ── Step 6: Collect post-edit diagnostics ──
    console.log('[6/7] Collecting post-edit diagnostics...');
    const postDiags = await lsp.collectDiagnostics(mainUri, 3000);
    const postErrors = postDiags.filter((d: LspDiagnostic) => d.severity === 1);

    // ── Step 7: Δ(P,E) Verdict ──
    const delta = postErrors.length - baselineErrors.length;
    const latency = (performance.now() - t0).toFixed(2);

    console.log('[7/7] Computing Δ(P,E)...');
    console.log();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  NREKI LSP PROXY — INTERCEPT RESULT');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log();
    console.log(`  Language:        Go`);
    console.log(`  LSP Server:      gopls`);
    console.log(`  Disk Touch:      go.mod scaffold only (30 bytes, deleted after)`);
    console.log(`  Source on Disk:   0 .go files (100% virtual via didOpen)`);
    console.log(`  Baseline Errors: ${baselineErrors.length}`);
    console.log(`  Post-Edit Errors: ${postErrors.length}`);
    console.log(`  Δ(P,E):          ${delta > 0 ? '+' : ''}${delta}`);
    console.log(`  Latency:         ${latency}ms`);
    console.log();

    if (delta > 0) {
        console.log('  ╔═══════════════════════════════════════════════════════╗');
        console.log('  ║  VERDICT: REJECTED — Type error detected in RAM      ║');
        console.log('  ║  verdict(P,E) = SAFE ⟹ |Δ(P,E)| = 0               ║');
        console.log('  ║  |Δ(P,E)| = ' + delta + ' > 0 → EDIT BLOCKED                    ║');
        console.log('  ╚═══════════════════════════════════════════════════════╝');
        console.log();
        console.log('  Errors detected:');
        for (const diag of postErrors) {
            const d = diag as LspDiagnostic;
            console.log(`    → L${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.message}`);
        }
    } else {
        console.log('  ╔═══════════════════════════════════════════════════════╗');
        console.log('  ║  VERDICT: APPROVED — No new errors                   ║');
        console.log('  ╚═══════════════════════════════════════════════════════╝');
    }

    console.log();
    console.log('  "No adivinamos si el código funciona;');
    console.log('   garantizamos matemáticamente que la entropía');
    console.log('   de errores no aumenta." — NREKI Manifesto');
    console.log();
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // ── Cleanup ──
    lsp.notify('textDocument/didClose', { textDocument: { uri: mainUri } });
    lsp.notify('textDocument/didClose', { textDocument: { uri: mathUri } });
    await lsp.shutdown();

    // Remove temp workspace scaffold
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    console.log('  Temp workspace cleaned up. Zero trace on disk.');
    console.log();

    process.exit(delta > 0 ? 2 : 0);
}

main().catch((err) => {
    console.error(`[FATAL] ${err.message}`);
    process.exit(1);
});
