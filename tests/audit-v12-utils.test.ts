/**
 * Regression tests for the v12.0.0 audit — pure helpers
 * (SEC-03, ROB-01, GAR-03, INT-07, GAR-01).
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { resolveExecutable, buildSafeChildEnv } from "../src/utils/safe-exec.js";
import { findNewSuppressions } from "../src/utils/suppression-guard.js";
import { readSourceForEdit, detectEol, captureFileTraits, withTraits } from "../src/utils/file-traits.js";
import { buildValidationBanner } from "../src/handlers/code/validation-banner.js";

const isWin = process.platform === "win32";
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}
afterEach(() => {
    while (tmpDirs.length > 0) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

/** Create a fake executable named `name` inside `dir`. */
function plantBinary(dir: string, name: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, isWin ? `${name}.cmd` : name);
    fs.writeFileSync(file, isWin ? "@echo planted\r\n" : "#!/bin/sh\necho planted\n");
    if (!isWin) fs.chmodSync(file, 0o755);
    return file;
}

// ─── NREKI-SEC-03 ───────────────────────────────────────────────────

describe("SEC-03: binaries are never resolved from the repository", () => {
    it("skips the project root, in-project node_modules bins and relative PATH entries", () => {
        const base = mkTmp("nreki-exec-");
        const project = path.join(base, "repo");
        const trusted = path.join(base, "toolchain", "bin");
        plantBinary(project, "gopls");                                  // repo root (cwd vector)
        plantBinary(path.join(project, "node_modules", ".bin"), "gopls"); // npx-injected PATH entry
        const real = plantBinary(trusted, "gopls");

        const PATH = [".", "relative/bin", project, path.join(project, "node_modules", ".bin"), trusted].join(path.delimiter);
        const resolved = resolveExecutable("gopls", { projectRoot: project, env: { PATH, PATHEXT: ".EXE;.CMD;.BAT" } });
        expect(resolved).toBe(real);
    });

    it("returns null instead of falling back to the cwd", () => {
        const project = mkTmp("nreki-exec-only-");
        plantBinary(project, "basedpyright-langserver");
        const resolved = resolveExecutable("basedpyright-langserver", {
            projectRoot: project,
            env: { PATH: [".", project].join(path.delimiter), PATHEXT: ".EXE;.CMD;.BAT" },
        });
        expect(resolved).toBeNull();
    });

    it("keeps an activated in-project virtualenv bin (explicit user action)", () => {
        const project = mkTmp("nreki-exec-venv-");
        const venvBin = path.join(project, ".venv", isWin ? "Scripts" : "bin");
        const real = plantBinary(venvBin, "basedpyright-langserver");
        const resolved = resolveExecutable("basedpyright-langserver", {
            projectRoot: project, env: { PATH: venvBin, PATHEXT: ".EXE;.CMD;.BAT" },
        });
        expect(resolved).toBe(real);
    });

    it("rejects relative explicit paths", () => {
        expect(resolveExecutable("./gopls")).toBeNull();
        expect(resolveExecutable("bin/gopls")).toBeNull();
    });
});

// ─── NREKI-SEC-03 + ROB-01 ──────────────────────────────────────────

describe("ROB-01: child environment", () => {
    it("drops secrets and keeps what toolchains need", () => {
        process.env.NREKI_TEST_SECRET_TOKEN = "sk-should-not-leak";
        try {
            const env = buildSafeChildEnv(["PATH", "GOCACHE"], { EXTRA: "1" });
            expect(env.NREKI_TEST_SECRET_TOKEN).toBeUndefined();
            expect(env.EXTRA).toBe("1");
            if (isWin) {
                const keys = Object.keys(env).map(k => k.toUpperCase());
                expect(keys).toContain("SYSTEMROOT");
                expect(keys).toContain("LOCALAPPDATA");
                expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1");
                // case-insensitive keys must not be duplicated
                expect(new Set(keys).size).toBe(keys.length);
            }
        } finally {
            delete process.env.NREKI_TEST_SECRET_TOKEN;
        }
    });
});

// ─── NREKI-GAR-03 ───────────────────────────────────────────────────

describe("GAR-03: Anti-Sweep Shield is differential and covers every documented directive", () => {
    const ts = "src/a.ts";
    const py = "app/a.py";

    it.each([
        ["// @ts-ignore\nfoo();"],
        ["/* @ts-nocheck */\n"],
        ["// @ts-expect-error\nfoo();"],
        ["// eslint-disable-next-line\nfoo();"],
        ["/* eslint-disable */\n"],
        ["// eslint-disable-line -- legacy\n"],
        ["// eslint-disable-next-line react-hooks/exhaustive-deps\n"],
        ["{/* eslint-disable-next-line react/jsx-key */}\n"],
        // A shield rule hidden after an unrelated one in the rule list.
        ["// eslint-disable no-console, react-hooks/exhaustive-deps\n"],
    ])("blocks a NEW TS/JS suppression: %s", (added) => {
        expect(findNewSuppressions(ts, "const x = 1;\n", "const x = 1;\n" + added)).not.toHaveLength(0);
    });

    it.each([
        ["x = f()  # type: ignore\n"],
        ["x = f()  # pyright: ignore[reportGeneralTypeIssues]\n"],
        ["import os  # noqa: F401\n"],
    ])("blocks a NEW Python suppression: %s", (added) => {
        expect(findNewSuppressions(py, "x = 1\n", "x = 1\n" + added)).not.toHaveLength(0);
    });

    it("does not trip on suppressions that already existed (legacy code)", () => {
        const legacy = "// eslint-disable-next-line react-hooks/exhaustive-deps\nuseEffect(() => {}, []);\n// @ts-ignore\nbar();\n";
        expect(findNewSuppressions(ts, legacy, legacy + "export const y = 2;\n")).toHaveLength(0);
    });

    it("leaves rules NREKI does not enforce to the project's linter", () => {
        expect(findNewSuppressions(ts, "", "// eslint-disable-next-line no-console\nconsole.log(1);\n")).toHaveLength(0);
    });

    it("is language-aware (no Python directives in TS, no TS directives in Python)", () => {
        expect(findNewSuppressions(ts, "", "const s = '# noqa';\n")).toHaveLength(0);
        expect(findNewSuppressions(py, "", "s = '@ts-ignore'\n")).toHaveLength(0);
    });
});

// ─── NREKI-INT-07 ───────────────────────────────────────────────────

describe("INT-07: encoding-safe edit reads", () => {
    it("refuses invalid UTF-8 (Latin-1 ñ) and UTF-16/binary instead of corrupting them", () => {
        const dir = mkTmp("nreki-enc-");
        const latin1 = path.join(dir, "legacy.py");
        fs.writeFileSync(latin1, Buffer.from([0x23, 0x20, 0x61, 0xf1, 0x6f, 0x0a])); // "# año\n" in Latin-1
        expect(() => readSourceForEdit(latin1)).toThrow(/not valid UTF-8/);

        const utf16 = path.join(dir, "u16.ts");
        fs.writeFileSync(utf16, Buffer.from("﻿const a = 1;\n", "utf16le"));
        expect(() => readSourceForEdit(utf16)).toThrow(/NUL bytes|not valid UTF-8/);
    });

    it("strips a UTF-8 BOM like readSource and lets the writer restore it", () => {
        const dir = mkTmp("nreki-bom-");
        const f = path.join(dir, "a.ts");
        fs.writeFileSync(f, "﻿export const a = 1;\n");
        expect(readSourceForEdit(f)).toBe("export const a = 1;\n");
        const traits = captureFileTraits(f);
        expect(traits.bom).toBe(true);
        expect(withTraits("export const a = 2;\n", traits).charCodeAt(0)).toBe(0xfeff);
        expect(withTraits("﻿x", traits)).toBe("﻿x"); // idempotent
    });

    it("detects the dominant line ending", () => {
        expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
        expect(detectEol("a\nb\n")).toBe("\n");
        expect(detectEol("single line")).toBe("\n");
    });
});

// ─── AST sandbox fail-open (audit Phase 1 remark) ──────────────────

describe("AST sandbox: a syntax error hidden below the recursion guard is not 'valid'", () => {
    it("fails closed when the error is nested deeper than 500 levels", async () => {
        const { AstSandbox } = await import("../src/ast-sandbox.js");
        const sandbox = new AstSandbox();
        await sandbox.initialize();
        const deep = "export const x = " + "[".repeat(700) + "1 +" + "]".repeat(700) + ";\n";
        const res = await sandbox.validateCode(deep, "typescript");
        expect(res.valid).toBe(false);

        const fine = "export const y = " + "[".repeat(700) + "1" + "]".repeat(700) + ";\n";
        expect((await sandbox.validateCode(fine, "typescript")).valid).toBe(true);
    });
});

// ─── NREKI-GAR-01 ───────────────────────────────────────────────────

describe("GAR-01: the validation footer never overclaims", () => {
    const tsCov = (f: string) => (/\.ts$/.test(f) ? { backend: "typescript" as const } : /\.py$/.test(f)
        ? { backend: "lsp" as const, languageId: "python" } : { backend: null });

    it("says syntax only when the kernel did not run", () => {
        const b = buildValidationBanner({ kernelRan: false, reasonNoKernel: "syntax mode", files: ["a.ts"] });
        expect(b).toContain("syntax only");
        expect(b).not.toMatch(/Semantic check passed|Do not run bash verification|redundant/);
    });

    it("only calls tsc redundant for fully covered project-mode TS edits", () => {
        const b = buildValidationBanner({ kernelRan: true, mode: "project", files: ["a.ts"], coverage: tsCov });
        expect(b).toContain("cross-file (project mode)");
        expect(b).toContain("redundant");
    });

    it("discloses the importer scope in file/hologram mode", () => {
        const none = buildValidationBanner({
            kernelRan: true, mode: "file", files: ["a.ts"], coverage: tsCov,
            dependents: { lookedUp: true, checked: 0, total: 0 },
        });
        expect(none).toContain("no importers");
        const partial = buildValidationBanner({
            kernelRan: true, mode: "hologram", files: ["a.ts"], coverage: tsCov,
            dependents: { lookedUp: true, checked: 50, total: 120 },
        });
        expect(partial).toContain("50 of 120");
        expect(partial).toContain("NOT checked");
        expect(partial).not.toContain("redundant");
    });

    it("flags languages with no checker and LSP sidecars that were offline", () => {
        const kt = buildValidationBanner({ kernelRan: true, mode: "project", files: ["Main.kt"], coverage: tsCov });
        expect(kt).toContain("syntax only");
        const py = buildValidationBanner({
            kernelRan: true, mode: "file", files: ["a.py"], coverage: tsCov, degradedLanguages: ["python"],
        });
        expect(py).toContain("syntax only");
        expect(py).toContain("offline");
        const mixed = buildValidationBanner({ kernelRan: true, mode: "project", files: ["a.ts", "b.json"], coverage: tsCov });
        expect(mixed).toContain("Syntax only for b.json");
        expect(mixed).not.toContain("redundant");
    });
});
