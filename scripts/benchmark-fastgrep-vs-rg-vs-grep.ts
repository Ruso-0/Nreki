/**
 * benchmark-fastgrep-vs-rg-vs-grep.ts
 *
 * Three-way latency comparison: nreki fast_grep vs ripgrep vs native grep.
 *
 * Methodology mirrors scripts/benchmark-fastgrep-vs-rg.ts:
 *   - 5 queries x 10 iterations
 *   - First iteration discarded as warmup
 *   - P50 / P99 / mean / min / max
 *
 * Run:
 *   npx tsx scripts/benchmark-fastgrep-vs-rg-vs-grep.ts
 *   RG_PATH=... GREP_PATH=... npx tsx scripts/benchmark-fastgrep-vs-rg-vs-grep.ts
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { NrekiEngine } from "../src/engine.js";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const N_ITER = 10;
const WARMUP_DISCARD = 1;

const RG_PATH = process.env.RG_PATH
    || (process.platform === "win32"
        ? "/tmp/rg-bench/node_modules/@vscode/ripgrep/bin/rg.exe"
        : "rg");

const GREP_PATH = process.env.GREP_PATH
    || (process.platform === "win32"
        ? "C:/Program Files/Git/usr/bin/grep.exe"
        : "grep");

const QUERIES = [
    { name: "common",   pattern: "export" },
    { name: "specific", pattern: "chronosMemory" },
    { name: "function", pattern: "findDefinition" },
    { name: "string",   pattern: "[OK]" },
    { name: "rare",     pattern: "TTRD_BOUNTY" },
];

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function stats(values: number[]) {
    if (values.length === 0) return { p50: 0, p99: 0, mean: 0, min: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return {
        p50: Math.round(percentile(sorted, 50) * 100) / 100,
        p99: Math.round(percentile(sorted, 99) * 100) / 100,
        mean: Math.round(mean * 100) / 100,
        min: Math.round(sorted[0] * 100) / 100,
        max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    };
}

function rgMatchCount(stdout: string): number {
    if (!stdout) return 0;
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
        const idx = line.lastIndexOf(":");
        if (idx < 0) continue;
        const n = parseInt(line.slice(idx + 1), 10);
        if (!isNaN(n)) total += n;
    }
    return total;
}

function grepMatchCount(stdout: string): number {
    // grep -rcF outputs "<file>:<count>" per file. Sum them.
    if (!stdout) return 0;
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
        const idx = line.lastIndexOf(":");
        if (idx < 0) continue;
        const n = parseInt(line.slice(idx + 1), 10);
        if (!isNaN(n)) total += n;
    }
    return total;
}

async function main() {
    // Verify both external binaries before doing anything expensive.
    const rgVer = spawnSync(RG_PATH, ["--version"], { encoding: "utf8" });
    if (rgVer.status !== 0) {
        console.error("ripgrep not runnable at:", RG_PATH);
        process.exit(1);
    }
    const rgVersionLine = (rgVer.stdout || "").split(/\r?\n/)[0];

    const grepVer = spawnSync(GREP_PATH, ["--version"], { encoding: "utf8" });
    if (grepVer.status !== 0) {
        console.error("grep not runnable at:", GREP_PATH);
        process.exit(1);
    }
    const grepVersionLine = (grepVer.stdout || "").split(/\r?\n/)[0];

    console.log("=== fast_grep vs ripgrep vs grep benchmark ===");
    console.log("ripgrep  :", rgVersionLine, "(" + RG_PATH + ")");
    console.log("grep     :", grepVersionLine, "(" + GREP_PATH + ")");
    console.log("Root     :", ROOT, "| Source:", SRC);
    console.log("Iterations per query:", N_ITER, "(first", WARMUP_DISCARD, "discarded)");
    console.log("");

    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-benchmark-3way.db"),
        watchPaths: [SRC],
    });
    await engine.initialize();

    console.log("Indexing src/ ...");
    const idxStart = performance.now();
    const walkAndIndex = async (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!["node_modules", "dist", ".git"].includes(entry.name)) await walkAndIndex(full);
            } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                try { await engine.indexFile(full); } catch { /* skip */ }
            }
        }
    };
    await walkAndIndex(SRC);
    const idxMs = Math.round(performance.now() - idxStart);
    console.log("Indexed in", idxMs, "ms\n");

    const RG_BASE_ARGS = [
        "--no-config",
        "--no-ignore-vcs",
        "--no-ignore-dot",
        "--type-add", "src:*.ts",
        "--type-add", "src:*.tsx",
        "--type-add", "src:*.js",
        "--type-add", "src:*.jsx",
        "--type-add", "src:*.mjs",
        "--type", "src",
        "-g", "!node_modules",
        "-g", "!dist",
        "-g", "!.git",
        "-g", "!*.d.ts",
        "-F",
        "-c",
    ];

    // grep flags chosen for fairness:
    //   -r            recursive
    //   -F            literal pattern
    //   -c            count matching lines per file (no piping output)
    //   --include     restrict to fast_grep's indexed extensions
    //   --exclude-dir mirror walker's exclusions
    //   --exclude     skip .d.ts (fast_grep does too)
    const GREP_BASE_ARGS = [
        "-r",
        "-F",
        "-c",
        "--include=*.ts",
        "--include=*.tsx",
        "--include=*.js",
        "--include=*.jsx",
        "--include=*.mjs",
        "--exclude=*.d.ts",
        "--exclude-dir=node_modules",
        "--exclude-dir=dist",
        "--exclude-dir=.git",
    ];

    type RowStats = ReturnType<typeof stats> & { matches: number };
    const results: Record<string, {
        pattern: string;
        fast: RowStats;
        rg: RowStats;
        grep: RowStats;
        speedup_fast_vs_rg: number;
        speedup_fast_vs_grep: number;
        speedup_rg_vs_grep: number;
    }> = {};

    for (const q of QUERIES) {
        console.log("--- Query: " + q.name + " | pattern: \"" + q.pattern + "\" ---");

        // fast_grep
        const fastTimes: number[] = [];
        let fastMatches = 0;
        for (let i = 0; i < N_ITER; i++) {
            const t0 = performance.now();
            const chunks = await engine.fastGrep(q.pattern, 1000);
            const dt = performance.now() - t0;
            if (i >= WARMUP_DISCARD) {
                fastTimes.push(dt);
                fastMatches = chunks.length;
            }
        }

        // ripgrep
        const rgTimes: number[] = [];
        let rgMatches = 0;
        for (let i = 0; i < N_ITER; i++) {
            const t0 = performance.now();
            const res = spawnSync(
                RG_PATH,
                [...RG_BASE_ARGS, q.pattern, SRC],
                { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
            );
            const dt = performance.now() - t0;
            if (i >= WARMUP_DISCARD) {
                rgTimes.push(dt);
                rgMatches = res.status === 0 ? rgMatchCount(res.stdout || "") : 0;
            }
        }

        // native grep
        const grepTimes: number[] = [];
        let grepMatches = 0;
        for (let i = 0; i < N_ITER; i++) {
            const t0 = performance.now();
            const res = spawnSync(
                GREP_PATH,
                [...GREP_BASE_ARGS, q.pattern, SRC],
                { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
            );
            const dt = performance.now() - t0;
            if (i >= WARMUP_DISCARD) {
                grepTimes.push(dt);
                // grep returns 1 when no matches, 0 when matches, 2 on error
                grepMatches = (res.status === 0 || res.status === 1) ? grepMatchCount(res.stdout || "") : 0;
            }
        }

        const fs_ = stats(fastTimes);
        const rs = stats(rgTimes);
        const gs = stats(grepTimes);
        const sFastRg = rs.p50 > 0 && fs_.p50 > 0 ? Math.round((rs.p50 / fs_.p50) * 100) / 100 : 0;
        const sFastGrep = gs.p50 > 0 && fs_.p50 > 0 ? Math.round((gs.p50 / fs_.p50) * 100) / 100 : 0;
        const sRgGrep = gs.p50 > 0 && rs.p50 > 0 ? Math.round((gs.p50 / rs.p50) * 100) / 100 : 0;

        console.log("  fast_grep: P50=" + fs_.p50 + "ms  P99=" + fs_.p99 + "ms  matches=" + fastMatches);
        console.log("  ripgrep  : P50=" + rs.p50 + "ms  P99=" + rs.p99 + "ms  matches=" + rgMatches);
        console.log("  grep     : P50=" + gs.p50 + "ms  P99=" + gs.p99 + "ms  matches=" + grepMatches);
        console.log("  Speedup fast_grep vs rg   (P50): " + sFastRg + "x");
        console.log("  Speedup fast_grep vs grep (P50): " + sFastGrep + "x");
        console.log("  Speedup ripgrep   vs grep (P50): " + sRgGrep + "x\n");

        results[q.name] = {
            pattern: q.pattern,
            fast: { ...fs_, matches: fastMatches },
            rg:   { ...rs,  matches: rgMatches },
            grep: { ...gs,  matches: grepMatches },
            speedup_fast_vs_rg: sFastRg,
            speedup_fast_vs_grep: sFastGrep,
            speedup_rg_vs_grep: sRgGrep,
        };
    }

    // Summary table
    console.log("=== Summary (P50 ms) ===");
    console.log("query".padEnd(12) + "fast_grep".padStart(12) + "ripgrep".padStart(12) + "grep".padStart(12)
        + "fg/rg".padStart(10) + "fg/grep".padStart(10));
    for (const q of QUERIES) {
        const r = results[q.name];
        console.log(
            q.name.padEnd(12)
            + String(r.fast.p50).padStart(12)
            + String(r.rg.p50).padStart(12)
            + String(r.grep.p50).padStart(12)
            + (r.speedup_fast_vs_rg + "x").padStart(10)
            + (r.speedup_fast_vs_grep + "x").padStart(10)
        );
    }

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const outFile = "scripts/benchmark-3way-" + date + ".json";
    fs.writeFileSync(outFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        baselines: ["ripgrep", "grep"],
        ripgrep_version: rgVersionLine,
        ripgrep_path: RG_PATH,
        grep_version: grepVersionLine,
        grep_path: GREP_PATH,
        root: ROOT,
        iterations: N_ITER,
        warmup_discarded: WARMUP_DISCARD,
        index_ms: idxMs,
        results,
    }, null, 2));
    console.log("\nSaved " + outFile);

    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-3way.db")); } catch {}
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-3way.vec")); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
