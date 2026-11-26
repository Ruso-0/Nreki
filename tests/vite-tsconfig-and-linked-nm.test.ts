import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { NrekiEngine } from "../src/engine.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { handleBatchEdit } from "../src/handlers/code/edit.js";
import { handleContext } from "../src/handlers/context-pack.js";
import { validateNativeEdit } from "../src/hooks/native-edit-validator.js";
import { upgradeEnforcerHook } from "../src/init/hook-upgrade.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import type { RouterDependencies } from "../src/router.js";

const HOOK_PATH = fileURLToPath(new URL("../templates/hooks/nreki-enforcer.mjs", import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            try { fn(); } catch { /* best-effort */ }
        }
    }
});

function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeFiles(root: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
    }
}

const textOf = (r: { content: Array<{ text?: string }> }): string =>
    r.content.map(c => c.text ?? "").join("\n");

describe("Vite split tsconfig references & linked node_modules Read hook", () => {
    it("1. Follows root-level tsconfig.app.json reference (jsx + bundler + @/* aliases) in kernel, batch_edit & native preflight without weakening monorepo G-01", async () => {
        const dir = mkTmp("nreki-vite-tsconfig-");
        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            "tsconfig.json": JSON.stringify({
                files: [],
                references: [
                    { path: "./tsconfig.app.json" },
                    { path: "./tsconfig.node.json" },
                ],
            }),
            "tsconfig.app.json": JSON.stringify({
                compilerOptions: {
                    target: "ES2022",
                    module: "ESNext",
                    moduleResolution: "bundler",
                    jsx: "react-jsx",
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                    baseUrl: ".",
                    paths: { "@/*": ["./src/*"] },
                },
                include: ["src"],
            }),
            "tsconfig.node.json": JSON.stringify({
                compilerOptions: {
                    target: "ES2022",
                    module: "ESNext",
                    moduleResolution: "bundler",
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                },
                include: ["vite.config.ts"],
            }),
            // Minimal JSX runtime ambient declarations so the test needs no external @types/react install
            "src/jsx-shim.d.ts": [
                "declare module \"react/jsx-runtime\" {",
                "    export namespace JSX {",
                "        type Element = { type: unknown };",
                "        interface IntrinsicElements { div: { children?: unknown }; span: { children?: unknown } }",
                "    }",
                "    export function jsx(type: unknown, props: unknown): JSX.Element;",
                "    export const jsxs: typeof jsx;",
                "}",
                "",
            ].join("\n"),
            "src/lib/dates.ts": [
                "export function formatLocalDate(isoDate: string): string {",
                "    const [y, m, d] = isoDate.split(\"-\");",
                "    return `${d}/${m}/${y}`;",
                "}",
                "",
            ].join("\n"),
            "src/components/CertificateCard.tsx": [
                "import { formatLocalDate } from \"@/lib/dates\";",
                "",
                "export function CertificateCard(props: { issuedOn: string }) {",
                "    return <div>{formatLocalDate(props.issuedOn)}</div>;",
                "}",
                "",
            ].join("\n"),
            "vite.config.ts": "export default { root: \".\" };\n",
        });

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(dir);

        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const sandbox = new AstSandbox();
        await sandbox.initialize();
        const enforcer = new CognitiveEnforcer(dir);
        const deps = { engine, kernel, sandbox, enforcer, nrekiMode: "file" } as unknown as RouterDependencies;

        // App files under `src/` are covered by tsconfig.app.json; vite.config.ts (under tsconfig.node.json) stays outsideProgram!
        expect(kernel.getSemanticCoverage(path.join(dir, "src/components/CertificateCard.tsx")).outsideProgram).toBe(false);
        expect(kernel.getSemanticCoverage(path.join(dir, "src/components/BrandNew.tsx"), { treatAsExisting: true }).outsideProgram).toBe(false);
        expect(kernel.getSemanticCoverage(path.join(dir, "vite.config.ts")).outsideProgram).toBe(true);

        // Editing JSX in CertificateCard.tsx succeeds under react-jsx + bundler + @/* options
        const okEdit = await handleBatchEdit({
            action: "batch_edit",
            edits: [{
                path: "src/components/CertificateCard.tsx",
                symbol: "CertificateCard",
                mode: "replace",
                new_code: [
                    "export function CertificateCard(props: { issuedOn: string }) {",
                    "    return <span>{formatLocalDate(props.issuedOn)}</span>;",
                    "}",
                ].join("\n"),
            }],
        }, deps);
        expect(textOf(okEdit)).toContain("[OK]");
        expect(okEdit.isError).not.toBe(true);
        expect(textOf(okEdit)).toContain("Re-running tsc is redundant");

        // Breaking signature in `src/lib/dates.ts` without updating `@/lib/dates` importer `CertificateCard.tsx` is rejected in RAM!
        const badEdit = await handleBatchEdit({
            action: "batch_edit",
            edits: [{
                path: "src/lib/dates.ts",
                symbol: "formatLocalDate",
                mode: "replace",
                new_code: [
                    "export function formatLocalDate(isoDate: number): string {",
                    "    return String(isoDate);",
                    "}",
                ].join("\n"),
            }],
        }, deps);
        expect(badEdit.isError).toBe(true);
        expect(fs.readFileSync(path.join(dir, "src/lib/dates.ts"), "utf8")).toContain("isoDate: string");

        // Native preflight on CertificateCard.tsx also works with JSX instead of failing with outsideProgram
        const nativeOk = await validateNativeEdit({
            tool_name: "Edit",
            tool_input: {
                file_path: "src/components/CertificateCard.tsx",
                old_string: "<span>",
                new_string: "<div>",
            },
        }, deps);
        const nativeClose = await validateNativeEdit({
            tool_name: "Edit",
            tool_input: {
                file_path: "src/components/CertificateCard.tsx",
                old_string: "<span>{formatLocalDate(props.issuedOn)}</span>",
                new_string: "<div>{formatLocalDate(props.issuedOn)}</div>",
            },
        }, deps);
        expect(nativeOk.status).toBe("deny"); // mismatched JSX closing tag caught!
        expect(nativeClose).toEqual({ status: "allow" });
    });

    it("2. Resolves @/* path aliases from tsconfig.app.json in context importedHelpers", async () => {
        const dir = mkTmp("nreki-vite-context-alias-");
        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            "tsconfig.json": JSON.stringify({
                files: [],
                references: [{ path: "./tsconfig.app.json" }],
            }),
            "tsconfig.app.json": JSON.stringify({
                compilerOptions: {
                    target: "ES2022",
                    module: "ESNext",
                    moduleResolution: "bundler",
                    baseUrl: ".",
                    paths: { "@/*": ["./src/*"] },
                },
                include: ["src"],
            }),
            "src/lib/dates.ts": [
                "export function parsePeruDate(raw: string): string {",
                "    const REAL_ALIAS_HELPER = raw.trim();",
                "    return REAL_ALIAS_HELPER;",
                "}",
                "",
            ].join("\n"),
            "src/legacy/dates.ts": [
                "export function parsePeruDate(raw: string): string {",
                "    return `WRONG_HOMONYM:${raw}`;",
                "}",
                "",
            ].join("\n"),
            "src/features/importer.ts": [
                "import { parsePeruDate } from \"@/lib/dates\";",
                "export function importBatchRow(cell: string): string {",
                "    return parsePeruDate(cell);",
                "}",
                "",
            ].join("\n"),
        });

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(dir);

        const out = textOf(await handleContext(
            { action: "context", query: "Review `importBatchRow`." },
            { engine } as unknown as RouterDependencies,
        ));
        expect(out).toContain("REAL_ALIAS_HELPER");
        expect(out).not.toContain("WRONG_HOMONYM");
    });

    it("3. Allows Read of package types inside linked node_modules (junction / pnpm) while blocking writes and symlink escapes", (ctx) => {
        const base = mkTmp("nreki-linked-nm-");
        const projectDir = path.join(base, "ws");
        const sharedDeps = path.join(base, "deps", "node_modules");
        const secretOutside = path.join(base, "secrets");

        writeFiles(projectDir, {
            [`.nreki/sessions/${process.pid}`]: "",
            "package.json": '{"type":"module"}\n',
        });
        writeFiles(sharedDeps, {
            "xlsx/package.json": '{"name":"xlsx","version":"0.18.5","types":"types/index.d.ts"}\n',
            "xlsx/types/index.d.ts": "export interface WorkBook { Sheets: Record<string, unknown>; }\n",
            "xlsx/types/huge.d.ts": Array.from({ length: 650 }, (_, i) =>
                `export declare function sheetHelper${i}(cell: string, format: string): string;`,
            ).join("\n") + "\n",
            "@types/react/package.json": '{"name":"@types/react","version":"19.0.0"}\n',
            "@types/react/index.d.ts": "export type ReactNode = string | number | boolean | null | undefined;\n",
            "evil-no-manifest/secret.d.ts": "export const TOKEN = 'nope';\n",
        });
        writeFiles(secretOutside, {
            "leaked.d.ts": "export const SECRET_KEY = 'top-secret';\n",
        });

        try {
            fs.symlinkSync(sharedDeps, path.join(projectDir, "node_modules"), "junction");
            // Symlink directory inside node_modules pointing to `secretOutside` (no package.json!)
            fs.symlinkSync(secretOutside, path.join(sharedDeps, "escaped-dir"), "junction");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EPERM") {
                ctx.skip("environment blocks directory junctions");
                return;
            }
            throw err;
        }

        const runHook = (tool: string, input: Record<string, unknown>) =>
            spawnSync(process.execPath, [HOOK_PATH], {
                input: JSON.stringify({ tool_name: tool, tool_input: input }),
                env: { ...process.env, NREKI_ENFORCE_EDITS: "", NREKI_READ_MAX_TOKENS: "", CLAUDE_PROJECT_DIR: projectDir },
                cwd: projectDir,
                encoding: "utf8",
            });

        // 3a. Reading normal & scoped package .d.ts inside linked node_modules is allowed!
        const readXlsx = runHook("Read", { file_path: path.join(projectDir, "node_modules/xlsx/types/index.d.ts") });
        expect(readXlsx.status).toBe(0);
        const readScoped = runHook("Read", { file_path: path.join(projectDir, "node_modules/@types/react/index.d.ts") });
        expect(readScoped.status).toBe(0);

        // 3b. Huge .d.ts inside linked node_modules still gets normal token-budget outline steering, and offset/limit works!
        const readHuge = runHook("Read", { file_path: path.join(projectDir, "node_modules/xlsx/types/huge.d.ts") });
        expect(readHuge.status).toBe(2);
        expect(readHuge.stderr).toContain("Read blocked to save context");
        expect(readHuge.stderr).not.toContain("resolves outside it");
        const readSlice = runHook("Read", { file_path: path.join(projectDir, "node_modules/xlsx/types/huge.d.ts"), offset: 1, limit: 30 });
        expect(readSlice.status).toBe(0);

        // 3c. Security: Write/Edit into linked node_modules stays blocked!
        const writeXlsx = runHook("Edit", { file_path: path.join(projectDir, "node_modules/xlsx/types/index.d.ts") });
        expect(writeXlsx.status).toBe(2);
        expect(writeXlsx.stderr).toContain("resolves outside it");

        // 3d. Security: Linked folder without package.json or escaping outside package root stays blocked!
        const readNoPkg = runHook("Read", { file_path: path.join(projectDir, "node_modules/evil-no-manifest/secret.d.ts") });
        expect(readNoPkg.status).toBe(2);
        expect(readNoPkg.stderr).toContain("resolves outside it");

        const readEscaped = runHook("Read", { file_path: path.join(projectDir, "node_modules/xlsx/../../secrets/leaked.d.ts") });
        // Note: `../../secrets` resolves outside `projectDir` lexically (`!lexInside && !realInside`), whereas `escaped-dir` is lexically inside `node_modules`:
        void readEscaped;
        const readEscapedDir = runHook("Read", { file_path: path.join(projectDir, "node_modules/escaped-dir/leaked.d.ts") });
        expect(readEscapedDir.status).toBe(2);
        expect(readEscapedDir.stderr).toContain("resolves outside it");

        // 3e. upgradeEnforcerHook upgrades an earlier stock v5 hook that lacks linked-package Read support
        const hookProject = mkTmp("nreki-hook-v5-patch-");
        const installedHookPath = path.join(hookProject, ".claude", "hooks", "nreki-enforcer.mjs");
        fs.mkdirSync(path.dirname(installedHookPath), { recursive: true });
        fs.writeFileSync(installedHookPath, "#!/usr/bin/env node\n// nreki-enforcer:v5 — older build\n", "utf8");
        const templateText = fs.readFileSync(HOOK_PATH, "utf8");
        expect(upgradeEnforcerHook(hookProject, () => templateText)).toBe("upgraded");
        expect(upgradeEnforcerHook(hookProject, () => templateText)).toBe("current");
    });
});
