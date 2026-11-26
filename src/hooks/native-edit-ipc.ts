import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { z } from "zod";

export interface NativeEditRequest {
    tool_name: string;
    tool_input: Record<string, unknown>;
}

export interface NativeEditResponse {
    status: "allow" | "deny" | "skip";
    error?: string;
}

export interface NativeEditServer {
    endpoint: string;
    token: string;
    close(): void;
}

const MAX_BYTES = 4 * 1024 * 1024;
const requestSchema = z.object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    tool_name: z.string().max(40),
    tool_input: z.record(z.unknown()),
});

/** Project-bound address; metadata cannot redirect the hook to arbitrary sockets. */
export function nativeEditEndpoint(root: string, pid: number = process.pid): string {
    let canonical = fs.realpathSync(root).replace(/\\/g, "/");
    if (process.platform === "win32" || process.platform === "darwin") canonical = canonical.toLowerCase();
    const id = crypto.createHash("sha256").update(`${canonical}\0${pid}`).digest("hex").slice(0, 32);
    return process.platform === "win32"
        ? `\\\\.\\pipe\\nreki-edit-${id}`
        : path.join(os.tmpdir(), `nreki-edit-${id}.sock`);
}

function listenOnce(server: net.Server, endpoint: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
            server.off("listening", onListening);
            reject(err);
        };
        const onListening = (): void => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(endpoint);
    });
}

async function isUnixSocketStale(endpoint: string): Promise<boolean> {
    try {
        if (!fs.lstatSync(endpoint).isSocket()) return false;
    } catch {
        return false;
    }
    return new Promise<boolean>(resolve => {
        const probe = net.createConnection(endpoint);
        let settled = false;
        const done = (stale: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            probe.destroy();
            resolve(stale);
        };
        const timer = setTimeout(() => done(false), 250);
        timer.unref();
        probe.once("connect", () => done(false));
        probe.once("error", (err: NodeJS.ErrnoException) => {
            done(err.code === "ECONNREFUSED" || err.code === "ENOENT");
        });
    });
}

export async function listenWithStaleSocketRecovery(server: net.Server, endpoint: string): Promise<void> {
    try {
        await listenOnce(server, endpoint);
    } catch (err) {
        if (process.platform === "win32" || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
            throw err;
        }
        if (!await isUnixSocketStale(endpoint)) throw err;
        try { fs.unlinkSync(endpoint); } catch { throw err; }
        await listenOnce(server, endpoint);
    }
}

/** One request per local connection. Never writes project content. */
export async function startNativeEditServer(
    root: string,
    validate: (request: NativeEditRequest) => Promise<NativeEditResponse>,
    options: { requestTimeoutMs?: number } = {},
): Promise<NativeEditServer> {
    const endpoint = nativeEditEndpoint(root);
    const token = crypto.randomBytes(32).toString("hex");
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        const timer = setTimeout(() => socket.destroy(), options.requestTimeoutMs ?? 30_000);
        timer.unref();
        socket.on("error", () => { /* client disappeared */ });
        socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); });
        let buffer = Buffer.alloc(0);
        let handled = false;
        const reply = (response: NativeEditResponse): void => {
            if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n");
        };
        socket.on("data", chunk => {
            if (handled) return;
            if (buffer.length + chunk.length > MAX_BYTES) {
                handled = true;
                reply({ status: "deny", error: "NREKI: native edit exceeds the 4 MiB IPC limit. Use batch_edit." });
                return;
            }
            buffer = Buffer.concat([buffer, chunk]);
            const end = buffer.indexOf(10);
            if (end < 0) return;
            handled = true;
            void (async () => {
                try {
                    const parsed = requestSchema.safeParse(JSON.parse(buffer.subarray(0, end).toString("utf8")));
                    if (!parsed.success || !crypto.timingSafeEqual(Buffer.from(parsed.data.token), Buffer.from(token))) {
                        reply({ status: "deny", error: "NREKI: invalid native-edit IPC request or session token." });
                        return;
                    }
                    reply(await validate({ tool_name: parsed.data.tool_name, tool_input: parsed.data.tool_input }));
                } catch {
                    reply({ status: "deny", error: "NREKI: native-edit validation failed. Use batch_edit to retry safely." });
                }
            })();
        });
    });
    server.maxConnections = 16;
    await listenWithStaleSocketRecovery(server, endpoint);
    server.on("error", () => { /* an unavailable endpoint must not crash MCP */ });
    try {
        if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
    } catch (error) {
        server.close();
        throw error;
    }
    server.unref();
    return { endpoint, token, close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}
