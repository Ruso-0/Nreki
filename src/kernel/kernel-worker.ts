/**
 * kernel-worker.ts - Worker thread script for NrekiKernel.
 *
 * Instantiates a NrekiKernel in an isolated worker thread.
 * Communicates with the main thread via postMessage.
 * All kernel state lives in the worker heap.
 */

import { parentPort, workerData } from "node:worker_threads";
import { NrekiKernel } from "./nreki-kernel.js";

if (!parentPort) {
    throw new Error("[NREKI Worker] Must be run as a worker thread");
}

const kernel = new NrekiKernel();
kernel.boot(workerData.projectRoot, workerData.mode);

parentPort.postMessage({ type: "booted" });

parentPort.on("message", async (msg: { id: number; type: string; [key: string]: unknown }) => {
    try {
        switch (msg.type) {
            case "intercept": {
                const result = await kernel.interceptAtomicBatch(msg.edits as any[]);
                // Serialize Maps for structured clone transfer
                const serialized = {
                    ...result,
                    postContracts: result.postContracts
                        ? Object.fromEntries(
                            [...result.postContracts].map(([k, v]) => [k, Object.fromEntries(v)])
                        )
                        : undefined,
                };
                parentPort!.postMessage({ id: msg.id, type: "result", data: serialized });
                break;
            }
            case "commit":
                await kernel.commitToDisk();
                parentPort!.postMessage({ id: msg.id, type: "result", data: null });
                break;
            case "rollback":
                await kernel.rollbackAll();
                parentPort!.postMessage({ id: msg.id, type: "result", data: null });
                break;
            case "predictBlastRadius": {
                const result = kernel.predictBlastRadius(
                    msg.targetFile as string,
                    msg.symbolName as string
                );
                parentPort!.postMessage({ id: msg.id, type: "result", data: result });
                break;
            }
            case "getStats":
                parentPort!.postMessage({
                    id: msg.id,
                    type: "result",
                    data: {
                        stagingSize: kernel.getStagingSize(),
                        trackedFiles: kernel.getTrackedFiles(),
                        baselineErrorCount: kernel.getBaselineErrorCount(),
                        initialErrorCount: kernel.getInitialErrorCount(),
                        currentErrorCount: kernel.getCurrentErrorCount(),
                        healingStats: kernel.healingStats,
                        mode: kernel.mode,
                        booted: kernel.isBooted(),
                    },
                });
                break;
            default:
                parentPort!.postMessage({
                    id: msg.id,
                    type: "error",
                    data: { message: `Unknown message type: ${msg.type}` },
                });
        }
    } catch (err: any) {
        parentPort!.postMessage({
            id: msg.id,
            type: "error",
            data: { message: err.message, stack: err.stack },
        });
    }
});
