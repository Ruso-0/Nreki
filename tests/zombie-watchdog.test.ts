import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Parent watchdog (zombie fix v10.19.0 — orphan detection)", () => {
    let dummyProcess: ChildProcess | null = null;
    let nrekiPid: number | null = null;

    afterEach(() => {
        // Cleanup defensivo: nunca dejar zombies si el test falla
        if (nrekiPid) {
            try { process.kill(nrekiPid, "SIGKILL"); }
            catch { /* already dead */ }
            nrekiPid = null;
        }
        if (dummyProcess && !dummyProcess.killed) {
            try { dummyProcess.kill("SIGKILL"); }
            catch { /* already dead */ }
            dummyProcess = null;
        }
    });

    // Skipped on Windows due to infrastructural flakiness:
    // SIGKILL on dummy parent + Node-on-Windows process.kill(pid, 0)
    // semantics during PID state transition produce non-deterministic
    // results (~50% pass rate observed). Cross-platform fix verified
    // empirically via PASO 5 manual: clicking X on PowerShell window
    // running `nreki --enable-embeddings` kills the process within
    // PARENT_CHECK_MS (sprint v10.19.0, 5/05/2026).
    //
    // Linux/Mac CI: this test should pass deterministically.
    // Windows CI: skipped — manual verification is source of truth.
    it.skipIf(process.platform === "win32")(
        "exits within ~4s when parent process is SIGKILLed",
        async () => {
        const binPath = path.resolve(__dirname, "..", "dist", "index.js");
        if (!fs.existsSync(binPath)) {
            throw new Error(
                `Build artifact not found: ${binPath}\n` +
                `Run 'npm run build' before this test.`
            );
        }

        // Dummy script: spawnea NREKI, reporta PID via stdout, queda vivo
        const dummyScript = [
            "const { spawn } = require('child_process');",
            "const child = spawn(process.argv[1], [process.argv[2]], {",
            "  stdio: ['pipe', 'inherit', 'inherit'],",
            "});",
            "process.stdout.write('NREKI_PID:' + child.pid + '\\n');",
            "setInterval(() => {}, 60000);",
        ].join("\n");

        dummyProcess = spawn(
            process.execPath,
            ["-e", dummyScript, process.execPath, binPath],
            {
                stdio: ["pipe", "pipe", "pipe"],
                cwd: path.resolve(__dirname, ".."),
            }
        );

        // Capturar PID de NREKI (nieto) desde stdout del dummy
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error("Did not receive NREKI PID in 3s")),
                3000
            );
            dummyProcess!.stdout!.on("data", (chunk: Buffer) => {
                const match = chunk.toString().match(/NREKI_PID:(\d+)/);
                if (match) {
                    nrekiPid = parseInt(match[1], 10);
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });

        expect(nrekiPid).toBeTruthy();

        // Esperar boot completo de NREKI
        await new Promise((r) => setTimeout(r, 1500));

        // Matar dummy con SIGKILL. NREKI queda huérfano.
        // En Windows SIGKILL se traduce a TerminateProcess.
        dummyProcess.kill("SIGKILL");

        // Esperar que watchdog detecte (PARENT_CHECK_MS=3000 + 1.5s margen).
        await new Promise((r) => setTimeout(r, 4500));

        // Verificar NREKI muerto via kill(0)
        let nrekiAlive = true;
        try {
            process.kill(nrekiPid!, 0);
        } catch {
            nrekiAlive = false;
        }

        expect(nrekiAlive).toBe(false);

        // Marcar limpio para afterEach
        nrekiPid = null;
        dummyProcess = null;
    }, 12000);
});