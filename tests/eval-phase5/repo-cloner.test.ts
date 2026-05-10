/**
 * Phase 5 C.1 repo-cloner tests — mocked CommandRunner.
 * NO real git operations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { cloneTaskRepo, installTaskDeps, type CommandRunner } from "../../scripts/eval-phase5/repo-cloner.js";
import type { BugCandidate } from "../../scripts/eval-phase5/types.js";

function mkCandidate(overrides: Partial<BugCandidate> = {}): BugCandidate {
    return {
        repo: "owner/repo",
        pr_number: 42,
        pr_title: "Fix",
        issue_url: null,
        issue_text: "Bug X",
        base_commit: "deadbeefcafe",
        merge_commit: "fedcba987654",
        modified_files: ["src/foo.ts"],
        pr_labels: ["bug"],
        curated_at: new Date().toISOString(),
        blind_approved: null,
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

describe("Phase 5 C.1: repo-cloner", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "p5-cloner-"));
    });

    it("clones repo to task-specific directory naming convention", async () => {
        const { runner, invocations } = makeMockRunner();
        const candidate = mkCandidate({ repo: "trpc/trpc", pr_number: 1234 });
        const taskDir = await cloneTaskRepo(candidate, tmpRoot, runner);

        expect(taskDir).toContain("task-trpc-trpc-pr1234");
        expect(invocations.some(c => c.startsWith("git clone"))).toBe(true);
    });

    it("checks out BASE commit (pre-fix), not merge_commit", async () => {
        const { runner, invocations } = makeMockRunner();
        const candidate = mkCandidate({
            base_commit: "BASE_SHA_123",
            merge_commit: "MERGE_SHA_999",
        });
        // Mock will return "deadbeefcafe" by default → mismatch trigger
        // but for this test we adjust mock to match
        const matched = makeMockRunner({ headSha: "BASE_SHA_123" });
        await cloneTaskRepo(candidate, tmpRoot, matched.runner);

        const checkoutCmd = matched.invocations.find(c => c.includes("checkout"));
        expect(checkoutCmd).toContain("BASE_SHA_123");
        expect(checkoutCmd).not.toContain("MERGE_SHA_999");
        // Suppress unused warning
        void runner;
        void invocations;
    });

    it("throws if checkout SHA mismatches expected (Time-Travel guard sanity)", async () => {
        const { runner } = makeMockRunner({ headSha: "WRONG_SHA" });
        const candidate = mkCandidate({ base_commit: "EXPECTED_SHA" });
        await expect(cloneTaskRepo(candidate, tmpRoot, runner)).rejects.toThrow(
            /Time-Travel guard failed/,
        );
    });

    it("cleans existing task dir before clone (idempotent)", async () => {
        const { runner } = makeMockRunner({ headSha: "BASE_SHA_123" });
        const candidate = mkCandidate({
            base_commit: "BASE_SHA_123",
            repo: "x/y",
            pr_number: 7,
        });
        const taskDir = path.join(tmpRoot, "task-x-y-pr7");
        await fs.mkdir(taskDir, { recursive: true });
        await fs.writeFile(path.join(taskDir, "stale.txt"), "old");

        await cloneTaskRepo(candidate, tmpRoot, runner);

        // Stale file removed (taskDir was rm'd before mock clone).
        await expect(fs.access(path.join(taskDir, "stale.txt"))).rejects.toThrow();
    });

    it("uses git clone --quiet flag", async () => {
        const { runner, invocations } = makeMockRunner();
        await cloneTaskRepo(mkCandidate(), tmpRoot, runner);
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
