#!/usr/bin/env tsx
/**
 * Sprint 6.3.5 reconcile: offline Reciprocal Rank Fusion simulation.
 *
 * Default analysis now fuses NREKI + BM25 retrieved_chunks, matching
 * Sprint 6.3's chunk-level RRF grain. The original file-level simulator
 * remains in this file only for side-by-side deltas.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mean } from "./metrics.js";

const DEFAULT_INPUT = "results-c4b-v2-full.jsonl";
const DEFAULT_RRF_K = 60;
const DEFAULT_LIMIT = 10;
const DEFAULT_RESAMPLES = 10_000;
const DEFAULT_SEED = 0x62_0;
const EXPECTED_STRICT_TASKS = 99;

type RetrieverName = "NREKI" | "BM25" | "RRF chunk-level";
type DeltaMetricName = "R@1" | "R@5" | "FHR" | "CLR" | "MRR";

export interface ChunkResult {
    file_path: string;
    start_line: number;
    end_line: number;
    score?: number;
}

interface RunnerCell {
    result: {
        retrieved_files: string[];
        retrieved_chunks?: ChunkResult[];
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
    fhr: number;
    clr: number;
    r1: number;
    r3: number;
    r5: number;
    r10: number;
    mrr: number;
}

interface SimulatedTask {
    instanceId: string;
    nrekiChunks: ChunkResult[];
    bm25Chunks: ChunkResult[];
    rrfChunks: ChunkResult[];
    nreki: TaskMetric;
    bm25: TaskMetric;
    rrf: TaskMetric;
}

interface FileLevelTask {
    instanceId: string;
    nrekiFiles: string[];
    bm25Files: string[];
    rrfFiles: string[];
    nreki: TaskMetric;
    bm25: TaskMetric;
    rrf: TaskMetric;
}

interface AggregateRow {
    retriever: RetrieverName;
    fhr: number;
    clr: number;
    r1: number;
    r3: number;
    r5: number;
    r10: number;
    mrr: number;
}

interface BootstrapRow {
    metric: DeltaMetricName;
    observed: number;
    ci95Low: number;
    ci95High: number;
    significant: boolean;
    toxicDegradation: boolean;
}

interface OverlapReport {
    n: number;
    improved: number;
    maintained: number;
    degraded: number;
    degradedTasks: Array<{
        instanceId: string;
        nrekiRank: number;
        bm25Rank: number;
        rrfRank: number | null;
    }>;
}

export interface ComparisonRow {
    metric: DeltaMetricName;
    fileLevelObserved: number;
    fileLevelSignificant: boolean;
    chunkLevelObserved: number;
    chunkLevelSignificant: boolean;
}

export interface RrfSimulationReport {
    inputPath: string;
    n: number;
    rrfK: number;
    limit: number;
    hybridLimit: number;
    aggregates: AggregateRow[];
    bootstrap: BootstrapRow[];
    fileLevelBootstrap: BootstrapRow[];
    comparison: ComparisonRow[];
    overlap: OverlapReport;
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

function assertStringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} schema error: retrieved_files is not an array`);
    }
    for (const [idx, item] of value.entries()) {
        if (typeof item !== "string") {
            throw new Error(`${label} schema error: retrieved_files[${idx}] is not a string`);
        }
    }
    const seen = new Set<string>();
    for (const item of value) {
        if (seen.has(item)) {
            throw new Error(`${label} schema error: duplicate retrieved_files entry ${item}`);
        }
        seen.add(item);
    }
    return value;
}

function chunkKey(chunk: Pick<ChunkResult, "file_path" | "start_line" | "end_line">): string {
    return `${chunk.file_path}\0${chunk.start_line}\0${chunk.end_line}`;
}

function assertChunkArray(value: unknown, label: string): ChunkResult[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} schema error: retrieved_chunks is not an array`);
    }
    for (const [idx, chunk] of value.entries()) {
        if (
            typeof chunk?.file_path !== "string" ||
            typeof chunk?.start_line !== "number" ||
            typeof chunk?.end_line !== "number"
        ) {
            throw new Error(`${label} schema error: retrieved_chunks[${idx}] lacks file_path/start_line/end_line`);
        }
        if (chunk.score !== undefined && typeof chunk.score !== "number") {
            throw new Error(`${label} schema error: retrieved_chunks[${idx}].score is not numeric`);
        }
    }
    return value;
}

function fallbackChunks(files: string[]): ChunkResult[] {
    return files.map((file, idx) => ({
        file_path: file,
        start_line: idx + 1,
        end_line: idx + 1,
    }));
}

function chunksForCell(cell: RunnerCell, label: string, strictChunks: boolean): ChunkResult[] {
    if (cell.result.retrieved_chunks !== undefined) {
        return assertChunkArray(cell.result.retrieved_chunks, label);
    }
    if (strictChunks) {
        throw new Error(`${label} schema error: retrieved_chunks missing`);
    }
    return fallbackChunks(assertStringArray(cell.result.retrieved_files, label));
}

function validateTask(task: PerTaskResult, strictChunks: boolean): void {
    if (!Array.isArray(task.ground_truth?.strict_src)) {
        throw new Error(`${task.instance_id} schema error: ground_truth.strict_src missing`);
    }
    const nreki = task.runners["nreki-mbf-on"];
    const bm25 = task.runners.bm25;
    if (!nreki) throw new Error(`${task.instance_id} schema error: nreki-mbf-on missing`);
    if (!bm25) throw new Error(`${task.instance_id} schema error: bm25 missing`);
    assertStringArray(nreki.result?.retrieved_files, `${task.instance_id} nreki-mbf-on`);
    assertStringArray(bm25.result?.retrieved_files, `${task.instance_id} bm25`);
    chunksForCell(nreki, `${task.instance_id} nreki-mbf-on`, strictChunks);
    chunksForCell(bm25, `${task.instance_id} bm25`, strictChunks);
}

function dedupeChunks(chunks: ChunkResult[]): ChunkResult[] {
    const seen = new Set<string>();
    const out: ChunkResult[] = [];
    for (const chunk of chunks) {
        const key = chunkKey(chunk);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(chunk);
    }
    return out;
}

function rankMap<T>(items: T[], key: (item: T) => string, limit: number): Map<string, number> {
    const ranks = new Map<string, number>();
    items.slice(0, limit).forEach((item, idx) => {
        const k = key(item);
        if (!ranks.has(k)) ranks.set(k, idx + 1);
    });
    return ranks;
}

export function rrfFuse(
    nrekiFiles: string[],
    bm25Files: string[],
    k = DEFAULT_RRF_K,
    limit = DEFAULT_LIMIT,
): string[] {
    assertStringArray(nrekiFiles, "nreki");
    assertStringArray(bm25Files, "bm25");

    const nrekiRanks = rankMap(nrekiFiles, file => file, limit);
    const bm25Ranks = rankMap(bm25Files, file => file, limit);
    const order = new Map<string, number>();
    const union: string[] = [];

    for (const file of [...nrekiFiles.slice(0, limit), ...bm25Files.slice(0, limit)]) {
        if (order.has(file)) continue;
        order.set(file, union.length);
        union.push(file);
    }

    return union
        .map(file => {
            const nRank = nrekiRanks.get(file);
            const bRank = bm25Ranks.get(file);
            const score =
                (nRank === undefined ? 0 : 1 / (k + nRank)) +
                (bRank === undefined ? 0 : 1 / (k + bRank));
            return {
                file,
                score,
                bestRank: Math.min(nRank ?? Number.POSITIVE_INFINITY, bRank ?? Number.POSITIVE_INFINITY),
                order: order.get(file) ?? Number.MAX_SAFE_INTEGER,
            };
        })
        .sort((a, b) =>
            b.score - a.score ||
            a.bestRank - b.bestRank ||
            a.order - b.order ||
            a.file.localeCompare(b.file),
        )
        .slice(0, limit)
        .map(item => item.file);
}

export function rrfFuseChunks(
    nrekiChunks: ChunkResult[],
    bm25Chunks: ChunkResult[],
    k = DEFAULT_RRF_K,
    limit = DEFAULT_LIMIT,
    hybridLimit = limit * 2,
): ChunkResult[] {
    const nrekiPool = dedupeChunks(nrekiChunks).slice(0, hybridLimit);
    const bm25Pool = dedupeChunks(bm25Chunks).slice(0, hybridLimit);
    const nrekiRanks = rankMap(nrekiPool, chunkKey, hybridLimit);
    const bm25Ranks = rankMap(bm25Pool, chunkKey, hybridLimit);
    const order = new Map<string, number>();
    const union = new Map<string, ChunkResult>();

    for (const chunk of [...nrekiPool, ...bm25Pool]) {
        const key = chunkKey(chunk);
        if (union.has(key)) continue;
        order.set(key, order.size);
        union.set(key, chunk);
    }

    return [...union.entries()]
        .map(([key, chunk]) => {
            const nRank = nrekiRanks.get(key);
            const bRank = bm25Ranks.get(key);
            const score =
                (nRank === undefined ? 0 : 1 / (k + nRank)) +
                (bRank === undefined ? 0 : 1 / (k + bRank));
            return {
                chunk,
                score,
                bestRank: Math.min(nRank ?? Number.POSITIVE_INFINITY, bRank ?? Number.POSITIVE_INFINITY),
                order: order.get(key) ?? Number.MAX_SAFE_INTEGER,
            };
        })
        .sort((a, b) =>
            b.score - a.score ||
            a.bestRank - b.bestRank ||
            a.order - b.order ||
            chunkKey(a.chunk).localeCompare(chunkKey(b.chunk)),
        )
        .slice(0, limit)
        .map(item => ({ ...item.chunk, score: item.score }));
}

function firstRelevantFileRank(files: string[], truth: string[], limit: number): number | null {
    const truthSet = new Set(truth);
    const index = files.slice(0, limit).findIndex(file => truthSet.has(file));
    return index >= 0 ? index + 1 : null;
}

function firstRelevantChunkRank(chunks: ChunkResult[], truth: string[], limit: number): number | null {
    const truthSet = new Set(truth);
    const index = chunks.slice(0, limit).findIndex(chunk => truthSet.has(chunk.file_path));
    return index >= 0 ? index + 1 : null;
}

function fileContainment(files: string[], truth: string[], limit: number): number {
    if (truth.length === 0) return 1;
    const fileSet = new Set(files.slice(0, limit));
    const truthSet = new Set(truth);
    let covered = 0;
    for (const file of truthSet) {
        if (fileSet.has(file)) covered++;
    }
    return covered / truthSet.size;
}

function metricsForFiles(files: string[], truth: string[], limit: number): TaskMetric {
    const rank = firstRelevantFileRank(files, truth, limit);
    return {
        fhr: rank !== null && rank <= limit ? 1 : 0,
        clr: fileContainment(files, truth, limit),
        r1: rank !== null && rank <= 1 ? 1 : 0,
        r3: rank !== null && rank <= 3 ? 1 : 0,
        r5: rank !== null && rank <= 5 ? 1 : 0,
        r10: rank !== null && rank <= 10 ? 1 : 0,
        mrr: rank === null ? 0 : 1 / rank,
    };
}

function metricsForChunks(chunks: ChunkResult[], truth: string[], limit: number): TaskMetric {
    const rank = firstRelevantChunkRank(chunks, truth, limit);
    const top1 = chunks[0];
    const truthSet = new Set(truth);
    return {
        fhr: top1 && truthSet.has(top1.file_path) ? 1 : 0,
        clr: rank !== null && rank <= limit ? 1 : 0,
        r1: rank !== null && rank <= 1 ? 1 : 0,
        r3: rank !== null && rank <= 3 ? 1 : 0,
        r5: rank !== null && rank <= 5 ? 1 : 0,
        r10: rank !== null && rank <= 10 ? 1 : 0,
        mrr: rank === null ? 0 : 1 / rank,
    };
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

function bootstrapDeltas(
    deltas: number[],
    resamples: number,
    seed: number,
): { observed: number; ci95Low: number; ci95High: number; significant: boolean } {
    const observed = mean(deltas);
    const random = rng(seed);
    const samples: number[] = new Array(resamples);
    for (let i = 0; i < resamples; i++) {
        let sum = 0;
        for (let j = 0; j < deltas.length; j++) {
            sum += deltas[Math.floor(random() * deltas.length)];
        }
        samples[i] = sum / deltas.length;
    }
    samples.sort((a, b) => a - b);
    const ci95Low = samples[Math.floor(0.025 * (samples.length - 1))];
    const ci95High = samples[Math.floor(0.975 * (samples.length - 1))];
    return {
        observed,
        ci95Low,
        ci95High,
        significant: ci95Low > 0 || ci95High < 0,
    };
}

function metricValue(metric: DeltaMetricName, values: TaskMetric): number {
    switch (metric) {
        case "R@1": return values.r1;
        case "R@5": return values.r5;
        case "FHR": return values.fhr;
        case "CLR": return values.clr;
        case "MRR": return values.mrr;
    }
}

function bootstrapRows<T>(
    tasks: T[],
    pickRrf: (task: T) => TaskMetric,
    pickNreki: (task: T) => TaskMetric,
    resamples: number,
): BootstrapRow[] {
    const metrics: DeltaMetricName[] = ["R@1", "R@5", "FHR", "CLR", "MRR"];
    return metrics.map((metric, idx) => {
        const deltas = tasks.map(task =>
            metricValue(metric, pickRrf(task)) - metricValue(metric, pickNreki(task)),
        );
        const row = bootstrapDeltas(deltas, resamples, DEFAULT_SEED + idx);
        return {
            metric,
            ...row,
            toxicDegradation: row.observed < 0 && row.ci95Low < 0,
        };
    });
}

function aggregate(name: RetrieverName, tasks: SimulatedTask[], pick: (task: SimulatedTask) => TaskMetric): AggregateRow {
    const values = tasks.map(pick);
    return {
        retriever: name,
        fhr: mean(values.map(v => v.fhr)),
        clr: mean(values.map(v => v.clr)),
        r1: mean(values.map(v => v.r1)),
        r3: mean(values.map(v => v.r3)),
        r5: mean(values.map(v => v.r5)),
        r10: mean(values.map(v => v.r10)),
        mrr: mean(values.map(v => v.mrr)),
    };
}

function simulateChunkTasks(
    records: PerTaskResult[],
    k: number,
    limit: number,
    hybridLimit: number,
    strictChunks: boolean,
): SimulatedTask[] {
    return records
        .filter(task => !task.error && task.ground_truth.strict_src.length > 0)
        .map(task => {
            validateTask(task, strictChunks);
            const nrekiCell = task.runners["nreki-mbf-on"]!;
            const bm25Cell = task.runners.bm25!;
            const nrekiChunks = chunksForCell(nrekiCell, `${task.instance_id} nreki-mbf-on`, strictChunks);
            const bm25Chunks = chunksForCell(bm25Cell, `${task.instance_id} bm25`, strictChunks);
            const rrfChunks = rrfFuseChunks(nrekiChunks, bm25Chunks, k, limit, hybridLimit);
            return {
                instanceId: task.instance_id,
                nrekiChunks,
                bm25Chunks,
                rrfChunks,
                nreki: metricsForChunks(nrekiChunks, task.ground_truth.strict_src, limit),
                bm25: metricsForChunks(bm25Chunks, task.ground_truth.strict_src, limit),
                rrf: metricsForChunks(rrfChunks, task.ground_truth.strict_src, limit),
            };
        });
}

function simulateFileLevelTasks(records: PerTaskResult[], k: number, limit: number): FileLevelTask[] {
    return records
        .filter(task => !task.error && task.ground_truth.strict_src.length > 0)
        .map(task => {
            validateTask(task, false);
            const nrekiFiles = task.runners["nreki-mbf-on"]!.result.retrieved_files.slice(0, limit);
            const bm25Files = task.runners.bm25!.result.retrieved_files.slice(0, limit);
            const rrfFiles = rrfFuse(nrekiFiles, bm25Files, k, limit);
            return {
                instanceId: task.instance_id,
                nrekiFiles,
                bm25Files,
                rrfFiles,
                nreki: metricsForFiles(nrekiFiles, task.ground_truth.strict_src, limit),
                bm25: metricsForFiles(bm25Files, task.ground_truth.strict_src, limit),
                rrf: metricsForFiles(rrfFiles, task.ground_truth.strict_src, limit),
            };
        });
}

function computeOverlapReport(records: PerTaskResult[], tasks: SimulatedTask[], limit: number): OverlapReport {
    const truthById = new Map(records.map(r => [r.instance_id, r.ground_truth.strict_src]));
    let improved = 0;
    let maintained = 0;
    let degraded = 0;
    const degradedTasks: OverlapReport["degradedTasks"] = [];

    for (const task of tasks) {
        const truth = truthById.get(task.instanceId) ?? [];
        const nRank = firstRelevantChunkRank(task.nrekiChunks, truth, limit);
        const bRank = firstRelevantChunkRank(task.bm25Chunks, truth, limit);
        if (nRank === null || bRank === null) continue;
        const rrfRank = firstRelevantChunkRank(task.rrfChunks, truth, limit);
        const best = Math.min(nRank, bRank);
        if (rrfRank !== null && rrfRank < best) {
            improved++;
        } else if (rrfRank === best) {
            maintained++;
        } else {
            degraded++;
            degradedTasks.push({
                instanceId: task.instanceId,
                nrekiRank: nRank,
                bm25Rank: bRank,
                rrfRank,
            });
        }
    }

    return { n: improved + maintained + degraded, improved, maintained, degraded, degradedTasks };
}

function compareBootstrap(fileLevel: BootstrapRow[], chunkLevel: BootstrapRow[]): ComparisonRow[] {
    return chunkLevel.map(row => {
        const fileRow = fileLevel.find(item => item.metric === row.metric);
        if (!fileRow) {
            throw new Error(`Internal error: missing file-level bootstrap row for ${row.metric}`);
        }
        return {
            metric: row.metric,
            fileLevelObserved: fileRow.observed,
            fileLevelSignificant: fileRow.significant,
            chunkLevelObserved: row.observed,
            chunkLevelSignificant: row.significant,
        };
    });
}

export function analyzeRrfSimulation(
    records: PerTaskResult[],
    inputPath = DEFAULT_INPUT,
    k = DEFAULT_RRF_K,
    limit = DEFAULT_LIMIT,
    resamples = DEFAULT_RESAMPLES,
    strictChunks = false,
): RrfSimulationReport {
    const hybridLimit = limit * 2;
    const chunkTasks = simulateChunkTasks(records, k, limit, hybridLimit, strictChunks);
    const fileTasks = simulateFileLevelTasks(records, k, limit);
    const bootstrap = bootstrapRows(chunkTasks, task => task.rrf, task => task.nreki, resamples);
    const fileLevelBootstrap = bootstrapRows(fileTasks, task => task.rrf, task => task.nreki, resamples);

    return {
        inputPath,
        n: chunkTasks.length,
        rrfK: k,
        limit,
        hybridLimit,
        aggregates: [
            aggregate("NREKI", chunkTasks, task => task.nreki),
            aggregate("BM25", chunkTasks, task => task.bm25),
            aggregate("RRF chunk-level", chunkTasks, task => task.rrf),
        ],
        bootstrap,
        fileLevelBootstrap,
        comparison: compareBootstrap(fileLevelBootstrap, bootstrap),
        overlap: computeOverlapReport(records, chunkTasks, limit),
    };
}

function fmt(n: number): string {
    if (Number.isNaN(n)) return "NaN";
    return n.toFixed(3);
}

function signed(n: number): string {
    if (Number.isNaN(n)) return "NaN";
    return `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;
}

function sig(value: boolean): string {
    return value ? "SIG" : "not sig";
}

export function renderRrfSimulation(report: RrfSimulationReport): string {
    const lines = [
        `Input: ${report.inputPath}`,
        `Tasks with strict_src > 0: N=${report.n}`,
        `RRF k=${report.rrfK} top=${report.limit} hybridLimit=${report.hybridLimit}`,
        "Chunk-level FHR is top-1 chunk hit; CLR is any top-K chunk hit.",
        "",
        "Retriever | FHR | CLR | R@1 | R@3 | R@5 | R@10 | MRR",
    ];
    for (const row of report.aggregates) {
        lines.push(
            `${row.retriever} | ${fmt(row.fhr)} | ${fmt(row.clr)} | ${fmt(row.r1)} | ${fmt(row.r3)} | ${fmt(row.r5)} | ${fmt(row.r10)} | ${fmt(row.mrr)}`,
        );
    }
    lines.push(
        "",
        "Bootstrap CI95%: Delta = RRF chunk-level - NREKI",
        "Metric | observed | CI95% low | CI95% high | significant | toxic_degradation",
    );
    for (const row of report.bootstrap) {
        lines.push(
            `${row.metric} | ${signed(row.observed)} | ${signed(row.ci95Low)} | ${signed(row.ci95High)} | ${row.significant} | ${row.toxicDegradation}`,
        );
    }
    lines.push(
        "",
        "File-level vs chunk-level delta comparison",
        "Metric | File-level RRF original | Chunk-level RRF",
    );
    for (const row of report.comparison) {
        lines.push(
            `${row.metric} | ${signed(row.fileLevelObserved)} ${sig(row.fileLevelSignificant)} | ${signed(row.chunkLevelObserved)} ${sig(row.chunkLevelSignificant)}`,
        );
    }
    lines.push(
        "",
        "Overlap degradation analysis (tasks where NREKI and BM25 chunks both hit)",
        `improve=${report.overlap.improved} maintain=${report.overlap.maintained} degrade=${report.overlap.degraded} total=${report.overlap.n}`,
    );
    if (report.overlap.degradedTasks.length > 0) {
        lines.push("Degraded tasks:");
        for (const task of report.overlap.degradedTasks) {
            lines.push(
                `${task.instanceId} | nreki=${task.nrekiRank} | bm25=${task.bm25Rank} | rrf=${task.rrfRank ?? "MISS"}`,
            );
        }
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
    const report = analyzeRrfSimulation(records, inputPath, DEFAULT_RRF_K, DEFAULT_LIMIT, DEFAULT_RESAMPLES, true);
    if (report.n !== EXPECTED_STRICT_TASKS) {
        throw new Error(
            `Expected ${EXPECTED_STRICT_TASKS} strict_src tasks, got ${report.n}`,
        );
    }
    process.stdout.write(renderRrfSimulation(report) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
