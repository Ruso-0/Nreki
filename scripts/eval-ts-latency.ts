/**
 * scripts/eval-ts-latency.ts
 *
 * Phase 1 — E3 kill-criterion script.
 * Mide latencia P50/P95/P99 de NREKI's TsCompilerWrapper.getTypeShape()
 * sobre un corpus realista, con harness completo:
 *   new TsCompilerWrapper()
 *     → wrapper.initConfig(corpusDir)
 *     → wrapper.createCompilerInfra(corpusDir, vfsAdapter)
 *     → wrapper.updateProgram()           // pay cold-start ANTES del loop
 *     → loop de wrapper.getTypeShape(...)  // measurement window
 *
 * Kill criterion: P95 >400ms → ABORT_SPRINT.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import {
    TsCompilerWrapper,
    type VfsAdapter,
} from "../src/kernel/backends/ts-compiler-wrapper.js";

function toPosix(p: string): string {
    return p.replace(/\\/g, "/");
}

function makeDiskVfsAdapter(): VfsAdapter {
    // Static read-only passthrough. Since the corpus does not mutate
    // during the benchmark, getScriptVersion can return a constant.
    return {
        readFile(fileName: string): string | undefined {
            try {
                return fs.readFileSync(fileName, "utf-8");
            } catch {
                return undefined;
            }
        },
        fileExists(fileName: string): boolean {
            try {
                return fs.statSync(fileName).isFile();
            } catch {
                return false;
            }
        },
        getModifiedTime(fileName: string): Date {
            try {
                return fs.statSync(fileName).mtime;
            } catch {
                return new Date(0);
            }
        },
        directoryExists(dirName: string): boolean {
            try {
                return fs.statSync(dirName).isDirectory();
            } catch {
                return false;
            }
        },
        getScriptVersion(_fileName: string): string {
            return "1";
        },
        getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
            try {
                const text = fs.readFileSync(fileName, "utf-8");
                return ts.ScriptSnapshot.fromString(text);
            } catch {
                return undefined;
            }
        },
    };
}

function collectTsFiles(dir: string, maxFiles: number): string[] {
    const out: string[] = [];
    const queue: string[] = [dir];
    while (queue.length > 0 && out.length < maxFiles) {
        const current = queue.shift()!;
        if (current.includes("node_modules") || current.includes(".git")) continue;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(full);
            } else if (
                entry.isFile() &&
                (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
                !entry.name.endsWith(".d.ts") &&
                !entry.name.endsWith(".test.ts") &&
                !entry.name.endsWith(".spec.ts")
            ) {
                out.push(full);
                if (out.length >= maxFiles) break;
            }
        }
    }
    return out;
}

function collectQueryTargets(
    dir: string,
    maxTargets: number,
): { file: string; symbol: string }[] {
    const out: { file: string; symbol: string }[] = [];
    const files = collectTsFiles(dir, 500);
    for (const file of files) {
        if (out.length >= maxTargets) break;
        let source: string;
        try {
            source = fs.readFileSync(file, "utf-8");
        } catch {
            continue;
        }
        const matches = source.matchAll(/export\s+function\s+(\w+)/g);
        for (const m of matches) {
            out.push({ file: toPosix(file), symbol: m[1] });
            if (out.length >= maxTargets) break;
        }
    }
    return out;
}

async function main(): Promise<void> {
    const corpusDir = process.argv[2];
    if (!corpusDir) {
        console.error("Usage: tsx scripts/eval-ts-latency.ts <corpus-dir>");
        process.exit(1);
    }
    const absCorpus = path.resolve(corpusDir);

    console.log("Initializing TsCompilerWrapper harness...");
    const initStart = Date.now();

    const wrapper = new TsCompilerWrapper();
    wrapper.initConfig(absCorpus);

    const vfs = makeDiskVfsAdapter();
    wrapper.createCompilerInfra(absCorpus, vfs);

    // Cold-start: pay it BEFORE measurement window.
    wrapper.updateProgram();

    const initMs = Date.now() - initStart;
    console.log(`Init+cold-start took ${initMs}ms`);

    const targets = collectQueryTargets(absCorpus, 100);
    console.log(`Querying ${targets.length} type shapes...`);

    const latencies: number[] = [];
    let nonNullCount = 0;
    for (const t of targets) {
        const start = process.hrtime.bigint();
        let shape: string | null = null;
        try {
            shape = wrapper.getTypeShape(t.file, t.symbol);
        } catch {
            // Individual failure does not block benchmark.
        }
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        latencies.push(elapsedMs);
        if (shape !== null) nonNullCount++;
    }

    if (latencies.length === 0) {
        console.error("No targets collected — cannot compute latency stats.");
        process.exit(1);
    }

    latencies.sort((a, b) => a - b);
    const pick = (q: number): number =>
        latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
    const p50 = pick(0.5);
    const p95 = pick(0.95);
    const p99 = pick(0.99);
    const max = latencies[latencies.length - 1];

    const report = {
        corpus: absCorpus,
        initMs,
        queries: latencies.length,
        nonNullResults: nonNullCount,
        p50: p50.toFixed(1) + "ms",
        p95: p95.toFixed(1) + "ms",
        p99: p99.toFixed(1) + "ms",
        max: max.toFixed(1) + "ms",
        killCriterion: p95 > 400 ? "ABORT_SPRINT" : "PROCEED",
    };

    console.log("\n=== TS COMPILER LATENCY REPORT ===");
    console.log(JSON.stringify(report, null, 2));

    fs.writeFileSync(
        path.join("scripts", "eval-ts-latency-report.json"),
        JSON.stringify(report, null, 2),
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
