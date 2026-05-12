/**
 * scripts/eval-phase5/repo-cloner.ts
 *
 * Phase 5 SWE-Bench-TS-Lite: shallow clone + (repo, commit) cache.
 *
 * Furia round 13 #3: pureza del entorno NO se negocia.
 *   - Per-task workspace (fresh checkout, no state bleed across tasks)
 *   - Time-Travel guard: HEAD verified == base_commit (pre-fix)
 *   - Optional fresh npm install per task (paralelizable via CI)
 *
 * Mantra: NREKI debe indexar el codebase BEFORE the fix existed.
 *
 * Phase 5 C.4.A.6 (refactor):
 *   - Original cloneTaskRepo did `rm -rf taskDir && git clone <url>` per task.
 *     With 70 mui tasks * ~1.5 GB each that exceeded the 47 GB disk budget.
 *   - New design: shallow clone (`git clone --filter=blob:none`) per UNIQUE
 *     repo, cached under `<workspaceRoot>/repo-cache/<safe-name>`. Per-task
 *     workspaces are built by copying the cache's `.git` directory into a
 *     fresh `<workspaceRoot>/task-<owner>-<repo>-pr<N>` and running
 *     `git checkout <base_commit>` there (Time-Travel guard sustained).
 *   - The 5 PolyBench repos collapse to ~1.5 GB of cache + transient
 *     workspaces, with `cp .git` ~5-10s per task vs ~60-180s for a full
 *     clone (cache-hit speedup ~10-30x).
 *   - Cache is NEVER cleaned by the orchestrator. Workspaces ARE cleaned
 *     when cleanupClones=true.
 *
 * Legacy API (`cloneTaskRepo(task, workspaceRoot, runner?)`) is preserved
 * as a wrapper around `getRepoCache` + `checkoutTaskWorkspace` so the
 * orchestrator's existing call site keeps working without changes.
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
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
            timeout: opts.timeoutMs ?? 600_000,
        });
    },
};

/**
 * Subdirectory layout under the orchestrator's workspaceRoot. The
 * cache is shared across all tasks; task-workspaces are transient.
 */
export const REPO_CACHE_SUBDIR = "repo-cache";
export const TASK_WORKSPACES_SUBDIR = "task-workspaces";

/**
 * Derive a filesystem-safe cache key from a repo URL or `owner/repo`
 * coordinate. `https://github.com/mui/material-ui.git` -> `mui-material-ui`.
 * Strips the .git suffix and the github.com prefix; preserves the
 * owner+repo segments for human-readable cache directories.
 */
export function repoUrlToCacheName(repoUrl: string): string {
    let normalized = repoUrl
        .replace(/^https?:\/\//, "")
        .replace(/^git@/, "")
        .replace(/\.git$/, "");
    // SSH form uses `:` to separate host from owner -- normalise to `/`.
    //   git@github.com:owner/repo  ->  github.com/owner/repo
    normalized = normalized.replace(":", "/");
    // Drop the host so github.com/mui/material-ui becomes mui/material-ui.
    const slash = normalized.indexOf("/");
    if (slash > 0) {
        const host = normalized.slice(0, slash);
        if (host.includes(".")) {
            normalized = normalized.slice(slash + 1);
        }
    }
    return normalized.replace(/[/:@]/g, "-");
}

/**
 * Return the absolute path to a cached shallow clone of `repoUrl`. The
 * first call clones (`git clone --filter=blob:none --no-checkout`) into
 * `cacheRoot/<safe-name>/`. Subsequent calls are O(filesystem-stat) -- the
 * cache is reused. The cached directory contains a `.git/` directory but
 * no working-tree files (no-checkout); per-task workspaces hydrate the
 * working tree at their specific commit via `checkoutTaskWorkspace`.
 *
 * Defensive: if a previous run left a partial clone (no `.git/HEAD`), the
 * directory is wiped and re-cloned.
 */
export async function getRepoCache(
    repoUrl: string,
    cacheRoot: string,
    runner: CommandRunner = defaultRunner,
): Promise<string> {
    const safeName = repoUrlToCacheName(repoUrl);
    const cachePath = path.join(cacheRoot, safeName);

    await fs.mkdir(cacheRoot, { recursive: true });

    const isHydrated = existsSync(path.join(cachePath, ".git", "HEAD"));
    if (isHydrated) return cachePath;

    // Partial/corrupt cache -- wipe and re-clone.
    if (existsSync(cachePath)) {
        await fs.rm(cachePath, { recursive: true, force: true });
    }

    // --filter=blob:none defers blob fetching until checkout (massive size
    // reduction for repos with deep history). --no-checkout keeps the
    // cache directory at a bare-ish state; per-task workspaces own the
    // working tree.
    runner.run(
        `git clone --quiet --filter=blob:none --no-checkout "${repoUrl}" "${cachePath}"`,
        { timeoutMs: 10 * 60 * 1000 },
    );

    return cachePath;
}

/**
 * Build a per-task workspace at `workspaceRoot/task-<owner>-<repo>-pr<N>/`
 * by copying the cache's `.git/` into the workspace and checking out
 * `task.base_commit`. The Time-Travel guard verifies the resulting HEAD
 * matches base_commit byte-for-byte.
 *
 * Idempotent: if the workspace already exists, it is rm -rf'd first.
 */
export async function checkoutTaskWorkspace(
    task: PolyBenchTask,
    cachePath: string,
    workspaceRoot: string,
    runner: CommandRunner = defaultRunner,
): Promise<string> {
    const safeName = task.repo.replace("/", "-");
    const workspacePath = path.join(
        workspaceRoot,
        `task-${safeName}-pr${task.pr_number}`,
    );

    // Idempotent cleanup of any previous workspace at this path.
    await fs.rm(workspacePath, { recursive: true, force: true });
    await fs.mkdir(workspacePath, { recursive: true });

    // Copy the cache's .git so the workspace has its own ref state but
    // shares the blob-light history. Node's fs.cp with recursive:true is
    // sufficient -- we are not chasing symlinks or special files.
    const cacheGit = path.join(cachePath, ".git");
    const workspaceGit = path.join(workspacePath, ".git");
    await fs.cp(cacheGit, workspaceGit, { recursive: true });

    // Checkout the base commit (lazy-fetches required blobs on demand).
    runner.run(
        `git -C "${workspacePath}" checkout --quiet ${task.base_commit}`,
        { timeoutMs: 10 * 60 * 1000 },
    );

    // Time-Travel guard.
    const headSha = runner
        .run(`git -C "${workspacePath}" rev-parse HEAD`)
        .trim();
    if (headSha !== task.base_commit) {
        throw new Error(
            `Time-Travel guard failed for ${task.repo}#${task.pr_number}: ` +
                `expected ${task.base_commit}, got ${headSha}`,
        );
    }

    return workspacePath;
}

/**
 * Legacy API maintained for orchestrator backwards compatibility.
 *
 * Internally:
 *   1. Bootstrap (or reuse) a shallow cache for the task's repo under
 *      `workspaceRoot/repo-cache/`.
 *   2. Hydrate a per-task workspace under
 *      `workspaceRoot/task-workspaces/task-<owner>-<repo>-pr<N>/`.
 *
 * Returns the absolute path to the task workspace (working tree at
 * base_commit). The cache directory is intentionally NOT returned --
 * orchestrator should never operate on the cache directly.
 *
 * Note: pre-refactor this function returned a path directly under
 * `workspaceRoot` (no `task-workspaces/` segment). The new path includes
 * the subdir so the cache and workspaces stay separated. Callers that
 * just use the returned absolute path are unaffected.
 */
export async function cloneTaskRepo(
    task: PolyBenchTask,
    workspaceRoot: string,
    runner: CommandRunner = defaultRunner,
): Promise<string> {
    const cacheRoot = path.join(workspaceRoot, REPO_CACHE_SUBDIR);
    const workspacesRoot = path.join(workspaceRoot, TASK_WORKSPACES_SUBDIR);

    const repoUrl = `https://github.com/${task.repo}.git`;
    const cachePath = await getRepoCache(repoUrl, cacheRoot, runner);
    return checkoutTaskWorkspace(task, cachePath, workspacesRoot, runner);
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
