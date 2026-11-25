import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Parser from "web-tree-sitter";
import { ensureHologramReady, ensureKernelBooted } from "../src/handlers/code/kernel-bridge.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { NrekiEngine } from "../src/engine.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { RouterDependencies } from "../src/router.js";
import * as shadowGenerator from "../src/hologram/shadow-generator.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanups.length) cleanups.pop()!(); });

function fixture(mode: "project" | "hologram" = "hologram") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-hologram-preparation-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "a.ts"), "export function count(): number { return 1; }\n");
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { strict: true, skipLibCheck: true, target: "ES2022" }, include: ["*.ts"],
    }));
    const kernel = new NrekiKernel();
    const engine = new NrekiEngine({ dbPath: path.join(root, ".nreki.db"), watchPaths: [root] });
    const sandbox = new AstSandbox();
    cleanups.push(() => { engine.shutdown(); sandbox.shutdown(); });
    const deps: RouterDependencies = { engine, kernel, sandbox, nrekiMode: mode, monitor: new TokenMonitor(), circuitBreaker: new CircuitBreaker(root) };
    return { root, kernel, deps };
}

describe("shared hologram preparation", () => {
    it("shares real WASM preparation between preloading and concurrent edit boot requests", async () => {
        const { root, kernel, deps } = fixture();
        const setParser = vi.spyOn(kernel, "setJitParser");
        const setClassifier = vi.spyOn(kernel, "setJitClassifier");
        const boot = vi.spyOn(kernel, "boot");
        const [, first, second] = await Promise.all([
            ensureHologramReady(kernel, "hologram", root),
            ensureKernelBooted(deps),
            ensureKernelBooted(deps),
        ]);
        expect(first).toBe(true);
        expect(second).toBe(true);
        expect(setParser).toHaveBeenCalledTimes(1);
        expect(setClassifier).toHaveBeenCalledTimes(1);
        expect(boot).toHaveBeenCalledTimes(1);
        expect(kernel.hasJitHologram()).toBe(true);
        await ensureHologramReady(kernel, "hologram", root);
        expect(setParser).toHaveBeenCalledTimes(1);
        const result = await kernel.previewAtomicBatch([{
            targetFile: path.join(root, "a.ts"), proposedContent: "export function count(): number { return 2; }\n",
        }]);
        expect(result.safe).toBe(true);
        expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain("return 1");
    });

    it("does not boot twice when ordinary concurrent requests pass the cold-start check", async () => {
        const { kernel, deps } = fixture("project");
        const boot = vi.spyOn(kernel, "boot");
        expect(await Promise.all([ensureKernelBooted(deps), ensureKernelBooted(deps)])).toEqual([true, true]);
        expect(boot).toHaveBeenCalledTimes(1);
    });

    it("permits a clean retry after both JIT preparation and eager fallback fail", async () => {
        const { root, kernel } = fixture();
        const init = vi.spyOn(Parser, "init").mockRejectedValueOnce(new Error("WASM unavailable"));
        const scan = vi.spyOn(shadowGenerator, "scanProject").mockRejectedValueOnce(new Error("scan unavailable"));
        await expect(ensureHologramReady(kernel, "hologram", root)).rejects.toThrow("scan unavailable");
        expect(kernel.hasJitHologram()).toBe(false);
        expect(kernel.hasShadows()).toBe(false);
        init.mockRestore();
        scan.mockRestore();
        await ensureHologramReady(kernel, "hologram", root);
        expect(kernel.hasJitHologram()).toBe(true);
    });
});
