#!/usr/bin/env tsx
/**
 * C.4.C.1 aggregate — bootstrap paired test
 * NREKI mbf-on vs BM25 standalone
 *
 * Output: results-c4c-aggregate.json
 */

import { readFileSync, writeFileSync } from "node:fs";

const C4C_PATH = "results-c4c-full.jsonl";
const AGG_PATH = "results-c4c-aggregate.json";
const N_RESAMPLES = 10_000;

interface C4CResult {
    task_id: string;
    retriever: string;
    equiv_result: "YES" | "NO" | "AMBIGUOUS" | "NULL";
    failure_mode: string | null;
}

function passRate(results: C4CResult[]): number {
    if (results.length === 0) return 0;
    const yes = results.filter((r) => r.equiv_result === "YES").length;
    return yes / results.length;
}

function bootstrapPairedCI(
    pairedSamples: Array<{ nreki: number; bm25: number }>,
    nResamples: number,
): { delta: number; ci95: [number, number]; pValue: number } {
    const n = pairedSamples.length;
    if (n === 0) return { delta: 0, ci95: [0, 0], pValue: 1 };
    const observedDelta =
        pairedSamples.reduce((sum, p) => sum + (p.nreki - p.bm25), 0) / n;

    const deltas: number[] = new Array(nResamples);
    for (let i = 0; i < nResamples; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) {
            const idx = Math.floor(Math.random() * n);
            sum += pairedSamples[idx].nreki - pairedSamples[idx].bm25;
        }
        deltas[i] = sum / n;
    }
    deltas.sort((a, b) => a - b);
    const ci95: [number, number] = [
        deltas[Math.floor(0.025 * nResamples)],
        deltas[Math.floor(0.975 * nResamples)],
    ];

    // Two-tailed p-value: proportion of resamples whose sign opposes observed.
    const crossings = deltas.filter((d) =>
        observedDelta >= 0 ? d <= 0 : d >= 0,
    ).length;
    const pValue = Math.min(1, (2 * crossings) / nResamples);

    return { delta: observedDelta, ci95, pValue };
}

function main() {
    const lines = readFileSync(C4C_PATH, "utf-8").trim().split("\n").filter(Boolean);
    const records: C4CResult[] = lines.map((l) => JSON.parse(l));

    const nrekiResults = records.filter((r) => r.retriever === "nreki-mbf-on");
    const bm25Results = records.filter((r) => r.retriever === "bm25");

    const passNreki = passRate(nrekiResults);
    const passBm25 = passRate(bm25Results);

    const taskIds = [...new Set(records.map((r) => r.task_id))];
    const paired: Array<{ nreki: number; bm25: number }> = [];
    for (const tid of taskIds) {
        const n = records.find((r) => r.task_id === tid && r.retriever === "nreki-mbf-on");
        const b = records.find((r) => r.task_id === tid && r.retriever === "bm25");
        if (n && b) {
            paired.push({
                nreki: n.equiv_result === "YES" ? 1 : 0,
                bm25: b.equiv_result === "YES" ? 1 : 0,
            });
        }
    }

    const bootstrap = bootstrapPairedCI(paired, N_RESAMPLES);

    const failureModes: Record<string, number> = {};
    for (const r of records) {
        if (r.failure_mode) {
            failureModes[r.failure_mode] = (failureModes[r.failure_mode] ?? 0) + 1;
        }
    }

    const agg = {
        n_tasks: taskIds.length,
        n_paired: paired.length,
        pass_rate_nreki_mbf_on: passNreki,
        pass_rate_bm25: passBm25,
        delta_observed: bootstrap.delta,
        ci95_delta: bootstrap.ci95,
        p_value_bilateral: bootstrap.pValue,
        significant_at_0_05: bootstrap.pValue < 0.05,
        significant_at_0_01: bootstrap.pValue < 0.01,
        failure_modes: failureModes,
        breakdown: {
            nreki_yes: nrekiResults.filter((r) => r.equiv_result === "YES").length,
            nreki_no: nrekiResults.filter((r) => r.equiv_result === "NO").length,
            nreki_ambiguous: nrekiResults.filter((r) => r.equiv_result === "AMBIGUOUS").length,
            nreki_null: nrekiResults.filter((r) => r.equiv_result === "NULL").length,
            bm25_yes: bm25Results.filter((r) => r.equiv_result === "YES").length,
            bm25_no: bm25Results.filter((r) => r.equiv_result === "NO").length,
            bm25_ambiguous: bm25Results.filter((r) => r.equiv_result === "AMBIGUOUS").length,
            bm25_null: bm25Results.filter((r) => r.equiv_result === "NULL").length,
        },
        methodology_disclosure: {
            judge: "claude-opus-4-7 via claude -p stdin pipe (CLI 2.1.114)",
            meta_judge: "deepseek-v4-pro via OpenCode runtime (mixed programmatic/manual)",
            temperature: "default uncontrolled (claude CLI 2.1.114 has no --temperature flag)",
            n_resamples_bootstrap: N_RESAMPLES,
            blinded_meta_judge: true,
            k_fix_proposals: 1,
            paired_test: true,
        },
        limitations: [
            "1. Single SOTA judge (Opus 4.7) without Cohen's κ inter-rater between independent judges. Cross-family meta-judge (DeepSeek V4 Pro) partially mitigates circularity.",
            "2. N=21 tasks. Statistical power marginal. IC95% reported explicitly.",
            "3. Judge model bias: Opus 4.7 may favor fixes aligned with its training distribution.",
            "4. Meta-judge semantic equivalence is approximation; false positives/negatives possible. Manual subsample review recommended.",
            "5. Single fix proposal (k=1) per task×retriever, no majority voting.",
            "6. Temperature uncontrolled (CLI does not expose --temperature flag in version 2.1.114).",
            "7. Data leakage risk: all 5 corpus repos (vscode, mui, tailwindcss, code-server, angular) are pre-cutoff for Opus 4.7. Model may have seen specific fixes during training.",
            "8. BM25 hyperparameter mismatch: standalone bm25-runner uses k1=1.5/b=0.75 (literature default); NREKI internal BM25 uses k1=1.8/b=0.35 (code-tuned). Token delta may be partially attributable to tuning, not architecture alone.",
            "9. Token count estimation via tiktoken cl100k_base is proxy for actual Opus tokenizer (which Anthropic does not expose). Cost reported is estimate ±10%.",
            "10. Chunk content materialised from .eval-phase5-cache/repo-cache via `git show <base_commit>:<file_path>`; files deleted before base_commit are recorded as '[unavailable]' inside the LLM-facing context (occasional, logged per-task).",
        ],
    };

    writeFileSync(AGG_PATH, JSON.stringify(agg, null, 2));
    process.stdout.write(`Aggregate written to ${AGG_PATH}\n`);
    process.stdout.write(JSON.stringify(agg, null, 2) + "\n");
}

main();
