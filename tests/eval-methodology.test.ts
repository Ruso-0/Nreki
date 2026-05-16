import { describe, expect, it, vi } from "vitest";

import {
    analyzePairedVoyage,
    renderPairedAnalysis,
} from "../scripts/eval-phase5/voyage-paired-analysis.js";
import {
    computeRecallAtK,
    renderRecallAtK,
} from "../scripts/eval-phase5/recall-at-k.js";
import {
    aggregateRows,
    renderAggregate,
} from "../scripts/eval-phase5/aggregate.js";
import {
    analyzeBootstrapRkMrr,
    bootstrapPairedMetric,
    renderBootstrapReport,
} from "../scripts/eval-phase5/bootstrap-rk-mrr.js";
import {
    analyzeRrfSimulation,
    renderRrfSimulation,
    rrfFuse,
} from "../scripts/eval-phase5/rrf-simulation.js";
import { printConsoleSummary } from "../scripts/eval-phase5/report.js";

function cell(files: string[], fhr: number, clr: number, tokens: number, error?: string) {
    return {
        result: { retrieved_files: files, error },
        metrics: {
            first_hit_recall: fhr,
            strict_chunk_containment: clr,
            token_cost: tokens,
            latency_ms: tokens,
        },
    };
}

describe("Phase 6.0 methodology scripts", () => {
    it("paired Voyage analysis keeps only successful voyage tasks", () => {
        const records = [
            {
                instance_id: "ok",
                runners: {
                    "voyage-3": cell(["a.ts"], 1, 0.5, 100),
                    "nreki-mbf-on": cell(["b.ts"], 0, 0.25, 10),
                },
            },
            {
                instance_id: "skipped",
                runners: {
                    "voyage-3": cell([], 0, 0, 0, "Voyage SKIPPED"),
                    "nreki-mbf-on": cell(["a.ts"], 1, 1, 10),
                },
            },
        ] as any;

        const analysis = analyzePairedVoyage(records, "fake.jsonl", 100);
        expect(analysis.n).toBe(1);
        expect(analysis.taskIds).toEqual(["ok"]);
        expect(renderPairedAnalysis(analysis)).toContain("Successful voyage-3 paired subset: N=1");
    });

    it("Recall@K and MRR use first relevant rank and exclude Aider", () => {
        const records = [
            {
                instance_id: "t1",
                ground_truth: { strict_src: ["target.ts"] },
                runners: {
                    bm25: { result: { retrieved_files: ["x.ts", "target.ts"] } },
                    "nreki-mbf-on": { result: { retrieved_files: ["target.ts"] } },
                    aider: { result: { retrieved_files: [], error: "timeout" } },
                },
            },
            {
                instance_id: "t2",
                ground_truth: { strict_src: ["other.ts"] },
                runners: {
                    bm25: { result: { retrieved_files: ["none.ts"] } },
                    "nreki-mbf-on": { result: { retrieved_files: ["z.ts", "other.ts"] } },
                    aider: { result: { retrieved_files: [], error: "timeout" } },
                },
            },
        ] as any;

        const summaries = computeRecallAtK(records);
        const bm25 = summaries.find(s => s.retriever === "bm25")!;
        const nreki = summaries.find(s => s.retriever === "nreki-mbf-on")!;
        expect(summaries.some(s => s.retriever === "aider")).toBe(false);
        expect(bm25.r1).toBe(0);
        expect(bm25.r3).toBe(0.5);
        expect(bm25.mrr).toBe(0.25);
        expect(nreki.r1).toBe(0.5);
        expect(nreki.r3).toBe(1);
        expect(nreki.mrr).toBe(0.75);
        expect(renderRecallAtK("fake.jsonl", summaries)).toContain("Aider excluded");
    });

    it("console report separates Aider infrastructure from IR table", () => {
        const report = {
            timestamp_utc: "now",
            options: {},
            total_tasks_attempted: 1,
            total_tasks_completed: 1,
            per_runner: {
                bm25: {
                    first_hit_recall_mean: 1,
                    strict_chunk_containment_mean: 1,
                    token_cost_mean: 100,
                    token_cost_p50: 50,
                    token_cost_p95: 95,
                    token_cost_p99: 99,
                    latency_ms_mean: 1000,
                    latency_ms_p50: 500,
                    latency_ms_p95: 950,
                    latency_ms_p99: 990,
                    error_rate: 0,
                    completed_tasks: 1,
                    excluded_empty_gt: 0,
                },
                aider: {
                    first_hit_recall_mean: 0,
                    strict_chunk_containment_mean: 0,
                    token_cost_mean: 0,
                    token_cost_p50: 0,
                    token_cost_p95: 0,
                    token_cost_p99: 0,
                    latency_ms_mean: 0,
                    latency_ms_p50: Number.NaN,
                    latency_ms_p95: Number.NaN,
                    latency_ms_p99: Number.NaN,
                    error_rate: 1,
                    completed_tasks: 0,
                    excluded_empty_gt: 0,
                },
            },
            per_task: [
                {
                    instance_id: "t1",
                    repo: "owner/repo",
                    runners: {
                        bm25: {
                            result: { retrieved_files: ["a.ts"] },
                            metrics: {
                                first_hit_recall: 1,
                                strict_chunk_containment: 1,
                                token_cost: 50,
                                latency_ms: 500,
                            },
                        },
                        aider: {
                            result: { retrieved_files: [], error: "Aider timeout: exceeded" },
                            metrics: {
                                first_hit_recall: 0,
                                strict_chunk_containment: 0,
                                token_cost: 0,
                                latency_ms: 0,
                            },
                        },
                    },
                },
            ],
        } as any;
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

        printConsoleSummary(report);
        const out = log.mock.calls.map(args => args.join(" ")).join("\n");
        log.mockRestore();

        expect(out).toContain("Information Retrieval (Aider excluded");
        expect(out).toContain("Mean disclosure (not headline)");
        expect(out).toContain("Infrastructure Reliability");
        expect(out).toContain("aider: timeout_rate=100.0%");
    });

    it("JSONL aggregate reports p50/p95/p99 and separates Aider", () => {
        const records = [
            {
                instance_id: "t1",
                ground_truth: { strict_src: ["a.ts"] },
                runners: {
                    bm25: cell(["a.ts"], 1, 1, 10),
                    aider: cell([], 0, 0, 0, "Aider timeout: exceeded"),
                },
            },
            {
                instance_id: "t2",
                ground_truth: { strict_src: ["b.ts"] },
                runners: {
                    bm25: cell([], 0, 0, 30),
                    aider: cell([], 0, 0, 0, "Aider timeout: exceeded"),
                },
            },
        ] as any;

        const rows = aggregateRows(records);
        const bm25 = rows.find(r => r.retriever === "bm25")!;
        expect(bm25.tokenP50).toBe(20);
        expect(bm25.tokenP95).toBe(29);
        expect(bm25.tokenP99).toBe(29.8);
        const rendered = renderAggregate("fake.jsonl", records);
        expect(rendered).toContain("Information Retrieval (Aider excluded");
        expect(rendered).toContain("Mean disclosure (not headline)");
        expect(rendered).toContain("Infrastructure Reliability");
        expect(rendered).toContain("timeout_rate=100.0%");
    });

    it("bootstrap R@K/MRR uses paired NREKI minus BM25 task deltas", () => {
        const boot = bootstrapPairedMetric([1, 1, 1], 100, 1);
        expect(boot.observed).toBe(1);
        expect(boot.ci95Low).toBe(1);
        expect(boot.ci95High).toBe(1);
        expect(boot.significant).toBe(true);

        const records = [
            {
                instance_id: "t1",
                ground_truth: { strict_src: ["a.ts"] },
                runners: {
                    bm25: { result: { retrieved_files: ["x.ts", "a.ts"] } },
                    "nreki-mbf-on": { result: { retrieved_files: ["a.ts"] } },
                },
            },
            {
                instance_id: "t2",
                ground_truth: { strict_src: ["b.ts"] },
                runners: {
                    bm25: { result: { retrieved_files: ["b.ts"] } },
                    "nreki-mbf-on": { result: { retrieved_files: ["z.ts"] } },
                },
            },
        ] as any;

        const report = analyzeBootstrapRkMrr(records, "fake.jsonl", 100);
        expect(report.n).toBe(2);
        expect(report.rows.find(r => r.metric === "R@1")?.observed).toBe(0);
        expect(report.rows.find(r => r.metric === "R@3")?.observed).toBe(-0.5);
        expect(report.rows.find(r => r.metric === "MRR")?.observed).toBe(-0.25);
        expect(renderBootstrapReport(report)).toContain("Delta = nreki-mbf-on - bm25");
    });

    it("RRF fusion boosts overlapping files and reports paired deltas", () => {
        expect(rrfFuse(
            ["n-only.ts", "shared.ts"],
            ["shared.ts", "b-only.ts"],
            60,
            3,
        )).toEqual(["shared.ts", "n-only.ts", "b-only.ts"]);
        expect(() => rrfFuse(["dup.ts", "dup.ts"], [], 60, 10)).toThrow(/duplicate/);

        const records = [
            {
                instance_id: "t1",
                ground_truth: { strict_src: ["shared.ts"] },
                runners: {
                    bm25: { result: {
                        retrieved_files: ["shared.ts"],
                        retrieved_chunks: [{ file_path: "shared.ts", start_line: 1, end_line: 1 }],
                    } },
                    "nreki-mbf-on": { result: {
                        retrieved_files: ["n-only.ts", "shared.ts"],
                        retrieved_chunks: [
                            { file_path: "n-only.ts", start_line: 1, end_line: 1 },
                            { file_path: "shared.ts", start_line: 1, end_line: 1 },
                        ],
                    } },
                },
            },
            {
                instance_id: "t2",
                ground_truth: { strict_src: ["nreki.ts"] },
                runners: {
                    bm25: { result: {
                        retrieved_files: ["other.ts"],
                        retrieved_chunks: [{ file_path: "other.ts", start_line: 1, end_line: 1 }],
                    } },
                    "nreki-mbf-on": { result: {
                        retrieved_files: ["nreki.ts"],
                        retrieved_chunks: [{ file_path: "nreki.ts", start_line: 1, end_line: 1 }],
                    } },
                },
            },
        ] as any;

        const report = analyzeRrfSimulation(records, "fake.jsonl", 60, 10, 100);
        expect(report.n).toBe(2);
        expect(report.aggregates.find(r => r.retriever === "RRF chunk-level")?.r1).toBe(1);
        expect(report.bootstrap.find(r => r.metric === "R@1")?.observed).toBe(0.5);
        expect(report.overlap.n).toBe(1);
        expect(report.overlap.maintained).toBe(1);
        expect(renderRrfSimulation(report)).toContain("RRF chunk-level");
    });
});
