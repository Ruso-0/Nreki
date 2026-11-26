import { describe, expect, it } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { nativeEditEndpoint } from "../src/hooks/native-edit-ipc.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtServer = path.join(repoRoot, "dist", "index.js");

function runNode(root: string, args: string[], input = "") {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: root,
            env: { ...process.env, CLAUDE_PROJECT_DIR: root, NREKI_ENFORCE_EDITS: "" },
            stdio: "pipe",
        });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8").on("data", chunk => stdout += chunk);
        child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk);
        child.once("error", reject);
        child.once("close", code => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
    });
}

function endpointLive(endpoint: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.createConnection(endpoint);
        const finish = (live: boolean) => { socket.destroy(); resolve(live); };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(500, () => finish(false));
    });
}

/** Wait until a process is gone, so its folder can be removed (Linux CI raced with ENOTEMPTY). */
async function waitForExit(pid: number | null | undefined, timeoutMs = 15_000): Promise<void> {
    if (!pid) return;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try { process.kill(pid, 0); } catch { return; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

describe("built MCP server native-edit integration", () => {
    it("advertises instructions and validates installed native hooks without writing source", async () => {
        if (!fs.existsSync(builtServer)) throw new Error("Run npm run build before the built-server integration test.");
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-native-server-"));
        const source = "export const count: number = 1;\n";
        const file = path.join(root, "a.ts");
        fs.writeFileSync(file, source);
        fs.writeFileSync(path.join(root, "b.ts"), 'import { count } from "./a"; export const total: number = count;\n');
        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: { strict: true, skipLibCheck: true, target: "ES2022" }, include: ["**/*.ts"],
        }));
        // Mode selection is automatic; 201 tiny TS files exercise the real project-mode path.
        fs.mkdirSync(path.join(root, "padding"));
        for (let i = 0; i < 199; i++) fs.writeFileSync(path.join(root, "padding", `p${i}.ts`), "export {};\n");
        const serverEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === "string") serverEnv[k] = v;
        }
        serverEnv.NREKI_NATIVE_PREFLIGHT = "1";
        const transport = new StdioClientTransport({ command: process.execPath, args: [builtServer], cwd: root, env: serverEnv, stderr: "pipe" });
        const client = new Client({ name: "native-edit-e2e", version: "1.0.0" });
        let serverStderr = "";
        transport.stderr?.on("data", chunk => serverStderr += String(chunk));
        let serverPid: number | null = null;
        try {
            await client.connect(transport);
            serverPid = transport.pid;
            // Instructions must arrive even in a repository that has never run init.
            expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
            expect(client.getInstructions()).toContain('nreki_navigate action:"context"');
            expect(client.getInstructions()).toContain('nreki_code action:"batch_edit"');
            const init = await runNode(root, [builtServer, "init", "--agent", "claude"]);
            expect(init.code, init.stderr).toBe(0);
            const installedHook = path.join(root, ".claude", "hooks", "nreki-enforcer.mjs");
            expect(fs.readFileSync(installedHook, "utf8")).toContain("nreki-enforcer:v5");
            expect(serverStderr).toContain("PROJECT mode detected");
            const pid = transport.pid;
            expect(pid).not.toBeNull();
            const marker = path.join(root, ".nreki", "sessions", String(pid));
            const metadata: { token?: string; startedAt?: string } = JSON.parse(fs.readFileSync(marker, "utf8"));
            expect(metadata.token).toMatch(/^[a-f0-9]{64}$/);
            expect(metadata.startedAt).toBeTruthy();
            const endpoint = nativeEditEndpoint(root, pid!);
            expect(await endpointLive(endpoint)).toBe(true);

            const edit = (new_string: string) => runNode(root, [installedHook], JSON.stringify({
                tool_name: "Edit", tool_input: { file_path: "a.ts", old_string: "= 1", new_string },
            }));
            expect(await edit("= 2"), serverStderr).toEqual({ code: 0, stdout: "", stderr: "" });
            expect(fs.readFileSync(file, "utf8")).toBe(source);
            const invalid = await edit('= "bad"');
            expect(invalid.code, invalid.stderr + serverStderr).toBe(2);
            expect(invalid.stdout).toBe("");
            expect(invalid.stderr).toMatch(/2322|not assignable/);
            expect(fs.readFileSync(file, "utf8")).toBe(source);
            expect(await edit("= 3"), serverStderr).toEqual({ code: 0, stdout: "", stderr: "" });
            expect(fs.readFileSync(file, "utf8")).toBe(source);

            await client.close();
            await expect.poll(() => endpointLive(endpoint), { timeout: 5_000 }).toBe(false);
            // SDK close uses a process abort. Windows terminates the process without exit handlers.
            if (process.platform !== "win32") expect(fs.existsSync(marker)).toBe(false);
        } finally {
            await client.close().catch(() => {});
            await transport.close().catch(() => {});
            await waitForExit(serverPid);
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
    });
});
