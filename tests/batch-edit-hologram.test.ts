import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { handleBatchEdit } from "../src/handlers/code/edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import type { CodeParams, RouterDependencies } from "../src/router.js";
import type { NrekiInterceptResult } from "../src/kernel/nreki-kernel.js";

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
        const interceptAtomicBatch = vi.fn(async () => ({ safe: true } as NrekiInterceptResult));
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
    });
});
