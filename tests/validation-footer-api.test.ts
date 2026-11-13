/**
 * File mode (a tsconfig project of ≤ 200 files) type-checks the edited files
 * and their direct importers. The [Validated] footer now compares what OTHER
 * files can see of the edit — the .d.ts TypeScript emits for the edited files,
 * and the program's file list — before and after it:
 *   - unchanged: no other file can type-check differently, so it says that
 *     re-running tsc is redundant;
 *   - changed: it says so and asks for tsc;
 *   - global declarations changed: files using them are not importers, so they
 *     were never checked. That case used to be reported as "no importers …
 *     Re-running tsc is redundant".
 * In the 2026-11-13 Codex holdout all three NREKI sessions got "run tsc if the
 * exported API changed" after body-only fixes, and each then spent 1–3 turns
 * finding and running tsc.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { handleEdit, handleBatchEdit } from "../src/handlers/code/edit.js";
import { buildValidationBanner } from "../src/handlers/code/validation-banner.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import type { RouterDependencies } from "../src/router.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

let parser: ASTParser;
let sandbox: AstSandbox;
beforeAll(async () => {
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

// noEmit and no `declaration`: the usual application tsconfig.
const TSCONFIG = JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
    include: ["src/**/*.ts"],
});

function fileModeProject(files: Record<string, string>, graph: Record<string, string[]>): { dir: string; deps: RouterDependencies } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-footer-api-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [rel, content] of Object.entries({ "tsconfig.json": TSCONFIG, ...files })) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    const kernel = new NrekiKernel();
    kernel.boot(dir, "file");
    const deps = {
        engine: {
            initialize: async () => {},
            getProjectRoot: () => dir,
            getParser: () => parser,
            expectInternalEdit: vi.fn(),
            cancelInternalEdit: vi.fn(),
            invalidateCachedGraph: vi.fn(),
            logUsage: vi.fn(),
            findDependents: async (rel: string) => graph[rel.replace(/\\/g, "/")] ?? [],
            getDependencyGraph: async () => ({ importedBy: new Map(), inDegree: new Map(), tiers: new Map() }),
        },
        sandbox,
        kernel,
        nrekiMode: "file",
    } as unknown as RouterDependencies;
    return { dir, deps };
}

const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? "").join("\n");
const REDUNDANT = "Re-running tsc is redundant";

describe("file mode footer: does the edit change what other files can see?", () => {
    it("a body-only fix: exported API unchanged, re-running tsc is redundant", async () => {
        const { dir, deps } = fileModeProject({
            "src/quote.ts": [
                "export interface Line { grams: number; quantity: number }",
                "",
                "export function totalKg(lines: Line[]): number {",
                "    let grams = 0;",
                "    for (const line of lines) grams += line.grams;",
                "    return Math.ceil(grams / 1000);",
                "}",
                "",
            ].join("\n"),
            "src/price.ts": "import { totalKg, type Line } from \"./quote\";\nexport function price(lines: Line[]): number {\n    return totalKg(lines) * 5;\n}\n",
            "src/label.ts": "import { totalKg } from \"./quote\";\nexport const zero: number = totalKg([]);\n",
            // Imports an importer: file mode never checks it.
            "src/invoice.ts": "import { price } from \"./price\";\nexport const total: number = price([]);\n",
        }, { "src/quote.ts": ["src/price.ts", "src/label.ts"] });

        const res = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/quote.ts", symbol: "totalKg", mode: "patch",
            search_text: "grams += line.grams;", replace_text: "grams += line.grams * line.quantity;",
        }] }, deps);
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("+ 2 direct importer(s) (file mode; exported API unchanged, no other file affected)");
        expect(text).toContain(REDUNDANT);
        expect(text).not.toContain("run tsc");
        expect(fs.readFileSync(path.join(dir, "src/quote.ts"), "utf8")).toContain("line.grams * line.quantity");
    });

    it("the single-symbol edit says the same", async () => {
        const { deps } = fileModeProject({
            "src/days.ts": "export function nextDay(day: number): number {\n    return day + 1;\n}\n",
            "src/plan.ts": "import { nextDay } from \"./days\";\nexport const tomorrow: number = nextDay(1);\n",
        }, { "src/days.ts": ["src/plan.ts"] });

        const res = await handleEdit({
            action: "edit", path: "src/days.ts", symbol: "nextDay",
            new_code: "export function nextDay(day: number): number {\n    return (day + 1) % 7;\n}",
        }, deps);
        expect(res.isError).not.toBe(true);
        expect(textOf(res)).toContain("exported API unchanged");
        expect(textOf(res)).toContain(REDUNDANT);
    });

    it("an inferred return type that changes: the edit is accepted, the footer asks for tsc", async () => {
        // scale() keeps its signature line, so a text diff sees no signature change.
        // use.ts still compiles; report.ts, which imports use.ts, would not.
        const { deps } = fileModeProject({
            "src/scale.ts": "export function scale(n: number) {\n    return n * 2;\n}\n",
            "src/use.ts": "import { scale } from \"./scale\";\nexport const doubled = scale(2);\n",
            "src/report.ts": "import { doubled } from \"./use\";\nexport const half: number = doubled / 2;\n",
        }, { "src/scale.ts": ["src/use.ts"] });

        const res = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/scale.ts", symbol: "scale", mode: "patch",
            search_text: "return n * 2;", replace_text: "return String(n * 2);",
        }] }, deps);
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("Exported API changed: transitive importers (e.g. via re-exports) NOT checked — run tsc before finishing.");
        expect(text).not.toContain(REDUNDANT);
    });

    it("a local type behind an export changes: same export type text, still a changed API", async () => {
        // The export's type prints as "() => Totals" before and after.
        const { deps } = fileModeProject({
            "src/totals.ts": "interface Totals {\n    cents: number;\n}\n\nexport function totals(): Totals {\n    return { cents: 1 };\n}\n",
            "src/show.ts": "import { totals } from \"./totals\";\nexport const shown = totals();\n",
        }, { "src/totals.ts": ["src/show.ts"] });

        const res = await handleBatchEdit({ action: "batch_edit", edits: [
            { path: "src/totals.ts", symbol: "Totals", mode: "patch", search_text: "cents: number;", replace_text: "amount: number;" },
            { path: "src/totals.ts", symbol: "totals", mode: "patch", search_text: "{ cents: 1 }", replace_text: "{ amount: 1 }" },
        ] }, deps);
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("Exported API changed");
        expect(text).not.toContain(REDUNDANT);
    });

    it("a global declaration file has no importers, yet every file using it can break", async () => {
        const { deps } = fileModeProject({
            "src/globals.d.ts": "interface AppConfig {\n    port: number;\n}\n",
            "src/server.ts": "export function listen(config: AppConfig): number {\n    return config.port + 1;\n}\n",
        }, {});

        const res = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/globals.d.ts", symbol: "AppConfig", mode: "patch",
            search_text: "port: number;", replace_text: "port: string;",
        }] }, deps);
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("It changes global declarations: files using them were NOT checked — run tsc before finishing.");
        expect(text).not.toContain(REDUNDANT);
    });

    it("`declare global` in a module: changing it asks for tsc, a body edit beside it does not", async () => {
        const { deps } = fileModeProject({
            "src/env.ts": [
                "export function version(): number {",
                "    return 1;",
                "}",
                "",
                "declare global {",
                "    interface AppFlags {",
                "        beta: boolean;",
                "    }",
                "}",
                "",
            ].join("\n"),
            "src/flags.ts": "export function isBeta(flags: AppFlags): boolean {\n    return flags.beta;\n}\n",
        }, {});

        const body = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/env.ts", symbol: "version", mode: "patch", search_text: "return 1;", replace_text: "return 2;",
        }] }, deps);
        expect(body.isError).not.toBe(true);
        expect(textOf(body)).toContain(REDUNDANT);

        const globals = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/env.ts", symbol: "AppFlags", mode: "patch", search_text: "beta: boolean;", replace_text: "beta: string;",
        }] }, deps);
        expect(globals.isError).not.toBe(true);
        expect(textOf(globals)).toContain("It changes global declarations");
        expect(textOf(globals)).not.toContain(REDUNDANT);
    });
});

describe("buildValidationBanner: the comparison's three outcomes", () => {
    const base = {
        kernelRan: true, mode: "file", files: ["src/a.ts"],
        coverage: () => ({ backend: "typescript" as const }),
        dependents: { lookedUp: true, checked: 2, total: 2 },
    };

    it("not compared (hologram mode, the auto-heal path): the conditional wording stays", () => {
        const banner = buildValidationBanner(base);
        expect(banner).toContain("Transitive importers (e.g. via re-exports) not checked — run tsc if the exported API changed.");
        expect(banner).not.toContain(REDUNDANT);
    });

    it("unchanged API covers importers beyond the per-edit cap too", () => {
        const banner = buildValidationBanner({ ...base, dependents: { lookedUp: true, checked: 50, total: 70 }, exportedApiUnchanged: true });
        expect(banner).toContain("+ 50 of 70 direct importer(s) (file mode; exported API unchanged, no other file affected)");
        expect(banner).toContain(REDUNDANT);
    });

    it("a file outside the checker still blocks the claim", () => {
        const banner = buildValidationBanner({
            ...base, files: ["src/a.ts", "styles.css"], exportedApiUnchanged: true,
            coverage: (f: string) => ({ backend: f.endsWith(".ts") ? "typescript" as const : null }),
        });
        expect(banner).toContain("Syntax only for styles.css");
        expect(banner).not.toContain(REDUNDANT);
    });
});
