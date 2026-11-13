/**
 * The Go edit path against the REAL gopls (opt-in).
 *
 * Runs only when `gopls` and `go` resolve from PATH the way NREKI resolves
 * sidecar binaries; skipped otherwise. NREKI turns on gopls' `pullDiagnostics`
 * setting, so diagnostics are pulled (one request per open document) instead
 * of waiting on a settle timer for published ones.
 * The kernel boots in "file" mode, as it does for a Go-only project.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { GoLspSidecar } from "../src/kernel/backends/go-sidecar.js";
import { resolveExecutable } from "../src/utils/safe-exec.js";

const goplsAvailable = resolveExecutable("gopls") !== null && resolveExecutable("go") !== null;

const MAIN = "package main\n\nfunc main() {\n\tprintln(helper())\n}\n";
// helper() carries an error from the start: the file never compiled.
const UTIL = "package main\n\nfunc helper() int {\n\treturn undefinedThing\n}\n";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

function goProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-real-gopls-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/demo\n\ngo 1.22\n");
    fs.writeFileSync(path.join(dir, "main.go"), MAIN);
    fs.writeFileSync(path.join(dir, "util.go"), UTIL);
    return dir;
}

/** GoLspSidecar with its delivery mode readable. */
class ObservedGoSidecar extends GoLspSidecar {
    pulls(): boolean { return this.supportsPullDiagnostics; }
}

describe.skipIf(!goplsAvailable)("real gopls", () => {
    const listed = (r: { structured?: Array<{ file: string; message: string }> }) =>
        (r.structured ?? []).map(e => `${path.basename(e.file)}: ${e.message}`);

    it("judges Go edits on the errors they add", async () => {
        const dir = goProject();
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const sidecar = new ObservedGoSidecar(dir);
        kernel.registerSidecar(".go", sidecar);
        cleanups.push(() => kernel.shutdownSidecars());
        const edit = async (file: string, content: string) => {
            const r = await kernel.interceptAtomicBatch([{ targetFile: path.join(dir, file), proposedContent: content }]);
            if (r.safe) await kernel.commitToDisk();
            return r;
        };
        const util = "// note\n\n" + UTIL;

        // The error util.go already had does not reject an unrelated edit (its line moves).
        expect((await edit("util.go", util)).safe).toBe(true);
        expect(sidecar.pulls()).toBe(true); // advertised thanks to the pullDiagnostics setting

        // A second error is rejected, and only that one is listed.
        const added = await edit("util.go", util.replace("undefinedThing", "undefinedThing + otherMissing"));
        expect(added.safe).toBe(false);
        expect(listed(added)).toEqual(["util.go: undefined: otherMissing"]);

        // util.go is now an open document with an error: it does not block main.go...
        expect((await edit("main.go", MAIN + "\n// tail\n")).safe).toBe(true);
        // ...whose own new error is still caught...
        const missing = await edit("main.go", MAIN.replace("helper()", "helper() + missingFn()"));
        expect(missing.safe).toBe(false);
        expect(listed(missing)).toEqual(["main.go: undefined: missingFn"]);
        // ...and so is breaking main.go from util.go.
        const renamed = await edit("util.go", util.replace("helper", "helper2"));
        expect(renamed.safe).toBe(false);
        expect(listed(renamed)).toEqual(["main.go: undefined: helper"]);

        // Fixing the old error is an ordinary accepted edit.
        expect((await edit("util.go", util.replace("undefinedThing", "7"))).safe).toBe(true);
        expect(fs.readFileSync(path.join(dir, "util.go"), "utf8")).toBe(util.replace("undefinedThing", "7"));
    }, 120_000);

    it("auto-heals a missing import in a file that already had an error", async () => {
        const dir = goProject();
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        kernel.registerSidecar(".go", new GoLspSidecar(dir));
        cleanups.push(() => kernel.shutdownSidecars());
        const util = path.join(dir, "util.go");

        // The fix is judged on the error the edit added ("undefined: fmt");
        // the older "undefined: undefinedThing" stays and must not undo it.
        const r = await kernel.interceptAtomicBatch([{
            targetFile: util,
            proposedContent: UTIL + "\nfunc label() string {\n\treturn fmt.Sprint(1)\n}\n",
        }]);
        expect(r.safe).toBe(true);
        expect(r.errorText).toContain("AUTO-HEAL");
        await kernel.commitToDisk();
        const onDisk = fs.readFileSync(util, "utf8");
        expect(onDisk).toContain('import "fmt"');
        expect(onDisk).toContain("undefinedThing");
    }, 120_000);

    it("rejects an edit that breaks a file gopls never had open (same package, and an importing package)", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-real-gopls-deps-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        const write = (rel: string, content: string) => {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        };
        write("go.mod", "module example.com/demo\n\ngo 1.22\n");
        write("lib.go", "package main\n\nfunc Greet(name string) string {\n\treturn \"hello \" + name\n}\n");
        write("main.go", "package main\n\nfunc main() {\n\tvar s string = Greet(\"go\")\n\tprintln(s)\n}\n");
        write("util/u.go", "package util\n\nfunc N() int { return 1 }\n");
        write("cmd/app/app.go", "package main\n\nimport \"example.com/demo/util\"\n\nfunc main() {\n\tvar n int = util.N()\n\t_ = n\n}\n");

        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const sidecar = new GoLspSidecar(dir);
        kernel.registerSidecar(".go", sidecar);
        cleanups.push(() => kernel.shutdownSidecars());

        // Same package: main.go calls Greet and was never opened. No importer list
        // is needed — the sidecar names the other files of the package itself.
        const samePackage = await kernel.interceptAtomicBatch([{
            targetFile: path.join(dir, "lib.go"),
            proposedContent: "package main\n\nfunc Greet(name string) int {\n\treturn len(name)\n}\n",
        }]);
        expect(samePackage.safe).toBe(false);
        expect(listed(samePackage).some(e => e.startsWith("main.go:"))).toBe(true);
        expect(fs.readFileSync(path.join(dir, "lib.go"), "utf8")).toContain("string {");

        // Another package imports util: the caller passes the importers it found in
        // the dependency graph (see the edit handlers).
        const breakN = "package util\n\nfunc N() string { return \"x\" }\n";
        const importer = await kernel.interceptAtomicBatch(
            [{ targetFile: path.join(dir, "util/u.go"), proposedContent: breakN }],
            ["cmd/app/app.go"],
        );
        expect(importer.safe).toBe(false);
        expect(listed(importer).some(e => e.startsWith("app.go:"))).toBe(true);

        // An edit that breaks nobody is accepted and says what it covered.
        const fine = await kernel.interceptAtomicBatch(
            [{ targetFile: path.join(dir, "util/u.go"), proposedContent: "package util\n\n// N is one.\nfunc N() int { return 1 }\n" }],
            ["cmd/app/app.go"],
        );
        expect(fine.safe).toBe(true);
        expect(fine.lspCoverage).toEqual([{ languageId: "go", checked: 1, skipped: 0 }]);
        await kernel.commitToDisk();
    }, 120_000);

    it("reports an empty open buffer as an error, and NREKI closes one whose file is absent (I-01)", async () => {
        const dir = goProject();
        const sidecar = new GoLspSidecar(dir);
        cleanups.push(() => sidecar.shutdown());
        await sidecar.boot();
        const ghost = path.join(dir, "ghost.go"); // never written to disk

        // What a null "tombstone" used to leave behind: an empty overlay.
        const empty = await sidecar.validateEdits([{ filePath: ghost, content: "" }]);
        expect(empty.map(e => path.basename(e.file))).toEqual(["ghost.go"]);

        expect(await sidecar.validateEdits([{ filePath: ghost, content: null }])).toEqual([]);
        expect(sidecar.hasOpenDocument(ghost)).toBe(false);
    }, 120_000);
});
