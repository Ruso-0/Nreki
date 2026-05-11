/**
 * Phase 5 repo-cloner tests — mocked CommandRunner.
 * NO real git operations.
 * Furia round 18: schema migrated to PolyBenchTask.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { cloneTaskRepo, installTaskDeps, type CommandRunner } from "../../scripts/eval-phase5/repo-cloner.js";
import type { PolyBenchTask } from "../../scripts/eval-phase5/types.js";

function mkTask(overrides: Partial<PolyBenchTask> = {}): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 42,
        instance_id: "owner__repo-42",
        base_commit: "deadbeefcafe",
        patch: "",
        test_patch: "",
        problem_statement: "Bug X",
        modified_nodes: [],
        task_category: "Bug Fix",
        F2P: [],
        P2P: [],
        dockerfile: "",
        test_command: "",
        language: "TypeScript",
        ...overrides,
    };
}

function makeMockRunner(behavior: { headSha?: string } = {}): {
    runner: CommandRunner;
    invocations: string[];
} {
    const invocations: string[] = [];
    const runner: CommandRunner = {
        run: (cmd) => {
            invocations.push(cmd);
            if (cmd.includes("rev-parse HEAD")) {
                return (behavior.headSha ?? "deadbeefcafe") + "\n";
            }
            return "";
        },
    };
    return { runner, invocations };
}

describe("Phase 5: repo-cloner", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "p5-cloner-"));
    });

    it("clones repo to task-specific directory naming convention", async () => {
        const { runner, invocations } = makeMockRunner();
        const task = mkTask({ repo: "trpc/trpc", pr_number: 1234 });
        const taskDir = await cloneTaskRepo(task, tmpRoot, runner);

        expect(taskDir).toContain("task-trpc-trpc-pr1234");
        expect(invocations.some(c => c.startsWith("git clone"))).toBe(true);
    });

    it("checks out BASE commit (pre-fix)", async () => {
        const task = mkTask({ base_commit: "BASE_SHA_123" });
        const matched = makeMockRunner({ headSha: "BASE_SHA_123" });
        await cloneTaskRepo(task, tmpRoot, matched.runner);

        const checkoutCmd = matched.invocations.find(c => c.includes("checkout"));
        expect(checkoutCmd).toContain("BASE_SHA_123");
    });

    it("throws if checkout SHA mismatches expected (Time-Travel guard sanity)", async () => {
        const { runner } = makeMockRunner({ headSha: "WRONG_SHA" });
        const task = mkTask({ base_commit: "EXPECTED_SHA" });
        await expect(cloneTaskRepo(task, tmpRoot, runner)).rejects.toThrow(
            /Time-Travel guard failed/,
        );
    });

    it("cleans existing task dir before clone (idempotent)", async () => {
        const { runner } = makeMockRunner({ headSha: "BASE_SHA_123" });
        const task = mkTask({
            base_commit: "BASE_SHA_123",
            repo: "x/y",
            pr_number: 7,
        });
        const taskDir = path.join(tmpRoot, "task-x-y-pr7");
        await fs.mkdir(taskDir, { recursive: true });
        await fs.writeFile(path.join(taskDir, "stale.txt"), "old");

        await cloneTaskRepo(task, tmpRoot, runner);

        // Stale file removed (taskDir was rm'd before mock clone).
        await expect(fs.access(path.join(taskDir, "stale.txt"))).rejects.toThrow();
    });

    it("uses git clone --quiet flag", async () => {
        const { runner, invocations } = makeMockRunner();
        await cloneTaskRepo(mkTask(), tmpRoot, runner);
        const cloneCmd = invocations.find(c => c.startsWith("git clone"));
        expect(cloneCmd).toContain("--quiet");
    });

    it("installTaskDeps returns installed=true on success", async () => {
        const runner: CommandRunner = { run: () => "" };
        const result = await installTaskDeps("/some/dir", runner);
        expect(result.installed).toBe(true);
    });

    it("installTaskDeps returns installed=false with reason on failure (defensive)", async () => {
        const runner: CommandRunner = {
            run: () => {
                throw new Error("npm install ENOENT");
            },
        };
        const result = await installTaskDeps("/some/dir", runner);
        expect(result.installed).toBe(false);
        expect(result.reason).toContain("ENOENT");
    });
});
