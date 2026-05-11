/**
 * scripts/eval-phase5/repo-cloner.ts
 *
 * Phase 5 SWE-Bench-TS-Lite: Per-task individual clone @ base_commit.
 *
 * Furia round 13 #3: pureza del entorno NO se negocia.
 *   - Fresh clone per task (no shared workspace state)
 *   - Time-Travel guard: checkout BASE commit (pre-fix)
 *   - Optional fresh npm install per task (paralelizable via CI)
 *
 * Mantra: NREKI debe indexar el codebase BEFORE the fix existed.
 * Si indexa @ commit post-fix, el grafo ya tiene la solución → leakage.
 *
 * Furia round 18: schema migrated to PolyBenchTask. base_commit
 * semantics unchanged (40-char SHA, pre-fix).
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { PolyBenchTask } from "./types.js";

/**
 * Injectable command runner for testability. Default uses execSync;
 * tests inject a mock that captures invocations without spawning git.
 */
export interface CommandRunner {
    run: (cmd: string, opts?: { cwd?: string; timeoutMs?: number }) => string;
}

const defaultRunner: CommandRunner = {
    run: (cmd, opts = {}) => {
        return execSync(cmd, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            cwd: opts.cwd,
            timeout: opts.timeoutMs ?? 120_000,
        });
    },
};

/**
 * Clone a repo to a task-specific directory and checkout the BASE commit.
 *
 * @param task            PolyBenchTask (provides repo + base_commit).
 * @param workspaceRoot   Parent directory for task-* subdirs.
 * @param runner          Optional injected CommandRunner (for tests).
 * @returns               Absolute path to the cloned task directory.
 *
 * @throws if Time-Travel guard sanity check fails (HEAD SHA mismatch).
 */
export async function cloneTaskRepo(
    task: PolyBenchTask,
    workspaceRoot: string,
    runner: CommandRunner = defaultRunner,
): Promise<string> {
    const safeName = task.repo.replace("/", "-");
    const taskDir = path.join(
        workspaceRoot,
        `task-${safeName}-pr${task.pr_number}`,
    );

    // 1. Idempotent clean (rm -rf if exists).
    try {
        await fs.rm(taskDir, { recursive: true, force: true });
    } catch {
        // ignore — defensive
    }

    // 2. Fresh clone.
    const repoUrl = `https://github.com/${task.repo}.git`;
    runner.run(`git clone --quiet "${repoUrl}" "${taskDir}"`);

    // 3. Time-Travel guard: checkout BASE commit (pre-fix state).
    runner.run(
        `git -C "${taskDir}" checkout --quiet ${task.base_commit}`,
    );

    // 4. Sanity check: verify HEAD matches expected base_commit.
    const headSha = runner.run(`git -C "${taskDir}" rev-parse HEAD`).trim();
    if (headSha !== task.base_commit) {
        throw new Error(
            `Time-Travel guard failed for ${task.repo}#${task.pr_number}: ` +
            `expected ${task.base_commit}, got ${headSha}`,
        );
    }

    return taskDir;
}

/**
 * Optional: install dependencies. Slow (~2-5min per task).
 * Non-fatal: NREKI eval may work without deps installed (regex-based
 * extraction doesn't need npm symlinks). Baselines that invoke a TS
 * compiler may require it.
 */
export async function installTaskDeps(
    taskDir: string,
    runner: CommandRunner = defaultRunner,
): Promise<{ installed: boolean; reason?: string }> {
    try {
        runner.run("npm install --silent --no-audit --no-fund", {
            cwd: taskDir,
            timeoutMs: 5 * 60 * 1000,
        });
        return { installed: true };
    } catch (e) {
        return {
            installed: false,
            reason: (e as Error).message,
        };
    }
}
