#!/usr/bin/env node
/**
 * NREKI v5.1.0 × SICAEP — JSON-RPC Integration Test Script
 * Tests 3 unified MCP tools against d:\SICAEP\sicaep-panel
 *
 * MCP SDK uses newline-delimited JSON (NDJSON), NOT Content-Length framing.
 *
 * Usage: node scripts/test-sicaep-integration.mjs
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NREKI_ROOT = path.resolve(__dirname, "..");
const SICAEP_ROOT = "d:\\SICAEP\\sicaep-panel";
const RESULTS_FILE = path.join(NREKI_ROOT, "test-results-sicaep.json");

// ─── Colors ─────────────────────────────────────────────────────────
const C = {
    reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m",
    yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", dim: "\x1b[2m",
};

// ─── MCP Client (NDJSON over stdio) ─────────────────────────────────
class McpTestClient {
    constructor() {
        this.proc = null;
        this.buffer = "";
        this.requestId = 0;
        this.pending = new Map();
    }

    async start() {
        return new Promise((resolve, reject) => {
            this.proc = spawn("node", [path.join(NREKI_ROOT, "dist", "index.js")], {
                cwd: SICAEP_ROOT,
                env: { ...process.env, PROJECT_ROOT: SICAEP_ROOT },
                stdio: ["pipe", "pipe", "pipe"],
            });

            this.proc.stderr.on("data", () => { }); // suppress stderr

            this.proc.stdout.on("data", (data) => {
                this.buffer += data.toString("utf-8");
                this._processBuffer();
            });

            this.proc.on("error", (err) => reject(err));
            this.proc.on("exit", (code) => {
                for (const [, { reject: r }] of this.pending) {
                    r(new Error(`Process exited with code ${code}`));
                }
                this.pending.clear();
            });

            // Wait for process to be ready, then send initialize
            setTimeout(async () => {
                try {
                    const initResult = await this.send("initialize", {
                        protocolVersion: "2024-11-05",
                        capabilities: {},
                        clientInfo: { name: "TestClient", version: "1.0.0" },
                    });
                    // Send initialized notification (no id = notification)
                    this._write({ jsonrpc: "2.0", method: "notifications/initialized" });
                    resolve(initResult);
                } catch (err) {
                    reject(err);
                }
            }, 1000);
        });
    }

    _write(obj) {
        // MCP SDK uses NDJSON: JSON line followed by \n
        const line = JSON.stringify(obj) + "\n";
        this.proc.stdin.write(line);
    }

    _processBuffer() {
        let newlineIdx;
        while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, "");
            this.buffer = this.buffer.slice(newlineIdx + 1);

            if (!line.trim()) continue;

            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
                    } else {
                        resolve(msg.result);
                    }
                }
            } catch {
                // not JSON, skip
            }
        }
    }

    send(method, params, timeoutMs = 180000) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            this.pending.set(id, { resolve, reject });
            this._write({ jsonrpc: "2.0", id, method, params });
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`Timeout after ${timeoutMs}ms for ${method}`));
                }
            }, timeoutMs);
        });
    }

    async callTool(name, args = {}) {
        return this.send("tools/call", { name, arguments: args });
    }

    async listTools() {
        return this.send("tools/list", {});
    }

    stop() {
        if (this.proc) {
            try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
            this.proc = null;
        }
    }
}

// ─── Test Runner ────────────────────────────────────────────────────
const allResults = [];
let totalTests = 0, passed = 0, failed = 0, skipped = 0;

function record(phase, name, status, details = {}) {
    totalTests++;
    allResults.push({ phase, name, status, ...details });
    if (status === "PASS") passed++;
    else if (status === "FAIL") failed++;
    else skipped++;

    const icon = status === "PASS" ? `${C.green}✅ PASS${C.reset}`
        : status === "FAIL" ? `${C.red}❌ FAIL${C.reset}`
            : `${C.yellow}⏭️ SKIP${C.reset}`;
    const t = details.timeMs ? ` ${C.dim}(${details.timeMs}ms)${C.reset}` : "";
    const n = details.note ? ` ${C.dim}— ${details.note}${C.reset}` : "";
    console.log(`  ${icon} ${name}${t}${n}`);
}

async function call(client, tool, args = {}) {
    const start = Date.now();
    const result = await client.callTool(tool, args);
    const timeMs = Date.now() - start;
    const text = result?.content?.[0]?.text ?? "";
    return { result, text, timeMs };
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
    console.log(`\n${C.bold}${C.cyan}╔═══════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.cyan}║   NREKI v5.1.0 × SICAEP — Integration Tests     ║${C.reset}`);
    console.log(`${C.bold}${C.cyan}╚═══════════════════════════════════════════════════════╝${C.reset}\n`);
    console.log(`${C.dim}SICAEP: ${SICAEP_ROOT}${C.reset}`);
    console.log(`${C.dim}NREKI: ${NREKI_ROOT}${C.reset}\n`);

    const client = new McpTestClient();

    try {
        // ═══ PHASE 0 ════════════════════════════════════════════════
        console.log(`${C.bold}━━━ PHASE 0: Connection & Initialization ━━━${C.reset}`);

        const t0 = Date.now();
        const initResult = await client.start();
        const initTime = Date.now() - t0;
        record("Phase 0", "MCP Initialize", "PASS", {
            timeMs: initTime,
            note: `Server: ${initResult?.serverInfo?.name} v${initResult?.serverInfo?.version}`,
        });

        const toolsResult = await client.listTools();
        const toolCount = toolsResult?.tools?.length ?? 0;
        record("Phase 0", "tools/list", toolCount >= 16 ? "PASS" : "FAIL", {
            note: `${toolCount} tools registered`,
        });

        // ═══ PHASE 1 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 1: Reconnaissance ━━━${C.reset}`);

        // nreki_status
        {
            const { text, timeMs } = await call(client, "nreki_status");
            const ok = text.includes("NREKI") || text.includes("Files:");
            record("Phase 1", "nreki_status", ok ? "PASS" : "FAIL", {
                timeMs,
                note: text.match(/Files:\s+(\d+)/)?.[0] ?? "index building…",
            });
        }

        // nreki_map (this triggers indexing on first call — can be slow)
        {
            const { text, timeMs } = await call(client, "nreki_map", { refresh: true });
            const hasTree = text.includes("src/") || text.includes("src\\") || text.includes("app");
            const tokenMatch = text.match(/([\d,]+)\s*tokens/);
            record("Phase 1", "nreki_map", hasTree ? "PASS" : "FAIL", {
                timeMs,
                note: `Tree visible: ${hasTree}, tokens: ${tokenMatch?.[1] ?? "?"}`,
            });
        }

        // nreki_outline
        {
            const { text, timeMs } = await call(client, "nreki_outline", {
                file: "src/app/api/empresas/route.ts",
            });
            const hasSymbols = text.includes("function") || text.includes("Outline") || text.includes("symbol");
            const hasGET = text.includes("GET");
            record("Phase 1", "nreki_outline", hasSymbols ? "PASS" : "FAIL", {
                timeMs,
                note: `GET: ${hasGET}, symbols found: ${hasSymbols}`,
            });
        }

        // ═══ PHASE 2 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 2: Reading & Analysis ━━━${C.reset}`);

        // nreki_read (small file — raw)
        {
            const { text, timeMs } = await call(client, "nreki_read", {
                file_path: "src/lib/supabase/cliente.ts",
                level: "medium",
            });
            const ok = text.includes("crearClienteNavegador") || text.includes("createBrowserClient") || text.includes("raw");
            record("Phase 2", "nreki_read (small file)", ok ? "PASS" : "FAIL", { timeMs });
        }

        // nreki_read (larger file — compressed)
        {
            const { text, timeMs } = await call(client, "nreki_read", {
                file_path: "src/app/api/empresas/route.ts",
                level: "medium",
            });
            const hasReduction = text.includes("reduction") || text.includes("compression");
            const savedMatch = text.match(/saved ~([\d,]+) tokens/);
            record("Phase 2", "nreki_read (compressed)", hasReduction ? "PASS" : "FAIL", {
                timeMs, note: `Saved: ${savedMatch?.[1] ?? "?"} tokens`,
            });
        }

        // nreki_def
        {
            const { text, timeMs } = await call(client, "nreki_def", {
                symbol: "GET",
                kind: "function",
            });
            const ok = text.includes("Definition") || text.includes("function");
            record("Phase 2", "nreki_def (GET)", ok ? "PASS" : "FAIL", { timeMs });
        }

        // nreki_refs
        {
            const { text, timeMs } = await call(client, "nreki_refs", {
                symbol: "crearClienteServidor",
            });
            const refMatch = text.match(/Found (\d+) reference/);
            record("Phase 2", "nreki_refs (crearClienteServidor)", refMatch ? "PASS" : "FAIL", {
                timeMs, note: `${refMatch?.[1] ?? "?"} references`,
            });
        }

        // ═══ PHASE 3 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 3: Search ━━━${C.reset}`);

        // Search .single()
        {
            const { text, timeMs } = await call(client, "nreki_search", {
                query: ".single()",
                limit: 10,
            });
            const ok = text.includes("result") || text.includes("Score:");
            const savedMatch = text.match(/saved ~([\d,]+) tokens/);
            record("Phase 3", 'nreki_search (".single()")', ok ? "PASS" : "FAIL", {
                timeMs, note: `Saved: ${savedMatch?.[1] ?? "0"} tokens`,
            });
        }

        // Search auth
        {
            const { text, timeMs } = await call(client, "nreki_search", {
                query: "session validation middleware",
                limit: 10,
            });
            const ok = text.includes("result") || text.includes("Score:");
            record("Phase 3", "nreki_search (middleware auth)", ok ? "PASS" : "FAIL", { timeMs });
        }

        // Search RLS
        {
            const { text, timeMs } = await call(client, "nreki_search", {
                query: "anon RLS policies supabase",
                limit: 5,
            });
            const ok = text.includes("result") || text.includes("Score:") || text.includes("No results");
            record("Phase 3", "nreki_search (RLS policies)", ok ? "PASS" : "FAIL", { timeMs });
        }

        // ═══ PHASE 4 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 4: Audit & Validation ━━━${C.reset}`);

        // nreki_audit
        {
            const { text, timeMs } = await call(client, "nreki_audit");
            const ok = text.includes("Token Consumption Audit") || text.includes("NREKI");
            const filesMatch = text.match(/Files indexed:\s+(\d+)/);
            const chunksMatch = text.match(/AST chunks:\s+(\d+)/);
            record("Phase 4", "nreki_audit", ok ? "PASS" : "FAIL", {
                timeMs, note: `Files: ${filesMatch?.[1] ?? "?"}, Chunks: ${chunksMatch?.[1] ?? "?"}`,
            });
        }

        // nreki_validate (valid)
        {
            const { text, timeMs } = await call(client, "nreki_validate", {
                code: 'export function hello(): string {\n  return "world";\n}',
                language: "typescript",
            });
            record("Phase 4", "nreki_validate (valid TS)", text.includes("PASSED") ? "PASS" : "FAIL", { timeMs });
        }

        // nreki_validate (invalid)
        {
            const { text, timeMs } = await call(client, "nreki_validate", {
                code: 'export function hello(): string { return "world" ',
                language: "typescript",
            });
            record("Phase 4", "nreki_validate (broken TS)", text.includes("FAILED") || text.includes("error") ? "PASS" : "FAIL", { timeMs });
        }

        // ═══ PHASE 5 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 5: Compression ━━━${C.reset}`);

        // nreki_compress tier 1
        {
            const { text, timeMs } = await call(client, "nreki_compress", {
                file_path: "src/app/api/trabajadores/route.ts",
                tier: 1,
            });
            const ratioMatch = text.match(/([\d.]+)%\s*reduction/);
            record("Phase 5", "nreki_compress (tier 1)", ratioMatch ? "PASS" : "FAIL", {
                timeMs, note: `Reduction: ${ratioMatch?.[1] ?? "?"}%`,
            });
        }

        // nreki_compress aggressive
        {
            const { text, timeMs } = await call(client, "nreki_compress", {
                file_path: "src/app/api/fotochecks/generar-pdf/route.ts",
                level: "aggressive",
            });
            const ratioMatch = text.match(/([\d.]+)%\s*reduction/);
            record("Phase 5", "nreki_compress (aggressive)", text.includes("reduction") || text.includes("Advanced") ? "PASS" : "FAIL", {
                timeMs, note: `Reduction: ${ratioMatch?.[1] ?? "?"}%`,
            });
        }

        // ═══ PHASE 6 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 6: Unique Features ━━━${C.reset}`);

        // nreki_circuit_breaker stats
        {
            const { text, timeMs } = await call(client, "nreki_circuit_breaker", {
                last_error: "test", action: "stats",
            });
            record("Phase 6", "nreki_circuit_breaker (stats)", text.includes("Stats") ? "PASS" : "FAIL", { timeMs });
        }

        // nreki_circuit_breaker check (no loop)
        {
            const { text, timeMs } = await call(client, "nreki_circuit_breaker", {
                last_error: "TypeError: Cannot read property 'x' of undefined",
                file_path: "src/test.ts", action: "check",
            });
            record("Phase 6", "nreki_circuit_breaker (check)", text.includes("OK") ? "PASS" : "FAIL", { timeMs });
        }

        // nreki_circuit_breaker loop detection
        {
            const sameError = "Error: ENOENT: no such file or directory 'test.ts'";
            let tripped = false;
            for (let i = 0; i < 8; i++) {
                const { text } = await call(client, "nreki_circuit_breaker", {
                    last_error: sameError, file_path: "src/test.ts", action: "check",
                });
                if (text.includes("TRIPPED")) { tripped = true; break; }
            }
            record("Phase 6", "nreki_circuit_breaker (loop detect)", tripped ? "PASS" : "FAIL", {
                note: tripped ? "Loop detected!" : "Loop NOT detected",
            });
            // Reset
            await call(client, "nreki_circuit_breaker", { last_error: "reset", action: "reset" });
        }

        // nreki_semantic_edit on TEMP COPY
        {
            const srcFile = path.join(SICAEP_ROOT, "src", "app", "api", "empresas", "route.ts");
            const tempDir = path.join(SICAEP_ROOT, "__nreki_test_temp__");
            const tempFile = path.join(tempDir, "route.ts");

            fs.mkdirSync(tempDir, { recursive: true });
            fs.copyFileSync(srcFile, tempFile);

            const originalContent = fs.readFileSync(tempFile, "utf-8");

            try {
                // Extract POST function text and replace .single() → .maybeSingle()
                const postMatch = originalContent.match(/(export async function POST[\s\S]*?)(?=\nexport async function|\n\/\*\*|\Z)/);
                if (postMatch) {
                    const newCode = postMatch[1].replace(".single()", ".maybeSingle()");

                    const { text, timeMs } = await call(client, "nreki_semantic_edit", {
                        file: "__nreki_test_temp__/route.ts",
                        symbol: "POST",
                        new_code: newCode,
                    });
                    const success = text.includes("SUCCESS");
                    let editedContent = "";
                    try { editedContent = fs.readFileSync(tempFile, "utf-8"); } catch { /* ignore */ }
                    const hasMaybeSingle = editedContent.includes(".maybeSingle()");
                    record("Phase 6", "nreki_semantic_edit (.single→.maybeSingle)", success ? "PASS" : "FAIL", {
                        timeMs, note: success ? `File modified, .maybeSingle: ${hasMaybeSingle}` : text.slice(0, 100),
                    });

                    // nreki_undo
                    if (success) {
                        const { text: undoText, timeMs: undoTime } = await call(client, "nreki_undo", {
                            file: "__nreki_test_temp__/route.ts",
                        });
                        const restored = (undoText.includes("SUCCESS") || undoText.includes("restored"));
                        let restoredContent = "";
                        try { restoredContent = fs.readFileSync(tempFile, "utf-8"); } catch { /* ignore */ }
                        record("Phase 6", "nreki_undo (revert)", restored ? "PASS" : "FAIL", {
                            timeMs: undoTime, note: `.single() back: ${restoredContent.includes(".single()")}`,
                        });
                    } else {
                        record("Phase 6", "nreki_undo (revert)", "SKIP", { note: "semantic_edit failed" });
                    }
                } else {
                    record("Phase 6", "nreki_semantic_edit", "SKIP", { note: "Could not extract POST" });
                    record("Phase 6", "nreki_undo", "SKIP", { note: "Skipped" });
                }
            } finally {
                try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
            }
        }

        // ═══ PHASE 7 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 7: Session Management ━━━${C.reset}`);

        // nreki_pin add
        {
            const { text, timeMs } = await call(client, "nreki_pin", {
                action: "add", text: "Always use .maybeSingle() instead of .single()",
            });
            record("Phase 7", "nreki_pin (add)", text.includes("ADDED") ? "PASS" : "FAIL", { timeMs });
        }

        // nreki_pin list
        {
            const { text, timeMs } = await call(client, "nreki_pin", { action: "list" });
            record("Phase 7", "nreki_pin (list)", text.includes("maybeSingle") ? "PASS" : "FAIL", { timeMs });
        }

        // nreki_terminal
        {
            const fakeOutput = [
                "npm ERR! code ELIFECYCLE",
                "npm ERR! errno 1",
                "npm ERR! sicaep-panel@0.1.0 build: `next build`",
                "npm ERR! Exit status 1",
                "",
                "   at Module._compile (node:internal/modules/cjs/loader:1469:14)",
                "   at Module._compile (node:internal/modules/cjs/loader:1469:14)",
                "   at Module._compile (node:internal/modules/cjs/loader:1469:14)",
                "",
                "Error: Cannot find module '@/components/Header'",
                "  at src/app/page.tsx:3:1",
                "",
                "\x1b[31mERROR\x1b[0m in src/app/layout.tsx:15:3",
                "Type error: Property 'children' is missing",
            ].join("\n");

            const { text, timeMs } = await call(client, "nreki_terminal", {
                output: fakeOutput, max_lines: 50,
            });
            const hasReduction = text.includes("reduction") || text.includes("Filter");
            record("Phase 7", "nreki_terminal (filter)", hasReduction ? "PASS" : "FAIL", {
                timeMs, note: text.match(/([\d.]+)%\s*reduction/)?.[0] ?? "",
            });
        }

        // nreki_session_report
        {
            const { text, timeMs } = await call(client, "nreki_session_report");
            const ok = text.includes("SESSION RECEIPT") || text.includes("Session Report");
            record("Phase 7", "nreki_session_report", ok ? "PASS" : "FAIL", {
                timeMs, note: ok ? "ASCII receipt generated" : "",
            });
        }

        // ═══ PHASE 8 ════════════════════════════════════════════════
        console.log(`\n${C.bold}━━━ PHASE 8: Stress Tests ━━━${C.reset}`);

        // Nonexistent file
        {
            const { text, timeMs } = await call(client, "nreki_read", {
                file_path: "src/esto/no/existe.ts", level: "medium",
            });
            const graceful = text.toLowerCase().includes("error") || text.includes("not");
            record("Phase 8", "nreki_read (nonexistent)", graceful ? "PASS" : "FAIL", {
                timeMs, note: "Graceful error handling",
            });
        }

        // Binary file
        {
            const { text, timeMs } = await call(client, "nreki_read", {
                file_path: "public/logo-sicaep.png", level: "medium",
            });
            const handled = text.toLowerCase().includes("skip") || text.toLowerCase().includes("binary")
                || text.toLowerCase().includes("error") || text.toLowerCase().includes("not");
            record("Phase 8", "nreki_read (binary PNG)", handled ? "PASS" : "FAIL", {
                timeMs, note: "Binary detection",
            });
        }

        // Path traversal
        {
            const { text, timeMs } = await call(client, "nreki_read", {
                file_path: "../../../etc/passwd", level: "medium",
            });
            const blocked = text.toLowerCase().includes("security") || text.toLowerCase().includes("error")
                || text.toLowerCase().includes("traversal");
            record("Phase 8", "nreki_read (path traversal)", blocked ? "PASS" : "FAIL", {
                timeMs, note: blocked ? "Blocked!" : "NOT blocked!",
            });
        }

        // Large file outline
        {
            const { text, timeMs } = await call(client, "nreki_outline", {
                file: "src/app/api/trabajadores/route.ts",
            });
            const ok = text.includes("Outline") || text.includes("function") || text.includes("symbol");
            record("Phase 8", "nreki_outline (large file)", ok ? "PASS" : "FAIL", {
                timeMs, note: `${timeMs}ms`,
            });
        }

        // ─── Cleanup ──────────────────────────────────────────────
        // Remove pins
        const { text: pinText } = await call(client, "nreki_pin", { action: "list" });
        const pinIds = [...pinText.matchAll(/\*\*(pin_\d+)\*\*/g)].map(m => m[1]);
        for (const pinId of pinIds) {
            await call(client, "nreki_pin", { action: "remove", id: pinId });
        }

        client.stop();

        // Cleanup .nreki artifacts from SICAEP
        for (const f of [".nreki.db", ".nreki.db-journal"]) {
            try { fs.unlinkSync(path.join(SICAEP_ROOT, f)); } catch { /* ignore */ }
        }
        try { fs.rmSync(path.join(SICAEP_ROOT, ".nreki"), { recursive: true, force: true }); } catch { /* ignore */ }

    } catch (err) {
        console.error(`\n${C.red}FATAL ERROR: ${err.message}${C.reset}`);
        console.error(err.stack);
        client.stop();
    }

    // ─── Summary ────────────────────────────────────────────────
    console.log(`\n${C.bold}${C.cyan}╔═══════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}${C.cyan}║                    TEST SUMMARY                       ║${C.reset}`);
    console.log(`${C.bold}${C.cyan}╚═══════════════════════════════════════════════════════╝${C.reset}\n`);

    const phaseMap = {};
    for (const r of allResults) {
        if (!phaseMap[r.phase]) phaseMap[r.phase] = { pass: 0, fail: 0, skip: 0, total: 0 };
        phaseMap[r.phase].total++;
        if (r.status === "PASS") phaseMap[r.phase].pass++;
        else if (r.status === "FAIL") phaseMap[r.phase].fail++;
        else phaseMap[r.phase].skip++;
    }

    console.log(`  ${"Phase".padEnd(45)} Pass  Fail  Total`);
    console.log(`  ${"─".repeat(45)} ${"─".repeat(4)}  ${"─".repeat(4)}  ${"─".repeat(5)}`);
    for (const [phase, s] of Object.entries(phaseMap)) {
        console.log(`  ${phase.padEnd(45)} ${String(s.pass).padEnd(6)}${String(s.fail).padEnd(6)}${s.total}`);
    }
    console.log(`  ${"─".repeat(45)} ${"─".repeat(4)}  ${"─".repeat(4)}  ${"─".repeat(5)}`);
    console.log(`  ${"TOTAL".padEnd(45)} ${C.green}${passed}${C.reset}${" ".repeat(6 - String(passed).length)}${failed > 0 ? C.red : ""}${failed}${C.reset}${" ".repeat(6 - String(failed).length)}${totalTests}`);
    console.log(`\n  ${C.bold}Result: ${failed === 0 ? `${C.green}ALL TESTS PASSED` : `${C.red}${failed} TEST(S) FAILED`}${C.reset}\n`);

    // Save JSON
    const output = {
        timestamp: new Date().toISOString(),
        nrekiVersion: "5.1.0",
        sicaepRoot: SICAEP_ROOT,
        summary: { total: totalTests, passed, failed, skipped },
        results: allResults,
    };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(output, null, 2));
    console.log(`${C.dim}Results saved to: ${RESULTS_FILE}${C.reset}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

main();
