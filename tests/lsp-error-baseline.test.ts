/**
 * Go/Python edits are judged on the errors they ADD (same rule as TypeScript).
 *
 * gopls/pyright report the errors of every open document. Before the baseline,
 * one error that was already there — in the edited file or in any document
 * opened by an earlier edit — rejected every later edit in that language.
 *
 * The mock server's "marker_errors" scenario derives errors from the text
 * (ERR / NEEDS+DEF / USES+IMPORT, see tests/mock-lsp-server.ts).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { LspSidecarBase } from "../src/kernel/backends/lsp-sidecar-base.js";
import { countErrors, errorsBeyondBaseline } from "../src/kernel/error-baseline.js";
import { buildValidationBanner } from "../src/handlers/code/validation-banner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockServerPath = path.resolve(__dirname, "mock-lsp-server.ts");
const tsxCli = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

function tmp(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-lsp-baseline-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content);
    return dir;
}

class MockLspSidecar extends LspSidecarBase {
    /** push = a server that refuses pulls and publishes diagnostics after each change. */
    constructor(projectRoot: string, push = false) {
        super(projectRoot, [process.execPath, tsxCli, mockServerPath], "mock", {
            MOCK_LSP_SCENARIO: "marker_errors",
            MOCK_LSP_PUSH: push ? "1" : "",
        });
    }
}

const err = (message: string, line = 1) => ({ file: "/p/a.py", line, column: 1, code: "mock-mock", message });

describe("errorsBeyondBaseline", () => {
    it("reports everything when there is no baseline", () => {
        expect(errorsBeyondBaseline([err("a"), err("b")], undefined)).toHaveLength(2);
    });

    it("ignores an error that only moved and reports an extra occurrence", () => {
        const baseline = countErrors([err("old", 2)]);
        expect(errorsBeyondBaseline([err("old", 40)], baseline)).toEqual([]);
        expect(errorsBeyondBaseline([err("old", 2), err("old", 9), err("new", 5)], baseline))
            .toEqual([err("old", 9), err("new", 5)]);
    });
});

describe("LspSidecarBase.baselineErrors", () => {
    async function booted(): Promise<{ sidecar: MockLspSidecar; file: string; pulls: () => number; failNextRequest: () => void }> {
        const dir = tmp({});
        const sidecar = new MockLspSidecar(dir);
        cleanups.push(() => sidecar.shutdown());
        await sidecar.boot();
        const spy = vi.spyOn(sidecar as unknown as { request: (method: string) => Promise<unknown> }, "request");
        return {
            sidecar,
            file: path.join(dir, "a.py"),
            pulls: () => spy.mock.calls.filter(c => c[0] === "textDocument/diagnostic").length,
            failNextRequest: () => { spy.mockRejectedValueOnce(new Error("pull timed out")); },
        };
    }

    it("opens the document at its pre-edit content, then answers from the cache while in sync", async () => {
        const { sidecar, file, pulls } = await booted();
        const content = "x = 1\nERR(old)\n";

        const first = await sidecar.baselineErrors([{ filePath: file, content }]);
        expect(first.map(e => e.message)).toEqual(["mock error old"]);
        expect(sidecar.hasOpenDocument(file)).toBe(true);

        const pullsSoFar = pulls();
        expect(await sidecar.baselineErrors([{ filePath: file, content }])).toEqual(first);
        expect(pulls()).toBe(pullsSoFar); // no request: a baseline costs nothing once the file is open
    });

    it("does not serve cached diagnostics after a pull round failed", async () => {
        const { sidecar, file, failNextRequest } = await booted();
        await sidecar.validateEdits([{ filePath: file, content: "ERR(a)\n" }]);

        failNextRequest(); // the overlay gets "x = 1", the cache still says ERR(a)
        await expect(sidecar.validateEdits([{ filePath: file, content: "x = 1\n" }])).rejects.toThrow("pull timed out");

        expect(await sidecar.baselineErrors([{ filePath: file, content: "x = 1\n" }])).toEqual([]);
    });
});

describe("kernel: Go/Python edits are judged on the errors they add", () => {
    async function project(files: Record<string, string>, push = false) {
        const dir = tmp(files);
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["./**/*.ts"] }));
        const sidecar = new MockLspSidecar(dir, push);
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        kernel.registerSidecar(".py", sidecar);
        cleanups.push(() => kernel.shutdownSidecars());
        const edit = (file: string, proposedContent: string | null) =>
            kernel.interceptAtomicBatch([{ targetFile: path.join(dir, file), proposedContent }]);
        return { dir, sidecar, kernel, edit };
    }

    it("accepts an unrelated edit of a file that already had an error, even when its line moves", async () => {
        const { edit, kernel, dir } = await project({ "a.py": "x = 1\nERR(old)\n" });

        const r = await edit("a.py", "import os\n\nx = 2\nERR(old)\n");
        expect(r.safe).toBe(true);
        await kernel.commitToDisk();
        expect(fs.readFileSync(path.join(dir, "a.py"), "utf8")).toBe("import os\n\nx = 2\nERR(old)\n");
    });

    it("rejects an edit that adds an error and lists only what it added", async () => {
        const { edit } = await project({ "a.py": "x = 1\nERR(old)\n" });

        const added = await edit("a.py", "x = 1\nERR(old)\nERR(new)\n");
        expect(added.safe).toBe(false);
        expect(added.structured?.map(e => e.message)).toEqual(["mock error new"]);

        // A second copy of an old error is one more than before: still an addition.
        const duplicated = await edit("a.py", "x = 1\nERR(old)\nERR(old)\n");
        expect(duplicated.safe).toBe(false);
        expect(duplicated.structured?.map(e => e.message)).toEqual(["mock error old"]);
    });

    it("ignores old errors of other open documents but still rejects breaking them", async () => {
        const { edit, kernel } = await project({
            "lib.py": "DEF(helper)\n",
            "consumer.py": "NEEDS(helper)\nERR(dep)\n",
        });
        // consumer.py becomes an open document that carries an error of its own.
        expect((await edit("consumer.py", "NEEDS(helper)\nERR(dep)\ny = 1\n")).safe).toBe(true);
        await kernel.commitToDisk();
        // That error does not block an unrelated edit of another file...
        expect((await edit("lib.py", "DEF(helper)\nz = 1\n")).safe).toBe(true);
        await kernel.commitToDisk();
        // ...but removing what consumer.py needs is a new error there.
        const breaking = await edit("lib.py", "z = 1\n");
        expect(breaking.safe).toBe(false);
        expect(breaking.structured?.map(e => `${path.basename(e.file)}: ${e.message}`))
            .toEqual(["consumer.py: mock undefined helper"]);
    });

    it("judges an LSP auto-heal on the new errors, not on the ones that were already there", async () => {
        const { edit, kernel, dir } = await project({ "a.py": "ERR(old)\nx = 1\n" });

        const r = await edit("a.py", "ERR(old)\nx = USES(os)\n");
        expect(r.safe).toBe(true);
        expect(r.errorText).toContain("AUTO-HEAL");
        await kernel.commitToDisk();
        expect(fs.readFileSync(path.join(dir, "a.py"), "utf8")).toBe("IMPORT(os)\nERR(old)\nx = USES(os)\n");
    });

    it("works the same with a push-only server (the pull is refused, diagnostics are published)", async () => {
        const { edit, kernel } = await project({ "a.py": "x = 1\nERR(old)\n" }, true);

        expect((await edit("a.py", "x = 2\nERR(old)\n")).safe).toBe(true);
        await kernel.commitToDisk();
        const added = await edit("a.py", "x = 2\nERR(old)\nERR(new)\n");
        expect(added.safe).toBe(false);
        expect(added.structured?.map(e => e.message)).toEqual(["mock error new"]);
    });

    it("does not open a file just to measure it when the edit deletes it", async () => {
        const { edit, sidecar, dir } = await project({ "gone.py": "ERR(old)\n" });

        expect((await edit("gone.py", null)).safe).toBe(true);
        expect(sidecar.hasOpenDocument(path.join(dir, "gone.py"))).toBe(false);
    });
});

describe("validation footer", () => {
    it("says the LSP check reports new errors only", () => {
        const banner = buildValidationBanner({
            kernelRan: true, mode: "project", files: ["a.py"],
            coverage: () => ({ backend: "lsp", languageId: "python" }),
        });
        expect(banner).toContain("python LSP diagnostics on the edited file(s) (new errors only)");
    });

    it("names the dependents that were checked and the ones that were not", () => {
        const base = { kernelRan: true, mode: "project", files: ["lib.go"], coverage: () => ({ backend: "lsp" as const, languageId: "go" }) };
        const checked = buildValidationBanner({ ...base, lspCoverage: [{ languageId: "go", checked: 3, skipped: 0 }] });
        expect(checked).toContain("go LSP diagnostics on the edited file(s) + 3 dependent file(s) (same package / importers) (new errors only)");
        expect(checked).not.toContain("NOT checked");

        const capped = buildValidationBanner({ ...base, lspCoverage: [{ languageId: "go", checked: 50, skipped: 12 }] });
        expect(capped).toContain("12 more go dependent(s) NOT checked");

        const blind = buildValidationBanner({ ...base, lspCoverage: [{ languageId: "go", checked: 1, skipped: 0 }], lspImportersUnknown: true });
        expect(blind).toContain("go importers NOT looked up");
    });
});
