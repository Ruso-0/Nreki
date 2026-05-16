#!/usr/bin/env tsx
/**
 * C.4.C.1 FASE A — Fix Proposals (no meta-judge)
 *
 * Inputs:
 *   - scripts/c4b-subset-stats.json (21 subset task IDs)
 *   - results-c4b-full.jsonl (retrieved chunk metadata per task×retriever)
 *   - scripts/eval-phase5/data/polybench-verified.csv
 *       (canonical source for PolyBenchTask.patch & .problem_statement —
 *        the C.4.B JSONL does NOT carry these)
 *   - .eval-phase5-cache/repo-cache/<owner>-<repo>/
 *       (shallow clones; chunk content materialised via
 *        `git show <base_commit>:<file_path>` then sliced to [start,end])
 *
 * Output:
 *   - results-c4c-proposals.jsonl (incremental, append-only checkpoint;
 *     self-contained: each record carries ground_truth_patch &
 *     problem_statement so Fase B can meta-judge without re-loading the CSV)
 *   - results-c4c-proposals-summary.txt (post-run human-readable summary)
 *
 * Fase A scope (per user instruction):
 *   - Generate fix proposals only — NO meta-judge call in this script.
 *   - Persist enough context per record that a future c4c-meta-judge.ts
 *     can run blind equivalence judgment without touching this file.
 */

import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { encoding_for_model } from "tiktoken";
import { loadPolyBenchVerified, DEFAULT_CSV_PATH } from "./polybench-loader.js";
import type { PolyBenchTask } from "./types.js";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const SUBSET_STATS_PATH = "scripts/c4b-subset-stats.json";
const C4B_RESULTS_PATH = "results-c4b-full.jsonl";
const C4C_OUTPUT_PATH = "results-c4c-proposals.jsonl";
const C4C_SUMMARY_PATH = "results-c4c-proposals-summary.txt";
const REPO_CACHE_ROOT = ".eval-phase5-cache/repo-cache";

const RETRIEVERS_COMPARED = ["nreki-mbf-on", "bm25"] as const;
const HARD_BUDGET_USD = 25;

const OPUS_INPUT_USD_PER_MTOK = 15;
const OPUS_OUTPUT_USD_PER_MTOK = 75;

// ─────────────────────────────────────────────────────────────
// TYPES — match the actual results-c4b-full.jsonl shape
// ─────────────────────────────────────────────────────────────

interface C4BChunk {
    file_path: string;
    start_line: number;
    end_line: number;
    score: number;
}

interface C4BRunnerResult {
    result?: {
        instance_id: string;
        retriever: string;
        retrieved_files: string[];
        retrieved_chunks: C4BChunk[];
        latency_ms: number;
        token_cost: { input_tokens: number; output_tokens: number; total_tokens: number };
    };
    metrics?: { first_hit_recall: number; strict_chunk_containment: number; token_cost: number; latency_ms: number };
    err?: string;
}

interface C4BRecord {
    instance_id: string;
    repo: string;
    base_commit: string;
    task_category: string;
    ground_truth: { strict_src: string[]; permissive: string[]; maximal: string[] };
    runners: Record<string, C4BRunnerResult>;
}

interface FixProposalRecord {
    task_id: string;
    retriever: string;
    repo: string;
    base_commit: string;
    problem_statement: string;
    ground_truth_patch: string;
    proposed_fix: string | null;        // extracted clean unified diff
    proposed_fix_raw: string;            // full raw Opus output
    chunks_unavailable: number;          // count of retrieved chunks that failed to materialise
    opus_input_tokens: number;
    opus_output_tokens: number;
    cost_usd: number;
    duration_ms: number;
    timestamp: string;
    failure_mode: string | null;
}

// ─────────────────────────────────────────────────────────────
// PROMPT (versioned — DO NOT modify post-batch start)
// ─────────────────────────────────────────────────────────────

const FIX_PROMPT_TEMPLATE = (bug: string, context: string) => `
You are a senior software engineer fixing a bug. Given the bug description and code context below, produce a unified diff (git format) that fixes the bug.

BUG DESCRIPTION:
${bug}

CODE CONTEXT (retrieved from repository):
${context}

Respond with ONLY the unified diff inside a single \`\`\`diff fenced code block. Format:

\`\`\`diff
--- a/path/to/file.ts
+++ b/path/to/file.ts
@@ -line,count +line,count @@
 context line
-removed line
+added line
\`\`\`

No explanation, no preamble, no postamble. Only the diff block.
`.trim();

// ─────────────────────────────────────────────────────────────
// TOKEN ESTIMATION (tiktoken cl100k_base — proxy per limitation #9)
// ─────────────────────────────────────────────────────────────

const tokenizer = encoding_for_model("gpt-4");

function estimateTokens(text: string): number {
    return tokenizer.encode(text).length;
}

// ─────────────────────────────────────────────────────────────
// REPO CACHE LOOKUP — `owner/repo` → repo-cache dir name
// ─────────────────────────────────────────────────────────────

function repoToCacheDir(repo: string): string {
    return `${REPO_CACHE_ROOT}/${repo.replace("/", "-")}`;
}

// Cache `git show <sha>:<path>` results within one process invocation.
const fileCache = new Map<string, string | null>();

function readFileAtCommit(cacheDir: string, sha: string, filePath: string): string | null {
    const cacheKey = `${cacheDir}@${sha}:${filePath}`;
    if (fileCache.has(cacheKey)) return fileCache.get(cacheKey)!;

    try {
        const content = execSync(`git show ${sha}:${filePath}`, {
            cwd: cacheDir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 50 * 1024 * 1024,
        });
        fileCache.set(cacheKey, content);
        return content;
    } catch {
        fileCache.set(cacheKey, null);
        return null;
    }
}

interface ChunkResult { content: string | null; reason: string; }

function materialiseChunk(cacheDir: string, sha: string, chunk: C4BChunk): ChunkResult {
    const full = readFileAtCommit(cacheDir, sha, chunk.file_path);
    if (full === null) return { content: null, reason: "file_unreadable_at_base_commit" };
    const lines = full.split("\n");
    const start = Math.max(1, chunk.start_line);
    const end = Math.min(lines.length, chunk.end_line);
    if (end < start) return { content: null, reason: "line_range_inverted" };
    return { content: lines.slice(start - 1, end).join("\n"), reason: "" };
}

function buildContext(rec: C4BRecord, retriever: string): { text: string; missing: number } {
    const cacheDir = repoToCacheDir(rec.repo);
    const chunks = rec.runners[retriever]?.result?.retrieved_chunks ?? [];
    const parts: string[] = [];
    let missing = 0;
    for (const chunk of chunks) {
        const got = materialiseChunk(cacheDir, rec.base_commit, chunk);
        const header = `=== ${chunk.file_path} (lines ${chunk.start_line}-${chunk.end_line}) ===`;
        if (got.content !== null) {
            parts.push(`${header}\n${got.content}`);
        } else {
            missing++;
            parts.push(`${header}\n[unavailable: ${got.reason}]`);
        }
    }
    return { text: parts.join("\n\n"), missing };
}

// ─────────────────────────────────────────────────────────────
// OPUS INVOCATION (stdin pipe — ARG_MAX mitigation per Furia r31)
// ─────────────────────────────────────────────────────────────

async function invokeOpus(prompt: string): Promise<{
    output: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
}> {
    const startTime = Date.now();
    // shell:true on win32 so cmd.exe resolves `claude` → `claude.cmd`.
    // ARG_MAX mitigation is preserved because the prompt rides via stdin, not argv.
    const useShell = process.platform === "win32";
    return new Promise((resolve, reject) => {
        const proc = spawn("claude", ["-p"], { stdio: ["pipe", "pipe", "pipe"], shell: useShell });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (c) => { stdout += c.toString(); });
        proc.stderr.on("data", (c) => { stderr += c.toString(); });
        proc.on("error", (err) => reject(new Error(`Spawn failed: ${err.message}`)));
        proc.on("close", (code) => {
            const durationMs = Date.now() - startTime;
            if (code !== 0) {
                reject(new Error(`claude -p exit code ${code}, stderr: ${stderr.slice(0, 500)}`));
                return;
            }
            const inputTokens = estimateTokens(prompt);
            const outputTokens = estimateTokens(stdout);
            const costUsd =
                (inputTokens / 1_000_000) * OPUS_INPUT_USD_PER_MTOK +
                (outputTokens / 1_000_000) * OPUS_OUTPUT_USD_PER_MTOK;
            resolve({ output: stdout, inputTokens, outputTokens, costUsd, durationMs });
        });
        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

// ─────────────────────────────────────────────────────────────
// REGEX PURIFIER (ANSI + conversational noise — Furia r31 mit 2)
// ─────────────────────────────────────────────────────────────

function extractUnifiedDiff(rawOutput: string): string | null {
    const ansiStripped = rawOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
    const fencedMatch = ansiStripped.match(/```(?:diff|patch|typescript|ts)?\n([\s\S]*?)\n```/);
    if (fencedMatch) return fencedMatch[1].trim();
    const diffStartIdx = ansiStripped.search(/^--- /m);
    if (diffStartIdx >= 0) return ansiStripped.slice(diffStartIdx).trim();
    return null;
}

// ─────────────────────────────────────────────────────────────
// SUMMARY WRITER
// ─────────────────────────────────────────────────────────────

function writeSummary(recordsPath: string, outPath: string) {
    const lines = readFileSync(recordsPath, "utf-8").trim().split("\n").filter(Boolean);
    const records: FixProposalRecord[] = lines.map((l) => JSON.parse(l));

    const total = records.length;
    const parseable = records.filter((r) => r.proposed_fix !== null).length;
    const nullCount = records.filter((r) => r.proposed_fix === null).length;
    const totalCost = records.reduce((s, r) => s + r.cost_usd, 0);

    const failureModes: Record<string, number> = {};
    for (const r of records) {
        if (r.failure_mode) {
            failureModes[r.failure_mode] = (failureModes[r.failure_mode] ?? 0) + 1;
        }
    }

    const byRetriever: Record<string, { total: number; parseable: number; null: number }> = {};
    for (const r of records) {
        const k = r.retriever;
        if (!byRetriever[k]) byRetriever[k] = { total: 0, parseable: 0, null: 0 };
        byRetriever[k].total++;
        if (r.proposed_fix !== null) byRetriever[k].parseable++;
        else byRetriever[k].null++;
    }

    const top3LongestInputs = [...records]
        .sort((a, b) => b.opus_input_tokens - a.opus_input_tokens)
        .slice(0, 3)
        .map((r) => `  ${r.task_id} / ${r.retriever}: ${r.opus_input_tokens.toLocaleString()} tokens (cost $${r.cost_usd.toFixed(3)})`);

    // 5 random task IDs with parseable proposed_fix
    const withFix = records.filter((r) => r.proposed_fix !== null);
    const sampled: FixProposalRecord[] = [];
    const used = new Set<number>();
    for (let i = 0; i < 5 && i < withFix.length; i++) {
        let idx;
        do { idx = Math.floor(Math.random() * withFix.length); } while (used.has(idx));
        used.add(idx);
        sampled.push(withFix[idx]);
    }

    const sampleBlocks = sampled.map((r) => {
        const first20 = (r.proposed_fix ?? "").split("\n").slice(0, 20).join("\n");
        return `--- SAMPLE: ${r.task_id} / ${r.retriever} ---\n${first20}\n${(r.proposed_fix ?? "").split("\n").length > 20 ? "[... truncated]" : ""}`;
    });

    const out = [
        `C.4.C.1 FASE A — Proposals Summary`,
        `Generated: ${new Date().toISOString()}`,
        ``,
        `=== COST ===`,
        `Total Opus 4.7 cost: $${totalCost.toFixed(4)} (tiktoken-estimated, ±10% — limitation #9)`,
        `Hard cap budget:     $${HARD_BUDGET_USD.toFixed(2)}`,
        ``,
        `=== COUNTS (total ${total} records) ===`,
        `Parseable proposals: ${parseable}`,
        `NULL (no fix):       ${nullCount}`,
        ``,
        `By retriever:`,
        ...Object.entries(byRetriever).map(([k, v]) =>
            `  ${k}: total=${v.total}, parseable=${v.parseable}, null=${v.null}`,
        ),
        ``,
        `Failure mode breakdown:`,
        Object.keys(failureModes).length === 0
            ? `  (none — all proposals produced a parseable diff)`
            : Object.entries(failureModes).map(([k, v]) => `  ${k}: ${v}`).join("\n"),
        ``,
        `=== TOP 3 LONGEST opus_input_tokens ===`,
        ...top3LongestInputs,
        ``,
        `=== 5 RANDOM PROPOSED_FIX SAMPLES (first 20 lines each) ===`,
        sampleBlocks.length === 0 ? `  (no parseable proposals to sample)` : sampleBlocks.join("\n\n"),
        ``,
    ].join("\n");

    writeFileSync(outPath, out);
    process.stderr.write(`\nSummary written to ${outPath}\n`);
}

// ─────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────

async function main() {
    // Load subset task IDs
    const subsetStats = JSON.parse(readFileSync(SUBSET_STATS_PATH, "utf-8"));
    const subsetTaskIds: string[] = [
        ...(subsetStats.subset_success_instance_ids ?? []),
        ...((subsetStats.subset_failure_instance_ids ?? []).map((x: any) =>
            typeof x === "string" ? x : x.instance_id,
        )),
    ];
    process.stderr.write(`Loaded ${subsetTaskIds.length} subset task IDs\n`);

    const polyTasks: PolyBenchTask[] = await loadPolyBenchVerified(DEFAULT_CSV_PATH);
    const polyById = new Map(polyTasks.map((t) => [t.instance_id, t]));

    const c4bRecords = new Map<string, C4BRecord>();
    const c4bLines = readFileSync(C4B_RESULTS_PATH, "utf-8").trim().split("\n");
    for (const line of c4bLines) {
        const rec: C4BRecord = JSON.parse(line);
        if (subsetTaskIds.includes(rec.instance_id)) c4bRecords.set(rec.instance_id, rec);
    }
    process.stderr.write(`Loaded ${c4bRecords.size} matching C.4.B records\n`);

    // Resume from checkpoint — also sum prior cost to honour $25 cap across resumes.
    const completedKeys = new Set<string>();
    let cumulativeCost = 0;
    if (existsSync(C4C_OUTPUT_PATH)) {
        const existing = readFileSync(C4C_OUTPUT_PATH, "utf-8").trim().split("\n").filter(Boolean);
        for (const line of existing) {
            const r: FixProposalRecord = JSON.parse(line);
            completedKeys.add(`${r.task_id}:${r.retriever}`);
            cumulativeCost += r.cost_usd;
        }
        process.stderr.write(
            `Resume mode: ${completedKeys.size} records already complete, prior cost $${cumulativeCost.toFixed(2)}\n`,
        );
    }

    for (const taskId of subsetTaskIds) {
        const rec = c4bRecords.get(taskId);
        const poly = polyById.get(taskId);
        if (!rec) {
            process.stderr.write(`Task ${taskId} not in C.4.B records — skipping\n`);
            continue;
        }
        if (!poly) {
            process.stderr.write(`Task ${taskId} not in PolyBench CSV — skipping\n`);
            continue;
        }

        for (const retriever of RETRIEVERS_COMPARED) {
            const key = `${taskId}:${retriever}`;
            if (completedKeys.has(key)) {
                process.stderr.write(`SKIP completed: ${key}\n`);
                continue;
            }

            if (cumulativeCost >= HARD_BUDGET_USD) {
                process.stderr.write(
                    `\n[HARD CAP REACHED] cumulative $${cumulativeCost.toFixed(2)} >= $${HARD_BUDGET_USD}\n` +
                    `STOP. Resume with: tsx scripts/eval-phase5/c4c-fix-accuracy.ts\n`,
                );
                process.exit(2);
            }

            process.stderr.write(`\n[${key}] starting...\n`);

            const runnerData = rec.runners[retriever];
            if (!runnerData || runnerData.err || !runnerData.result?.retrieved_chunks) {
                const r: FixProposalRecord = {
                    task_id: taskId,
                    retriever,
                    repo: rec.repo,
                    base_commit: rec.base_commit,
                    problem_statement: poly.problem_statement,
                    ground_truth_patch: poly.patch,
                    proposed_fix: null,
                    proposed_fix_raw: "",
                    chunks_unavailable: 0,
                    opus_input_tokens: 0,
                    opus_output_tokens: 0,
                    cost_usd: 0,
                    duration_ms: 0,
                    timestamp: new Date().toISOString(),
                    failure_mode: "retriever_data_missing",
                };
                appendFileSync(C4C_OUTPUT_PATH, JSON.stringify(r) + "\n");
                process.stderr.write(`  → NULL (retriever data missing: ${runnerData?.err ?? "no data"})\n`);
                continue;
            }

            const { text: contextText, missing } = buildContext(rec, retriever);
            if (missing > 0) {
                process.stderr.write(`  ⚠ ${missing} chunk(s) unavailable at base_commit\n`);
            }
            const fixPrompt = FIX_PROMPT_TEMPLATE(poly.problem_statement, contextText);

            let opusResult;
            try {
                opusResult = await invokeOpus(fixPrompt);
            } catch (err) {
                process.stderr.write(`  Opus call failed: ${(err as Error).message}, retrying in 60s...\n`);
                await sleep(60_000);
                try {
                    opusResult = await invokeOpus(fixPrompt);
                } catch (err2) {
                    const r: FixProposalRecord = {
                        task_id: taskId,
                        retriever,
                        repo: rec.repo,
                        base_commit: rec.base_commit,
                        problem_statement: poly.problem_statement,
                        ground_truth_patch: poly.patch,
                        proposed_fix: null,
                        proposed_fix_raw: "",
                        chunks_unavailable: missing,
                        opus_input_tokens: 0,
                        opus_output_tokens: 0,
                        cost_usd: 0,
                        duration_ms: 0,
                        timestamp: new Date().toISOString(),
                        failure_mode: `opus_call_failed: ${(err2 as Error).message.slice(0, 200)}`,
                    };
                    appendFileSync(C4C_OUTPUT_PATH, JSON.stringify(r) + "\n");
                    process.stderr.write(`  → NULL (Opus failed)\n`);
                    continue;
                }
            }

            cumulativeCost += opusResult.costUsd;
            process.stderr.write(
                `  Opus done: ${opusResult.durationMs}ms, in=${opusResult.inputTokens} out=${opusResult.outputTokens}, ` +
                `$${opusResult.costUsd.toFixed(3)}, cumul $${cumulativeCost.toFixed(2)}\n`,
            );

            const cleanDiff = extractUnifiedDiff(opusResult.output);
            const r: FixProposalRecord = {
                task_id: taskId,
                retriever,
                repo: rec.repo,
                base_commit: rec.base_commit,
                problem_statement: poly.problem_statement,
                ground_truth_patch: poly.patch,
                proposed_fix: cleanDiff,
                proposed_fix_raw: opusResult.output,
                chunks_unavailable: missing,
                opus_input_tokens: opusResult.inputTokens,
                opus_output_tokens: opusResult.outputTokens,
                cost_usd: opusResult.costUsd,
                duration_ms: opusResult.durationMs,
                timestamp: new Date().toISOString(),
                failure_mode: cleanDiff === null ? "diff_unparseable" : null,
            };
            appendFileSync(C4C_OUTPUT_PATH, JSON.stringify(r) + "\n");
            process.stderr.write(
                cleanDiff === null
                    ? `  → NULL (no parseable diff)\n`
                    : `  → PROPOSAL: ${cleanDiff.split("\n").length} lines, first hunk: ${cleanDiff.split("\n").find((l) => l.startsWith("@@")) ?? "(no @@)"}\n`,
            );
        }
    }

    process.stderr.write(`\n[BATCH COMPLETE] cumulative cost $${cumulativeCost.toFixed(2)}\n`);
    process.stderr.write(`Output: ${C4C_OUTPUT_PATH}\n`);
    writeSummary(C4C_OUTPUT_PATH, C4C_SUMMARY_PATH);
}

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}

main().catch((err) => {
    process.stderr.write(`FATAL: ${err.stack ?? err}\n`);
    process.exit(1);
});
