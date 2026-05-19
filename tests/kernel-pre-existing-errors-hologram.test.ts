/**
 * kernel-pre-existing-errors-hologram.test.ts — v11.4.0 Phase 1.5
 *
 * Hologram mode = the default mode the MCP server runs in
 * (see src/index.ts:308 `detectMode(cwd)` → typically "hologram").
 *
 * The original Phase 1 suite (tests/kernel-pre-existing-errors.test.ts) only
 * exercised PROJECT mode. This file pins the same differential-filter
 * behavior in HOLOGRAM mode, with the EXACT TS codes the user reported
 * (TS1259 and TS2802 — not the TS1192 my first test accidentally tripped).
 *
 * Boot path mirrors src/handlers/code/kernel-bridge.ts:ensureHologramReady
 * (JIT hologram via web-tree-sitter, no eager scanProject).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Parser from "web-tree-sitter";
import { fileURLToPath } from "url";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { classifyAndGenerateShadow } from "../src/hologram/shadow-generator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.join(__dirname, "..", "wasm");

let parser: Parser;
let tsLanguage: Parser.Language;

beforeAll(async () => {
    await Parser.init();
    parser = new Parser();
    tsLanguage = await Parser.Language.load(
        path.join(wasmDir, "tree-sitter-typescript.wasm"),
    );
});

function createProject(files: Record<string, string>, tsconfigOpts: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-holo-pre-"));
    for (const [filePath, content] of Object.entries(files)) {
        const full = path.join(dir, filePath);
        const dn = path.dirname(full);
        if (!fs.existsSync(dn)) fs.mkdirSync(dn, { recursive: true });
        fs.writeFileSync(full, content);
    }
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            module: "commonjs",
            strict: true,
            noEmit: true,
            rootDir: ".",
            skipLibCheck: true,
            ...tsconfigOpts,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));
    return dir;
}

function cleanup(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function bootHologramKernel(dir: string): NrekiKernel {
    const kernel = new NrekiKernel();
    kernel.setJitParser(parser, tsLanguage);
    kernel.setJitClassifier(classifyAndGenerateShadow);
    kernel.boot(dir, "hologram");
    return kernel;
}

describe("Hologram mode — differential filter for pre-existing errors", () => {
    let dir: string;
    afterEach(() => { if (dir) cleanup(dir); });

    // EXACT TS1259 reproduction — recipe empirically verified via TS compiler probe:
    //   esModuleInterop: true
    //   allowSyntheticDefaultImports: false
    //   source uses `export =`
    //
    // Result: import lib from "./lib"  →  TS1259 "Module 'X' can only be
    //                                       default-imported using the
    //                                       'esModuleInterop' flag"
    it("ALLOWS unrelated-symbol edit when target file has pre-existing TS1259", async () => {
        dir = createProject(
            {
                "lib.ts": `export = { v: 42 };`,
                "fillTemplate.ts": [
                    `import lib from "./lib";`,
                    `export const useLib = lib.v;`,
                    ``,
                    `export function targetForEdit(): number {`,
                    `    return 1;`,
                    `}`,
                ].join("\n"),
            },
            { target: "ES2022", esModuleInterop: true, allowSyntheticDefaultImports: false },
        );

        const kernel = bootHologramKernel(dir);

        const target = path.resolve(dir, "fillTemplate.ts");
        const newContent = [
            `import lib from "./lib";`,
            `export const useLib = lib.v;`,
            ``,
            `export function targetForEdit(): number {`,
            `    return 2;`,
            `}`,
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        // If the differential filter works in hologram, this must pass.
        // If it doesn't, we'll see safe=false with structured errors
        // including a TS1259 entry.
        if (!result.safe) {
            // Honest diagnostic: dump the codes so we know what slipped through.
            const codes = (result.structured ?? []).map(e => e.code).join(", ");
            console.error(`[hologram TS1259 test] result.safe=false codes=[${codes}]`);
        }
        expect(result.safe).toBe(true);
    });

    // EXACT TS2802 reproduction — recipe empirically verified via TS compiler probe:
    //   target: ES5
    //   downlevelIteration: false
    //   iterate a Set / Map / generator (non-array iterable)
    //
    // Result: for (const x of mySet) ...  →  TS2802 "Type 'Set<number>' can
    //                                                only be iterated through
    //                                                when using the
    //                                                '--downlevelIteration' flag"
    it("ALLOWS unrelated-symbol edit when target file has pre-existing TS2802", async () => {
        dir = createProject(
            {
                "fillTemplate.ts": [
                    `const numbers = new Set([1, 2, 3]);`,
                    `export function sumNumbers(): number {`,
                    `    let total = 0;`,
                    `    for (const x of numbers) { total += x; }`,  // ← TS2802 site
                    `    return total;`,
                    `}`,
                    ``,
                    `export function targetForEdit(): string {`,
                    `    return "before";`,
                    `}`,
                ].join("\n"),
            },
            { target: "ES5", downlevelIteration: false, lib: ["ES2015"] },
        );

        const kernel = bootHologramKernel(dir);

        const target = path.resolve(dir, "fillTemplate.ts");
        const newContent = [
            `const numbers = new Set([1, 2, 3]);`,
            `export function sumNumbers(): number {`,
            `    let total = 0;`,
            `    for (const x of numbers) { total += x; }`,
            `    return total;`,
            `}`,
            ``,
            `export function targetForEdit(): string {`,
            `    return "after";`,
            `}`,
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        if (!result.safe) {
            const codes = (result.structured ?? []).map(e => e.code).join(", ");
            console.error(`[hologram TS2802 test] result.safe=false codes=[${codes}]`);
        }
        expect(result.safe).toBe(true);
    });

    // Counter-test: introducing a NEW error in hologram mode must still BLOCK,
    // so we don't accidentally prove "the filter swallows everything".
    it("BLOCKS in hologram when edit introduces a NEW error on top of pre-existing TS1259", async () => {
        dir = createProject(
            {
                "lib.ts": `export = { v: 42 };`,
                "fillTemplate.ts": [
                    `import lib from "./lib";`,
                    `export const useLib = lib.v;`,
                    ``,
                    `export function ok(): string {`,
                    `    return "still ok";`,
                    `}`,
                ].join("\n"),
            },
            { target: "ES2022", esModuleInterop: true, allowSyntheticDefaultImports: false },
        );

        const kernel = bootHologramKernel(dir);

        const target = path.resolve(dir, "fillTemplate.ts");
        // Pre-existing TS1259 stays. New TS2322 introduced in `ok`.
        const newContent = [
            `import lib from "./lib";`,
            `export const useLib = lib.v;`,
            ``,
            `export function ok(): string {`,
            `    return 999;`,  // ← new TS2322
            `}`,
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        expect(result.safe).toBe(false);
        expect(result.exitCode).toBe(2);
        // Verify the rejection contains the NEW error code, not the pre-existing one.
        const errorCodes = (result.structured ?? []).map(e => e.code);
        expect(errorCodes.some(c => c === "TS2322")).toBe(true);
    });

    // Subtle hologram-specific case: target file is NOT yet in rootNames at
    // boot time (jitMode keeps only .d.ts in rootNames per nreki-kernel.ts:213).
    // The interceptAtomicBatch path adds the target to rootNames at line ~554
    // BEFORE captureBaseline runs at line ~592. This test pins that ordering:
    // a freshly-targeted file with pre-existing disk errors must still have
    // those errors captured into the baseline.
    it("captures pre-existing errors in baseline when target file enters rootNames at edit time (JIT hologram)", async () => {
        dir = createProject(
            {
                // Two files; user edits fillTemplate.ts, fresh hologram entry.
                "lib.ts": `export = { v: 42 };`,
                "fillTemplate.ts": [
                    `import lib from "./lib";`,
                    `export const useLib = lib.v;`,
                    ``,
                    `export function targetForEdit(): number {`,
                    `    return 1;`,
                    `}`,
                ].join("\n"),
            },
            { target: "ES2022", esModuleInterop: true, allowSyntheticDefaultImports: false },
        );

        const kernel = bootHologramKernel(dir);

        // Confirm jit hologram active (target file not in rootNames at boot).
        expect(kernel.hasJitHologram()).toBe(true);

        const target = path.resolve(dir, "fillTemplate.ts");
        const newContent = [
            `import lib from "./lib";`,
            `export const useLib = lib.v;`,
            ``,
            `export function targetForEdit(): number {`,
            `    return 42;`,
            `}`,
        ].join("\n");

        const result = await kernel.interceptAtomicBatch([{
            targetFile: target,
            proposedContent: newContent,
        }]);

        if (!result.safe) {
            const codes = (result.structured ?? []).map(e => e.code).join(", ");
            console.error(`[hologram JIT baseline test] result.safe=false codes=[${codes}]`);
        }
        expect(result.safe).toBe(true);
    });
});
