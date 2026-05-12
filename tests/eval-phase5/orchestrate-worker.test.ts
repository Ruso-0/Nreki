/**
 * Phase 5 C.4.B.2 Sprint 4.9.8 (Furia round 29) child_process isolation
 * tests.
 *
 * Sprint 4.9 transport (worker_threads) was empirically inadequate
 * for mui (Sprint 4.9.5 0.9x reduction). Path C universal: every task
 * spawns a fresh Node OS process via child_process.fork() so the
 * kernel reclaims every page on exit.
 *
 * These tests exercise the task-worker.ts entrypoint as a real
 * child_process.fork()-spawned Node process so the IPC contract
 * (send -> message -> exit) is covered end-to-end. They intentionally
 * do NOT mock the runner modules: vi.mock cannot cross process
 * boundaries, and the point of these tests is precisely to validate
 * that the child boots its own module graph, posts a TaskBodyOutput
 * over IPC, then terminates.
 *
 * To keep the tests offline-friendly and fast we use a task with an
 * empty `repo` field. cloneTaskRepo will attempt `git clone
 * https://github.com/.git`, which git rejects locally. The exact
 * error message is unstable across git versions; we only assert the
 * child reported a clone-failed task result and then exited cleanly
 * with code 0.
 */

import { describe, it, expect } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PolyBenchTask } from "../../scripts/eval-phase5/types.js";
import type { TaskBodyInput, TaskBodyOutput } from "../../scripts/eval-phase5/task-worker-body.js";

const BOOTSTRAP_PATH = fileURLToPath(
    new URL("../../scripts/eval-phase5/task-worker-bootstrap.mjs", import.meta.url),
);

function fakeTask(overrides: Partial<PolyBenchTask> = {}): PolyBenchTask {
    return {
        repo: "",
        pr_number: 1,
        instance_id: "worker-test-1",
        base_commit: "0".repeat(40),
        patch: "",
        test_patch: "",
        problem_statement: "x",
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
 * Fork the bootstrap, attach listeners FIRST, send the input, await
 * the IPC message AND the child's exit. The ordering matters: the
 * child waits for an IPC message on `process.once("message")`, then
 * sends the result, then exits. Listener-before-send avoids any race.
 */
async function runChildOnce(input: TaskBodyInput): Promise<{
    output: TaskBodyOutput;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}> {
    const child: ChildProcess = fork(BOOTSTRAP_PATH, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout?.on("data", () => { /* discard */ });
    child.stderr?.on("data", () => { /* discard */ });

    const messagePromise = new Promise<TaskBodyOutput>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error("child did not post a message within 30s")),
            30_000,
        );
        child.once("message", msg => {
            clearTimeout(timer);
            resolve(msg as TaskBodyOutput);
        });
        child.once("error", err => {
            clearTimeout(timer);
            reject(err);
        });
    });
    child.send({ input });

    const output = await messagePromise;
    const { exitCode, signal } = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
    }>(resolve => {
        child.once("exit", (code, sig) => resolve({ exitCode: code, signal: sig }));
    });
    return { output, exitCode, signal };
}

describe("task-worker.ts (Sprint 4.9.8 child_process isolation)", () => {
    it("child forks, posts a TaskBodyOutput over IPC, then exits with code 0", async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-spawn-"));
        try {
            const { output, exitCode } = await runChildOnce({
                task: fakeTask(),
                workspaceRoot,
                topK: 10,
                voyageKey: "",
                runnersList: [],
            });
            expect(exitCode).toBe(0);
            expect(output).toBeDefined();
            expect(output.result.instance_id).toBe("worker-test-1");
            expect(output.result.error).toMatch(/clone failed/);
            expect(output.taskDir).toBeNull();
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it("child passes runnersList through and respects empty list", async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-empty-"));
        try {
            const { output, exitCode } = await runChildOnce({
                task: fakeTask({ instance_id: "worker-test-2" }),
                workspaceRoot,
                topK: 5,
                voyageKey: "",
                runnersList: [],
            });
            expect(exitCode).toBe(0);
            expect(output.result.instance_id).toBe("worker-test-2");
            expect(Object.keys(output.result.runners)).toHaveLength(0);
            expect(output.result.error).toMatch(/clone failed/);
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    }, 60_000);

    it("child terminates exactly once per task (no leaked OS processes)", async () => {
        // Each runChildOnce awaits exit; if the child did not terminate
        // the second call would hang. The 30s message timeout in
        // runChildOnce acts as a hard cap so test runs do not stall.
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cp-seq-"));
        try {
            const a = await runChildOnce({
                task: fakeTask({ instance_id: "seq-a" }),
                workspaceRoot,
                topK: 1,
                voyageKey: "",
                runnersList: [],
            });
            const b = await runChildOnce({
                task: fakeTask({ instance_id: "seq-b" }),
                workspaceRoot,
                topK: 1,
                voyageKey: "",
                runnersList: [],
            });
            expect(a.exitCode).toBe(0);
            expect(b.exitCode).toBe(0);
            expect(a.output.result.instance_id).toBe("seq-a");
            expect(b.output.result.instance_id).toBe("seq-b");
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    }, 90_000);
});
