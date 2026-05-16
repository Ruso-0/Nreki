#!/usr/bin/env tsx
/**
 * Phase 6.0.1: paired Voyage-vs-NREKI methodology audit.
 *
 * Restricts comparison to tasks where voyage-3 returned a successful
 * response, then computes NREKI on the exact same task subset.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mean, percentile } from "./metrics.js";

const DEFAULT_INPUT = "results-c4b-v2-full.jsonl";
const DEFAULT_RESAMPLES = 10_000;
const DEFAULT_SEED = 0x6_0_1;

interface RunnerCell {
    result: {
        retrieved_files: string[];
        error?: string;
    };
    metrics: {
        first_hit_recall: number;
        strict_chunk_containment: number;
        token_cost: number;
    };
}

interface PerTaskResult {
    instance_id: string;
    runners: Record<string, RunnerCell | undefined>;
    error?: string;
}

export interface RetrieverSummary {
    retriever: string;
    fhr: number;
    clr: number;
    tokenP50: number;
    tokenP95: number;
}

export interface BootstrapResult {
    delta: number;
    ci95: [number, number];
    significantAt05: boolean;
}

export interface PairedAnalysis {
    inputPath: string;
    n: number;
    taskIds: string[];
    summaries: RetrieverSummary[];
    bootstrapFhr: BootstrapResult;
    bootstrapClr: BootstrapResult;
}

function fmt(n: number, decimals = 3): string {
    if (Number.isNaN(n)) return "NaN";
    return n.toFixed(decimals);
}

function readJsonl(inputPath: string): PerTaskResult[] {
    const raw = readFileSync(inputPath, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(line => JSON.parse(line) as PerTaskResult);
}

function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function bootstrapPairedDelta(
    pairs: Array<{ nreki: number; voyage: number }>,
    resamples = DEFAULT_RESAMPLES,
    seed = DEFAULT_SEED,
): BootstrapResult {
    if (pairs.length === 0) return { delta: 0, ci95: [0, 0], significantAt05: false };

    const observed = mean(pairs.map(p => p.nreki - p.voyage));
    const random = rng(seed);
    const deltas: number[] = [];
    for (let i = 0; i < resamples; i++) {
        let sum = 0;
        for (let j = 0; j < pairs.length; j++) {
            const idx = Math.floor(random() * pairs.length);
            sum += pairs[idx].nreki - pairs[idx].voyage;
        }
        deltas.push(sum / pairs.length);
    }
    deltas.sort((a, b) => a - b);
    const ci95: [number, number] = [
        deltas[Math.floor(0.025 * (deltas.length - 1))],
        deltas[Math.floor(0.975 * (deltas.length - 1))],
    ];
    return {
        delta: observed,
        ci95,
        significantAt05: ci95[0] > 0 || ci95[1] < 0,
    };
}

function isSuccessfulVoyage(task: PerTaskResult): boolean {
    if (task.error) return false;
    const voyage = task.runners["voyage-3"];
    return voyage !== undefined && !voyage.result.error;
}

function summarize(retriever: string, cells: RunnerCell[]): RetrieverSummary {
    return {
        retriever,
        fhr: mean(cells.map(c => c.metrics.first_hit_recall)),
        clr: mean(cells.map(c => c.metrics.strict_chunk_containment)),
        tokenP50: percentile(cells.map(c => c.metrics.token_cost), 50),
        tokenP95: percentile(cells.map(c => c.metrics.token_cost), 95),
    };
}

export function analyzePairedVoyage(
    records: PerTaskResult[],
    inputPath = DEFAULT_INPUT,
    resamples = DEFAULT_RESAMPLES,
): PairedAnalysis {
    const pairedTasks = records.filter(task =>
        isSuccessfulVoyage(task) && task.runners["nreki-mbf-on"] !== undefined,
    );
    const voyageCells = pairedTasks.map(t => t.runners["voyage-3"]!);
    const nrekiCells = pairedTasks.map(t => t.runners["nreki-mbf-on"]!);

    return {
        inputPath,
        n: pairedTasks.length,
        taskIds: pairedTasks.map(t => t.instance_id),
        summaries: [
            summarize("voyage-3", voyageCells),
            summarize("nreki-mbf-on", nrekiCells),
        ],
        bootstrapFhr: bootstrapPairedDelta(
            pairedTasks.map(t => ({
                voyage: t.runners["voyage-3"]!.metrics.first_hit_recall,
                nreki: t.runners["nreki-mbf-on"]!.metrics.first_hit_recall,
            })),
            resamples,
            DEFAULT_SEED,
        ),
        bootstrapClr: bootstrapPairedDelta(
            pairedTasks.map(t => ({
                voyage: t.runners["voyage-3"]!.metrics.strict_chunk_containment,
                nreki: t.runners["nreki-mbf-on"]!.metrics.strict_chunk_containment,
            })),
            resamples,
            DEFAULT_SEED + 1,
        ),
    };
}

export function renderPairedAnalysis(analysis: PairedAnalysis): string {
    const nLabel = `N=${analysis.n}`;
    const lines = [
        `Input: ${analysis.inputPath}`,
        `Successful voyage-3 paired subset: ${nLabel}`,
        "",
        `Retriever | FHR ${nLabel} | CLR ${nLabel} | tokens p50 | tokens p95`,
    ];
    for (const s of analysis.summaries) {
        lines.push(
            `${s.retriever} | ${fmt(s.fhr)} | ${fmt(s.clr)} | ${fmt(s.tokenP50, 1)} | ${fmt(s.tokenP95, 1)}`,
        );
    }
    lines.push(
        "",
        "Paired bootstrap delta = nreki-mbf-on - voyage-3",
        `Metric | Δ | CI95 low | CI95 high | significant@0.05`,
        `FHR | ${fmt(analysis.bootstrapFhr.delta)} | ${fmt(analysis.bootstrapFhr.ci95[0])} | ${fmt(analysis.bootstrapFhr.ci95[1])} | ${analysis.bootstrapFhr.significantAt05}`,
        `CLR | ${fmt(analysis.bootstrapClr.delta)} | ${fmt(analysis.bootstrapClr.ci95[0])} | ${fmt(analysis.bootstrapClr.ci95[1])} | ${analysis.bootstrapClr.significantAt05}`,
    );
    return lines.join("\n");
}

function parseInput(argv: string[]): string {
    const idx = argv.indexOf("--input");
    return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : DEFAULT_INPUT;
}

export function main(argv = process.argv): void {
    const inputPath = parseInput(argv);
    const records = readJsonl(inputPath);
    const analysis = analyzePairedVoyage(records, inputPath);
    process.stdout.write(renderPairedAnalysis(analysis) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
