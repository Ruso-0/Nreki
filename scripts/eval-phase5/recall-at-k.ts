#!/usr/bin/env tsx
/**
 * Phase 6.0.3: Recall@K ladder + MRR over C.4.B JSONL output.
 *
 * Aider is intentionally excluded from the Information Retrieval table;
 * its timeout/error behavior belongs in Infrastructure Reliability.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mean } from "./metrics.js";

const DEFAULT_INPUT = "results-c4b-v2-full.jsonl";
const K_VALUES = [1, 3, 5, 10] as const;
const AIDER = "aider";

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

export interface RecallAtKSummary {
    retriever: string;
    n: number;
    r1: number;
    r3: number;
    r5: number;
    r10: number;
    mrr: number;
}

function fmt(n: number): string {
    if (Number.isNaN(n)) return "NaN";
    return n.toFixed(3);
}

function readJsonl(inputPath: string): PerTaskResult[] {
    const raw = readFileSync(inputPath, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map(line => JSON.parse(line) as PerTaskResult);
}

function firstRelevantRank(retrievedFiles: string[], truth: string[]): number | null {
    if (truth.length === 0) return null;
    const truthSet = new Set(truth);
    const idx = retrievedFiles.findIndex(file => truthSet.has(file));
    return idx >= 0 ? idx + 1 : null;
}

function candidateRetrievers(records: PerTaskResult[]): string[] {
    const names = new Set<string>();
    for (const record of records) {
        for (const name of Object.keys(record.runners)) {
            if (name !== AIDER) names.add(name);
        }
    }
    return [...names].sort();
}

export function computeRecallAtK(
    records: PerTaskResult[],
    retrievers = candidateRetrievers(records),
): RecallAtKSummary[] {
    const tasks = records.filter(t => !t.error && t.ground_truth.strict_src.length > 0);
    const summaries: RecallAtKSummary[] = [];

    for (const retriever of retrievers) {
        const ranks: Array<number | null> = [];
        for (const task of tasks) {
            const cell = task.runners[retriever];
            if (!cell) continue;
            if (cell.result.error) {
                ranks.push(null);
                continue;
            }
            ranks.push(firstRelevantRank(
                cell.result.retrieved_files,
                task.ground_truth.strict_src,
            ));
        }

        const recallAt = (k: number): number =>
            mean(ranks.map(rank => rank !== null && rank <= k ? 1 : 0));

        summaries.push({
            retriever,
            n: ranks.length,
            r1: recallAt(1),
            r3: recallAt(3),
            r5: recallAt(5),
            r10: recallAt(10),
            mrr: mean(ranks.map(rank => rank === null ? 0 : 1 / rank)),
        });
    }

    return summaries;
}

export function renderRecallAtK(inputPath: string, summaries: RecallAtKSummary[]): string {
    const lines = [
        `Input: ${inputPath}`,
        `Aider excluded from Information Retrieval ranking; report it under Infrastructure Reliability.`,
        "",
        "Retriever | R@1 | R@3 | R@5 | R@10 | MRR",
    ];
    for (const s of summaries) {
        lines.push(
            `${s.retriever} | ${fmt(s.r1)} | ${fmt(s.r3)} | ${fmt(s.r5)} | ${fmt(s.r10)} | ${fmt(s.mrr)}`,
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
    process.stdout.write(renderRecallAtK(inputPath, computeRecallAtK(records)) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
