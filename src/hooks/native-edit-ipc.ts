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
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => { server.off("error", reject); resolve(); });
    });
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
