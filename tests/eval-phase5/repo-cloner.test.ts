/**
 * Phase 5 repo-cloner tests -- mocked CommandRunner.
 *
 * NO real git operations. Mock runner intercepts `git clone` and `git
 * checkout`/`rev-parse` calls. To exercise the cache + workspace path
 * (Phase 5 C.4.A.6 refactor) the mock for `git clone` physically
 * creates a `.git/HEAD` under the destination directory so the
 * downstream `fs.cp` step has something to copy.
 *
 * Furia round 18: schema migrated to PolyBenchTask.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
    cloneTaskRepo,
    getRepoCache,
    checkoutTaskWorkspace,
    installTaskDeps,
    repoUrlToCacheName,
    REPO_CACHE_SUBDIR,
    TASK_WORKSPACES_SUBDIR,
    type CommandRunner,
} from "../../scripts/eval-phase5/repo-cloner.js";
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

/**
 * Extract the destination path from a quoted `git clone` command:
 *   `git clone --quiet ... "URL" "DEST"`  ->  DEST
 * Returns null if the command isn't a clone or the regex doesn't match.
 */
function extractCloneDest(cmd: string): string | null {
    if (!cmd.startsWith("git clone")) return null;
    const matches = [...cmd.matchAll(/"([^"]+)"/g)];
    if (matches.length < 2) return null;
    return matches[matches.length - 1][1];
}

function makeMockRunner(behavior: { headSha?: string } = {}): {
    runner: CommandRunner;
    invocations: string[];
} {
    const invocations: string[] = [];
    const runner: CommandRunner = {
        run: cmd => {
            invocations.push(cmd);
            // Simulate `git clone` by physically creating the dest's
            // .git/HEAD so the downstream `fs.cp(cache/.git, ...)` finds
            // something to copy. The shape mirrors what a real shallow
            // clone produces well enough for the test surface.
            const dest = extractCloneDest(cmd);
            if (dest !== null) {
                mkdirSync(path.join(dest, ".git"), { recursive: true });
                writeFileSync(
                    path.join(dest, ".git", "HEAD"),
                    "ref: refs/heads/main\n",
                );
            }
            if (cmd.includes("rev-parse HEAD")) {
                return (behavior.headSha ?? "deadbeefcafe") + "\n";
            }
            return "";
        },
    };
    return { runner, invocations };
}

describe("Phase 5 repo-cloner: legacy cloneTaskRepo", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "p5-cloner-"));
    });

    it("returns a workspace path under task-workspaces/ with the expected naming", async () => {
        const { runner, invocations } = makeMockRunner();
        const task = mkTask({ repo: "trpc/trpc", pr_number: 1234 });
        const taskDir = await cloneTaskRepo(task, tmpRoot, runner);

        expect(taskDir).toContain("task-trpc-trpc-pr1234");
        expect(taskDir).toContain(TASK_WORKSPACES_SUBDIR);
        expect(invocations.some(c => c.startsWith("git clone"))).toBe(true);
    });

    it("checks out BASE commit (Time-Travel guard)", async () => {
        const task = mkTask({ base_commit: "BASE_SHA_123" });
        const matched = makeMockRunner({ headSha: "BASE_SHA_123" });
        await cloneTaskRepo(task, tmpRoot, matched.runner);

        // The clone command contains the flag "--no-checkout" -- the
        // actual checkout is a separate later invocation in the
        // workspace. Filter for the latter.
        const checkoutCmd = matched.invocations.find(
            c => c.includes(" checkout ") && !c.includes("--no-checkout"),
        );
        expect(checkoutCmd).toContain("BASE_SHA_123");
    });

    it("throws if checkout SHA mismatches expected (Time-Travel guard sanity)", async () => {
        const { runner } = makeMockRunner({ headSha: "WRONG_SHA" });
        const task = mkTask({ base_commit: "EXPECTED_SHA" });
        await expect(cloneTaskRepo(task, tmpRoot, runner)).rejects.toThrow(
            /Time-Travel guard failed/,
        );
    });

    it("cleans existing task workspace before checkout (idempotent)", async () => {
        const { runner } = makeMockRunner({ headSha: "BASE_SHA_123" });
        const task = mkTask({
            base_commit: "BASE_SHA_123",
            repo: "x/y",
            pr_number: 7,
        });
        const workspaceDir = path.join(
            tmpRoot,
            TASK_WORKSPACES_SUBDIR,
            "task-x-y-pr7",
        );
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "stale.txt"), "old");

        await cloneTaskRepo(task, tmpRoot, runner);

        await expect(fs.access(path.join(workspaceDir, "stale.txt"))).rejects.toThrow();
    });

    it("uses git clone --quiet + --filter=blob:none + --no-checkout flags", async () => {
        const { runner, invocations } = makeMockRunner();
        await cloneTaskRepo(mkTask(), tmpRoot, runner);
        const cloneCmd = invocations.find(c => c.startsWith("git clone"));
        expect(cloneCmd).toBeDefined();
        expect(cloneCmd).toContain("--quiet");
        expect(cloneCmd).toContain("--filter=blob:none");
        expect(cloneCmd).toContain("--no-checkout");
    });
});

describe("Phase 5 repo-cloner: getRepoCache", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "p5-cache-"));
    });

    it("creates a shallow clone on first call", async () => {
        const { runner, invocations } = makeMockRunner();
        const cachePath = await getRepoCache(
            "https://github.com/foo/bar.git",
            tmpRoot,
            runner,
        );
        expect(cachePath).toContain("foo-bar");
        expect(invocations.filter(c => c.startsWith("git clone"))).toHaveLength(1);
    });

    it("reuses the cache on second call (no re-clone)", async () => {
        const { runner, invocations } = makeMockRunner();
        await getRepoCache("https://github.com/foo/bar.git", tmpRoot, runner);
        await getRepoCache("https://github.com/foo/bar.git", tmpRoot, runner);
        expect(invocations.filter(c => c.startsWith("git clone"))).toHaveLength(1);
    });

    it("wipes a partial/corrupt cache and re-clones (defensive)", async () => {
        const safeName = "foo-bar";
        const corrupt = path.join(tmpRoot, safeName);
        await fs.mkdir(corrupt, { recursive: true });
        // Note: no .git/HEAD -- looks corrupt to getRepoCache.

        const { runner, invocations } = makeMockRunner();
        await getRepoCache("https://github.com/foo/bar.git", tmpRoot, runner);
        expect(invocations.filter(c => c.startsWith("git clone"))).toHaveLength(1);
        expect(existsSync(path.join(corrupt, ".git", "HEAD"))).toBe(true);
    });
});

describe("Phase 5 repo-cloner: checkoutTaskWorkspace", () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "p5-ws-"));
    });

    it("creates a fresh workspace from a hydrated cache + verifies HEAD", async () => {
        // Seed a fake hydrated cache.
        const cachePath = path.join(tmpRoot, "cache", "owner-repo");
        await fs.mkdir(path.join(cachePath, ".git"), { recursive: true });
        await fs.writeFile(
            path.join(cachePath, ".git", "HEAD"),
            "ref: refs/heads/main\n",
        );
        const workspacesRoot = path.join(tmpRoot, "ws");

        const { runner, invocations } = makeMockRunner({ headSha: "abc123" });
        const workspace = await checkoutTaskWorkspace(
            mkTask({ repo: "owner/repo", pr_number: 9, base_commit: "abc123" }),
            cachePath,
            workspacesRoot,
            runner,
        );
        expect(workspace).toContain("task-owner-repo-pr9");
        // The workspace inherits a copy of .git/HEAD.
        expect(existsSync(path.join(workspace, ".git", "HEAD"))).toBe(true);
        // Checkout was issued against the workspace.
        const checkoutCmd = invocations.find(c => c.includes("checkout"));
        expect(checkoutCmd).toContain("abc123");
    });

    it("rejects when HEAD does not match the expected base_commit", async () => {
        const cachePath = path.join(tmpRoot, "cache", "owner-repo");
        await fs.mkdir(path.join(cachePath, ".git"), { recursive: true });
        await fs.writeFile(path.join(cachePath, ".git", "HEAD"), "x\n");
        const workspacesRoot = path.join(tmpRoot, "ws");

        const { runner } = makeMockRunner({ headSha: "WRONG" });
        await expect(
            checkoutTaskWorkspace(
                mkTask({ base_commit: "EXPECTED" }),
                cachePath,
                workspacesRoot,
                runner,
            ),
        ).rejects.toThrow(/Time-Travel guard failed/);
    });

    it("is idempotent (rm -rf existing workspace before recreating)", async () => {
        const cachePath = path.join(tmpRoot, "cache", "x-y");
        await fs.mkdir(path.join(cachePath, ".git"), { recursive: true });
        await fs.writeFile(path.join(cachePath, ".git", "HEAD"), "h\n");
        const workspacesRoot = path.join(tmpRoot, "ws");

        // Pre-create a stale workspace with a leftover file.
        const stale = path.join(workspacesRoot, "task-x-y-pr1", "stale.txt");
        await fs.mkdir(path.dirname(stale), { recursive: true });
        await fs.writeFile(stale, "old");

        const { runner } = makeMockRunner({ headSha: "good" });
        await checkoutTaskWorkspace(
            mkTask({ repo: "x/y", pr_number: 1, base_commit: "good" }),
            cachePath,
            workspacesRoot,
            runner,
        );
        await expect(fs.access(stale)).rejects.toThrow();
    });
});

describe("Phase 5 repo-cloner: repoUrlToCacheName", () => {
    it("strips https:// and .git, collapses slashes to dashes", () => {
        expect(repoUrlToCacheName("https://github.com/mui/material-ui.git")).toBe("mui-material-ui");
    });
    it("handles owner/repo coordinate (no protocol)", () => {
        expect(repoUrlToCacheName("microsoft/vscode")).toBe("microsoft-vscode");
    });
    it("handles git@host:owner/repo.git ssh form", () => {
        expect(repoUrlToCacheName("git@github.com:tailwindlabs/tailwindcss.git")).toBe("tailwindlabs-tailwindcss");
    });
});

describe("Phase 5 repo-cloner: subdir constants", () => {
    it("exports REPO_CACHE_SUBDIR + TASK_WORKSPACES_SUBDIR sensible defaults", () => {
        expect(REPO_CACHE_SUBDIR).toBe("repo-cache");
        expect(TASK_WORKSPACES_SUBDIR).toBe("task-workspaces");
    });
});

describe("Phase 5 repo-cloner: installTaskDeps (unchanged)", () => {
    it("returns installed=true on success", async () => {
        const runner: CommandRunner = { run: () => "" };
        const result = await installTaskDeps("/some/dir", runner);
        expect(result.installed).toBe(true);
    });

    it("returns installed=false with reason on failure (defensive)", async () => {
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
