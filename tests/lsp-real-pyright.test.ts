/**
 * The Python edit path against the REAL pyright / basedpyright (opt-in).
 *
 * Runs only when `basedpyright-langserver` or `pyright-langserver` resolves
 * from PATH the way NREKI resolves sidecar binaries; skipped otherwise. It
 * goes through PythonLspSidecar, so it also covers the production spawn path
 * (on Windows: the `.cmd` shim run through an absolute cmd.exe). pyright
 * registers pull diagnostics dynamically and sends its own requests while
 * doing so (ids 0, 1, 2… — the same numbers the client uses), so this also
 * exercises answering them without mistaking one for a response.
 * The kernel boots in "file" mode, as it does for a Python-only project.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { PythonLspSidecar } from "../src/kernel/backends/python-sidecar.js";
import { resolveExecutable } from "../src/utils/safe-exec.js";

const pyrightAvailable =
    resolveExecutable("basedpyright-langserver") !== null || resolveExecutable("pyright-langserver") !== null;

const MAIN = "from lib import helper\n\nprint(helper())\n";
// helper() carries an error from the start.
const LIB = "def helper() -> int:\n    return undefined_thing\n";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

function pyProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-real-pyright-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n");
    fs.writeFileSync(path.join(dir, "main.py"), MAIN);
    fs.writeFileSync(path.join(dir, "lib.py"), LIB);
    return dir;
}

/** PythonLspSidecar with its delivery mode readable. */
class ObservedPythonSidecar extends PythonLspSidecar {
    pulls(): boolean { return this.supportsPullDiagnostics; }
}

describe.skipIf(!pyrightAvailable)("real pyright", () => {
    const listed = (errors: Array<{ file: string; message: string }> | undefined) =>
        (errors ?? []).map(e => `${path.basename(e.file)}: ${e.message}`);

    it("judges Python edits on the errors they add", async () => {
        const dir = pyProject();
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const sidecar = new ObservedPythonSidecar(dir);
        kernel.registerSidecar(".py", sidecar);
        cleanups.push(() => kernel.shutdownSidecars());
        const edit = async (file: string, content: string) => {
            const r = await kernel.interceptAtomicBatch([{ targetFile: path.join(dir, file), proposedContent: content }]);
            if (r.safe) await kernel.commitToDisk();
            return r;
        };
        const lib = "# note\n\n" + LIB;

        // The error lib.py already had does not reject an unrelated edit (its line moves).
        expect((await edit("lib.py", lib)).safe).toBe(true);
        expect(sidecar.pulls()).toBe(true); // diagnostics are pulled, not awaited on a timer

        // A second error is rejected, and only that one is listed.
        const added = await edit("lib.py", lib.replace("undefined_thing", "undefined_thing + other_missing"));
        expect(added.safe).toBe(false);
        expect(listed(added.structured)).toHaveLength(1);
        expect(listed(added.structured)[0]).toContain("lib.py: \"other_missing\"");

        // lib.py is now an open document with an error: it does not block main.py...
        expect((await edit("main.py", MAIN + "\n# tail\n")).safe).toBe(true);
        // ...whose own new error is still caught...
        const missing = await edit("main.py", MAIN.replace("helper()", "helper() + missing_fn()"));
        expect(missing.safe).toBe(false);
        expect(listed(missing.structured)).toHaveLength(1);
        expect(listed(missing.structured)[0]).toContain("main.py: \"missing_fn\"");
        // ...and so is breaking main.py from lib.py.
        const renamed = await edit("lib.py", lib.replace("helper", "helper2"));
        expect(renamed.safe).toBe(false);
        expect(listed(renamed.structured)).toHaveLength(1);
        expect(listed(renamed.structured)[0]).toContain("main.py: \"helper\"");

        // Fixing the old error is an ordinary accepted edit.
        expect((await edit("lib.py", lib.replace("undefined_thing", "7"))).safe).toBe(true);
        expect(fs.readFileSync(path.join(dir, "lib.py"), "utf8")).toBe(lib.replace("undefined_thing", "7"));
    }, 120_000);

    it("rejects an edit that breaks an importer pyright never had open", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-real-pyright-deps-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n");
        fs.writeFileSync(path.join(dir, "lib.py"), "def helper(n: int) -> int:\n    return n + 1\n");
        fs.writeFileSync(path.join(dir, "app.py"), "from lib import helper\n\n\ndef run() -> int:\n    return helper(1)\n");

        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        kernel.registerSidecar(".py", new PythonLspSidecar(dir));
        cleanups.push(() => kernel.shutdownSidecars());
        const lib = path.join(dir, "lib.py");

        // app.py returns helper(1) as int. The importer comes from the dependency
        // graph (the edit handlers pass it); pyright only reports open documents.
        const breaking = await kernel.interceptAtomicBatch(
            [{ targetFile: lib, proposedContent: "def helper(n: int) -> str:\n    return str(n)\n" }],
            ["app.py"],
        );
        expect(breaking.safe).toBe(false);
        expect(listed(breaking.structured).some(e => e.startsWith("app.py:"))).toBe(true);

        const fine = await kernel.interceptAtomicBatch(
            [{ targetFile: lib, proposedContent: "def helper(n: int) -> int:\n    return n + 2\n" }],
            ["app.py"],
        );
        expect(fine.safe).toBe(true);
        expect(fine.lspCoverage).toEqual([{ languageId: "python", checked: 1, skipped: 0 }]);
        await kernel.commitToDisk();
        expect(fs.readFileSync(lib, "utf8")).toContain("n + 2");
    }, 120_000);

    it("an empty overlay of a real file hides its symbols from importers; a buffer absent on disk is not importable (I-01)", async () => {
        const dir = pyProject();
        const sidecar = new PythonLspSidecar(dir);
        cleanups.push(() => sidecar.shutdown());
        await sidecar.boot();
        const main = path.join(dir, "main.py");
        const lib = path.join(dir, "lib.py");
        const ghost = path.join(dir, "ghost.py"); // never written to disk
        const fixedLib = LIB.replace("undefined_thing", "7");

        expect(await sidecar.validateEdits([{ filePath: main, content: MAIN }, { filePath: lib, content: fixedLib }])).toEqual([]);

        // What a null "tombstone" did to a collateral file after a rolled-back heal.
        const hidden = await sidecar.validateEdits([{ filePath: lib, content: "" }]);
        expect(listed(hidden)).toHaveLength(1);
        expect(listed(hidden)[0]).toContain("main.py: \"helper\"");
        // Its disk content (what NREKI sends now) brings the symbols back.
        expect(await sidecar.validateEdits([{ filePath: lib, content: fixedLib }])).toEqual([]);

        // A buffer for a file that is not on disk does not satisfy an import.
        const unresolved = await sidecar.validateEdits([
            { filePath: main, content: "import ghost\n" + MAIN },
            { filePath: ghost, content: "value = 1\n" },
        ]);
        expect(listed(unresolved)).toHaveLength(1);
        expect(listed(unresolved)[0]).toContain("main.py: Import \"ghost\"");
        await sidecar.validateEdits([{ filePath: ghost, content: null }]);
        expect(sidecar.hasOpenDocument(ghost)).toBe(false);
    }, 120_000);
});
