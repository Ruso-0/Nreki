/**
 * Tests for tsbuildinfo cache (Bug 1 fix).
 *
 * Validates that:
 * - First boot creates .nreki/cache.tsbuildinfo after commitToDisk
 * - Second boot loads from cache without crash
 * - TS version mismatch purges cache
 * - Corrupted cache falls back to cold boot
 */
import { describe, it, expect, afterAll } from "vitest";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const tmpDirs: string[] = [];

function createProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-cache-"));
    tmpDirs.push(dir);

    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "Node16",
            moduleResolution: "Node16",
            strict: true,
            outDir: "dist",
            declaration: true,
        },
        include: ["*.ts"],
    }));

    fs.writeFileSync(
        path.join(dir, "index.ts"),
        `export const greeting: string = "hello";\n`
    );

    return dir;
}

afterAll(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("tsbuildinfo cache", () => {
    it("should create cache file after commitToDisk", async () => {
        const dir = createProject();
        const kernel = new NrekiKernel();
        kernel.boot(dir);

        const cachePath = path.join(dir, ".nreki", "cache.tsbuildinfo");
        const versionPath = path.join(dir, ".nreki", "ts-version");

        // Before commit: cache may or may not exist depending on boot
        // After a valid edit + commit, cache should be written
        const result = await kernel.interceptAtomicBatch([{
            targetFile: "index.ts",
            proposedContent: `export const greeting: string = "world";\n`,
        }]);
        expect(result.safe).toBe(true);

        await kernel.commitToDisk();

        // Cache and version guard should now exist
        expect(fs.existsSync(cachePath)).toBe(true);
        expect(fs.existsSync(versionPath)).toBe(true);

        const cachedVersion = fs.readFileSync(versionPath, "utf-8").trim();
        expect(cachedVersion).toBeTruthy();
    });

    it("should boot successfully from cached state", async () => {
        const dir = createProject();

        // First boot + commit to create cache
        const kernel1 = new NrekiKernel();
        kernel1.boot(dir);
        const r1 = await kernel1.interceptAtomicBatch([{
            targetFile: "index.ts",
            proposedContent: `export const greeting: string = "cached";\n`,
        }]);
        expect(r1.safe).toBe(true);
        await kernel1.commitToDisk();

        const cachePath = path.join(dir, ".nreki", "cache.tsbuildinfo");
        expect(fs.existsSync(cachePath)).toBe(true);

        // Second boot should load from cache without crash
        const kernel2 = new NrekiKernel();
        expect(() => kernel2.boot(dir)).not.toThrow();

        // Verify kernel works correctly after warm boot
        const r2 = await kernel2.interceptAtomicBatch([{
            targetFile: "index.ts",
            proposedContent: `export const greeting: number = 42;\n`,
        }]);
        expect(r2.safe).toBe(true);
    });

    it("should purge cache on TS version mismatch", async () => {
        const dir = createProject();

        // First boot + commit
        const kernel1 = new NrekiKernel();
        kernel1.boot(dir);
        await kernel1.interceptAtomicBatch([{
            targetFile: "index.ts",
            proposedContent: `export const greeting: string = "v1";\n`,
        }]);
        await kernel1.commitToDisk();

        // Tamper with version file to simulate TS upgrade
        const versionPath = path.join(dir, ".nreki", "ts-version");
        fs.writeFileSync(versionPath, "4.9.0", "utf-8");

        // Second boot should purge cache and cold-build
        const kernel2 = new NrekiKernel();
        expect(() => kernel2.boot(dir)).not.toThrow();

        // Kernel should still work
        const result = await kernel2.interceptAtomicBatch([{
            targetFile: "index.ts",
            proposedContent: `export const greeting: string = "v2";\n`,
        }]);
        expect(result.safe).toBe(true);
    });

    it("should cold-boot when cache is corrupted", async () => {
        const dir = createProject();

        // Create corrupted cache
        const nrekiDir = path.join(dir, ".nreki");
        fs.mkdirSync(nrekiDir, { recursive: true });
        fs.writeFileSync(path.join(nrekiDir, "cache.tsbuildinfo"), "CORRUPTED DATA", "utf-8");
        // Write correct version so it tries to load (and fails gracefully)
        const ts = await import("typescript");
        fs.writeFileSync(path.join(nrekiDir, "ts-version"), ts.version, "utf-8");

        // Boot should recover gracefully with cold build
        const kernel = new NrekiKernel();
        expect(() => kernel.boot(dir)).not.toThrow();

        const result = await kernel.interceptAtomicBatch([{
            targetFile: "index.ts",
            proposedContent: `export const greeting: string = "recovered";\n`,
        }]);
        expect(result.safe).toBe(true);
    });
});
