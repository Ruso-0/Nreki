const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const binPath = path.resolve(__dirname, "..", "dist", "index.js");
const RUNS = 5;
const results = [];

async function measureOne(runNum) {
    return new Promise((resolve, reject) => {
        const start = process.hrtime.bigint();
        const child = spawn("node", [binPath], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        let bootDetected = false;
        const TIMEOUT = 30000;
        const timer = setTimeout(() => {
            if (!bootDetected) {
                child.kill("SIGKILL");
                reject(new Error(`Run ${runNum}: boot timeout 30s`));
            }
        }, TIMEOUT);

        // El boot está completo cuando aparece "File watcher started"
        // (último log de boot según los outputs que vi en sesión).
        child.stderr.on("data", (chunk) => {
            const txt = chunk.toString();
            if (txt.includes("File watcher started") && !bootDetected) {
                bootDetected = true;
                const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
                clearTimeout(timer);
                child.kill("SIGKILL");
                resolve(elapsed);
            }
        });
        // También probar stdout por si los logs van ahí
        child.stdout.on("data", (chunk) => {
            const txt = chunk.toString();
            if (txt.includes("File watcher started") && !bootDetected) {
                bootDetected = true;
                const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
                clearTimeout(timer);
                child.kill("SIGKILL");
                resolve(elapsed);
            }
        });

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

(async () => {
    console.log(`Measuring NREKI boot time, ${RUNS} cold-start runs...`);
    for (let i = 1; i <= RUNS; i++) {
        try {
            const ms = await measureOne(i);
            results.push(ms);
            console.log(`Run ${i}: ${ms.toFixed(1)}ms`);
        } catch (err) {
            console.log(`Run ${i}: FAILED — ${err.message}`);
            results.push(null);
        }
        await new Promise(r => setTimeout(r, 500)); // gap entre runs
    }

    const valid = results.filter(r => r !== null).sort((a, b) => a - b);
    console.log("\n--- Results ---");
    console.log(`Successful: ${valid.length}/${RUNS}`);
    console.log(`Min: ${valid[0]?.toFixed(1)}ms`);
    console.log(`Median: ${valid[Math.floor(valid.length / 2)]?.toFixed(1)}ms`);
    console.log(`Max: ${valid[valid.length - 1]?.toFixed(1)}ms`);
})();