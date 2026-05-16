#!/usr/bin/env tsx
/**
 * Sprint 6.0 addendum: paired bootstrap CI95 for NREKI-vs-BM25 R@K + MRR.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mean } from "./metrics.js";

const DEFAULT_INPUT = "results-c4b-v2-full.jsonl";
const DEFAULT_RESAMPLES = 10_000;
const DEFAULT_SEED = 42;

type MetricName = "R@1" | "R@3" | "R@5" | "R@10" | "MRR";

interface RunnerCell {
    result: {
        retrieved_files: string[];
        error?: string;
    };
}

interface PerTaskResult {
    instance_id: string;
    ground_truth: { strict_src: string[] };
    runners: Record<string, RunnerCell | undefined>;
    error?: string;
}

interface TaskMetric {
    r1: number;
    r3: number;
    r5: number;
    r10: number;
    mrr: number;
}

interface PairedTaskMetrics {
    instanceId: string;
    bm25: TaskMetric;
    nreki: TaskMetric;
}

export interface BootstrapMetricRow {
    metric: MetricName;
    observed: number;
    ci95Low: number;
    ci95High: number;
    significant: boolean;
}

export interface BootstrapReport {
    inputPath: string;
    n: number;
    rows: BootstrapMetricRow[];
}

function fmtSigned(n: number): string {
    if (Number.isNaN(n)) return "NaN";
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(3)}`;
}

function parseJsonlStrict(inputPath: string): PerTaskResult[] {
    const raw = readFileSync(inputPath, "utf-8");
    const records: PerTaskResult[] = [];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            records.push(JSON.parse(line) as PerTaskResult);
        } catch (err) {
            throw new Error(
                `Malformed JSONL at ${inputPath}:${i + 1}: ${(err as Error).message}`,
            );
        }
    }
    return records;
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

function firstRelevantRank(retrievedFiles: string[], truth: string[]): number | null {
    const truthSet = new Set(truth);
    const index = retrievedFiles.findIndex(file => truthSet.has(file));
    return index >= 0 ? index + 1 : null;
}

function computeTaskMetric(cell: RunnerCell | undefined, truth: string[]): TaskMetric {
    if (!cell || cell.result.error) {
        return { r1: 0, r3: 0, r5: 0, r10: 0, mrr: 0 };
    }
    const rank = firstRelevantRank(cell.result.retrieved_files, truth);
    return {
        r1: rank !== null && rank <= 1 ? 1 : 0,
        r3: rank !== null && rank <= 3 ? 1 : 0,
        r5: rank !== null && rank <= 5 ? 1 : 0,
        r10: rank !== null && rank <= 10 ? 1 : 0,
        mrr: rank === null ? 0 : 1 / rank,
    };
}

function pairedTaskMetrics(records: PerTaskResult[]): PairedTaskMetrics[] {
    return records
        .filter(task => !task.error && task.ground_truth.strict_src.length > 0)
        .map(task => ({
            instanceId: task.instance_id,
            bm25: computeTaskMetric(task.runners.bm25, task.ground_truth.strict_src),
            nreki: computeTaskMetric(task.runners["nreki-mbf-on"], task.ground_truth.strict_src),
        }));
}

function metricValue(metric: MetricName, sample: TaskMetric): number {
    switch (metric) {
        case "R@1": return sample.r1;
        case "R@3": return sample.r3;
        case "R@5": return sample.r5;
        case "R@10": return sample.r10;
        case "MRR": return sample.mrr;
    }
}

export function bootstrapPairedMetric(
    deltas: number[],
    resamples = DEFAULT_RESAMPLES,
    seed = DEFAULT_SEED,
): { observed: number; ci95Low: number; ci95High: number; significant: boolean } {
    if (deltas.length === 0) {
        return { observed: 0, ci95Low: 0, ci95High: 0, significant: false };
    }

    const observed = mean(deltas);
    const random = rng(seed);
    const boot: number[] = new Array(resamples);
    for (let i = 0; i < resamples; i++) {
        let sum = 0;
        for (let j = 0; j < deltas.length; j++) {
            const idx = Math.floor(random() * deltas.length);
            sum += deltas[idx];
        }
        boot[i] = sum / deltas.length;
    }
    boot.sort((a, b) => a - b);
    const low = boot[Math.floor(0.025 * (boot.length - 1))];
    const high = boot[Math.floor(0.975 * (boot.length - 1))];
    return {
        observed,
        ci95Low: low,
        ci95High: high,
        significant: low > 0 || high < 0,
    };
}

export function analyzeBootstrapRkMrr(
    records: PerTaskResult[],
    inputPath = DEFAULT_INPUT,
    resamples = DEFAULT_RESAMPLES,
): BootstrapReport {
    const pairs = pairedTaskMetrics(records);
    const metrics: MetricName[] = ["R@1", "R@3", "R@5", "R@10", "MRR"];
    const rows = metrics.map((metric, idx) => {
        const deltas = pairs.map(pair =>
            metricValue(metric, pair.nreki) - metricValue(metric, pair.bm25),
        );
        return {
            metric,
            ...bootstrapPairedMetric(deltas, resamples, DEFAULT_SEED + idx),
        };
    });
    return { inputPath, n: pairs.length, rows };
}

export function renderBootstrapReport(report: BootstrapReport): string {
    const lines = [
        `Input: ${report.inputPath}`,
        `Paired tasks with strict_src > 0: N=${report.n}`,
        "Delta = nreki-mbf-on - bm25",
        "",
        "Metric | observed | CI95% low | CI95% high | significant",
    ];
    for (const row of report.rows) {
        lines.push(
            `${row.metric} | ${fmtSigned(row.observed)} | ${fmtSigned(row.ci95Low)} | ${fmtSigned(row.ci95High)} | ${row.significant}`,
        );
    }
    return lines.join("\n");
}

function parseInput(argv: string[]): string {
    const idx = argv.indexOf("--input");
    return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : DEFAULT_INPUT;
}

export function main(argv = process.argv): void {
    const inputPath = parseInput(argv);
    const records = parseJsonlStrict(inputPath);
    process.stdout.write(renderBootstrapReport(analyzeBootstrapRkMrr(records, inputPath)) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
