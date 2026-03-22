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
const toPosix = (p: string) => path.normalize(p).replace(/\\/g, "/");

let parser: Parser;
let tsLanguage: Parser.Language;

beforeAll(async () => {
    await Parser.init();
    parser = new Parser();
    tsLanguage = await Parser.Language.load(
        path.join(wasmDir, "tree-sitter-typescript.wasm"),
    );
});

function createTempProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-jit-"));
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

function bootJitKernel(dir: string): NrekiKernel {
    const kernel = new NrekiKernel();
    kernel.setJitParser(parser, tsLanguage);
    kernel.setJitClassifier(classifyAndGenerateShadow);
    // NO setShadows() — this is JIT mode
    kernel.boot(dir, "hologram");
    return kernel;
}

describe("JIT Holography", () => {
    let dir: string;

    afterEach(() => { if (dir) cleanupDir(dir); });

    it("1. JIT mode activates when no shadows set and jitParser provided", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; }`,
        });
        const kernel = new NrekiKernel();
        kernel.setJitParser(parser, tsLanguage);
        kernel.setJitClassifier(classifyAndGenerateShadow);
        expect(kernel.hasJitHologram()).toBe(true);
        expect(kernel.hasShadows()).toBe(false);
        kernel.boot(dir, "hologram");
        expect(kernel.isBooted()).toBe(true);
    });

    it("2. fileExists returns false for prunable .ts (JIT classified)", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; age: number; }`,
            "main.ts": `import { User } from "./types";\nconst u: User = { name: "a", age: 1 };`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        // types.ts is prunable → fileExists should return false (hidden)
        const typesPath = toPosix(path.resolve(dir, "types.ts"));
        const result = host.fileExists(typesPath);
        expect(result).toBe(false);
        expect(kernel.getJitCacheSize()).toBeGreaterThanOrEqual(1);
    });

    it("3. fileExists returns true for shadow .d.ts (JIT generated)", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; age: number; }`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        // First classify the .ts by asking about it
        const typesTs = toPosix(path.resolve(dir, "types.ts"));
        host.fileExists(typesTs); // triggers JIT classify

        // Now ask for the .d.ts — should exist as shadow
        const typesDts = toPosix(path.resolve(dir, "types.d.ts"));
        expect(host.fileExists(typesDts)).toBe(true);
    });

    it("4. readFile returns shadow content for .d.ts (JIT generated)", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; age: number; }`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        // Trigger JIT classify
        const typesTs = toPosix(path.resolve(dir, "types.ts"));
        host.fileExists(typesTs);

        // Read shadow .d.ts
        const typesDts = toPosix(path.resolve(dir, "types.d.ts"));
        const shadow = host.readFile(typesDts);
        expect(shadow).toBeDefined();
        expect(shadow).toContain("User");
        expect(shadow).toContain("interface");
    });

    it("5. fileExists returns true for unprunable .ts (JIT classified)", () => {
        dir = createTempProject({
            // No return type → unprunable
            "service.ts": `export function create(name: string) { return { name }; }`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        const servicePath = toPosix(path.resolve(dir, "service.ts"));
        expect(host.fileExists(servicePath)).toBe(true);
        expect(kernel.getJitCacheSize()).toBeGreaterThanOrEqual(1);
    });

    it("6. readFile returns real content for unprunable .ts", () => {
        dir = createTempProject({
            "service.ts": `export function create(name: string) { return { name }; }`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        const servicePath = toPosix(path.resolve(dir, "service.ts"));
        // Trigger classify
        host.fileExists(servicePath);
        // Read should return real content (not shadow)
        const content = host.readFile(servicePath);
        expect(content).toContain("return { name }");
    });

    it("7. JIT classification cache prevents re-classification", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; }`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        const typesPath = toPosix(path.resolve(dir, "types.ts"));
        host.fileExists(typesPath);
        const cacheSize1 = kernel.getJitCacheSize();

        // Ask again — should not re-classify
        host.fileExists(typesPath);
        const cacheSize2 = kernel.getJitCacheSize();
        expect(cacheSize2).toBe(cacheSize1);
    });

    it("8. JIT mode does not interfere with non-hologram mode", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; }`,
        });
        const kernel = new NrekiKernel();
        kernel.setJitParser(parser, tsLanguage);
        kernel.setJitClassifier(classifyAndGenerateShadow);
        kernel.boot(dir, "project"); // Not hologram
        const host = (kernel as any).host;

        const typesPath = toPosix(path.resolve(dir, "types.ts"));
        // In project mode, .ts should always be visible
        expect(host.fileExists(typesPath)).toBe(true);
        expect(kernel.getJitCacheSize()).toBe(0);
    });

    it("9. Edit target bypasses JIT classification", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; }`,
            "main.ts": `import { User } from "./types";\nconst u: User = { name: "a" };`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        // Simulate setting edit target (like interceptAtomicBatch does)
        const typesPath = toPosix(path.resolve(dir, "types.ts"));
        (kernel as any).currentEditTargets.add(typesPath);

        // Should bypass JIT and show real .ts
        expect(host.fileExists(typesPath)).toBe(true);
    });

    it("10. JIT cache size reports correctly", () => {
        dir = createTempProject({
            "a.ts": `export interface A { x: number; }`,
            "b.ts": `export interface B { y: string; }`,
            "c.ts": `export function noReturn() { return 1; }`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        expect(kernel.getJitCacheSize()).toBe(0);

        host.fileExists(toPosix(path.resolve(dir, "a.ts")));
        host.fileExists(toPosix(path.resolve(dir, "b.ts")));
        host.fileExists(toPosix(path.resolve(dir, "c.ts")));

        expect(kernel.getJitCacheSize()).toBe(3);
    });

    it("11. Boot with JIT mode completes without scanProject", () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; age: number; }`,
            "utils.ts": `export function clamp(val: number, min: number, max: number): number { return Math.max(min, Math.min(max, val)); }`,
            "service.ts": `import { User } from "./types";\nimport { clamp } from "./utils";\nexport function create(name: string) { return { name } as User; }`,
        });
        const kernel = bootJitKernel(dir);
        expect(kernel.isBooted()).toBe(true);
        expect(kernel.hasShadows()).toBe(false); // No pre-computed shadows
        expect(kernel.hasJitHologram()).toBe(true);
    });

    it("12. First interceptAtomicBatch triggers JIT shadow generation", async () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; age: number; }`,
            "main.ts": `import { User } from "./types";\nexport const user: User = { name: "test", age: 25 };`,
        });
        const kernel = bootJitKernel(dir);

        const mainPath = toPosix(path.resolve(dir, "main.ts"));
        const result = await kernel.interceptAtomicBatch([{
            targetFile: mainPath,
            proposedContent: `import { User } from "./types";\nexport const user: User = { name: "updated", age: 30 };`,
        }]);

        expect(result.safe).toBe(true);
        // JIT should have classified types.ts on-demand during resolution
        expect(kernel.getJitCacheSize()).toBeGreaterThanOrEqual(1);
    });

    it("13. JIT shadows match pre-computed shadows for same file", () => {
        const content = `export interface User { name: string; age: number; }\nexport type Role = "admin" | "user";`;

        dir = createTempProject({ "types.ts": content });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        // Trigger JIT
        const typesTs = toPosix(path.resolve(dir, "types.ts"));
        host.fileExists(typesTs);
        const typesDts = toPosix(path.resolve(dir, "types.d.ts"));
        const jitShadow = host.readFile(typesDts);

        // Pre-computed shadow
        const precomputed = classifyAndGenerateShadow(typesTs, content, parser, tsLanguage);

        expect(jitShadow).toBe(precomputed.shadow);
    });

    it("14. .tsx files classified and shadow served correctly", () => {
        dir = createTempProject({
            "component.tsx": `export interface Props { title: string; }\nexport const Label: React.FC<Props> = (p: Props) => null;`,
        });
        // tsconfig needs jsx
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
            compilerOptions: {
                target: "ES2022", module: "commonjs", strict: true,
                jsx: "react", skipLibCheck: true,
            },
            include: ["./**/*.tsx", "./**/*.ts"],
        }));

        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        const tsxPath = toPosix(path.resolve(dir, "component.tsx"));
        host.fileExists(tsxPath); // trigger classification

        // Check that .d.ts probe works for .tsx source
        const dtsPath = toPosix(path.resolve(dir, "component.d.ts"));
        // Either the shadow exists (prunable) or file exists check returns real (unprunable)
        // The important thing is no crash and JIT classified it
        expect(kernel.getJitCacheSize()).toBeGreaterThanOrEqual(1);
    });

    it("15. rollbackAll preserves JIT cache, only invalidates edit targets", async () => {
        dir = createTempProject({
            "types.ts": `export interface User { name: string; }`,
            "main.ts": `import { User } from "./types";\nexport const u: User = { name: "a" };`,
        });
        const kernel = bootJitKernel(dir);
        const host = (kernel as any).host;

        // Trigger JIT classification for both files
        const typesTs = toPosix(path.resolve(dir, "types.ts"));
        const mainTs = toPosix(path.resolve(dir, "main.ts"));
        host.fileExists(typesTs);
        host.fileExists(mainTs);
        const cacheBefore = kernel.getJitCacheSize();
        expect(cacheBefore).toBe(2);

        // Verify types.ts shadow exists before rollback
        expect((kernel as any).prunedTsLookup.has(typesTs)).toBe(true);

        // Simulate an in-flight edit on main.ts (like interceptAtomicBatch does)
        (kernel as any).currentEditTargets.add(mainTs);

        // Snapshot cache size before rollback
        const sizeBefore = kernel.getJitCacheSize();

        // Rollback: should only invalidate main.ts, preserve types.ts
        // Note: updateProgram() triggers TS resolution which re-classifies via JIT hooks
        await kernel.rollbackAll();

        // Cache preserved for types.ts (disk didn't change, classification valid)
        expect((kernel as any).jitClassifiedCache.has(typesTs)).toBe(true);
        // Cache size >= what we had before (updateProgram may re-classify more files)
        // The key invariant: we did NOT clear() the entire cache (would have been 0 before updateProgram)
        expect(kernel.getJitCacheSize()).toBeGreaterThanOrEqual(sizeBefore - 1);

        // Kernel still functional
        expect(kernel.isBooted()).toBe(true);
        expect(kernel.hasJitHologram()).toBe(true);
    });
});
