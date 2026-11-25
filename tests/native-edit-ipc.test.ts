import { afterEach, describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { nativeEditEndpoint, startNativeEditServer, type NativeEditRequest, type NativeEditResponse } from "../src/hooks/native-edit-ipc.js";

const hook = fileURLToPath(new URL("../templates/hooks/nreki-enforcer.mjs", import.meta.url));
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-native-ipc-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, ".nreki", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(root, "a.ts"), "export const value: number = 1;\n");
    return root;
}

function marker(root: string, token: string, extra: object = {}): void {
    fs.writeFileSync(path.join(root, ".nreki", "sessions", String(process.pid)), JSON.stringify({ token, ...extra }));
}

async function running(root: string, validate: (request: NativeEditRequest) => Promise<NativeEditResponse>) {
    const server = await startNativeEditServer(root, validate);
    cleanups.push(() => server.close());
    marker(root, server.token);
    return server;
}

function invoke(root: string, tool_name = "Edit", tool_input: object = { file_path: "a.ts", old_string: "= 1", new_string: "= 2" }, env: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [hook], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root, NREKI_ENFORCE_EDITS: "", ...env }, stdio: "pipe" });
        let stdout = "", stderr = "";
        child.stdout.setEncoding("utf8").on("data", chunk => stdout += chunk);
        child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk);
        child.once("error", reject);
        child.once("close", code => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({ tool_name, tool_input }));
    });
}

function send(endpoint: string, payload: string): Promise<NativeEditResponse> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        let response = "";
        socket.setEncoding("utf8");
        socket.once("connect", () => socket.write(payload + "\n"));
        socket.on("data", chunk => response += chunk);
        socket.once("error", reject);
        socket.once("end", () => { socket.destroy(); resolve(JSON.parse(response)); });
    });
}

describe("native-edit local IPC", () => {
    it("forwards edits and allows a validated change silently without touching disk", async () => {
        const root = project();
        const seen: NativeEditRequest[] = [];
        await running(root, async request => { seen.push(request); return { status: "allow" }; });
        expect(await invoke(root)).toEqual({ code: 0, stdout: "", stderr: "" });
        expect(seen).toEqual([{ tool_name: "Edit", tool_input: { file_path: "a.ts", old_string: "= 1", new_string: "= 2" } }]);
        expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain("= 1");
    });

    it("blocks invalid edits with the exact compiler diagnostic", async () => {
        const root = project();
        const error = "a.ts:1:14 TS2322: El tipo 'string' no se puede asignar a 'number'.";
        await running(root, async () => ({ status: "deny", error }));
        expect(await invoke(root)).toEqual({ code: 2, stdout: "", stderr: error + "\n" });
    });

    it("previews new Write files and MultiEdit before legacy size checks", async () => {
        const root = project();
        const names: string[] = [];
        await running(root, async request => { names.push(request.tool_name); return { status: "deny", error: "invalid" }; });
        expect((await invoke(root, "Write", { file_path: "new.ts", content: "bad" })).code).toBe(2);
        expect((await invoke(root, "MultiEdit", { file_path: "a.ts", edits: [{ old_string: "1", new_string: "2" }] })).code).toBe(2);
        expect(names).toEqual(["Write", "MultiEdit"]);
        expect(fs.existsSync(path.join(root, "new.ts"))).toBe(false);
    });

    it("keeps old empty markers and unreachable servers compatible", async () => {
        const root = project();
        fs.writeFileSync(path.join(root, ".nreki", "sessions", String(process.pid)), "");
        expect((await invoke(root)).code).toBe(0);
        marker(root, crypto.randomBytes(32).toString("hex"));
        expect((await invoke(root)).code).toBe(0);
    });

    it("preserves strict fallback when the server skips an unsupported shape", async () => {
        const root = project();
        fs.writeFileSync(path.join(root, "a.ts"), "export const value = 1;\n".repeat(120));
        await running(root, async () => ({ status: "skip" }));
        const result = await invoke(root, "Replace", { file_path: "a.ts", text: "different API" }, { NREKI_ENFORCE_EDITS: "1" });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("NREKI_ENFORCE_EDITS=1");
    });

    it("does not forward paths outside the project or non-code writes", async () => {
        const root = project();
        let calls = 0;
        await running(root, async () => { calls++; return { status: "deny" }; });
        expect((await invoke(root, "Write", { file_path: "../elsewhere.ts", content: "bad" })).code).toBe(0);
        expect((await invoke(root, "Write", { file_path: "notes.md", content: "text" })).code).toBe(0);
        expect(calls).toBe(0);
    });

    it("authenticates requests and rejects malformed messages without invoking the validator", async () => {
        const root = project();
        let calls = 0;
        const server = await running(root, async () => { calls++; return { status: "allow" }; });
        const wrong = JSON.stringify({ token: "0".repeat(64), tool_name: "Edit", tool_input: {} });
        expect((await send(server.endpoint, wrong)).status).toBe("deny");
        expect((await send(server.endpoint, "{")).status).toBe("deny");
        expect(calls).toBe(0);
    });

    it("fails closed after a connected validator throws", async () => {
        const root = project();
        await running(root, async () => { throw new Error("internal failure"); });
        const result = await invoke(root);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("validation failed");
    });

    it("does not silently allow a malformed response from a connected server", async () => {
        const root = project();
        const endpoint = nativeEditEndpoint(root);
        const server = net.createServer(socket => { socket.on("error", () => {}); socket.once("data", () => socket.end("{\n")); });
        await new Promise<void>(resolve => server.listen(endpoint, resolve));
        cleanups.push(() => server.close());
        marker(root, "a".repeat(64));
        const result = await invoke(root);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("did not complete");
    });

    it("fails closed when a connected validator exceeds its deadline", async () => {
        const root = project();
        const server = await startNativeEditServer(root, () => new Promise(() => {}), { requestTimeoutMs: 50 });
        cleanups.push(() => server.close());
        marker(root, server.token);
        const result = await invoke(root);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("did not complete");
    });

    it("bounds native requests before invoking the validator", async () => {
        const root = project();
        let calls = 0;
        await running(root, async () => { calls++; return { status: "allow" }; });
        const result = await invoke(root, "Write", { file_path: "new.ts", content: "x".repeat(4 * 1024 * 1024) });
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("4 MiB");
        expect(calls).toBe(0);
    });

    it("binds endpoints to canonical project and process identities", () => {
        const a = project(), b = project();
        expect(nativeEditEndpoint(a, 123)).not.toBe(nativeEditEndpoint(b, 123));
        expect(nativeEditEndpoint(a, 123)).not.toBe(nativeEditEndpoint(a, 124));
        expect(nativeEditEndpoint(a, 123)).toBe(nativeEditEndpoint(path.join(a, "."), 123));
    });

    it("ignores metadata endpoints from another project", async () => {
        const a = project(), b = project();
        let calls = 0;
        const server = await running(a, async () => { calls++; return { status: "deny" }; });
        marker(b, server.token, { endpoint: server.endpoint });
        expect((await invoke(b)).code).toBe(0);
        expect(calls).toBe(0);
    });
});
