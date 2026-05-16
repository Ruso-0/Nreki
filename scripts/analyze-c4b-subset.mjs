/**
 * Phase 5 C.4.B post-hoc subset analysis.
 *
 * The Sprint 4.9.8 100-task C.4.B run reported recall_mean per
 * retriever over its own success cells. Comparing the headline
 * numbers directly is a fair-comparison violation (different
 * denominators).
 *
 * Two scientifically defensible subset universes:
 *
 *   (1) N=16 SUCCESS universe -- tasks where Voyage actually
 *       returned a non-error result. All retrievers are measured
 *       on the same 16 tasks; the comparison is strict
 *       apples-to-apples on the cells Voyage chose to evaluate.
 *
 *   (2) N=21 INTENDED universe -- the 16 success cells plus the
 *       5 tasks where Voyage was IN the C.4.B.0b stratified subset
 *       but errored at runtime (HTTP 400 payload-size cascade
 *       despite token-budgeted batching). Voyage's failures are
 *       penalized as recall=0; other retrievers (which succeeded
 *       on those 5 tasks) contribute their actual metrics.
 *
 * Report BOTH so the reviewer sees:
 *   - Voyage's quality when it works (N=16 row)
 *   - Voyage's quality WITH coverage penalty for large-repo HTTP 400
 *     failures (N=21 row) -- the Cloud Dense unviability signal.
 *
 * Methodology choice (within each universe): error cells are
 * EXCLUDED from per-runner means by default (matches orchestrate.ts
 * PerRunnerAggregate convention). The N=21 row applies the punitive
 * "errors as recall=0" rule UNIFORMLY to every runner so coverage
 * problems are visible across the table.
 */

import * as fs from "node:fs/promises";

const INPUT_PATH = "results-c4b-full.jsonl";

function parseArgv(argv) {
    const opts = { jsonOut: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--json" && i + 1 < argv.length) {
            opts.jsonOut = argv[++i];
        }
    }
    return opts;
}

function mean(xs) { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }
function percentile(xs, p) {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
}

const opts = parseArgv(process.argv);

const raw = await fs.readFile(INPUT_PATH, "utf-8");
const tasks = raw
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l));

console.log(`[subset] loaded ${tasks.length} tasks from ${INPUT_PATH}`);

// === Identify the two universes ===

// Voyage success cells: in subset AND ran without error.
const subsetSuccess = tasks.filter(t => {
    const cell = t.runners?.["voyage-3"];
    return cell?.result && !cell.result.error;
});

// Voyage in-subset failures: Voyage ran (was selected by the gate)
// but errored with a non-skip error (typically HTTP 400 / payload
// size). "SKIPPED (not in subset)" and "VOYAGE_API_KEY missing"
// indicate the gate or env-config kept Voyage out -- not "tried and
// failed". Anything else is a runtime failure on a gate-selected
// task.
const subsetIntendedFailures = tasks.filter(t => {
    const cell = t.runners?.["voyage-3"];
    if (!cell?.result?.error) return false;
    const err = cell.result.error;
    if (err.startsWith("Voyage SKIPPED (not in subset)")) return false;
    if (err.startsWith("VOYAGE_API_KEY missing")) return false;
    return true;
});

const subsetIntended = [...subsetSuccess, ...subsetIntendedFailures];

console.log(`[subset] Voyage success universe:  N=${subsetSuccess.length}`);
console.log(`[subset] Voyage in-subset failures: N=${subsetIntendedFailures.length}`);
console.log(`[subset] Voyage intended universe: N=${subsetIntended.length}`);

console.log("\n[subset] Voyage in-subset RUNTIME FAILURES (counted in N=21, recall=0):");
for (const t of subsetIntendedFailures) {
    const err = t.runners["voyage-3"].result.error;
    console.log(`  ${t.instance_id}  (${t.repo})`);
    console.log(`    ${err.slice(0, 140)}${err.length > 140 ? "..." : ""}`);
}

console.log("\n[subset] Voyage in-subset SUCCESSES (counted in both N=16 and N=21):");
for (const t of subsetSuccess) console.log(`  ${t.instance_id}  (${t.repo})`);

// === Per-runner subset stats ===

const RUNNERS = [
    "voyage-3",
    "nreki-mbf-on",
    "nreki-mbf-off",
    "bm25",
    "aider",
    "ripgrep",
    "fast_grep",
];

/**
 * Compute per-runner stats on a given task universe.
 * Modes:
 *   - "exclude":   skip error cells in the mean (orchestrate.ts default).
 *   - "as_zero":   include error cells in the mean as recall=0
 *                  (uniform coverage penalty across runners).
 */
function statsOver(universe, mode) {
    const out = {};
    for (const name of RUNNERS) {
        const cells = universe
            .map(t => t.runners?.[name])
            .filter(c => c && c.result);
        const okCells = cells.filter(c => !c.result.error);

        let recalls, chunks, tokens, lats;
        if (mode === "as_zero") {
            // Every cell contributes; error cells contribute recall=0,
            // chunk=0, token_cost=cell's measured (could be 0 if errored
            // before tokenization), latency=cell's measured.
            recalls = cells.map(c => c.result.error ? 0 : c.metrics.first_hit_recall);
            chunks  = cells.map(c => c.result.error ? 0 : c.metrics.strict_chunk_containment);
            tokens  = cells.map(c => c.metrics.token_cost ?? 0);
            lats    = cells.map(c => c.metrics.latency_ms ?? 0);
        } else {
            recalls = okCells.map(c => c.metrics.first_hit_recall);
            chunks  = okCells.map(c => c.metrics.strict_chunk_containment);
            tokens  = okCells.map(c => c.metrics.token_cost);
            lats    = okCells.map(c => c.metrics.latency_ms);
        }
        out[name] = {
            n_total:    cells.length,
            n_ok:       okCells.length,
            error_rate: cells.length > 0 ? (cells.length - okCells.length) / cells.length : 0,
            recall_mean:     mean(recalls),
            chunk_mean:      mean(chunks),
            token_cost_mean: mean(tokens),
            latency_p50_ms:  percentile(lats, 50),
            latency_p95_ms:  percentile(lats, 95),
        };
    }
    return out;
}

const statsN16 = statsOver(subsetSuccess, "exclude");
const statsN21Exclude = statsOver(subsetIntended, "exclude");
const statsN21AsZero  = statsOver(subsetIntended, "as_zero");

// === Table emission ===

function emitTable(title, stats, N) {
    console.log("");
    console.log("=".repeat(115));
    console.log(`${title}  (N=${N})`);
    console.log("=".repeat(115));
    console.log(
        "Runner            | n_ok    | err%   | recall   | chunk    | tok_mean | p50_ms   | p95_ms",
    );
    console.log("-".repeat(115));
    for (const name of RUNNERS) {
        const s = stats[name];
        const cols = [
            name.padEnd(17),
            `${s.n_ok}/${s.n_total}`.padStart(7),
            `${(s.error_rate * 100).toFixed(1)}`.padStart(6),
            s.recall_mean.toFixed(3).padStart(8),
            s.chunk_mean.toFixed(3).padStart(8),
            s.token_cost_mean.toFixed(0).padStart(8),
            s.latency_p50_ms.toFixed(0).padStart(8),
            s.latency_p95_ms.toFixed(0).padStart(8),
        ];
        console.log(`${cols[0]} | ${cols[1]} | ${cols[2]} | ${cols[3]} | ${cols[4]} | ${cols[5]} | ${cols[6]} | ${cols[7]}`);
    }
    console.log("-".repeat(115));
}

emitTable(
    "TABLE A — N=16 SUCCESS universe (strict apples-to-apples on Voyage's success cells)",
    statsN16,
    subsetSuccess.length,
);
console.log("note: error cells EXCLUDED from means (orchestrate.ts default). All 7 retrievers compared on same 16 tasks.");

emitTable(
    "TABLE B — N=21 INTENDED universe, COVERAGE-PENALIZED (errors counted as recall=0 for every runner)",
    statsN21AsZero,
    subsetIntended.length,
);
console.log("note: Voyage's 5 HTTP 400 failures contribute recall=0. Aider's 120s timeouts likewise. Reveals coverage-vs-quality tradeoff.");

emitTable(
    "TABLE C — N=21 INTENDED universe, errors EXCLUDED (orchestrate.ts methodology applied to wider universe)",
    statsN21Exclude,
    subsetIntended.length,
);
console.log("note: per-runner denominator varies (each runner's success cells). Useful for showing 'when retrievers work, here's their quality'.");

// === Headline contrasts ===

console.log("\n" + "=".repeat(115));
console.log("HEADLINE CONTRASTS");
console.log("=".repeat(115));

function contrast(label, statsA, statsB) {
    const v = statsA["voyage-3"];
    const n = statsB["nreki-mbf-on"];
    const dV = v.recall_mean;
    const dN = n.recall_mean;
    console.log(`\n${label}`);
    console.log(`  voyage-3 recall      = ${dV.toFixed(3)}`);
    console.log(`  nreki-mbf-on recall  = ${dN.toFixed(3)}`);
    console.log(`  delta (V - N)        = ${(dV - dN >= 0 ? "+" : "")}${(dV - dN).toFixed(3)}`);
    console.log(`  Voyage tok / NREKI tok = ${(v.token_cost_mean / Math.max(1, n.token_cost_mean)).toFixed(2)}x`);
    console.log(`  Voyage p50 / NREKI p50 = ${(v.latency_p50_ms / Math.max(1, n.latency_p50_ms)).toFixed(1)}x`);
}

contrast("N=16 success universe (strict apples-to-apples):", statsN16, statsN16);
contrast("N=21 intended universe, coverage-penalized (paper claim universe):", statsN21AsZero, statsN21AsZero);

if (opts.jsonOut) {
    const out = {
        input: INPUT_PATH,
        n_total_tasks: tasks.length,
        n_subset_success: subsetSuccess.length,
        n_subset_intended_failures: subsetIntendedFailures.length,
        n_subset_intended: subsetIntended.length,
        subset_success_instance_ids: subsetSuccess.map(t => t.instance_id),
        subset_failure_instance_ids: subsetIntendedFailures.map(t => ({
            instance_id: t.instance_id,
            repo: t.repo,
            voyage_error: t.runners["voyage-3"].result.error,
        })),
        stats_n16_success_exclude_errors: statsN16,
        stats_n21_intended_as_zero:       statsN21AsZero,
        stats_n21_intended_exclude_errors: statsN21Exclude,
        generated_at: new Date().toISOString(),
    };
    await fs.writeFile(opts.jsonOut, JSON.stringify(out, null, 2), "utf-8");
    console.log(`\n[subset] structured JSON written to ${opts.jsonOut}`);
}
