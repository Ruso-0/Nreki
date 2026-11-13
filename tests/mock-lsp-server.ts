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
 *   empty_is_error — 1 error for each open document whose text is empty, like
 *                    gopls v0.24 ("expected ';', found 'EOF'")
 *   marker_errors  — the document text decides its errors, so a test controls
 *                    what exists before and after an edit:
 *                      ERR(name)   always an error, no fix
 *                      NEEDS(name) error unless an OPEN document has DEF(name)
 *                      USES(name)  error unless the same document has
 *                                  IMPORT(name); fix: "Add import 'name'"
 */

const scenario = process.env.MOCK_LSP_SCENARIO || "clean";
// MOCK_LSP_PUSH=1: a push-only server. textDocument/diagnostic is refused
// ("method not found") and the diagnostics of every open document are
// published after each change.
const pushMode = process.env.MOCK_LSP_PUSH === "1";
// MOCK_LSP_UNADVERTISED_PULL=1: pulls are answered but `initialize` does not
// advertise them and nothing is published (gopls without its setting and
// pyright behave like this towards NREKI's handshake).
const advertisePull = !pushMode && process.env.MOCK_LSP_UNADVERTISED_PULL !== "1";
// MOCK_LSP_SERVER_REQUESTS=1: after each change the server sends the client a
// request whose id is the one the client uses for its NEXT request (both sides
// count from small integers; pyright's ids collide with the client's).
const sendsRequests = process.env.MOCK_LSP_SERVER_REQUESTS === "1";
let lastClientRequestId = 0;
let clientReplies = 0;

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
        case "marker_errors": {
            const text = files.get(uri) ?? "";
            const defined = new Set<string>();
            for (const body of files.values()) {
                for (const m of body.matchAll(/DEF\((\w+)\)/g)) defined.add(m[1]);
            }
            const out: Diagnostic[] = [];
            text.split("\n").forEach((lineText, line) => {
                for (const m of lineText.matchAll(/(ERR|NEEDS|USES)\((\w+)\)/g)) {
                    const [whole, kind, name] = m;
                    if (kind === "NEEDS" && defined.has(name)) continue;
                    if (kind === "USES" && text.includes(`IMPORT(${name})`)) continue;
                    const start = m.index ?? 0;
                    out.push({
                        range: { start: { line, character: start }, end: { line, character: start + whole.length } },
                        severity: 1,
                        source: "mock",
                        message: kind === "ERR" ? `mock error ${name}`
                            : kind === "NEEDS" ? `mock undefined ${name}`
                            : `mock unimported ${name}`,
                    });
                }
            });
            return out;
        }
        case "empty_is_error":
            return (files.get(uri) ?? "").trim() === ""
                ? [{
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    severity: 1,
                    source: "mock",
                    message: "expected ';', found 'EOF'",
                }]
                : [];
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
        case "marker_errors": {
            const m = /^mock unimported (\w+)$/.exec(diagnostics[0]?.message ?? "");
            return m
                ? [{
                    title: `Add import '${m[1]}'`,
                    kind: "quickfix",
                    edit: {
                        changes: {
                            [uri]: [{
                                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                                newText: `IMPORT(${m[1]})\n`,
                            }],
                        },
                    },
                }]
                : [];
        }
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

/** Push mode only: publish the diagnostics of every open document. */
function publishAll(): void {
    if (!pushMode) return;
    for (const uri of files.keys()) {
        sendMessage({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri, diagnostics: getDiagnostics(uri) },
        });
    }
}

/** MOCK_LSP_SERVER_REQUESTS only: a server → client request with a colliding id. */
function requestRefresh(): void {
    if (!sendsRequests) return;
    sendMessage({ jsonrpc: "2.0", id: lastClientRequestId + 1, method: "workspace/diagnostic/refresh" });
}

// ─── Request Handlers ──────────────────────────────────────────────

let concatTestDone = false;

function handleMessage(msg: any): void {
    // The client's answer to one of OUR requests (an id, no method).
    if (msg.method === undefined) {
        clientReplies++;
        return;
    }
    // Request (has id)
    if (typeof msg.id === "number") {
        lastClientRequestId = msg.id;
        switch (msg.method) {
            case "initialize":
                sendResponse(msg.id, {
                    capabilities: {
                        textDocumentSync: 1,
                        ...(advertisePull ? {
                            diagnosticProvider: {
                                interFileDependencies: false,
                                workspaceDiagnostics: false,
                            },
                        } : {}),
                        codeActionProvider: true,
                    },
                });
                break;

            // Test hook: how many of the server's requests the client answered.
            case "mock/clientReplies":
                sendResponse(msg.id, clientReplies);
                break;

            case "textDocument/diagnostic": {
                if (pushMode) {
                    sendMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unhandled method textDocument/diagnostic" } });
                    break;
                }
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
                publishAll();
                requestRefresh();
                break;
            }

            case "textDocument/didChange": {
                const uri = msg.params?.textDocument?.uri;
                const changes = msg.params?.contentChanges;
                if (uri && changes?.length > 0) {
                    files.set(uri, changes[changes.length - 1].text);
                }
                publishAll();
                requestRefresh();
                break;
            }

            case "textDocument/didClose": {
                const uri = msg.params?.textDocument?.uri;
                if (uri) files.delete(uri);
                // Real servers clear the diagnostics of a closed document.
                if (pushMode && uri) {
                    sendMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
                }
                publishAll();
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
