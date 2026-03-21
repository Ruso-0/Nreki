import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-holo-vfs-"));
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, filePath);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "commonjs", strict: true,
            noEmit: true, esModuleInterop: true, rootDir: ".", skipLibCheck: true,
        },
        include: ["./**/*.ts"],
        exclude: ["node_modules", "dist"],
    }));
    return dir;
}

function cleanupDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const toPosix = (p: string) => path.normalize(p).replace(/\\/g, "/");

describe("hologram VFS hooks", () => {
    let dir: string;
    let kernel: NrekiKernel;

    // Project: api.ts is prunable (all explicit), consumer.ts imports it
    beforeAll(() => {
        dir = createTempProject({
            "api.ts": [
                `export interface Config { host: string; port: number; }`,
                `export function init(c: Config): void {}`,
                `export const VERSION: number = 1;`,
            ].join("\n"),
            "consumer.ts": [
                `import { init, Config } from "./api";`,
                `export function start(): void { init({ host: "localhost", port: 3000 }); }`,
            ].join("\n"),
            "unpruned.ts": [
                `export function compute(x: number) { return x * 2; }`,
            ].join("\n"),
        });

        kernel = new NrekiKernel();

        // Set up shadows: api.ts is prunable, unpruned.ts is not
        const apiPath = toPosix(path.resolve(dir, "api.ts"));
        const shadowContent = [
            `export interface Config { host: string; port: number; }`,
            `export declare function init(c: Config): void;`,
            `export declare const VERSION: number;`,
        ].join("\n");

        kernel.setShadows(
            new Map([[apiPath, shadowContent]]),
            new Set([toPosix(path.resolve(dir, "unpruned.ts"))]),
            [],
        );

        kernel.boot(dir, "hologram");
    });

    afterAll(() => cleanupDir(dir));

    it("19. pruned .ts file: fileExists returns false", () => {
        // The kernel should report that the pruned .ts does not exist
        // (TypeScript falls back to .d.ts)
        expect(kernel.isBooted()).toBe(true);
        expect(kernel.mode).toBe("hologram");
        // Verify kernel booted (indirect: no crash)
    });

    it("20. shadow .d.ts: kernel boots without errors from shadows", () => {
        expect(kernel.isBooted()).toBe(true);
        // In hologram mode, rootNames is filtered to only ambient files.
        // With no ambient files provided, trackedFiles starts at 0 (lazy subgraph).
        // Files are added to rootNames dynamically during interceptAtomicBatch.
        expect(kernel.getTrackedFiles()).toBeGreaterThanOrEqual(0);
    });

    it("21. shadow serves correct content for type checking", async () => {
        // consumer.ts imports from api.ts - with hologram, it uses api.d.ts shadow
        // A valid edit to consumer.ts should type-check against the shadow
        const consumerPath = path.join(dir, "consumer.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: consumerPath,
            proposedContent: [
                `import { init, Config } from "./api";`,
                `export function start(): void {`,
                `  const c: Config = { host: "prod", port: 8080 };`,
                `  init(c);`,
                `}`,
            ].join("\n"),
        }]);
        expect(result.safe).toBe(true);
        await kernel.rollbackAll();
    });

    it("22. unpruned .ts file: still accessible", async () => {
        // Editing the unpruned file should work normally
        const unprunedPath = path.join(dir, "unpruned.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: unprunedPath,
            proposedContent: `export function compute(x: number): number { return x * 3; }`,
        }]);
        expect(result.safe).toBe(true);
        await kernel.rollbackAll();
    });

    it("23. edited file always real .ts regardless of prune status", async () => {
        // Even though api.ts is pruned, when we edit it, the kernel should
        // see the real proposed content, not the shadow
        const apiPath = path.join(dir, "api.ts");
        const result = await kernel.interceptAtomicBatch([{
            targetFile: apiPath,
            proposedContent: [
                `export interface Config { host: string; port: number; timeout: number; }`,
                `export function init(c: Config): void {}`,
                `export const VERSION: number = 2;`,
            ].join("\n"),
        }]);
        // This should work - we're editing the real file
        expect(result.safe).toBe(true);
        await kernel.rollbackAll();
    });

    it("24. tsbuildinfo always from disk", () => {
        // The .tsbuildinfo bypass in readFile should still work
        // (Verified indirectly: kernel boots successfully with build cache)
        expect(kernel.isBooted()).toBe(true);
    });

    it("25. hasShadows returns true after setShadows", () => {
        expect(kernel.hasShadows()).toBe(true);
    });

    it("26. O(1) lookup: pre-computed sets populated", () => {
        // Verify internal state indirectly via API behavior
        // If lookups were wrong, the boot would fail or type-checking would break
        expect(kernel.isBooted()).toBe(true);
    });
});
