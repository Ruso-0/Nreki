/**
 * scripts/benchmark-hybrid-smoke.ts
 *
 * Phase 5.5.2 dogfood smoke benchmark: action="search" vs action="hybrid_search"
 * on NREKI's own src/ tree. Honest empirical comparison for v11.2.0 release —
 * NOT a substitute for the Sprint 6.5 N=99 PolyBench re-benchmark (deferred,
 * documented in docs/sprint-6.5-empirical.md).
 *
 * What this measures
 *   - Hit on a curated truth set of (query, expected_file) pairs
 *   - Total tokens returned per query (real BPE via tiktoken cl100k_base)
 *   - Whether hybrid_search surfaces files that search alone misses
 *
 * Run with: npx tsx scripts/benchmark-hybrid-smoke.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { NrekiEngine } from "../src/engine.js";
import { estimateTokens } from "../src/utils/token-estimator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

interface TruthCase {
    query: string;
    expectedFiles: string[];
    note: string;
}

// Paths relative to src/ (the indexed root). NREKI semantic and BM25 lexical
// both emit src-relative paths since we set watchPaths=[src/].
const TRUTH_SET: TruthCase[] = [
    {
        query: "BM25 lexical retrieval engine with Okapi scoring",
        expectedFiles: ["bm25-engine.ts"],
        note: "Phase 5.5.2 new module — semantic + lexical signals both relevant",
    },
    {
        query: "RRF fusion file level Reciprocal Rank",
        expectedFiles: ["hybrid-engine.ts"],
        note: "Pure lexical: 'RRF' is a literal acronym",
    },
    {
        query: "tfcCompress foveal compression",
        expectedFiles: ["compressor-foveal.ts"],
        note: "Symbol name + concept; NREKI semantic should win",
    },
    {
        query: "kernel interceptAtomicBatch cross-file semantic verification",
        expectedFiles: ["kernel/nreki-kernel.ts", "handlers/code/edit.ts"],
        note: "Multi-file fact: kernel hosts, edit handler calls",
    },
    {
        query: "estimateTokens tiktoken cl100k_base",
        expectedFiles: ["utils/token-estimator.ts"],
        note: "Direct identifier reference",
    },
    {
        query: "chronos high friction file blocker",
        expectedFiles: ["handlers/code/edit.ts", "chronos-memory.ts"],
        note: "Concept that spans handler + module",
    },
    {
        query: "TTRD type technical debt registry regression",
        expectedFiles: ["handlers/code/kernel-bridge.ts"],
        note: "Acronym + concept — BM25 should help",
    },
    {
        query: "Fiedler bridge guard v2 spectral",
        expectedFiles: ["handlers/code/edit.ts"],
        note: "Math symbol 'v2' plus concept",
    },
];

interface RunResult {
    query: string;
    expected: string[];
    searchHits: string[];
    hybridHits: string[];
    searchTokens: number;
    hybridTokens: number;
    searchHitCount: number;
    hybridHitCount: number;
    searchLatencyMs: number;
    hybridLatencyMs: number;
}

function hits(retrieved: string[], expected: string[]): number {
    const expSet = new Set(expected);
    let c = 0;
    for (const r of retrieved) if (expSet.has(r)) c++;
    return c;
}

async function runQuery(engine: NrekiEngine, tc: TruthCase): Promise<RunResult> {
    const topK = 5;
    const projectRoot = engine.getProjectRoot();

    // action="search"
    const t0 = Date.now();
    const searchRaw = await engine.search(tc.query, topK);
    const searchT = Date.now() - t0;
    const searchHits = [...new Set(searchRaw.map(r =>
        path.relative(projectRoot, r.path).split(path.sep).join("/"),
    ))];
    const searchPayload = searchRaw.map(r => r.rawCode).join("\n");
    const searchTokens = estimateTokens(searchPayload);

    // action="hybrid_search"
    const hybrid = await engine.getHybridEngine();
    const t1 = Date.now();
    const hybridRaw = await hybrid.search(tc.query, { topK, applyFovealOnBm25: true });
    const hybridT = Date.now() - t1;
    const hybridHits = [...new Set(hybridRaw.map(r => r.path))];
    const hybridPayload = hybridRaw.map(r => r.content).join("\n");
    const hybridTokens = estimateTokens(hybridPayload);

    return {
        query: tc.query,
        expected: tc.expectedFiles,
        searchHits,
        hybridHits,
        searchTokens,
        hybridTokens,
        searchHitCount: hits(searchHits, tc.expectedFiles),
        hybridHitCount: hits(hybridHits, tc.expectedFiles),
        searchLatencyMs: searchT,
        hybridLatencyMs: hybridT,
    };
}

async function main(): Promise<void> {
    console.log("Phase 5.5.2 dogfood smoke benchmark — search vs hybrid_search\n");
    console.log(`Corpus: ${REPO_ROOT}`);
    console.log(`Truth set: ${TRUTH_SET.length} curated (query, expected_files) pairs\n`);

    // Scope to src/ so BM25 walk + NREKI search both stay tight and the
    // bench finishes in seconds. Truth set uses src-relative paths.
    const SRC_DIR = path.join(REPO_ROOT, "src");
    const engine = new NrekiEngine({
        dbPath: path.join(REPO_ROOT, ".nreki-bench-hybrid.db"),
        watchPaths: [SRC_DIR],
    });

    await engine.initialize();
    console.log("Indexing src/ ...");
    const idx = await engine.indexDirectory(SRC_DIR);
    console.log(`Indexed ${idx.indexed} files, skipped ${idx.skipped}, errors ${idx.errors}\n`);

    const results: RunResult[] = [];
    let totalExpected = 0;
    let totalSearchHits = 0;
    let totalHybridHits = 0;
    let totalSearchTokens = 0;
    let totalHybridTokens = 0;
    let totalSearchMs = 0;
    let totalHybridMs = 0;

    for (const tc of TRUTH_SET) {
        process.stdout.write(`  ${tc.query.substring(0, 60).padEnd(62)}`);
        const r = await runQuery(engine, tc);
        results.push(r);
        totalExpected += tc.expectedFiles.length;
        totalSearchHits += r.searchHitCount;
        totalHybridHits += r.hybridHitCount;
        totalSearchTokens += r.searchTokens;
        totalHybridTokens += r.hybridTokens;
        totalSearchMs += r.searchLatencyMs;
        totalHybridMs += r.hybridLatencyMs;
        console.log(`search=${r.searchHitCount}/${tc.expectedFiles.length} hybrid=${r.hybridHitCount}/${tc.expectedFiles.length}`);
    }

    console.log("\n─── Per-query detail ───\n");
    for (const r of results) {
        console.log(`Query: "${r.query}"`);
        console.log(`  Expected:    ${r.expected.join(", ")}`);
        console.log(`  search    →  ${r.searchHits.join(", ") || "(none)"}`);
        console.log(`  hybrid    →  ${r.hybridHits.join(", ") || "(none)"}`);
        console.log(`  Tokens:      search=${r.searchTokens}  hybrid=${r.hybridTokens}  (Δ ${r.hybridTokens - r.searchTokens >= 0 ? "+" : ""}${r.hybridTokens - r.searchTokens})`);
        console.log(`  Latency ms:  search=${r.searchLatencyMs}  hybrid=${r.hybridLatencyMs}`);
        console.log();
    }

    const searchRecall = totalSearchHits / totalExpected;
    const hybridRecall = totalHybridHits / totalExpected;
    const tokenOverhead = (totalHybridTokens - totalSearchTokens) / totalSearchTokens;

    console.log("─── Aggregate ───\n");
    console.log(`Truth-set recall (file-level hit rate):`);
    console.log(`  action="search"        ${(searchRecall * 100).toFixed(1)}%  (${totalSearchHits}/${totalExpected})`);
    console.log(`  action="hybrid_search" ${(hybridRecall * 100).toFixed(1)}%  (${totalHybridHits}/${totalExpected})`);
    console.log(`  Δ                       ${((hybridRecall - searchRecall) * 100).toFixed(1)}pp`);
    console.log();
    console.log(`Token cost (real BPE, tiktoken cl100k_base):`);
    console.log(`  action="search"        ${totalSearchTokens.toLocaleString()} tokens (sum across ${TRUTH_SET.length} queries)`);
    console.log(`  action="hybrid_search" ${totalHybridTokens.toLocaleString()} tokens`);
    console.log(`  Overhead              ${(tokenOverhead * 100).toFixed(1)}%`);
    console.log();
    console.log(`Latency (sum across ${TRUTH_SET.length} queries):`);
    console.log(`  action="search"        ${totalSearchMs}ms`);
    console.log(`  action="hybrid_search" ${totalHybridMs}ms  (includes one BM25 index build amortized)`);
    console.log();
    console.log("Honest disclosures:");
    console.log("  - Single-project corpus (NREKI src/ itself, ~", idx.indexed, "files). Not generalizable to other languages/sizes.");
    console.log("  - Curated truth set of 8 queries — selection bias possible. NOT a replacement for Sprint 6.5 N=99 PolyBench re-benchmark.");
    console.log("  - Foveal-on-BM25 may zero-out for files < 100 lines (compressor bypass at compressor-foveal.ts:109).");

    try { engine.shutdown(); } catch { /* best effort */ }
}

main().catch(e => {
    console.error("Benchmark failed:", e);
    process.exit(1);
});
