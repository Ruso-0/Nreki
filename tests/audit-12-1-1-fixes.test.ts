/**
 * Regressions for the external audit of 12.1.1 (findings F-02 to F-14), and for
 * the auto-heal defect found while verifying F-06. Each test failed on 12.1.0.
 * F-01 (writing through symbolic links) is in tests/hook-upgrade.test.ts.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { isSensitivePath } from "../src/utils/path-jail.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { NrekiEngine } from "../src/engine.js";
import { handleBatchEdit, handleEdit } from "../src/handlers/code/edit.js";
import { buildValidationBanner } from "../src/handlers/code/validation-banner.js";
import { handleContext, extractTaskIdentifiers, splitTaskIssues } from "../src/handlers/context-pack.js";
import { handleDefinition } from "../src/handlers/navigate.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { wrapWithCircuitBreaker } from "../src/middleware/circuit-breaker.js";
import * as imports from "../src/utils/imports.js";
import { estimateTokens } from "../src/utils/token-estimator.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import type { RouterDependencies } from "../src/router.js";
import type { McpToolResponse } from "../src/router.js";

const require = createRequire(import.meta.url);
const { get_encoding } = require("tiktoken") as typeof import("tiktoken");

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

function project(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-audit-1211-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

const TSCONFIG = (extra: Record<string, unknown> = {}) => JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", ...extra },
    include: ["src/**/*.ts"],
});

function mockDeps(dir: string, graph: Record<string, string[]>, extra: Partial<Record<string, unknown>> = {}): RouterDependencies {
    return {
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
        ...extra,
    } as unknown as RouterDependencies;
}

function fileModeDeps(dir: string, graph: Record<string, string[]>): RouterDependencies {
    const kernel = new NrekiKernel();
    kernel.boot(dir, "file");
    return mockDeps(dir, graph, { kernel, nrekiMode: "file" });
}

async function indexed(files: Record<string, string>): Promise<{ dir: string; engine: NrekiEngine }> {
    const dir = project(files);
    const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
    cleanups.push(() => engine.shutdown());
    await engine.initialize();
    await engine.indexDirectory(dir);
    return { dir, engine };
}

const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? "").join("\n");
const REDUNDANT = "Re-running tsc is redundant";

describe("F-02: sensitive paths", () => {
    it("editor configs that start processes, yarn tokens, key stores; relative paths too", () => {
        for (const p of [".vscode/tasks.json", ".vscode/launch.json", ".vscode/mcp.json", ".cursor/mcp.json",
            "app/.windsurf/mcp.json", ".yarnrc.yml", ".npmrc", ".git/config", "keys/id_ecdsa", "certs/app.p12"]) {
            expect(isSensitivePath(p), p).toBe(true);
        }
        for (const p of [".vscode/settings.json", "src/tasks.json", "src/mcp.json", "docs/npmrc.md", "src/valid_dsa.ts"]) {
            expect(isSensitivePath(p), p).toBe(false);
        }
    });
});

describe("kernel: errors that already exist, and auto-heal", () => {
    it("F-06: 75 errors already in the project neither trip the cascade limit nor fake an auto-heal", async () => {
        const files: Record<string, string> = {
            "tsconfig.json": TSCONFIG(),
            "src/clean.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\n",
        };
        for (let i = 0; i < 15; i++) {
            files[`src/legacy/old${i}.ts`] = Array.from({ length: 5 }, (_, j) => `export const bad${i}_${j}: number = "x${j}";`).join("\n") + "\n";
        }
        const dir = project(files);
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        const r = await kernel.interceptAtomicBatch([{
            targetFile: "src/clean.ts",
            proposedContent: "export function add(a: number, b: number): number {\n    return b + a;\n}\n",
        }], []);
        expect(r.safe).toBe(true);
        expect(r.errorText ?? "").not.toContain("AUTO-HEAL");
    });

    it("an error no backend can fix is not reported as healed", async () => {
        const dir = project({ "tsconfig.json": TSCONFIG(), "src/a.ts": "export const a = 1;\n" });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const heal = (kernel as unknown as {
            phase4_healingCascade(
                errors: Array<{ file: string; line: number; column: number; code: string; message: string }>,
                edited: Set<string>, evaluated: Set<string>, mutated: Set<string>, baselines: ReadonlyMap<unknown, unknown>,
            ): Promise<{ healed: boolean }>;
        }).phase4_healingCascade.bind(kernel);
        const result = await heal(
            [{ file: "global", line: 0, column: 0, code: "TS9999", message: "Cascade exceeded threshold" }],
            new Set(), new Set(), new Set(), new Map<unknown, unknown>(),
        );
        expect(result.healed).toBe(false);
    });

    it("F-05: fixing an old error and adding the same one in another function is a new error", async () => {
        const dir = project({
            "tsconfig.json": TSCONFIG(),
            "src/billing.ts": "export function legacyTotal(): number {\n    const a: number = \"x\";\n    return a;\n}\n\nexport function computeTax(): number {\n    return 1;\n}\n",
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const r = await kernel.interceptAtomicBatch([{
            targetFile: "src/billing.ts",
            proposedContent: "export function legacyTotal(): number {\n    return 0;\n}\n\nexport function computeTax(): number {\n    const b: number = \"y\";\n    return b;\n}\n",
        }], []);
        expect(r.safe).toBe(false);
        expect(r.errorText).toContain("TS2322");
    });
});

describe("F-03/F-04: importers, as the compiler resolves them", () => {
    it("an importer through a tsconfig alias is found and checked: the breaking edit is rejected", async () => {
        const dir = project({
            "tsconfig.json": TSCONFIG({ baseUrl: ".", paths: { "~/*": ["src/*"] } }),
            "src/calc.ts": "export function calc(x: number): number {\n    return x * 2;\n}\n",
            "src/app.ts": "import { calc } from \"~/calc\";\nexport const v: number = calc(2);\n",
        });
        // The import graph does not resolve "~/calc": it reports no importer.
        const deps = fileModeDeps(dir, {});
        const res = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/calc.ts", symbol: "calc",
            new_code: "export function calc(x: number): string {\n    return String(x * 2);\n}",
        }] }, deps);
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain("app.ts");
        expect(fs.readFileSync(path.join(dir, "src/calc.ts"), "utf8")).toContain("): number {");
    });

    it("an importer outside the tsconfig program is reported as not checked, not counted as checked", async () => {
        const dir = project({
            "tsconfig.json": TSCONFIG(),
            "src/calc.ts": "export function calc(x: number): number {\n    return x * 2;\n}\n",
            "tests/calc.test.ts": "import { calc } from \"../src/calc\";\nexport const t: number = calc(1);\n",
        });
        const deps = fileModeDeps(dir, { "src/calc.ts": ["tests/calc.test.ts"] });
        const res = await handleBatchEdit({ action: "batch_edit", edits: [{
            path: "src/calc.ts", symbol: "calc",
            new_code: "export function calc(x: number, factor = 2): number {\n    return x * factor;\n}",
        }] }, deps);
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("1 importer(s) outside the tsconfig program (another tsconfig, plain JS) NOT checked");
        expect(text).not.toContain("1 direct importer");
        expect(text).not.toContain(REDUNDANT);
    });

    it("a changed program or files auto-heal patched beyond the edit never read as fully checked", () => {
        const base = {
            kernelRan: true, mode: "file", files: ["src/a.ts"],
            coverage: () => ({ backend: "typescript" as const }),
            dependents: { lookedUp: true, checked: 0, total: 0 },
        };
        const changed = buildValidationBanner({ ...base, programChanged: true });
        expect(changed).toContain("adds or removes files of the program");
        expect(changed).not.toContain(REDUNDANT);
        const healed = buildValidationBanner({ ...base, healedOthers: ["/p/src/util.ts"] });
        expect(healed).toContain("NREKI also auto-fixed util.ts: their importers were NOT checked");
        expect(healed).not.toContain(REDUNDANT);
    });
});

describe("F-07/F-08: context", () => {
    it("a named interface is shown, and the issue is still searched for the code that uses it", async () => {
        const { engine } = await indexed({
            "src/orders/item.ts": "export interface OrderItem {\n    price: number;\n    qty: number;\n}\n",
            "src/orders/discount.ts": "import type { OrderItem } from \"./item.js\";\n\n/** Discount applied to each line, rounded per line. */\nexport function discountedTotal(items: OrderItem[]): number {\n    return items.reduce((sum, item) => sum + Math.round(item.price * item.qty * 0.9), 0);\n}\n",
            "src/catalog/books.ts": "export function byAuthor(names: string[]): string[] {\n    return names.slice();\n}\n",
        });
        const text = textOf(await handleContext({ action: "context", query: "OrderItem discounts are rounded on each line instead of once on the order subtotal." }, { engine } as unknown as RouterDependencies));
        expect(text).toContain("export interface OrderItem {");
        expect(text).toContain("export function discountedTotal(items: OrderItem[]): number {");
    });

    it("a symbol cut to its first line does not count as read", async () => {
        const body = Array.from({ length: 120 }, (_, i) => `    x += ${i};`).join("\n");
        const { dir, engine } = await indexed({ "src/huge.ts": `export function hugeRoutine(x: number): number {\n${body}\n    return x;\n}\n` });
        const enforcer = new CognitiveEnforcer(dir);
        const text = textOf(await handleContext({ action: "context", query: "refactor hugeRoutine" }, { engine, enforcer } as unknown as RouterDependencies));
        expect(text).toContain("123 lines: compress focus:\"hugeRoutine\"");
        const blind = enforcer.evaluate("nreki_code", "edit", { path: "src/huge.ts", symbol: "hugeRoutine", mode: "replace" });
        expect(blind.blocked).toBe(true);
    });

    it("Spanish: \"No todas …\" is an issue, \"Nunca leas …\" an instruction; accents do not cut words", () => {
        expect(splitTaskIssues(
            "No todas las facturas aplican el descuento del cliente. " +
            "Las devoluciones ignoran los cupones del pedido anterior. " +
            "Nunca leas el verificador externo de evaluación.",
        )).toEqual([
            "No todas las facturas aplican el descuento del cliente.",
            "Las devoluciones ignoran los cupones del pedido anterior.",
        ]);
        const ids = extractTaskIdentifiers("La Configuración del cálculo de la estación");
        expect(ids.capitalized).toContain("Configuracion");
        expect([...ids.strong, ...ids.weak]).not.toContain("Configuraci");
        expect(ids.weak).toContain("calculo");
    });

    it("the short definitions are shared among the symbols shown, called functions first", async () => {
        // Measured pair of 2026-11-14: the cap went file by file, so the first two
        // symbols took it and the third's 3-line callee (the bug) was never shown.
        const helperFile = (prefix: string) => Array.from({ length: 6 }, (_, i) =>
            `export function ${prefix}${i}(x: number): number {\n    return x + ${i};\n}\n`).join("\n");
        const { engine } = await indexed({
            "src/a/help.ts": helperFile("alphaStep"),
            "src/a/alpha.ts": `import { ${Array.from({ length: 6 }, (_, i) => `alphaStep${i}`).join(", ")} } from "./help.js";\n\nexport function alphaRun(x: number): number {\n    return ${Array.from({ length: 6 }, (_, i) => `alphaStep${i}(x)`).join(" + ")};\n}\n`,
            "src/b/help.ts": helperFile("betaStep"),
            "src/b/beta.ts": `import { ${Array.from({ length: 6 }, (_, i) => `betaStep${i}`).join(", ")} } from "./help.js";\n\nexport function betaRun(x: number): number {\n    return ${Array.from({ length: 6 }, (_, i) => `betaStep${i}(x)`).join(" + ")};\n}\n`,
            "src/c/range.ts": "export function coveredWeight(weight: number, upper: number): number {\n    return Math.max(0, Math.min(weight, upper));\n}\n",
            "src/c/gamma.ts": "import { coveredWeight } from \"./range.js\";\n\nexport function gammaRun(w: number): number {\n    return coveredWeight(w, 10);\n}\n",
        });
        const text = textOf(await handleContext({ action: "context", query: "fix alphaRun, betaRun and gammaRun" }, { engine } as unknown as RouterDependencies));
        expect(text).toContain("export function gammaRun(w: number): number {");
        expect(text).toContain("export function coveredWeight(weight: number, upper: number): number {");
    });

    it("search folds accents: \"cálculo\" finds calculoTotal", async () => {
        const { engine } = await indexed({
            "src/tax.ts": "export function calculoTotal(base: number): number {\n    return base * 1.18;\n}\n",
            "src/names.ts": "export function fullName(first: string, last: string): string {\n    return `${first} ${last}`;\n}\n",
        });
        const hits = await engine.search("cálculo", 3);
        expect(hits.some(h => h.path.endsWith("tax.ts"))).toBe(true);
    });
});

describe("F-09: two classes with a method of the same name", () => {
    const FILE = [
        "export class InviteCodes {",
        "    redeem(code: string): boolean {",
        "        return code.length > 0;",
        "    }",
        "}",
        "",
        "export class RecoveryCodes {",
        "    redeem(code: string): boolean {",
        "        return code.startsWith(\"R\");",
        "    }",
        "}",
        "",
    ].join("\n");

    it("a batch that edits both keeps each signature check apart", async () => {
        const dir = project({ "src/codes.ts": FILE, "src/use.ts": "export const u = 1;\n" });
        const deps = mockDeps(dir, { "src/codes.ts": ["src/use.ts"] }, { nrekiMode: "syntax" });
        const res = await handleBatchEdit({ action: "batch_edit", edits: [
            { path: "src/codes.ts", symbol: "InviteCodes.redeem", mode: "patch", search_text: "code.length > 0", replace_text: "code.length > 3" },
            { path: "src/codes.ts", symbol: "RecoveryCodes.redeem", new_code: "redeem(code: string, userId: string): boolean {\n        return code.startsWith(\"R\") && userId.length > 0;\n    }" },
        ] }, deps);
        expect(res.isError).not.toBe(true);
        expect(textOf(res)).toContain("Signature changed: RecoveryCodes.redeem");
    });

    it("reading one class's method does not unlock a blind replace of the other's", () => {
        const padding = Array.from({ length: 110 }, (_, i) => `// line ${i} keeps the file over the small-file bypass`).join("\n");
        const dir = project({ "src/codes.ts": `${FILE}${padding}\n` });
        const enforcer = new CognitiveEnforcer(dir);
        enforcer.registerSuccess("nreki_code", "compress", { path: "src/codes.ts", focus: "RecoveryCodes.redeem" });
        expect(enforcer.evaluate("nreki_code", "edit", { path: "src/codes.ts", symbol: "InviteCodes.redeem", mode: "replace" }).blocked).toBe(true);
        expect(enforcer.evaluate("nreki_code", "edit", { path: "src/codes.ts", symbol: "RecoveryCodes.redeem", mode: "replace" }).blocked).toBe(false);
    });
});

describe("F-11: the circuit breaker keeps the error that tripped it", () => {
    it("the redirect comes after the compiler's message, with the batch's file and symbol", async () => {
        const cb = new CircuitBreaker();
        const failing = async (): Promise<McpToolResponse> => ({
            content: [{ type: "text" as const, text: "## Batch Edit: BLOCKED BY NREKI (Layer 2)\nsrc/a.ts (3,5): TS2322 - Type 'string' is not assignable to type 'number'." }],
            isError: true,
        });
        let res: McpToolResponse | undefined;
        for (let i = 0; i < 3; i++) res = await wrapWithCircuitBreaker(cb, "nreki_code", "batch_edit", failing, "src/a.ts", "total");
        const text = textOf(res!);
        expect(text).toContain("BREAK & BUILD");
        expect(text).toContain("TS2322 - Type 'string' is not assignable to type 'number'.");
        expect(text).not.toContain("the current file");
    });
});

describe("F-12: secrets in ordinary code are blanked before they leave for Voyage", () => {
    it("token shapes, key blocks and the literals of lines that name a secret", () => {
        const redact = (imports as unknown as { redactSecrets?: (t: string) => string }).redactSecrets;
        expect(redact).toBeTypeOf("function");
        // Token-shaped values are assembled at run time: written whole, they would
        // trip secret scanners (GitHub push protection) on this test file.
        const stripe = ["sk", "live", "51Habcdefghijklmnopqrstu"].join("_");
        const github = ["gh", "p_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
        const keyLabel = ["PRIVATE", "KEY"].join(" ");
        const src = [
            `const STRIPE_SECRET = "${stripe}";`,
            "const db = { password: 'hunter2-long' };",
            `// token in a comment: ${github}`,
            `const pem = \`-----BEGIN ${keyLabel}-----`,
            "MIIEvQIBADANBgkq",
            `-----END ${keyLabel}-----\`;`,
            "const greeting = \"hello world\";",
        ].join("\n");
        const out = redact!(src);
        for (const secret of [stripe.slice(0, 11), "hunter2-long", github.slice(0, 10), "MIIEvQIBADANBgkq"]) expect(out).not.toContain(secret);
        expect(out).toContain("const greeting = \"hello world\";");
    });

    // Measured pair of 2026-11-14 (D:/NrekiMeasurements/pair-voyage-20261114/audit):
    // the filter worked line by line, so a value on the next line or inside a
    // multi-line template survived into the text sent to Voyage.
    const VALUE = "DEMO_VALUE_0123456789_abcdefghijklmnopqrstuvwxyz";
    const leaks: Array<[string, string]> = [
        ["a property whose value is on the next line", `export const settings = {\n  apiKey:\n    "${VALUE}"\n};`],
        ["a multi-line template literal", `export const password = \`\n${VALUE}\n\`;`],
        ["a Go short declaration", `apiKey := "${VALUE}"`],
        ["a quoted JSON key", `{ "client_secret": "${VALUE}" }`],
        ["a concatenation", `const dbPassword = "${VALUE.slice(0, 20)}" +\n    "${VALUE.slice(20)}";`],
        ["an Authorization header literal", `fetch(url, { headers: { Authorization: "Bearer ${VALUE}" } });`],
    ];
    for (const [name, code] of leaks) {
        it(`blanks ${name}, also in the text VectorIndex embeds`, async () => {
            const { redactSecrets } = await import("../src/utils/imports.js");
            const { VectorIndex } = await import("../src/search/vector-index.js");
            for (const part of [VALUE, VALUE.slice(0, 20), VALUE.slice(20)]) expect(redactSecrets(code)).not.toContain(part);
            const index = new VectorIndex({} as never, { apiKey: "synthetic-placeholder", model: "voyage-code-4" }, "/offline-repro", { env: {} });
            const embedded = index.embedText({ id: 1, path: "/offline-repro/src/settings.ts", node_type: "variable", raw_code: code, symbol_name: "settings", context_comment: "" }) ?? "";
            expect(embedded).not.toContain(VALUE.slice(0, 20));
        });
    }

    it("leaves ordinary code alone", async () => {
        const { redactSecrets } = await import("../src/utils/imports.js");
        const code = "interface Login {\n    password: string;\n}\nconst greeting = \"hello\";\nconst maxTokens = 4000;\nconst label = `total: ${1 + 2}`;";
        expect(redactSecrets(code)).toBe(code);
    });
});

describe("F-13: turns NREKI itself cost", () => {
    it("Chronos does not block a patch on a high-friction file; a replace still needs the read", async () => {
        const dir = project({ "src/a.ts": "export function total(x: number): number {\n    return x + 1;\n}\n" });
        const chronos = { isHighFriction: () => true, hasReadUncompressed: () => false, recordTrip: vi.fn() };
        const deps = mockDeps(dir, {}, { nrekiMode: "syntax", chronos });
        const patch = await handleEdit({ action: "edit", path: "src/a.ts", symbol: "total", mode: "patch", search_text: "x + 1", replace_text: "x + 2" }, deps);
        expect(textOf(patch)).not.toContain("High Friction");
        const replace = await handleEdit({ action: "edit", path: "src/a.ts", symbol: "total", new_code: "export function total(x: number): number {\n    return x + 3;\n}" }, deps);
        expect(textOf(replace)).toContain("High Friction");
    });

    it("token estimates use o200k_base, the tokenizer of current models", () => {
        const sample = "La configuración de la estación meteorológica: déjà vu — 🌡️ 25 °C; función cálculoTotal().";
        const o200k = get_encoding("o200k_base");
        const cl100k = get_encoding("cl100k_base");
        expect(o200k.encode(sample).length).not.toBe(cl100k.encode(sample).length);
        expect(estimateTokens(sample)).toBe(o200k.encode(sample).length);
        o200k.free();
        cl100k.free();
    });
});

describe("F-14: definition", () => {
    it("a name defined in many places: three bodies, the rest as locations", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 5; i++) files[`src/mod${i}/view.ts`] = `export function render(x: number): number {\n    return x + ${i};\n}\n`;
        const { engine } = await indexed(files);
        const text = textOf(await handleDefinition({ action: "definition", symbol: "render" }, { engine } as unknown as RouterDependencies));
        expect(text).toContain("Found 5 definition(s).");
        expect(text.match(/^### \d+\. /gm)?.length).toBe(3);
        expect(text).toContain("Also defined at: ");
    });
});
