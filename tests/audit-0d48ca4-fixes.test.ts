/**
 * Regressions for the external audit of 12.1.1 at 0d48ca4. Each finding was
 * first reproduced with the auditor's own scripts, and each test here failed
 * on 0d48ca4:
 *   1. a typed or commented initializer kept a generic secret in the text sent to Voyage;
 *   2. NREKI's own files (.nreki/…) were written through a `.nreki` link leaving the project;
 *   3. `context` showed a homonym from another module as "what that code imports";
 *   4. "exported API unchanged" hid a known importer compiled by another tsconfig;
 *   5. the error baseline confused sibling anonymous callbacks.
 * On Windows without symlink rights a directory junction stands in for the link.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { redactSecrets } from "../src/utils/imports.js";
import { VectorIndex } from "../src/search/vector-index.js";
import { NrekiEngine } from "../src/engine.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { ChronosMemory } from "../src/chronos-memory.js";
import { getOrGenerateRepoMap } from "../src/repo-map.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { saveBackup } from "../src/undo.js";
import { addPin } from "../src/pin-memory.js";
import { quarantineFile } from "../src/utils/trust.js";
import { handleContext } from "../src/handlers/context-pack.js";
import { handleEdit } from "../src/handlers/code/edit.js";
import { buildValidationBanner } from "../src/handlers/code/validation-banner.js";
import { goPackageHolds, pythonModuleHolds } from "../src/utils/import-origin.js";
import type { RouterDependencies } from "../src/router.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

let parser: ASTParser;
let sandbox: AstSandbox;
beforeAll(async () => {
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
    return dir;
}

function write(dir: string, files: Record<string, string>): string {
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

const project = (files: Record<string, string>): string => write(tmp("nreki-audit-0d48-"), files);

const TSCONFIG = (extra: Record<string, unknown> = {}, include = ["src/**/*.ts"]) => JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", skipLibCheck: true, ...extra },
    include,
});

const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? "").join("\n");
const REDUNDANT = "Re-running tsc is redundant";

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

async function indexed(files: Record<string, string>): Promise<{ dir: string; engine: NrekiEngine }> {
    const dir = project(files);
    const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
    cleanups.push(() => engine.shutdown());
    await engine.initialize();
    await engine.indexDirectory(dir);
    return { dir, engine };
}

describe("1: the whole value of a secret name is blanked before it leaves for Voyage", () => {
    const VALUE = "DEMO_VALUE_0123456789_abcdefghijklmnopqrstuvwxyz";
    const [HEAD, TAIL] = [VALUE.slice(0, 20), VALUE.slice(20)];
    const leaks: Array<[string, string]> = [
        // The four the auditor found (valid TypeScript, zero diagnostics).
        ["a typed declaration with the value on the next line", `export const apiKey: string =\n  "${VALUE}";`],
        ["a line comment after the =", `export const apiKey = // deployment configuration\n  "${VALUE}";`],
        ["a block comment before the value", `export const apiKey =\n  /* deployment configuration */\n  "${VALUE}";`],
        ["a comment after the + of a concatenation", `export const apiKey = "${HEAD}" + // suffix\n  "${TAIL}";`],
        // The same gap, other shapes.
        ["an optional class field", `class C {\n  apiKey?: string =\n    "${VALUE}";\n}`],
        ["a Go typed var", `var apiKey string =\n\t"${VALUE}"`],
        ["Python implicit concatenation in parentheses", `API_KEY: str = (  # prod\n    "${HEAD}"\n    "${TAIL}"\n)`],
        ["a multi-line ternary", `const apiKey = prod\n  ? "${VALUE}"\n  : "x";`],
        ["a fallback on the next line", `const secret = process.env.SECRET ??\n  "${VALUE}";`],
        ["a PHP array entry", `$config = [\n  'api_key' =>\n     '${VALUE}',\n];`],
        ["a header set by key", `headers["x-api-key"] =\n  "${VALUE}";`],
        ["a Python triple-quoted string", `PASSWORD = """\n${VALUE}\n"""`],
    ];
    for (const [name, code] of leaks) {
        it(`blanks ${name}, also in the text VectorIndex embeds`, () => {
            for (const part of [HEAD, TAIL]) expect(redactSecrets(code)).not.toContain(part);
            const index = new VectorIndex({} as never, { apiKey: "synthetic-placeholder", model: "voyage-code-4" }, "/offline-repro", { env: {} });
            const embedded = index.embedText({ id: 1, path: "/offline-repro/src/settings.ts", node_type: "variable", raw_code: code, symbol_name: "apiKey", context_comment: "" }) ?? "";
            expect(embedded).not.toContain(HEAD);
            expect(embedded).not.toContain(TAIL);
        });
    }

    it("stops at the end of the value: the next statement, a type member, a parameter list", () => {
        for (const code of [
            "const apiKey = \"x\"\nconst region = \"eu-west\";",
            "interface Opts {\n  apiKey: string\n  region: \"eu-west\" | \"us\"\n}",
            "export const tokens = tokenize(\"VAT on shipping and handling\");",
            "const settings = {\n  apiKey: readKey(),\n  region: \"eu-west\",\n};",
        ]) {
            const out = redactSecrets(code);
            expect(out).toMatch(/eu-west|VAT on shipping/);
        }
    });
});

/** `.nreki` inside the project is a link to a folder outside it. */
function linkedNreki(ctx: { skip: (note?: string) => void }): { root: string; outside: string } {
    const root = tmp("nreki-link-project-");
    const outside = tmp("nreki-link-outside-");
    try {
        fs.symlinkSync(outside, path.join(root, ".nreki"), process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") ctx.skip("environment blocks directory junctions");
        throw err;
    }
    return { root, outside };
}

describe("2: NREKI's own files are never written through a `.nreki` link", () => {
    it("the repo map cache and the Chronos history: not written outside, the map still served", async (ctx) => {
        const { root, outside } = linkedNreki(ctx);
        write(root, { "src/math.ts": "export function addAmounts(a: number, b: number): number {\n    return a + b;\n}\n" });
        write(outside, { "repo-map.json": "SENTINEL", "chronos-history.json": "SENTINEL" });

        const { text } = await getOrGenerateRepoMap(root, parser, true);
        expect(text).toContain("src/ [1 peripheral files]");
        const chronos = new ChronosMemory(root);
        chronos.forcePersist(); // logs, never throws (it runs from a timer)

        expect(fs.readFileSync(path.join(outside, "repo-map.json"), "utf8")).toBe("SENTINEL");
        expect(fs.readFileSync(path.join(outside, "chronos-history.json"), "utf8")).toBe("SENTINEL");
    });

    it("pins and undo backups refuse with the reason; quarantine moves nothing", (ctx) => {
        const { root, outside } = linkedNreki(ctx);
        write(root, { "src/a.ts": "export const a = 1;\n" });
        expect(() => addPin(root, "Always run the tests", "user")).toThrow(/symbolic link/);
        expect(() => saveBackup(root, "src/a.ts")).toThrow(/symbolic link/);
        write(outside, { "pins.json": "{}" });
        expect(quarantineFile(path.join(root, ".nreki", "pins.json"))).toBeNull();
        expect(fs.readdirSync(outside).sort()).toEqual(["pins.json"]);
    });

    it("the kernel neither deletes the linked transactions folder at boot nor commits through it", async (ctx) => {
        const { root, outside } = linkedNreki(ctx);
        write(root, { "tsconfig.json": TSCONFIG(), "src/a.ts": "export const a: number = 1;\n" });
        // A folder of the same name the link points at: WAL recovery deleted it recursively.
        write(outside, { "transactions/keep.txt": "user data" });

        const kernel = new NrekiKernel();
        kernel.boot(root, "file");
        expect(fs.readFileSync(path.join(outside, "transactions", "keep.txt"), "utf8")).toBe("user data");

        const r = await kernel.interceptAtomicBatch([{ targetFile: path.join(root, "src/a.ts"), proposedContent: "export const a: number = 2;\n" }]);
        expect(r.safe).toBe(true);
        await expect(kernel.commitToDisk()).rejects.toThrow(/symbolic link/);
        expect(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).toBe("export const a: number = 1;\n");
        expect(fs.readdirSync(path.join(outside, "transactions"))).toEqual(["keep.txt"]);
    });

    it("the installed hook (v4) writes its state through no link either", () => {
        const hook = fs.readFileSync(new URL("../templates/hooks/nreki-enforcer.mjs", import.meta.url), "utf8");
        expect(hook).toContain("nreki-enforcer:v6");
        expect(hook).toMatch(/lstatSync\(path\.dirname\(STATE_FILE\)\)\.isDirectory\(\)/);
        expect(hook).toContain("{ flag: \"wx\" }");
    });
});

describe("3: an imported helper is shown only from the file that declares it", () => {
    const MAIN = (from: string) =>
        `import { calculateFee } from "${from}";\nexport function checkout(total: number): number {\n  return calculateFee(total);\n}\n`;
    const UNRELATED = "export function calculateFee(total: number): number {\n  return total * 999;\n}\n";
    const ask = async (engine: NrekiEngine) => textOf(await handleContext(
        { action: "context", query: "Fix `checkout`.", token_budget: 2000 },
        { engine } as unknown as RouterDependencies,
    ));

    it("through a barrel that re-exports an alias: the real function, not the homonym", async () => {
        const { engine } = await indexed({
            "package.json": "{\"type\":\"module\"}",
            "src/main.ts": MAIN("./public.js"),
            "src/public.ts": "export { realFee as calculateFee } from \"./real.js\";\n",
            "src/real.ts": "export function realFee(total: number): number {\n  return total + 3;\n}\n",
            "src/unrelated.ts": UNRELATED,
        });
        const text = await ask(engine);
        expect(text).not.toContain("total * 999");
        expect(text).toContain("// src/real.ts:L1-L3 (imported as calculateFee)");
        expect(text).toContain("return total + 3;");
    });

    it("from a package: no helper rather than a project function of the same name", async () => {
        const { engine } = await indexed({
            "package.json": "{\"type\":\"module\"}",
            "src/main.ts": MAIN("@vendor/billing"),
            "src/unrelated.ts": UNRELATED,
            "node_modules/@vendor/billing/package.json": "{\"name\":\"@vendor/billing\",\"type\":\"module\",\"exports\":\"./index.js\"}",
            "node_modules/@vendor/billing/index.d.ts": "export declare function calculateFee(total: number): number;\n",
        });
        const text = await ask(engine);
        expect(text).not.toContain("total * 999");
        expect(text).not.toContain("what that code imports");
    });

    it("a tsconfig path alias is resolved; the direct import still works", async () => {
        const { engine } = await indexed({
            "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] }, moduleResolution: "Bundler", module: "ESNext" } }),
            "src/main.ts": MAIN("@/lib/fees"),
            "src/lib/fees.ts": "export function calculateFee(total: number): number {\n  return total + 3;\n}\n",
            "src/other/fees.ts": UNRELATED,
        });
        const text = await ask(engine);
        expect(text).toContain("// src/lib/fees.ts:L1-L3");
        expect(text).not.toContain("total * 999");
    });

    it("Python and Go: the module's file or package, under its import path", () => {
        // from app.billing import fee / from .billing import fee / from billing import fee (a pip package)
        expect(pythonModuleHolds("app.billing", "app/main.py", "app/billing.py")).toBe(true);
        expect(pythonModuleHolds("app.billing", "app/main.py", "app/billing/__init__.py")).toBe(true);
        expect(pythonModuleHolds("app.billing", "app/main.py", "app/billing/core.py")).toBe(true);
        expect(pythonModuleHolds(".billing", "app/main.py", "app/billing.py")).toBe(true);
        expect(pythonModuleHolds("..shared", "app/web/main.py", "app/shared.py")).toBe(true);
        expect(pythonModuleHolds("billing", "app/main.py", "app/unrelated.py")).toBe(false);
        expect(pythonModuleHolds(".billing", "app/main.py", "other/billing.py")).toBe(false);

        const root = project({ "go.mod": "module example.com/demo\n\ngo 1.22\n" });
        expect(goPackageHolds(root, "example.com/demo/util", "util/u.go")).toBe(true);
        expect(goPackageHolds(root, "example.com/demo", "main.go")).toBe(true);
        expect(goPackageHolds(root, "example.com/demo/util", "internal/util/u.go")).toBe(false);
        expect(goPackageHolds(root, "github.com/other/util", "util/u.go")).toBe(false);
    });
});

describe("4: a known importer under another tsconfig is never hidden", () => {
    it("file mode: the .d.ts is the same under strict:false, the strict tests still break", async () => {
        const dir = project({
            "tsconfig.json": TSCONFIG({ strict: false }),
            "tsconfig.tests.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { strict: true }, include: ["src/**/*.ts", "tests/**/*.ts"] }),
            "src/service.ts": "export function lookup(enabled: boolean) {\n    return \"ready\";\n}\n",
            "tests/consumer.ts": "import { lookup } from \"../src/service\";\nexport const result: string = lookup(false);\n",
        });
        const kernel = new NrekiKernel();
        kernel.boot(dir, "file");
        const res = await handleEdit({
            action: "edit", path: "src/service.ts", symbol: "lookup",
            new_code: "export function lookup(enabled: boolean) {\n    return enabled ? \"ready\" : undefined;\n}",
        }, mockDeps(dir, { "src/service.ts": ["tests/consumer.ts"] }, { kernel, nrekiMode: "file" }));
        const text = textOf(res);
        expect(res.isError).not.toBe(true);
        expect(text).toContain("exported API unchanged under this tsconfig's options");
        expect(text).toContain("1 importer(s) outside the tsconfig program (another tsconfig, plain JS) NOT checked");
        expect(text).not.toContain("no other file affected");
        expect(text).not.toContain(REDUNDANT);
    });

    it("project mode reports them too; with none, the footer is complete as before", async () => {
        const files = {
            "tsconfig.json": TSCONFIG(),
            "src/service.ts": "export function lookup(enabled: boolean): string {\n    return \"ready\";\n}\n",
            "tests/consumer.ts": "import { lookup } from \"../src/service\";\nexport const result: string = lookup(false);\n",
        };
        const edit = {
            action: "edit" as const, path: "src/service.ts", symbol: "lookup",
            new_code: "export function lookup(enabled: boolean): string {\n    return enabled ? \"ready\" : \"waiting\";\n}",
        };
        const cases: Array<[Record<string, string[]>, string]> = [
            [{ "src/service.ts": ["tests/consumer.ts"] }, "1 importer(s) outside the tsconfig program"],
            [{}, REDUNDANT],
        ];
        for (const [graph, expected] of cases) {
            const dir = project(files);
            const kernel = new NrekiKernel();
            kernel.boot(dir, "project");
            const text = textOf(await handleEdit(edit, mockDeps(dir, graph, { kernel, nrekiMode: "project" })));
            expect(text).toContain(expected);
            if (expected !== REDUNDANT) expect(text).not.toContain(REDUNDANT);
        }
    });

    it("the banner: same .d.ts plus importers outside the program is not complete", () => {
        const banner = buildValidationBanner({
            kernelRan: true, mode: "file", files: ["src/a.ts"],
            coverage: () => ({ backend: "typescript" as const }),
            dependents: { lookedUp: true, checked: 0, total: 0, notInProgram: 2 },
            exportedApiUnchanged: true,
        });
        expect(banner).toContain("2 importer(s) outside the tsconfig program");
        expect(banner).not.toContain(REDUNDANT);
    });
});

describe("5: sibling anonymous callbacks keep their own errors", () => {
    const HANDLERS = (first: string, second: string, local2 = "count") =>
        `export const handlers = [\n  () => {\n    const count: number = ${first};\n    return count;\n  },\n  () => {\n    const ${local2}: number = ${second};\n    return ${local2};\n  },\n];\n`;
    const intercept = async (mode: "project" | "file", before: string, after: string) => {
        const dir = project({ "tsconfig.json": TSCONFIG(), "src/handlers.ts": before });
        const kernel = new NrekiKernel();
        kernel.boot(dir, mode);
        return kernel.interceptAtomicBatch([{ targetFile: path.join(dir, "src/handlers.ts"), proposedContent: after }], []);
    };

    for (const mode of ["project", "file"] as const) {
        it(`${mode} mode: fixing the first callback's error and adding it to the second is a new error`, async () => {
            const r = await intercept(mode, HANDLERS("\"old-error\"", "0"), HANDLERS("0", "\"new-error\""));
            expect(r.safe).toBe(false);
            expect(r.errorText).toContain("TS2322");
        });
    }

    it("the old error alone stays tolerated, also when a callback is inserted before its own", async () => {
        const before = HANDLERS("\"old-error\"", "0");
        expect((await intercept("project", before, HANDLERS("\"old-error\"", "2"))).safe).toBe(true);
        // The broken callback moves from [0] to [1]; its source is unchanged.
        const inserted = before.replace("export const handlers = [\n", "export const handlers = [\n  () => 1,\n");
        expect((await intercept("project", before, inserted)).safe).toBe(true);
    });

    it("test callbacks are told apart by their names; copying a broken one is a new error", async () => {
        const suite = (a: string, b: string) =>
            `declare function it(name: string, fn: () => void): void;\n` +
            `it("adds", () => {\n    const n: number = ${a};\n});\n` +
            `it("subtracts", () => {\n    const n: number = ${b};\n});\n`;
        expect((await intercept("project", suite("\"x\"", "1"), suite("1", "\"x\""))).safe).toBe(false);
        const copied = suite("\"x\"", "1") + `it("adds", () => {\n    const n: number = "x";\n});\n`;
        expect((await intercept("project", suite("\"x\"", "1"), copied)).safe).toBe(false);
    });
});
