import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { NrekiEngine } from "../src/engine.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { KeywordIndex } from "../src/search/keyword-index.js";
import { expandSpanishContextQuery } from "../src/utils/spanish-query.js";
import { listenWithStaleSocketRecovery, startNativeEditServer } from "../src/hooks/native-edit-ipc.js";

const HOOK_PATH = fileURLToPath(new URL("../templates/hooks/nreki-enforcer.mjs", import.meta.url));
const cleanup: Array<() => void> = [];

afterEach(() => {
    vi.restoreAllMocks();
    while (cleanup.length > 0) {
        const fn = cleanup.pop();
        if (fn) fn();
    }
});

function runHook(root: string, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK_PATH], {
            cwd: root,
            env: { ...process.env, CLAUDE_PROJECT_DIR: root, NREKI_ENFORCE_EDITS: "", ...extraEnv },
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

describe("Audit 3878d87 regression suite", () => {
    it("Bug #3: coalesces queued external watcher changes into a single batch notification and skips TS baseline on .py changes", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-audit-watcher-"));
        cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: { strict: true, skipLibCheck: true, target: "ES2022" },
            include: ["*.ts"],
        }));
        const files: string[] = [];
        for (let i = 0; i < 6; i++) {
            const p = path.join(root, `mod${i}.ts`);
            fs.writeFileSync(p, `export const v${i}: number = ${i};\n`);
            files.push(p);
        }
        const pyPath = path.join(root, "worker.py");
        fs.writeFileSync(pyPath, "def run() -> int:\n    return 1\n");

        const engine = new NrekiEngine({ watchPaths: [root], dbPath: path.join(root, ".nreki.db") });
        const kernel = new NrekiKernel();
        cleanup.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(root);
        kernel.boot(root, "project");

        const batchCalls: string[][] = [];
        const captureSpy = vi.spyOn(kernel["tsBackend"], "captureBaseline");
        engine.onExternalBatchChange(async changedFiles => {
            batchCalls.push([...changedFiles]);
            await kernel.notifyExternalChange(changedFiles);
        });

        // Modify all 6 TS files externally and enqueue them into indexingQueue before draining once
        for (let i = 0; i < files.length; i++) {
            fs.writeFileSync(files[i]!, `export const v${i}: number = ${i + 100};\n`);
            engine["indexingQueue"].add(files[i]!);
        }
        await engine["processQueue"]();

        expect(batchCalls).toHaveLength(1);
        expect(batchCalls[0]).toHaveLength(6);
        expect(captureSpy).toHaveBeenCalledTimes(1);

        // External Python change must NOT trigger TypeScript program/baseline rebuild
        captureSpy.mockClear();
        fs.writeFileSync(pyPath, "def run() -> int:\n    return 2\n");
        await kernel.notifyExternalChange([pyPath]);
        expect(captureSpy).not.toHaveBeenCalled();
    });

    it("Bug #4: preserves todo/todos and short identifier sub-tokens in KeywordIndex while dropping unambiguous Spanish connectors", () => {
        const idx = new KeywordIndex();
        const addTodoTokens = idx.tokenize("addTodo");
        const todoListTokens = idx.tokenize("TodoList");
        expect(addTodoTokens.length).toBe(2);
        expect(addTodoTokens).toContain("todo");
        expect(todoListTokens).toContain("todo");
        expect(idx.tokenize("todo")).toEqual(["todo"]);
        expect(idx.tokenize("todos").length).toBe(1);

        // Code sub-tokens like del/para/por/que are preserved
        const codeSubTokens = idx.tokenize("delKey paraNode porId msgQue");
        expect(codeSubTokens.length).toBeGreaterThanOrEqual(8);

        // Unambiguous Spanish connectors are still filtered out
        expect(idx.tokenize("cuando antes porque durante ademas")).toEqual([]);
    });

    it("Minor #3: translates Spanish gateway/noise/trim terms faithfully without spurious domain coupling", () => {
        const gateway = expandSpanishContextQuery("integrar pasarela de pagos");
        expect(gateway).toContain("gateway");
        expect(gateway).not.toContain("webhook");
        expect(gateway).not.toContain("delivery");

        const trimOut = expandSpanishContextQuery("recortar salida con ruido en consola");
        expect(trimOut).toContain("truncate");
        expect(trimOut).toContain("noise");
        expect(trimOut).toContain("terminal");
        expect(expandSpanishContextQuery("basura temporal")).toBe("basura temporal");
    });

    it("Bug #5 & Session Ordering: session marker without IPC token still keeps read-steering active, and hook prefers newest startedAt session", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-audit-ipc-"));
        cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
        const sessionsDir = path.join(root, ".nreki", "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });

        // 1. Marker written when IPC failed (token undefined): read-steering still sees NREKI alive,
        //    while native Edit fails open cleanly (silent allow).
        const bigTs = path.join(root, "big.ts");
        const bigBody = Array.from({ length: 700 }, (_, i) => `export function fn${i}(x: number): number { return x + ${i}; }`).join("\n") + "\n";
        fs.writeFileSync(bigTs, bigBody);
        fs.writeFileSync(
            path.join(sessionsDir, String(process.pid)),
            JSON.stringify({ startedAt: "2026-11-25T00:00:00.000Z" }),
        );

        const blockedRead = await runHook(root, { tool_name: "Read", tool_input: { file_path: bigTs } });
        expect(blockedRead.code).toBe(2);
        expect(blockedRead.stderr).toContain("fn0");

        const openEdit = await runHook(root, {
            tool_name: "Edit",
            tool_input: { file_path: bigTs, old_string: "return x + 0;", new_string: "return x + 1;" },
        });
        expect(openEdit).toEqual({ code: 0, stdout: "", stderr: "" });

        // 2. When two live PIDs exist, the newer `startedAt` session is contacted first
        const seenTools: string[] = [];
        const server = await startNativeEditServer(root, async req => {
            seenTools.push(req.tool_name);
            return { status: "allow" };
        });
        cleanup.push(() => server.close());

        // Older live PID (process.ppid) with a syntactically valid dummy token but no pipe/socket
        if (Number.isInteger(process.ppid) && process.ppid > 0 && process.ppid !== process.pid) {
            fs.writeFileSync(
                path.join(sessionsDir, String(process.ppid)),
                JSON.stringify({ startedAt: "2020-01-01T00:00:00.000Z", token: "a".repeat(64) }),
            );
        }
        fs.writeFileSync(
            path.join(sessionsDir, String(process.pid)),
            JSON.stringify({ startedAt: "2026-11-25T05:00:00.000Z", token: server.token }),
        );

        const validatedEdit = await runHook(root, {
            tool_name: "Edit",
            tool_input: { file_path: bigTs, old_string: "return x + 0;", new_string: "return x + 1;" },
        });
        expect(validatedEdit).toEqual({ code: 0, stdout: "", stderr: "" });
        expect(seenTools).toEqual(["Edit"]);

        // Exercise listenWithStaleSocketRecovery directly on current platform
        const auxServer = net.createServer();
        const auxEndpoint = process.platform === "win32"
            ? `\\\\.\\pipe\\nreki-test-aux-${process.pid}-${Date.now()}`
            : path.join(os.tmpdir(), `nreki-test-aux-${process.pid}-${Date.now()}.sock`);
        await listenWithStaleSocketRecovery(auxServer, auxEndpoint);
        auxServer.close();
    });
});
