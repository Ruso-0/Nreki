import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { handleBatchEdit } from "../src/handlers/code/edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import type { CodeParams, RouterDependencies } from "../src/router.js";
import type { NrekiEdit, NrekiInterceptResult } from "../src/kernel/nreki-kernel.js";

describe("batch_edit hologram path normalization", () => {
    let tmpDir: string;
    let parser: ASTParser;
    let sandbox: AstSandbox;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-hologram-batch-"));
        fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
        parser = new ASTParser();
        sandbox = new AstSandbox();
        await parser.initialize();
        await sandbox.initialize();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("passes relative-path signature changes to hologram dependents", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"), [
            "export function foo(a: string): string {",
            "    return a;",
            "}",
        ].join("\n"), "utf-8");

        const findDependents = vi.fn(async () => ["src/caller.ts"]);
        // Typed like the kernel method so mock.calls[0][1] (the dependents) type-checks.
        const interceptAtomicBatch = vi.fn(
            async (_edits: NrekiEdit[], _dependents?: string[]): Promise<NrekiInterceptResult> => ({ safe: true, exitCode: 0 }),
        );
        const deps = {
            engine: {
                initialize: async () => {},
                getProjectRoot: () => tmpDir,
                getParser: () => parser,
                expectInternalEdit: vi.fn(),
                invalidateCachedGraph: vi.fn(),
                findDependents,
            },
            sandbox,
            kernel: {
                isBooted: () => true,
                interceptAtomicBatch,
                commitToDisk: vi.fn(async () => {}),
                getSemanticCoverage: () => ({ backend: "typescript" }),
            },
            nrekiMode: "hologram",
        } as unknown as RouterDependencies;
        const params: CodeParams = {
            action: "batch_edit",
            edits: [{
                path: "src/foo.ts",
                symbol: "foo",
                new_code: "export function foo(a: number): number {\n    return a;\n}",
            }],
        };

        const response = await handleBatchEdit(params, deps);

        expect(response.isError).not.toBe(true);
        expect(findDependents).toHaveBeenCalledWith("src/foo.ts");
        expect(interceptAtomicBatch).toHaveBeenCalledTimes(1);
        expect(interceptAtomicBatch.mock.calls[0][1]).toEqual(["src/caller.ts"]);
        // GAR-01: the footer states the real scope instead of a blanket guarantee.
        const text = response.content[0].text ?? "";
        expect(text).toContain("1 direct importer(s) (hologram mode)");
        expect(text).not.toContain("Semantic check passed");
    });

    // NREKI-INT-06 regression: >50 importers outside the batch used to fall through
    // with ZERO dependents and commit; now it blocks like handleEdit does.
    it("blocks a hologram signature change with more than 50 importers outside the batch", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"),
            "export function foo(a: string): string {\n    return a;\n}\n", "utf-8");
        const callers = Array.from({ length: 60 }, (_, i) => `src/caller${i}.ts`);
        const interceptAtomicBatch = vi.fn(async () => ({ safe: true } as NrekiInterceptResult));
        const deps = {
            engine: {
                initialize: async () => {},
                getProjectRoot: () => tmpDir,
                getParser: () => parser,
                expectInternalEdit: vi.fn(),
                cancelInternalEdit: vi.fn(),
                invalidateCachedGraph: vi.fn(),
                findDependents: vi.fn(async () => callers),
            },
            sandbox,
            kernel: {
                isBooted: () => true,
                interceptAtomicBatch,
                commitToDisk: vi.fn(async () => {}),
                getSemanticCoverage: () => ({ backend: "typescript" }),
            },
            nrekiMode: "hologram",
        } as unknown as RouterDependencies;

        const response = await handleBatchEdit({
            action: "batch_edit",
            edits: [{ path: "src/foo.ts", symbol: "foo", new_code: "export function foo(a: number): number {\n    return a;\n}" }],
        }, deps);

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("60 importer(s) outside this batch");
        expect(interceptAtomicBatch).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(tmpDir, "src", "foo.ts"), "utf-8")).toContain("a: string");
    });

    // NREKI-GAR-02 regression: batch_edit dropped errorText (auto-heal notice,
    // collateral files) and warnings (LSP offline) that handleEdit always showed.
    it("surfaces auto-heal notices and sidecar warnings", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "foo.ts"),
            "export function foo(a: string): string {\n    return a;\n}\n", "utf-8");
        const deps = {
            engine: {
                initialize: async () => {},
                getProjectRoot: () => tmpDir,
                getParser: () => parser,
                expectInternalEdit: vi.fn(),
                invalidateCachedGraph: vi.fn(),
                findDependents: vi.fn(async () => []),
            },
            sandbox,
            kernel: {
                isBooted: () => true,
                interceptAtomicBatch: vi.fn(async () => ({
                    safe: true, exitCode: 0,
                    errorText: "[NREKI AUTO-HEAL: 3ms] WARNING: NREKI also auto-patched collateral files: src/util.ts.",
                    warnings: ["[⚠️ NREKI WARNING: 'gopls' not found or crashed. Layer 2 Semantic Shield OFFLINE for go files.]"],
                } as NrekiInterceptResult)),
                commitToDisk: vi.fn(async () => {}),
                getSemanticCoverage: () => ({ backend: "typescript" }),
            },
            nrekiMode: "file",
        } as unknown as RouterDependencies;

        const response = await handleBatchEdit({
            action: "batch_edit",
            edits: [{ path: "src/foo.ts", symbol: "foo", new_code: "export function foo(a: string): string {\n    return a + 1;\n}" }],
        }, deps);

        const text = response.content[0].text ?? "";
        expect(response.isError).not.toBe(true);
        expect(text).toContain("auto-patched collateral files: src/util.ts");
        expect(text).toContain("Shield OFFLINE for go files");
    });
});
