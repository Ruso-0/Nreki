import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NrekiEngine } from "../src/engine.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { handleBatchEdit, handleEdit } from "../src/handlers/code/edit.js";
import { handleContext, CONTEXT_EDIT_HINT } from "../src/handlers/context-pack.js";
import { nativeEditEndpoint } from "../src/hooks/native-edit-ipc.js";
import { validateNativeEdit } from "../src/hooks/native-edit-validator.js";
import { isAdditiveDeclarationChange } from "../src/kernel/backends/ts-compiler-wrapper.js";
import type { RouterDependencies } from "../src/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const builtServer = path.join(repoRoot, "dist", "index.js");
const hookScript = path.join(repoRoot, "templates", "hooks", "nreki-enforcer.mjs");

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            try { fn(); } catch { /* ignore cleanup errors */ }
        }
    }
});

function endpointLive(endpoint: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.createConnection(endpoint);
        const finish = (live: boolean): void => {
            socket.destroy();
            resolve(live);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(500, () => finish(false));
    });
}

function runHook(root: string, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === "string" && k !== "NREKI_NATIVE_PREFLIGHT") env[k] = v;
        }
        Object.assign(env, { CLAUDE_PROJECT_DIR: root, NREKI_ENFORCE_EDITS: "" }, extraEnv);
        const child = spawn(process.execPath, [hookScript], {
            cwd: root,
            env,
            stdio: "pipe",
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", code => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify(payload));
    });
}

function serverEnvWithoutPreflight(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string" && k !== "NREKI_NATIVE_PREFLIGHT") env[k] = v;
    }
    return env;
}

describe("Claude Code token-friction & preflight opt-in regressions", () => {
    it("1. Without NREKI_NATIVE_PREFLIGHT: session marker has no token, no IPC endpoint listens, read-steering stays active, and file-mode JSDoc Edit passes silently", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-default-nopreflight-"));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }));

        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true },
            include: ["src/**/*.ts"],
        }));
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        const prorationPath = path.join(root, "src", "proration.ts");
        fs.writeFileSync(
            prorationPath,
            "/** Flat 30-day billing period. */\nexport function prorationCredit(cents: number): number {\n    return cents;\n}\n",
        );
        fs.writeFileSync(
            path.join(root, "src", "caller.ts"),
            'import { prorationCredit } from "./proration.js";\nexport const due: number = prorationCredit(1500);\n',
        );
        const bigPath = path.join(root, "src", "big.ts");
        fs.writeFileSync(
            bigPath,
            Array.from({ length: 700 }, (_, i) => `export function helper${i}(n: number): number { return n + ${i}; }`).join("\n") + "\n",
        );

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [builtServer],
            cwd: root,
            env: serverEnvWithoutPreflight(),
            stderr: "pipe",
        });
        const client = new Client({ name: "nopreflight-check", version: "1.0.0" });
        try {
            await client.connect(transport);
            const pid = transport.pid;
            expect(pid).not.toBeNull();

            const markerPath = path.join(root, ".nreki", "sessions", String(pid));
            expect(fs.existsSync(markerPath)).toBe(true);
            const metadata = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { startedAt?: string; token?: string };
            expect(metadata.startedAt).toBeTruthy();
            expect(metadata.token).toBeUndefined();
            expect("token" in metadata).toBe(false);

            const endpoint = nativeEditEndpoint(root, pid!);
            expect(await endpointLive(endpoint)).toBe(false);

            // Large whole-file Read steering remains active via session marker
            const readRes = await runHook(root, {
                tool_name: "Read",
                tool_input: { file_path: bigPath },
            });
            expect(readRes.code).toBe(2);
            expect(readRes.stderr).toContain("helper0");

            // Native Edit in file mode changing JSDoc on an exported function exits 0 with empty stdout/stderr
            const editRes = await runHook(root, {
                tool_name: "Edit",
                tool_input: {
                    file_path: prorationPath,
                    old_string: "/** Flat 30-day billing period. */",
                    new_string: "/** Actual calendar days in billing period. */",
                },
            });
            expect(editRes).toEqual({ code: 0, stdout: "", stderr: "" });
        } finally {
            await client.close().catch(() => {});
            await transport.close().catch(() => {});
        }
    }, 120_000);

    it("3. batch_edit and edit with mode:'replace' and new_code:'' delete the symbol cleanly and still block breaking deletions", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-delete-symbol-"));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ES2022", module: "CommonJS", strict: true, skipLibCheck: true, noEmit: true },
            include: ["src/**/*.ts"],
        }));
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        const prorationFile = path.join(root, "src", "proration.ts");
        fs.writeFileSync(
            prorationFile,
            [
                "/** Legacy 30-day period assumption. */",
                "const DAYS_PER_PERIOD = 30;",
                "",
                "export function unusedHelper(): number {",
                "    return 0;",
                "}",
                "",
                "export function prorationCredit(days: number): number {",
                "    return days * 100;",
                "}",
                "",
            ].join("\n"),
        );
        const callerFile = path.join(root, "src", "caller.ts");
        fs.writeFileSync(
            callerFile,
            'import { prorationCredit } from "./proration";\nexport const credit: number = prorationCredit(10);\n',
        );

        const engine = new NrekiEngine({ watchPaths: [root], dbPath: path.join(root, ".nreki.db") });
        const sandbox = new AstSandbox();
        const kernel = new NrekiKernel();
        cleanups.push(() => { engine.shutdown(); sandbox.shutdown(); });
        await engine.initialize();
        await engine.indexDirectory(root);

        const deps: RouterDependencies = {
            engine,
            sandbox,
            kernel,
            nrekiMode: "file",
            monitor: new TokenMonitor(),
            circuitBreaker: new CircuitBreaker(root),
        };

        // 3a. batch_edit deletes DAYS_PER_PERIOD (and its attached JSDoc) via mode:"replace", new_code:""
        const delBatch = await handleBatchEdit({
            action: "batch_edit",
            edits: [{ path: "src/proration.ts", symbol: "DAYS_PER_PERIOD", mode: "replace", new_code: "" }],
        }, deps);
        expect(delBatch.isError, delBatch.content[0]?.text).not.toBe(true);
        const afterBatch = fs.readFileSync(prorationFile, "utf8");
        expect(afterBatch).not.toContain("DAYS_PER_PERIOD");
        expect(afterBatch).not.toContain("Legacy 30-day period assumption");
        expect(afterBatch).toContain("export function prorationCredit");

        // 3b. Single edit deletes unusedHelper via mode:"replace", new_code:""
        const delSingle = await handleEdit({
            action: "edit",
            path: "src/proration.ts",
            symbol: "unusedHelper",
            mode: "replace",
            new_code: "",
        }, deps);
        expect(delSingle.isError, delSingle.content[0]?.text).not.toBe(true);
        const afterSingle = fs.readFileSync(prorationFile, "utf8");
        expect(afterSingle).not.toContain("unusedHelper");
        expect(afterSingle).toContain("export function prorationCredit");

        // 3c. Deleting prorationCredit (still imported by caller.ts) is blocked by Layer 2 without modifying disk
        const blockedDel = await handleBatchEdit({
            action: "batch_edit",
            edits: [{ path: "src/proration.ts", symbol: "prorationCredit", mode: "replace", new_code: "" }],
        }, deps);
        expect(blockedDel.isError).toBe(true);
        expect(blockedDel.content[0]?.text).toMatch(/caller\.ts|TS2305/);
        expect(fs.readFileSync(prorationFile, "utf8")).toBe(afterSingle);
    });

    it("4. In file mode, a JSDoc-only edit reports exportedApiUnchanged === true in both previewAtomicBatch and batch_edit footer", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-jsdoc-surface-"));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ES2022", module: "CommonJS", strict: true, skipLibCheck: true, noEmit: true },
            include: ["src/**/*.ts"],
        }));
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        const target = path.join(root, "src", "proration.ts");
        const before = "/** Computes credit using 30-day month. */\nexport function prorationCredit(days: number): number {\n    return days * 100;\n}\n";
        const after = "/** Computes credit using actual calendar days in billing period. */\nexport function prorationCredit(days: number): number {\n    return days * 100;\n}\n";
        fs.writeFileSync(target, before);
        fs.writeFileSync(
            path.join(root, "src", "caller.ts"),
            'import { prorationCredit } from "./proration";\nexport const total: number = prorationCredit(3);\n',
        );

        const engine = new NrekiEngine({ watchPaths: [root], dbPath: path.join(root, ".nreki.db") });
        const sandbox = new AstSandbox();
        const kernel = new NrekiKernel();
        cleanups.push(() => { engine.shutdown(); sandbox.shutdown(); });
        await engine.initialize();
        await engine.indexDirectory(root);
        kernel.boot(root, "file");

        const preview = await kernel.previewAtomicBatch(
            [{ targetFile: target, proposedContent: after, baseContent: before }],
            ["src/caller.ts"],
        );
        expect(preview.safe, preview.errorText).toBe(true);
        expect(preview.exportedApiUnchanged).toBe(true);

        // Now verify batch_edit footer when editing body + JSDoc (or file with JSDoc change) in file mode
        const deps: RouterDependencies = {
            engine,
            sandbox,
            kernel,
            nrekiMode: "file",
            monitor: new TokenMonitor(),
            circuitBreaker: new CircuitBreaker(root),
        };
        // Rewrite file with JSDoc inside an exported interface/class method so symbol chunk includes JSDoc
        const svcFile = path.join(root, "src", "service.ts");
        fs.writeFileSync(
            svcFile,
            "export class BillingService {\n    /** Old method JSDoc. */\n    credit(days: number): number {\n        return days * 10;\n    }\n}\n",
        );
        fs.writeFileSync(
            path.join(root, "src", "use-service.ts"),
            'import { BillingService } from "./service";\nexport const val: number = new BillingService().credit(2);\n',
        );
        await engine.indexDirectory(root);
        await kernel.notifyExternalChange(["src/service.ts", "src/use-service.ts"]);

        const editRes = await handleBatchEdit({
            action: "batch_edit",
            edits: [{
                path: "src/service.ts",
                symbol: "BillingService",
                mode: "patch",
                search_text: "/** Old method JSDoc. */",
                replace_text: "/** Updated method JSDoc. */",
            }],
        }, deps);
        const banner = editRes.content[0]?.text ?? "";
        expect(editRes.isError, banner).not.toBe(true);
        expect(banner).toContain("exported API unchanged");
        expect(banner).toContain("Re-running tsc is redundant");
        expect(banner).not.toContain("Exported API changed");
    });

    it("5. Adding an export to a module with 'export *' is NOT treated as additive and is blocked when outside-program importers exist", async () => {
        expect(
            isAdditiveDeclarationChange(
                'export * from "./other";\n',
                'export * from "./other";\nexport declare const foo: string;\n',
            ),
        ).toBe(false);

        for (const mode of ["file", "project"] as const) {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), `nreki-export-star-${mode}-`));
            cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

            fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
                compilerOptions: { target: "ES2022", module: "CommonJS", strict: true, skipLibCheck: true, noEmit: true },
                include: ["src/**/*.ts"],
            }));
            fs.mkdirSync(path.join(root, "src"), { recursive: true });
            fs.mkdirSync(path.join(root, "tests"), { recursive: true });
            fs.writeFileSync(path.join(root, "src", "other.ts"), "export const foo: number = 1;\n");
            fs.writeFileSync(path.join(root, "src", "m.ts"), 'export * from "./other";\n');
            // Outside tsconfig include ("src/**/*.ts"): shadows foo: number -> foo: string, breaking tests/t.ts with TS2322
            fs.writeFileSync(path.join(root, "tests", "t.ts"), 'import { foo } from "../src/m";\nexport const n: number = foo;\n');

            const engine = new NrekiEngine({ watchPaths: [root], dbPath: path.join(root, ".nreki.db") });
            const sandbox = new AstSandbox();
            const kernel = new NrekiKernel();
            cleanups.push(() => { engine.shutdown(); sandbox.shutdown(); });
            await engine.initialize();
            await engine.indexDirectory(root);

            const deps: RouterDependencies = {
                engine,
                sandbox,
                kernel,
                nrekiMode: mode,
                monitor: new TokenMonitor(),
                circuitBreaker: new CircuitBreaker(root),
            };

            const res = await validateNativeEdit({
                tool_name: "Edit",
                tool_input: {
                    file_path: "src/m.ts",
                    old_string: 'export * from "./other";',
                    new_string: 'export * from "./other";\nexport const foo: string = "x";',
                },
            }, deps);
            expect(res.status, `mode=${mode} unexpectedly allowed export* shadowing`).toBe("deny");
        }
    });

    it("6. CLAUDE.md, SKILL.md, MCP instructions, and context header steer single-file edits to native Edit instead of 'one batch_edit with every change'", async () => {
        const claudeMd = fs.readFileSync(path.join(repoRoot, "templates", "CLAUDE.md"), "utf8");
        const skillMd = fs.readFileSync(path.join(repoRoot, "templates", "SKILL.md"), "utf8");
        const agentsMd = fs.readFileSync(path.join(repoRoot, "templates", "AGENTS.md"), "utf8");

        const everyChangePattern = /one\s+(?:`[^`]*batch_edit[^`]*`|batch_edit)\s+with\s+every\s+change/i;
        expect(claudeMd).not.toMatch(everyChangePattern);
        expect(skillMd).not.toMatch(everyChangePattern);
        expect(CONTEXT_EDIT_HINT).not.toMatch(everyChangePattern);

        // CLAUDE.md and SKILL.md explicitly direct single-file changes to native Edit
        expect(claudeMd).toMatch(/native\s+`?Edit`?/i);
        expect(skillMd).toMatch(/native\s+`?Edit`?/i);

        // AGENTS.md (Codex) remains untouched
        expect(agentsMd).toMatch(everyChangePattern);

        // Check MCP server instructions and handleContext header
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-instr-"));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }));
        fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "src", "math.ts"), "export function clampValue(x: number): number {\n    return x;\n}\n");

        const engine = new NrekiEngine({ watchPaths: [root], dbPath: path.join(root, ".nreki.db") });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(root);
        const ctxRes = await handleContext({ action: "context", query: "fix clampValue" }, { engine } as unknown as RouterDependencies);
        const ctxHeader = (ctxRes.content[0]?.text ?? "").split("\n")[0] ?? "";
        expect(ctxHeader).not.toContain("edit it with batch_edit");
        expect(ctxHeader).toContain("no further read is needed");

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [builtServer],
            cwd: root,
            env: serverEnvWithoutPreflight(),
            stderr: "pipe",
        });
        const client = new Client({ name: "instr-check", version: "1.0.0" });
        try {
            await client.connect(transport);
            const instructions = client.getInstructions() ?? "";
            expect(instructions).not.toMatch(/Edit with nreki_code action:"batch_edit"/i);
            expect(instructions).not.toMatch(everyChangePattern);
            expect(instructions).toMatch(/native\s+Edit/i);
            expect(instructions).toContain('nreki_code action:"batch_edit"');
        } finally {
            await client.close().catch(() => {});
            await transport.close().catch(() => {});
        }
    }, 120_000);
});
