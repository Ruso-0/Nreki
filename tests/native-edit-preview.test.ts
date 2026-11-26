import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { classifyAndGenerateShadow } from "../src/hologram/shadow-generator.js";
import { logger } from "../src/utils/logger.js";

const original = "export function value(): number { return 1; }";
const changed = "export function value(): number { return 2; }";
const dirs: string[] = [];
let parser: Parser;
let language: Parser.Language;

beforeAll(async () => {
    await Parser.init();
    parser = new Parser();
    language = await Parser.Language.load(fileURLToPath(new URL("../wasm/tree-sitter-typescript.wasm", import.meta.url)));
});
afterAll(() => parser.delete());

function project(files: Record<string, string>, mode: "project" | "file" | "hologram" = "project") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-preview-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ES2022", module: "CommonJS", strict: true, skipLibCheck: true, noEmit: true },
        include: ["**/*.ts"],
    }));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    const kernel = new NrekiKernel();
    if (mode === "hologram") {
        kernel.setJitParser(parser, language);
        kernel.setJitClassifier(classifyAndGenerateShadow);
    }
    kernel.boot(dir, mode);
    return { dir, kernel };
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("native edit preview", () => {
    it("accepts exact valid content without leaving a committable change", async () => {
        const { dir, kernel } = project({ "app.ts": original });
        const result = await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }]);
        expect(result.safe).toBe(true);
        expect(kernel.getStagingSize()).toBe(0);
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe(original);
        await kernel.commitToDisk();
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe(original);
    });

    it("rejects compiler errors and accepts a subsequent clean preview", async () => {
        const { kernel } = project({ "app.ts": original });
        const bad = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: 'export function value(): number { return "bad"; }',
        }]);
        expect(bad.safe).toBe(false);
        expect(bad.structured?.some(error => error.code === "TS2322")).toBe(true);
        expect(kernel.getStagingSize()).toBe(0);
        expect((await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }])).safe).toBe(true);
    });

    it("does not auto-heal proposals that native tools would write unchanged", async () => {
        const { dir, kernel } = project({
            "types.ts": "export interface UserConfig { id: string; }",
            "app.ts": "export function processUser(c: { id: string }) { return c.id; }",
        });
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: "export function processUser(c: UserConfig) { return c.id; }",
        }]);
        expect(result.safe).toBe(false);
        expect(result.structured?.some(error => error.code === "TS2304")).toBe(true);
        expect(kernel.healingStats.applied).toBe(0);
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).not.toContain("UserConfig");
    });

    it("preserves a staged MCP transaction while refusing the preview", async () => {
        const { dir, kernel } = project({ "app.ts": original });
        expect((await kernel.interceptAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }])).safe).toBe(true);
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: "export function value(): number { return 99; }",
        }]);
        expect(result.safe).toBe(false);
        expect(result.errorText).toContain("awaiting commit");
        await kernel.commitToDisk();
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe(changed);
    });

    it("refreshes a native disk write before validating its next proposal", async () => {
        const { dir, kernel } = project({
            "app.ts": original,
            "caller.ts": 'import { value } from "./app"; export const result: number = value();',
        });
        expect((await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }])).safe).toBe(true);
        fs.writeFileSync(path.join(dir, "app.ts"), 'export function value(): string { return "old"; }');
        fs.writeFileSync(path.join(dir, "caller.ts"), 'import { value } from "./app"; export const result: string = value();');
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: 'export function value(): string { return "new"; }',
        }], ["caller.ts"]);
        expect(result.safe).toBe(true);
        expect(kernel.getStagingSize()).toBe(0);
    });

    it("checks importer regressions in file mode and preserves existing errors", async () => {
        const { kernel } = project({
            "app.ts": original,
            "caller.ts": 'import { value } from "./app"; export const result: number = value();',
            "old.ts": 'export const oldError: number = "existing";',
        }, "file");
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: 'export function value(): string { return "changed"; }',
        }], ["caller.ts"]);
        expect(result.safe).toBe(false);
        expect(result.structured?.some(error => error.file === "caller.ts")).toBe(true);
        expect((await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }], ["caller.ts"])).safe).toBe(true);
    });

    it("cleans previews of newly created files before a later commit", async () => {
        const { dir, kernel } = project({ "app.ts": original });
        const tracked = kernel.getTrackedFiles();
        expect((await kernel.previewAtomicBatch([{
            targetFile: "new.ts", proposedContent: "export const count = 1;",
        }])).safe).toBe(true);
        await kernel.commitToDisk();
        expect(fs.existsSync(path.join(dir, "new.ts"))).toBe(false);
        expect(kernel.getTrackedFiles()).toBe(tracked);
    });

    it("keeps concurrent previews and a queued commit from writing preview content", async () => {
        const { dir, kernel } = project({ "app.ts": original });
        const [first, second] = await Promise.all([
            kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }]),
            kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: "export const answer = 42;" }]),
            kernel.commitToDisk(),
        ]);
        expect(first.safe).toBe(true);
        expect(second.safe).toBe(true);
        expect(kernel.getStagingSize()).toBe(0);
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe(original);
    });

    it("rejects type weakening even when the compiler accepts it", async () => {
        const { kernel } = project({ "app.ts": "export function value(): { id: number } { return { id: 1 }; }" });
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: "export function value(): any { return { id: 2 }; }",
        }]);
        expect(result.safe).toBe(false);
        expect(result.errorText).toContain("weakens type safety");
        expect(kernel.getStagingSize()).toBe(0);
    });

    it("does not silently approve declaration changes beyond file-mode coverage", async () => {
        const { kernel } = project({ "app.ts": original }, "file");
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: 'export function value(): string { return "changed"; }',
        }]);
        expect(result.safe).toBe(false);
        expect(result.errorText).toContain("coverage");
        expect(kernel.getStagingSize()).toBe(0);
    });

    it("purges preview content when validation throws", async () => {
        const { kernel } = project({ "app.ts": original });
        const getSourceFile = kernel.host.getSourceFile;
        kernel.host.getSourceFile = (...args) => {
            if (kernel.host.readFile(args[0])?.includes("previewCrash")) throw new Error("preview compiler crash");
            return getSourceFile(...args);
        };
        try {
            await expect(kernel.previewAtomicBatch([{
                targetFile: "app.ts", proposedContent: "export const previewCrash = 2;",
            }])).rejects.toThrow("preview compiler crash");
        } finally {
            kernel.host.getSourceFile = getSourceFile;
        }
        expect(kernel.getStagingSize()).toBe(0);
        expect((await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }])).safe).toBe(true);
    });

    it("defers watcher invalidation while preserving the pending commit's conflict guard", async () => {
        const { dir, kernel } = project({ "app.ts": original });
        expect((await kernel.interceptAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }])).safe).toBe(true);
        const external = "export function value(): number { return 3; }";
        fs.writeFileSync(path.join(dir, "app.ts"), external);
        await kernel.notifyExternalChange(["app.ts"]);
        expect(kernel.getStagingSize()).toBe(1);
        await expect(kernel.commitToDisk()).rejects.toThrow("CONFLICT");
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe(external);
        expect((await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }])).safe).toBe(true);
    });

    it("includes newly created configured importers after a watcher notification", async () => {
        const { dir, kernel } = project({ "app.ts": original });
        fs.writeFileSync(path.join(dir, "new-caller.ts"), 'import { value } from "./app"; export const result: number = value();');
        await kernel.notifyExternalChange(["new-caller.ts"]);
        expect(await kernel.findTypeScriptImporters(["app.ts"])).toContain("new-caller.ts");
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: 'export function value(): string { return "changed"; }',
        }]);
        expect(result.safe).toBe(false);
        expect(result.structured?.some(error => error.file === "new-caller.ts")).toBe(true);
    });

    it("aborts a staged commit when an external dependency changes and accepts a refreshed edit", async () => {
        const dependency = "export const value: number = 1;";
        const originalCaller = 'import { value } from "./app"; export const result: number = value;';
        const { dir, kernel } = project({ "app.ts": dependency, "caller.ts": originalCaller });
        expect((await kernel.interceptAtomicBatch([{
            targetFile: "caller.ts", proposedContent: 'import { value } from "./app"; export const result: number = value + 1;',
        }])).safe).toBe(true);
        const external = 'export const value: string = "external";';
        fs.writeFileSync(path.join(dir, "app.ts"), external);
        await kernel.notifyExternalChange(["app.ts"]);
        await expect(kernel.commitToDisk()).rejects.toThrow("CONFLICT: app.ts");
        expect(fs.readFileSync(path.join(dir, "caller.ts"), "utf8")).toBe(originalCaller);
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toBe(external);
        const compatible = 'import { value } from "./app"; export const result: string = value;';
        expect((await kernel.interceptAtomicBatch([{ targetFile: "caller.ts", proposedContent: compatible }])).safe).toBe(true);
        await kernel.commitToDisk();
        expect(fs.readFileSync(path.join(dir, "caller.ts"), "utf8")).toBe(compatible);
    });

    it("rejects a stale base even though the proposal compiles", async () => {
        const { dir, kernel } = project({ "app.ts": original });
        fs.writeFileSync(path.join(dir, "app.ts"), "export function value(): number { return 99; }");
        const result = await kernel.previewAtomicBatch([{
            targetFile: "app.ts", proposedContent: changed, baseContent: original,
        }]);
        expect(result.safe).toBe(false);
        expect(result.errorText).toContain("CONFLICT");
        expect(kernel.getStagingSize()).toBe(0);
        expect(fs.readFileSync(path.join(dir, "app.ts"), "utf8")).toContain("99");
    });

    it("approves unchanged hologram declarations and restores mode compiler settings", async () => {
        const { kernel } = project({ "app.ts": original }, "hologram");
        const before = { ...kernel["compilerOptions"] };
        const result = await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }]);
        expect(result.safe).toBe(true);
        expect(result.exportedApiUnchanged).toBe(true);
        expect(kernel["compilerOptions"]).toEqual(before);
        expect(kernel.getStagingSize()).toBe(0);
        expect((await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }])).safe).toBe(true);
    });

    it("rejects changed declarations, globals and program membership in hologram previews", async () => {
        const { kernel } = project({ "app.ts": original, "helper.ts": "export const amount: number = 2;" }, "hologram");
        for (const proposedContent of [
            'export function value(): string { return "changed"; }',
            "declare global { interface Window { previewAdded: number; } } " + changed,
            'import { amount } from "./helper"; export function value(): number { return amount; }',
        ]) {
            const result = await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent }]);
            expect(result.safe).toBe(false);
            expect(kernel.getStagingSize()).toBe(0);
        }
    });

    it("approves disjoint additive exports and new files in file and hologram modes while rejecting overload merging", async () => {
        for (const mode of ["file", "hologram"] as const) {
            const { kernel } = project({ "app.ts": original }, mode);
            const addedExport = await kernel.previewAtomicBatch([{
                targetFile: "app.ts",
                proposedContent: `${original}\nexport function extraTag(): string { return "tag"; }`,
            }]);
            expect(addedExport.safe).toBe(true);
            expect(addedExport.exportedApiAdditive).toBe(true);

            const createdFile = await kernel.previewAtomicBatch([{
                targetFile: "fresh.ts",
                proposedContent: "export const freshCount: number = 42;",
            }]);
            expect(createdFile.safe).toBe(true);
            expect(createdFile.exportedApiAdditive).toBe(true);

            // Overload merging onto existing `value` symbol must still be rejected
            const mergedOverload = await kernel.previewAtomicBatch([{
                targetFile: "app.ts",
                proposedContent: [
                    "export function value(): number;",
                    "export function value(label: string): string;",
                    "export function value(label?: string): number | string { return label ?? 1; }",
                ].join("\n"),
            }]);
            expect(mergedOverload.safe).toBe(false);
        }
    });

    it("skips redundant baseline recapture on warm previews and suppresses Hard rollback warning", async () => {
        const { kernel } = project({ "app.ts": original }, "project");
        const captureSpy = vi.spyOn(kernel["tsBackend"], "captureBaseline");
        const warnSpy = vi.spyOn(logger, "warn");
        try {
            const res = await kernel.previewAtomicBatch([{ targetFile: "app.ts", proposedContent: changed }]);
            expect(res.safe).toBe(true);
            expect(captureSpy).not.toHaveBeenCalled();
            expect(warnSpy.mock.calls.some(args => String(args[0]).includes("Hard rollback executed"))).toBe(false);
        } finally {
            captureSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });
});
