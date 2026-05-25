#!/usr/bin/env tsx
/**
 * Sprint 7.0 — Phase 2 driver (Verified-Patch Rate experiment).
 *
 * Frozen per scripts/eval-phase7/sprint70-prereg.md.
 *
 * Pipeline per (arm, task, rep):
 *   1. Cleanup task workspace to base_commit (git checkout)
 *   2. Spawn the arm's agent subprocess (child_process.fork — WASM hierro)
 *   3. Subprocess receives task input, runs Claude+tool loop, exits
 *   4. Parent applies patch capture, runs F2P + P2P + tsc check
 *   5. Records pass/fail + secondary metrics
 *
 * Top-level CLI:
 *   npx tsx scripts/eval-phase7/sprint70-driver.ts \
 *     [--arms A,B,C] \
 *     [--n 50] [--reps 3] [--dry-run]
 *
 * Pre-execution: sprint70-sanity-gate.ts MUST exit 0. The driver
 * re-runs the gate and refuses to proceed on HARD blocker.
 *
 * --dry-run: skip all API calls + test_command; simulate arm output as
 *   {pass=0, edits=0, error="dry-run"} per cell. Used to verify the
 *   harness shape WITHOUT spending API tokens.
 *
 * The driver writes results to scripts/eval-phase7/sprint70-results.jsonl
 * one line per cell, append-only, resumable.
 */

import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(process.cwd());
const PHASE7 = path.join(ROOT, "scripts", "eval-phase7");
const RESULTS_JSONL = path.join(PHASE7, "sprint70-results.jsonl");
const FULL_RESULTS = path.join(ROOT, "results-c4b-full.json");
const CACHE = path.join(ROOT, ".eval-phase5-cache", "task-workspaces");

interface Cli {
    arms: ("A" | "B" | "C")[];
    n: number;
    reps: number;
    dryRun: boolean;
}

function parseCli(argv: string[]): Cli {
    const cli: Cli = { arms: ["A", "B"], n: 50, reps: 3, dryRun: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--arms") cli.arms = argv[++i].split(",") as Cli["arms"];
        else if (a === "--n") cli.n = parseInt(argv[++i], 10);
        else if (a === "--reps") cli.reps = parseInt(argv[++i], 10);
        else if (a === "--dry-run") cli.dryRun = true;
    }
    return cli;
}

interface PolyBenchTask {
    instance_id: string;
    repo: string;
    base_commit: string;
    task_category: string;
    patch: string;
    test_patch: string;
    F2P: string;
    P2P: string;
    test_command: string;
    Dockerfile: string;
    problem_statement: string;
}

function slugToTaskDir(repo: string, pullNumber: number): string {
    return path.join(CACHE, `task-${repo.replace("/", "-")}-pr${pullNumber}`);
}

function loadTasks(n: number): PolyBenchTask[] {
    // PolyBench full fields aren't in results-c4b-full.json's per_task (only
    // ground_truth + base_commit). Production driver should re-parse the CSV
    // for full PolyBench fields. For scaffold dry-run we only need
    // (instance_id, repo, base_commit, problem_statement).
    const raw = JSON.parse(readFileSync(FULL_RESULTS, "utf-8"));
    const tasks = raw.per_task as Array<{
        instance_id: string;
        repo: string;
        base_commit: string;
        task_category: string;
    }>;
    const sorted = [...tasks].sort((a, b) => a.instance_id.localeCompare(b.instance_id));
    // Pre-registered selection: even indices [0, 2, 4, ..., 2(n-1)]
    const picked: PolyBenchTask[] = [];
    for (let i = 0; i < n && i * 2 < sorted.length; i++) {
        const t = sorted[i * 2];
        picked.push({
            instance_id: t.instance_id,
            repo: t.repo,
            base_commit: t.base_commit,
            task_category: t.task_category,
            patch: "",  // production driver reads from polybench-verified.csv
            test_patch: "",
            F2P: "",
            P2P: "",
            test_command: "",
            Dockerfile: "",
            problem_statement: "",
        });
    }
    return picked;
}

interface CellResult {
    instance_id: string;
    arm: "A" | "B" | "C";
    rep: number;
    pass: 0 | 1;
    timeout: boolean;
    edits_attempted: number;
    edits_rejected_by_shield: number;
    edits_rejected_then_corrected: number;
    doom_loop: boolean;
    llm_tokens: number;
    wall_clock_ms: number;
    error?: string;
}

function runArmSubprocess(
    arm: "A" | "B" | "C",
    task: PolyBenchTask,
    rep: number,
    dryRun: boolean,
): Promise<CellResult> {
    return new Promise((resolve) => {
        if (dryRun) {
            resolve({
                instance_id: task.instance_id,
                arm,
                rep,
                pass: 0,
                timeout: false,
                edits_attempted: 0,
                edits_rejected_by_shield: 0,
                edits_rejected_then_corrected: 0,
                doom_loop: false,
                llm_tokens: 0,
                wall_clock_ms: 0,
                error: "dry-run (no API call attempted)",
            });
            return;
        }
        // Production path: fork the per-arm body
        const bodyScript = path.join(PHASE7, `sprint70-arm-${arm.toLowerCase()}-body.ts`);
        if (!existsSync(bodyScript)) {
            resolve({
                instance_id: task.instance_id,
                arm,
                rep,
                pass: 0,
                timeout: false,
                edits_attempted: 0,
                edits_rejected_by_shield: 0,
                edits_rejected_then_corrected: 0,
                doom_loop: false,
                llm_tokens: 0,
                wall_clock_ms: 0,
                error: `arm body not implemented: ${bodyScript}`,
            });
            return;
        }
        const child = fork(bodyScript, [], {
            execArgv: ["--max-old-space-size=4096", "-r", "tsx/cjs"],
            silent: true,
            timeout: 2_100_000,  // 2100 s pre-registered total cap
        });
        const startedAt = Date.now();
        child.send({ task, rep });
        child.on("message", (msg: CellResult) => {
            child.kill();
            resolve({ ...msg, wall_clock_ms: Date.now() - startedAt });
        });
        child.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                resolve({
                    instance_id: task.instance_id, arm, rep,
                    pass: 0, timeout: code === null, edits_attempted: 0,
                    edits_rejected_by_shield: 0,
                    edits_rejected_then_corrected: 0,
                    doom_loop: false, llm_tokens: 0,
                    wall_clock_ms: Date.now() - startedAt,
                    error: `subprocess exit ${code}`,
                });
            }
        });
    });
}

async function main() {
    const cli = parseCli(process.argv);

    // Re-run sanity gate
    try {
        execFileSync("npx", ["tsx", path.join(PHASE7, "sprint70-sanity-gate.ts")], {
            stdio: ["ignore", "ignore", "inherit"],
            timeout: 30_000,
        });
    } catch (e) {
        if (!cli.dryRun) {
            process.stderr.write(
                "\nSprint 7.0 driver: sanity gate FAILED. Refusing to run.\n"
                + "Use --dry-run to scaffold-test the harness without API calls.\n\n",
            );
            process.exit(2);
        }
        process.stderr.write(
            "\nSprint 7.0 driver: sanity gate FAILED but --dry-run set, proceeding.\n",
        );
    }

    const tasks = loadTasks(cli.n);
    process.stderr.write(
        `\nSprint 7.0 driver: ${tasks.length} tasks × ${cli.arms.length} arms × ${cli.reps} reps `
        + `= ${tasks.length * cli.arms.length * cli.reps} cells\n`
        + `Mode: ${cli.dryRun ? "DRY-RUN (no API)" : "EXECUTION"}\n\n`,
    );
    if (!existsSync(PHASE7)) mkdirSync(PHASE7, { recursive: true });
    if (existsSync(RESULTS_JSONL)) {
        // Resume from prior partial run
        const seen = readFileSync(RESULTS_JSONL, "utf-8").trim().split("\n")
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l) as CellResult);
        process.stderr.write(`Resume: ${seen.length} prior cells already recorded.\n`);
    } else {
        writeFileSync(RESULTS_JSONL, "");
    }

    let completed = 0;
    const total = tasks.length * cli.arms.length * cli.reps;
    for (const task of tasks) {
        for (const arm of cli.arms) {
            for (let rep = 1; rep <= cli.reps; rep++) {
                process.stderr.write(
                    `[${++completed}/${total}] ${task.instance_id} arm=${arm} rep=${rep} ... `,
                );
                const result = await runArmSubprocess(arm, task, rep, cli.dryRun);
                appendFileSync(RESULTS_JSONL, JSON.stringify(result) + "\n");
                process.stderr.write(
                    result.error
                        ? `ERROR: ${result.error.slice(0, 60)}\n`
                        : `pass=${result.pass} (${result.wall_clock_ms}ms)\n`,
                );
            }
        }
    }

    process.stderr.write(`\nDone. Results in ${RESULTS_JSONL}\n`);
}

main().catch((e) => {
    process.stderr.write(`Driver crashed: ${(e as Error).stack}\n`);
    process.exit(2);
});
