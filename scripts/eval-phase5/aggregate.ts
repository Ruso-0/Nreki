#!/usr/bin/env tsx
/**
 * Phase 6.0.2 / 6.0.4 aggregate from C.4.B JSONL.
 *
 * Prints Information Retrieval metrics with p50 token/latency as
 * headline, means as disclosure, and Aider separated as infra reliability.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mean, percentile } from "./metrics.js";

const DEFAULT_INPUT = "results-c4b-v2-full.jsonl";
const AIDER = "aider";

interface RunnerCell {
    result: { error?: string };
    metrics: {
        first_hit_recall: number;
        strict_chunk_containment: number;
        token_cost: number;
        latency_ms: number;
    };
}

interface PerTaskResult {
    instance_id: string;
    ground_truth: { strict_src: string[] };
    runners: Record<string, RunnerCell | undefined>;
    error?: string;
}

interface AggregateRow {
    retriever: string;
    n: number;
    fhrMean: number;
    clrMean: number;
    tokenMean: number;
    tokenP50: number;
    tokenP95: number;
    tokenP99: number;
    latencyMean: number;
    latencyP50: number;
    latencyP95: number;
    latencyP99: number;
    errorRate: number;
    completed: number;
}

function fmt(n: number, digits = 3): string {
    if (Number.isNaN(n)) return "NaN";
    return n.toFixed(digits);
}

function readJsonl(inputPath: string): PerTaskResult[] {
    const raw = readFileSync(inputPath, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(line => JSON.parse(line) as PerTaskResult);
}

function retrievers(records: PerTaskResult[]): string[] {
    const names = new Set<string>();
    for (const task of records) {
        for (const name of Object.keys(task.runners)) names.add(name);
    }
    return [...names].sort();
}

export function aggregateRows(records: PerTaskResult[]): AggregateRow[] {
    const tasks = records.filter(t => !t.error && t.ground_truth.strict_src.length > 0);
    const rows: AggregateRow[] = [];
    for (const retriever of retrievers(tasks)) {
        const cells = tasks
            .map(t => t.runners[retriever])
            .filter((c): c is RunnerCell => c !== undefined);
        const okCells = cells.filter(c => !c.result.error);
        const allTokens = cells.map(c => c.result.error ? 0 : c.metrics.token_cost);
        const okLatencies = okCells.map(c => c.metrics.latency_ms);

        rows.push({
            retriever,
            n: cells.length,
            fhrMean: mean(cells.map(c => c.result.error ? 0 : c.metrics.first_hit_recall)),
            clrMean: mean(cells.map(c => c.result.error ? 0 : c.metrics.strict_chunk_containment)),
            tokenMean: mean(allTokens),
            tokenP50: percentile(allTokens, 50),
            tokenP95: percentile(allTokens, 95),
            tokenP99: percentile(allTokens, 99),
            latencyMean: mean(okLatencies),
            latencyP50: percentile(okLatencies, 50),
            latencyP95: percentile(okLatencies, 95),
            latencyP99: percentile(okLatencies, 99),
            errorRate: cells.length > 0 ? (cells.length - okCells.length) / cells.length : 0,
            completed: okCells.length,
        });
    }
    return rows;
}

function timeoutRate(records: PerTaskResult[], runner: string): number {
    const cells = records
        .filter(t => !t.error && t.ground_truth.strict_src.length > 0)
        .map(t => t.runners[runner])
        .filter((c): c is RunnerCell => c !== undefined);
    if (cells.length === 0) return 0;
    return cells.filter(c => /timeout/i.test(c.result.error ?? "")).length / cells.length;
}

export function renderAggregate(inputPath: string, records: PerTaskResult[]): string {
    const rows = aggregateRows(records);
    const irRows = rows.filter(r => r.retriever !== AIDER);
    const lines = [
        `Input: ${inputPath}`,
        "Information Retrieval (Aider excluded; p50 is headline)",
        "Retriever | FHR mean | CLR mean | tok p50 | tok p95 | tok p99 | lat p50 | lat p95 | lat p99 | err%",
    ];
    for (const row of irRows) {
        lines.push(
            `${row.retriever} | ${fmt(row.fhrMean)} | ${fmt(row.clrMean)} | ${fmt(row.tokenP50, 1)} | ${fmt(row.tokenP95, 1)} | ${fmt(row.tokenP99, 1)} | ${fmt(row.latencyP50, 0)} | ${fmt(row.latencyP95, 0)} | ${fmt(row.latencyP99, 0)} | ${fmt(row.errorRate * 100, 1)}`,
        );
    }
    lines.push("", "Mean disclosure (not headline):");
    for (const row of irRows) {
        lines.push(
            `${row.retriever} | tok mean=${fmt(row.tokenMean, 1)} | lat mean=${fmt(row.latencyMean, 0)}`,
        );
    }

    const aider = rows.find(r => r.retriever === AIDER);
    if (aider) {
        lines.push(
            "",
            "Infrastructure Reliability (excluded from IR ranking)",
            `aider | timeout_rate=${fmt(timeoutRate(records, AIDER) * 100, 1)}% | error_rate=${fmt(aider.errorRate * 100, 1)}% | completed=${aider.completed}/${aider.n}`,
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
    const records = readJsonl(inputPath);
    process.stdout.write(renderAggregate(inputPath, records) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
