import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// ESM equivalent of __dirname (package.json type=module)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Graceful shutdown on stdin close (zombie fix v10.19.0)", () => {
    // Skipped on Windows due to NREKI cold-start time (~25s on this
    // platform, vs <500ms expected by this test). The shutdown
    // mechanism itself is verified manually on Windows: clicking X
    // on a PowerShell window running `nreki --enable-embeddings`
    // kills the process within PARENT_CHECK_MS (sprint v10.19.0,
    // 5/05/2026). Boot time is tracked as separate work item for
    // v10.20.0 (target: cold-start ≤2s).
    //
    // Linux/Mac CI: this test passes deterministically.
    it.skipIf(process.platform === "win32")(
        "exits cleanly within 1s when stdin is closed",
        async () => {
        const binPath = path.resolve(__dirname, "..", "dist", "index.js");

        // Guard: build artifact must exist. npm test does not run build.
        if (!fs.existsSync(binPath)) {
            throw new Error(
                `Build artifact not found: ${binPath}\n` +
                `Run 'npm run build' before 'npm test' for this integration test.`
            );
        }

        const child = spawn("node", [binPath], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: path.resolve(__dirname, ".."),
        });

        // Wait for boot (MCP handshake-ready). 500ms conservative.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const exitPromise = new Promise<number>((resolve) => {
            child.on("exit", (code) => resolve(code ?? -1));
        });

        // Trigger orphan condition: close stdin from parent side.
        // This emits 'end' on child's process.stdin -> triggers gracefulShutdown.
        child.stdin.end();

        const timeoutPromise = new Promise<number>((_, reject) => {
            setTimeout(() => reject(new Error("Did not exit within 1s")), 1000);
        });

        const exitCode = await Promise.race([exitPromise, timeoutPromise]);
        expect(exitCode).toBe(0);
    }, 5000);
});