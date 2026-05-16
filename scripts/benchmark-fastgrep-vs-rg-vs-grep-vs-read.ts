/**
 * benchmark-fastgrep-vs-rg-vs-grep-vs-read.ts
 *
 * Four-way latency comparison:
 *   - nreki fast_grep  (SQLite-indexed substring search)
 *   - ripgrep          (mmap, parallel, regex-engine baseline)
 *   - grep             (POSIX baseline)
 *   - read             (naive fs.readFileSync + String.indexOf scan in Node;
 *                       simulates the LLM agent "Read every file then look for X" workflow)
 *
 * Methodology:
 *   - 5 queries x 10 iterations
 *   - First iteration discarded as warmup
 *   - P50 / P99 / mean / min / max
 *
 * Run:
 *   npx tsx scripts/benchmark-fastgrep-vs-rg-vs-grep-vs-read.ts
 */

import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { NrekiEngine } from "../src/engine.js";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const N_ITER = 100;
const WARMUP_DISCARD = 5;

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
    if (values.length === 0) return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return {
        p50: Math.round(percentile(sorted, 50) * 100) / 100,
        p95: Math.round(percentile(sorted, 95) * 100) / 100,
        p99: Math.round(percentile(sorted, 99) * 100) / 100,
        mean: Math.round(mean * 100) / 100,
        min: Math.round(sorted[0] * 100) / 100,
        max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    };
}

function sumColonCount(stdout: string): number {
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

function collectFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!["node_modules", "dist", ".git"].includes(e.name)) stack.push(full);
            } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
                out.push(full);
            }
        }
    }
    return out;
}

function naiveReadGrep(files: string[], pattern: string): number {
    let total = 0;
    const plen = pattern.length;
    for (const f of files) {
        let buf: string;
        try { buf = fs.readFileSync(f, "utf8"); } catch { continue; }
        let from = 0;
        while (true) {
            const idx = buf.indexOf(pattern, from);
            if (idx < 0) break;
            total++;
            from = idx + plen;
        }
    }
    return total;
}

async function main() {
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

    console.log("=== fast_grep vs ripgrep vs grep vs read benchmark ===");
    console.log("ripgrep  :", rgVersionLine, "(" + RG_PATH + ")");
    console.log("grep     :", grepVersionLine, "(" + GREP_PATH + ")");
    console.log("read     : Node " + process.version + " fs.readFileSync + String.indexOf");
    console.log("Root     :", ROOT, "| Source:", SRC);
    console.log("Iterations per query:", N_ITER, "(first", WARMUP_DISCARD, "discarded)");
    console.log("");

    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-benchmark-4way.db"),
        watchPaths: [SRC],
    });
    await engine.initialize();

    console.log("Indexing src/ ...");
    const idxStart = performance.now();
    const files = collectFiles(SRC);
    for (const f of files) {
        try { await engine.indexFile(f); } catch { /* skip */ }
    }
    const idxMs = Math.round(performance.now() - idxStart);
    console.log("Indexed", files.length, "files in", idxMs, "ms\n");

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
        read: RowStats;
        speedup_fast_vs_rg: number;
        speedup_fast_vs_grep: number;
        speedup_fast_vs_read: number;
        speedup_rg_vs_read: number;
        speedup_grep_vs_read: number;
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
                rgMatches = res.status === 0 ? sumColonCount(res.stdout || "") : 0;
            }
        }

        // grep
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
                grepMatches = (res.status === 0 || res.status === 1) ? sumColonCount(res.stdout || "") : 0;
            }
        }

        // read (naive fs.readFileSync + String.indexOf)
        const readTimes: number[] = [];
        let readMatches = 0;
        for (let i = 0; i < N_ITER; i++) {
            const t0 = performance.now();
            const n = naiveReadGrep(files, q.pattern);
            const dt = performance.now() - t0;
            if (i >= WARMUP_DISCARD) {
                readTimes.push(dt);
                readMatches = n;
            }
        }

        const fs_ = stats(fastTimes);
        const rs = stats(rgTimes);
        const gs = stats(grepTimes);
        const rd = stats(readTimes);
        const sFastRg = rs.p50 > 0 && fs_.p50 > 0 ? Math.round((rs.p50 / fs_.p50) * 100) / 100 : 0;
        const sFastGrep = gs.p50 > 0 && fs_.p50 > 0 ? Math.round((gs.p50 / fs_.p50) * 100) / 100 : 0;
        const sFastRead = rd.p50 > 0 && fs_.p50 > 0 ? Math.round((rd.p50 / fs_.p50) * 100) / 100 : 0;
        const sRgRead = rd.p50 > 0 && rs.p50 > 0 ? Math.round((rd.p50 / rs.p50) * 100) / 100 : 0;
        const sGrepRead = rd.p50 > 0 && gs.p50 > 0 ? Math.round((rd.p50 / gs.p50) * 100) / 100 : 0;

        console.log("  fast_grep: P50=" + fs_.p50 + "ms  P95=" + fs_.p95 + "ms  P99=" + fs_.p99 + "ms  matches=" + fastMatches);
        console.log("  ripgrep  : P50=" + rs.p50 + "ms  P95=" + rs.p95 + "ms  P99=" + rs.p99 + "ms  matches=" + rgMatches);
        console.log("  grep     : P50=" + gs.p50 + "ms  P95=" + gs.p95 + "ms  P99=" + gs.p99 + "ms  matches=" + grepMatches);
        console.log("  read     : P50=" + rd.p50 + "ms  P95=" + rd.p95 + "ms  P99=" + rd.p99 + "ms  matches=" + readMatches);
        console.log("  Speedup fast_grep vs rg   (P50): " + sFastRg + "x");
        console.log("  Speedup fast_grep vs grep (P50): " + sFastGrep + "x");
        console.log("  Speedup fast_grep vs read (P50): " + sFastRead + "x");
        console.log("  Speedup ripgrep   vs read (P50): " + sRgRead + "x");
        console.log("  Speedup grep      vs read (P50): " + sGrepRead + "x\n");

        results[q.name] = {
            pattern: q.pattern,
            fast: { ...fs_, matches: fastMatches },
            rg:   { ...rs,  matches: rgMatches },
            grep: { ...gs,  matches: grepMatches },
            read: { ...rd,  matches: readMatches },
            speedup_fast_vs_rg: sFastRg,
            speedup_fast_vs_grep: sFastGrep,
            speedup_fast_vs_read: sFastRead,
            speedup_rg_vs_read: sRgRead,
            speedup_grep_vs_read: sGrepRead,
        };
    }

    const renderTable = (label: string, key: "p50" | "p95" | "p99") => {
        console.log("=== Summary (" + label + " ms) ===");
        console.log(
            "query".padEnd(12)
            + "fast_grep".padStart(12)
            + "ripgrep".padStart(12)
            + "grep".padStart(12)
            + "read".padStart(12)
            + "fg/rg".padStart(10)
            + "fg/grep".padStart(10)
            + "fg/read".padStart(10)
        );
        for (const q of QUERIES) {
            const r = results[q.name];
            const fg = r.fast[key];
            const rg = r.rg[key];
            const gp = r.grep[key];
            const rd = r.read[key];
            const sFastRg = rg > 0 && fg > 0 ? Math.round((rg / fg) * 100) / 100 : 0;
            const sFastGrep = gp > 0 && fg > 0 ? Math.round((gp / fg) * 100) / 100 : 0;
            const sFastRead = rd > 0 && fg > 0 ? Math.round((rd / fg) * 100) / 100 : 0;
            console.log(
                q.name.padEnd(12)
                + String(fg).padStart(12)
                + String(rg).padStart(12)
                + String(gp).padStart(12)
                + String(rd).padStart(12)
                + (sFastRg + "x").padStart(10)
                + (sFastGrep + "x").padStart(10)
                + (sFastRead + "x").padStart(10)
            );
        }
        console.log("");
    };

    renderTable("P50", "p50");
    renderTable("P95", "p95");
    renderTable("P99", "p99");

    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const outFile = "scripts/benchmark-4way-" + date + ".json";
    fs.writeFileSync(outFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        baselines: ["ripgrep", "grep", "read"],
        ripgrep_version: rgVersionLine,
        ripgrep_path: RG_PATH,
        grep_version: grepVersionLine,
        grep_path: GREP_PATH,
        node_version: process.version,
        root: ROOT,
        source: SRC,
        files_indexed: files.length,
        iterations: N_ITER,
        warmup_discarded: WARMUP_DISCARD,
        index_ms: idxMs,
        results,
    }, null, 2));
    console.log("\nSaved " + outFile);

    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-4way.db")); } catch {}
    try { fs.unlinkSync(path.join(ROOT, ".nreki-benchmark-4way.vec")); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
