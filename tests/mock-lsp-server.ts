#!/usr/bin/env node
/**
 * mock-lsp-server.ts — Minimal LSP Server for Sidecar Tests
 *
 * A JSON-RPC 2.0 server that speaks LSP over stdin/stdout.
 * Responds to initialize, textDocument/diagnostic, textDocument/codeAction, etc.
 * Behavior controlled via MOCK_LSP_SCENARIO env var.
 *
 * Scenarios:
 *   missing_import — 1 error diagnostic + "Add import 'os'" code action
 *   clean          — 0 diagnostics
 *   unfixable      — 1 error diagnostic, no code action
 *   destructive    — 1 code action with title "Remove unused function"
 *   multi_error    — 2 diagnostics: 1 fixable + 1 unfixable
 *   slow_response  — same as missing_import but 500ms delay on diagnostics
 */

const scenario = process.env.MOCK_LSP_SCENARIO || "clean";

// ─── In-Memory File Store ──────────────────────────────────────────

const files = new Map<string, string>();

// ─── Scenario-Based Diagnostics ────────────────────────────────────

interface Diagnostic {
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity: number;
    code?: string;
    source?: string;
    message: string;
}

function getDiagnostics(uri: string): Diagnostic[] {
    switch (scenario) {
        case "missing_import":
            return [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                severity: 1,
                code: "import-error",
                source: "mock",
                message: "Module 'os' is not imported",
            }];
        case "unfixable":
            return [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                severity: 1,
                code: "syntax-error",
                source: "mock",
                message: "Unexpected token",
            }];
        case "destructive":
            return [{
                range: { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } },
                severity: 2,
                source: "mock",
                message: "Function 'unused' is defined but never used",
            }];
        case "multi_error":
            return [
                {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                    severity: 1,
                    code: "import-error",
                    source: "mock",
                    message: "Module 'os' is not imported",
                },
                {
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
                    severity: 1,
                    code: "syntax-error",
                    source: "mock",
                    message: "Unexpected token in expression",
                },
            ];
        case "slow_response":
            return [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                severity: 1,
                code: "import-error",
                source: "mock",
                message: "Module 'os' is not imported",
            }];
        case "clean":
        default:
            return [];
    }
}

function getCodeActions(uri: string, diagnostics: Diagnostic[]): any[] {
    switch (scenario) {
        case "missing_import":
            return [{
                title: "Add import 'os'",
                kind: "quickfix",
                edit: {
                    changes: {
                        [uri]: [{
                            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                            newText: "import os\n",
                        }],
                    },
                },
            }];
        case "destructive":
            return [{
                title: "Remove unused function",
                kind: "quickfix",
                edit: {
                    changes: {
                        [uri]: [{
                            range: { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } },
                            newText: "",
                        }],
                    },
                },
            }];
        case "multi_error":
            // Only the first diagnostic (import-error) has a fix
            if (diagnostics.length > 0 && diagnostics[0].code === "import-error") {
                return [{
                    title: "Add import 'os'",
                    kind: "quickfix",
                    edit: {
                        changes: {
                            [uri]: [{
                                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                                newText: "import os\n",
                            }],
                        },
                    },
                }];
            }
            return [];
        case "unfixable":
        case "clean":
        default:
            return [];
    }
}

// ─── JSON-RPC 2.0 Framing ─────────────────────────────────────────

function sendMessage(msg: object): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    process.stdout.write(header + body);
}

function sendResponse(id: number, result: unknown): void {
    sendMessage({ jsonrpc: "2.0", id, result });
}

function sendConcatenated(messages: object[]): void {
    let combined = "";
    for (const msg of messages) {
        const body = JSON.stringify(msg);
        combined += `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    }
    process.stdout.write(combined);
}

// ─── Request Handlers ──────────────────────────────────────────────

let concatTestDone = false;

function handleMessage(msg: any): void {
    // Request (has id)
    if (typeof msg.id === "number") {
        switch (msg.method) {
            case "initialize":
                sendResponse(msg.id, {
                    capabilities: {
                        textDocumentSync: 1,
                        diagnosticProvider: {
                            interFileDependencies: false,
                            workspaceDiagnostics: false,
                        },
                        codeActionProvider: true,
                    },
                });
                break;

            case "textDocument/diagnostic": {
                const uri = msg.params?.textDocument?.uri || "";
                const items = getDiagnostics(uri);
                const result = { kind: "full", items };

                if (scenario === "slow_response") {
                    setTimeout(() => sendResponse(msg.id, result), 500);
                } else if (!concatTestDone) {
                    // First diagnostic request: send response + a publishDiagnostics
                    // notification concatenated in one write to test parser robustness
                    concatTestDone = true;
                    const response = { jsonrpc: "2.0", id: msg.id, result };
                    const notification = {
                        jsonrpc: "2.0",
                        method: "window/logMessage",
                        params: { type: 3, message: "concat-test-marker" },
                    };
                    sendConcatenated([response, notification]);
                } else {
                    sendResponse(msg.id, result);
                }
                break;
            }

            case "textDocument/codeAction": {
                const uri = msg.params?.textDocument?.uri || "";
                const diagnostics = msg.params?.context?.diagnostics || [];
                sendResponse(msg.id, getCodeActions(uri, diagnostics));
                break;
            }

            case "shutdown":
                sendResponse(msg.id, null);
                break;

            default:
                // Unknown request — respond with method not found
                sendMessage({
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: { code: -32601, message: `Method not found: ${msg.method}` },
                });
                break;
        }
    }
    // Notification (no id)
    else {
        switch (msg.method) {
            case "initialized":
                // noop
                break;

            case "textDocument/didOpen": {
                const td = msg.params?.textDocument;
                if (td) files.set(td.uri, td.text);
                break;
            }

            case "textDocument/didChange": {
                const uri = msg.params?.textDocument?.uri;
                const changes = msg.params?.contentChanges;
                if (uri && changes?.length > 0) {
                    files.set(uri, changes[changes.length - 1].text);
                }
                break;
            }

            case "textDocument/didClose": {
                const uri = msg.params?.textDocument?.uri;
                if (uri) files.delete(uri);
                break;
            }

            case "exit":
                process.exit(0);
                break;
        }
    }
}

// ─── stdin JSON-RPC Frame Parser ───────────────────────────────────

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const headerStr = buffer.toString("utf-8", 0, headerEnd);
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
            buffer = buffer.subarray(headerEnd + 4);
            continue;
        }

        const bodyLen = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + bodyLen) break;

        const bodyBuf = buffer.subarray(bodyStart, bodyStart + bodyLen);
        buffer = buffer.subarray(bodyStart + bodyLen);

        try {
            const msg = JSON.parse(bodyBuf.toString("utf-8"));
            handleMessage(msg);
        } catch {
            // Malformed JSON — skip
        }
    }
});

process.stdin.on("end", () => {
    process.exit(0);
});

// Self-destruct if parent (Vitest) is killed and breaks IPC
process.stdin.on("close", () => {
    process.exit(0);
});

process.stdin.on("error", () => {
    process.exit(0);
});
