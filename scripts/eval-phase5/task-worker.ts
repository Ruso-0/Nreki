/**
 * scripts/eval-phase5/task-worker.ts
 *
 * Phase 5 C.4.B.2 Sprint 4.9.8 (Furia round 29): child_process entry.
 *
 * Sprint 4.9 worker_threads variant was empirically inadequate for mui
 * (Sprint 4.9.5 measured 0.9x reduction — V8 page allocator retains
 * pages from torn-down isolates in the parent process's address
 * space). Path C universal: each task runs in a fresh Node OS
 * process spawned via `child_process.fork()`. When the process exits
 * the kernel reclaims every page it owned — main-thread RSS stays
 * flat regardless of task size.
 *
 * Transport contract:
 *   - Parent invokes `fork(task-worker-bootstrap.mjs)` and sends one
 *     `{ input: TaskBodyInput }` message on the IPC channel.
 *   - Child runs `executeTaskBody(input)`, then `process.send(output)`
 *     and exits with code 0.
 *   - On uncaught throw (defence-in-depth -- executeTaskBody never
 *     throws by design) the child posts a synthetic error result so
 *     the parent always observes a message before exit.
 */

import { computeGroundTruth } from "./ground-truth.js";
import {
    executeTaskBody,
    type TaskBodyInput,
    type TaskBodyOutput,
} from "./task-worker-body.js";

if (typeof process.send !== "function") {
    throw new Error("task-worker.ts must be invoked via child_process.fork() (no IPC channel detected)");
}

const sendOutput = process.send.bind(process);

process.once("message", async (msg: { input: TaskBodyInput }) => {
    let output: TaskBodyOutput;
    try {
        output = await executeTaskBody(msg.input);
    } catch (err) {
        output = {
            result: {
                instance_id: msg.input.task.instance_id,
                repo: msg.input.task.repo,
                base_commit: msg.input.task.base_commit,
                task_category: msg.input.task.task_category,
                ground_truth: computeGroundTruth(msg.input.task),
                runners: {},
                error: `worker uncaught: ${(err as Error).message}`,
            },
            taskDir: null,
        };
    }
    sendOutput(output, (sendErr: Error | null) => {
        // Disconnect so the child's IPC channel closes cleanly and the
        // process can exit immediately. Without explicit disconnect the
        // child can linger waiting for additional messages.
        if (sendErr) {
            process.stderr.write(`[task-worker] send error: ${sendErr.message}\n`);
        }
        process.disconnect();
        process.exit(0);
    });
});
