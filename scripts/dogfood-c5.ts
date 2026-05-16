/**
 * FASE C.5 dogfood verification — Phase 3 type_graph empirical test.
 * Untracked scratch tool. Wipes .nreki.db, re-indexes ./src clean,
 * validates SINGLE_LETTER filter, runs 6 type_graph queries.
 */

import fs from "node:fs";
import { performance } from "node:perf_hooks";

import { NrekiEngine } from "../src/engine.js";
import { handleTypeGraph } from "../src/handlers/type-graph.js";
import type { RouterDependencies, NavigateParams } from "../src/router.js";

async function main() {
    // ── PASO 2.A: wipe ────────────────────────────────────────────
    console.log("=== PASO 2: Wipe + re-index ===");
    if (fs.existsSync(".nreki.db")) {
        fs.unlinkSync(".nreki.db");
        console.log("Wiped .nreki.db");
    }

    // ── PASO 2.B: re-index ────────────────────────────────────────
    const engine = new NrekiEngine({
        dbPath: ".nreki.db",
        watchPaths: ["./src"],
    });
    await engine.initialize();
    const t0 = performance.now();
    const memBefore = process.memoryUsage().rss;
    const result = await engine.indexDirectory("./src");
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const memAfter = process.memoryUsage().rss;
    const memDeltaMB = ((memAfter - memBefore) / 1024 / 1024).toFixed(0);

    const stats = engine.getStats();
    console.log(`Re-index complete in ${elapsed}s`);
    console.log(`  files: indexed=${result.indexed} skipped=${result.skipped} errors=${result.errors}`);
    console.log(`  total chunks: ${stats.totalChunks}`);
    console.log(`  total files indexed: ${stats.filesIndexed}`);
    console.log(`  RSS delta during indexing: +${memDeltaMB} MB`);

    // ── PASO 2.C: filter verification ─────────────────────────────
    const allTypes = engine.getAllTypeNames();
    const singleLetterUpper = allTypes.filter(t => /^[A-Z]$/.test(t));
    console.log(`\n=== Filter SINGLE_LETTER verification ===`);
    console.log(`  total distinct types: ${allTypes.length}`);
    console.log(`  single-letter UPPERCASE present: ${singleLetterUpper.length}`);
    if (singleLetterUpper.length > 0) {
        console.log(`  ⚠️  LEAKED: ${singleLetterUpper.join(", ")}`);
    } else {
        console.log(`  ✅ filter applied correctly`);
    }

    // Top 10 most-frequent consumed types (sanity check)
    type Freq = { name: string; count: number };
    const consumeFreq: Freq[] = [];
    for (const t of allTypes) {
        const ids = engine.getChunksByConsumedType(t);
        if (ids.length > 0) consumeFreq.push({ name: t, count: ids.length });
    }
    consumeFreq.sort((a, b) => b.count - a.count);
    console.log(`\n  top 5 consumed types:`);
    for (const f of consumeFreq.slice(0, 5)) console.log(`    ${f.count}x ${f.name}`);

    // ── Mock deps for handler ─────────────────────────────────────
    const deps = {
        engine,
        monitor: undefined as any,
        sandbox: undefined as any,
        circuitBreaker: undefined as any,
    } as unknown as RouterDependencies;

    async function runQuery(label: string, params: NavigateParams) {
        console.log(`\n=== ${label} ===`);
        console.log(`params: ${JSON.stringify(params)}`);
        const t = performance.now();
        const r = await handleTypeGraph(params, deps);
        const ms = (performance.now() - t).toFixed(0);
        const text = r.content[0].text as string;
        console.log(`elapsed: ${ms}ms`);
        // Print first 80 lines of output
        const lines = text.split("\n");
        console.log(lines.slice(0, 80).join("\n"));
        if (lines.length > 80) console.log(`... [+${lines.length - 80} more lines]`);
    }

    // ── PASO 3: 6 dogfood queries ─────────────────────────────────
    console.log("\n\n========================================");
    console.log("PASO 3 — DOGFOOD QUERIES");
    console.log("========================================");

    await runQuery("Q1 NrekiEngine depth=1 bidirectional", {
        action: "type_graph", type_name: "NrekiEngine", walk_depth: 1,
    });

    await runQuery("Q2 NrekiEngine depth=2", {
        action: "type_graph", type_name: "NrekiEngine", walk_depth: 2,
    });

    await runQuery("Q3a NrekiEngine consumers only", {
        action: "type_graph", type_name: "NrekiEngine", direction: "consumers",
    });

    await runQuery("Q3b NrekiEngine producers only", {
        action: "type_graph", type_name: "NrekiEngine", direction: "producers",
    });

    await runQuery("Q4 NOCASE fallback (nrekiengine lowercase)", {
        action: "type_graph", type_name: "nrekiengine",
    });

    await runQuery("Q5 Type not existing", {
        action: "type_graph", type_name: "DefinitelyNotARealType",
    });

    // Q6: hub query — pick the most-frequent consumed type
    if (consumeFreq.length > 0) {
        const hub = consumeFreq[0].name;
        await runQuery(`Q6 Hub type "${hub}" with max_nodes=20`, {
            action: "type_graph", type_name: hub, walk_depth: 1, max_nodes: 20,
        });
    }

    console.log("\n=== END DOGFOOD ===");
}

main().catch(err => {
    console.error("DOGFOOD FAILED:", err);
    process.exit(1);
});
