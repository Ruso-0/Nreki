/**
 * profile-fgcache-populate.ts - Medir boot cost de FastGrepRAMCache.
 *
 * Tres fases:
 *   X: db.exportAllChunksForCache() solo (SQLite SELECT + serializacion).
 *   Y: populate completo (X + buildLineMap por chunk + push a arrays).
 *   Z: validateAgainstDatabase (autotest, NO deberia correr en prod boot
 *      pero lo medimos para auditoria).
 *
 * Reporta P50/P95/P99 por fase + Delta(p99-p50).
 */

import path from "path";
import fs from "fs";
import { NrekiEngine } from "../src/engine.js";
import { FastGrepRAMCache } from "../src/search/fastgrep-cache.js";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "src");
const N = 100;
const WARMUP = 5;

function pct(xs: number[], p: number): number {
    const s = [...xs].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.floor(s.length * p));
    return Math.round(s[idx] * 100) / 100;
}
function stats(xs: number[]): { p50: number; p95: number; p99: number } {
    return { p50: pct(xs, 0.50), p95: pct(xs, 0.95), p99: pct(xs, 0.99) };
}

async function main() {
    const engine = new NrekiEngine({
        dbPath: path.join(ROOT, ".nreki-profile-fgcache.db"),
        watchPaths: [SRC],
    });
    await engine.initialize();

    console.log("Indexing src/ ...");
    const walkIdx = async (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!["node_modules", "dist", ".git"].includes(e.name)) await walkIdx(full);
            } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
                try { await engine.indexFile(full); } catch {}
            }
        }
    };
    await walkIdx(SRC);

    const db = (engine as any).db; // acceso para pruebas

    // Phase X: SQLite export only
    const phaseX: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        db.exportAllChunksForCache();
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseX.push(dt);
    }

    // Phase Y: full populate (recreating cache each iter)
    const phaseY: number[] = [];
    for (let i = 0; i < N; i++) {
        const cache = new FastGrepRAMCache();
        const t0 = performance.now();
        cache.populateFromDatabase(db);
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseY.push(dt);
    }

    // Phase Z: validate (autotest cost)
    const cache = new FastGrepRAMCache();
    cache.populateFromDatabase(db);
    const phaseZ: number[] = [];
    for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        cache.validateAgainstDatabase(db);
        const dt = performance.now() - t0;
        if (i >= WARMUP) phaseZ.push(dt);
    }

    const sX = stats(phaseX);
    const sY = stats(phaseY);
    const sZ = stats(phaseZ);

    const fmt = (s: { p50: number; p95: number; p99: number }) =>
        `p50=${s.p50.toFixed(2).padStart(6)}ms  p95=${s.p95.toFixed(2).padStart(6)}ms  p99=${s.p99.toFixed(2).padStart(6)}ms  Delta(p99-p50)=${(s.p99 - s.p50).toFixed(2).padStart(6)}ms`;

    console.log("");
    console.log("=== FastGrepRAMCache boot cost (cache.size=" + cache.size + ") ===");
    console.log("");
    console.log("X  db.exportAllChunksForCache (SELECT)  " + fmt(sX));
    console.log("Y  populateFromDatabase full            " + fmt(sY));
    console.log("Z  validateAgainstDatabase (autotest)   " + fmt(sZ));
    console.log("");
    console.log("Y - X (in-memory work, lineMap build):  Deltap50=" + (sY.p50 - sX.p50).toFixed(2) + "ms");

    engine.shutdown();
    try { fs.unlinkSync(path.join(ROOT, ".nreki-profile-fgcache.db")); } catch {}
    try { fs.unlinkSync(path.join(ROOT, ".nreki-profile-fgcache.vec")); } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
