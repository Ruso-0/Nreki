/**
 * Token economy. In the 2026-11-13 Codex A/B (same model, same 3 tasks,
 * 18/18 checks passed by both arms) NREKI used 24.86 % MORE tokens: its tool
 * schemas, a `map depth:"full"` of 2.1k tokens, ~150 tokens of banners around
 * every 3-line `compress` body, and one more turn of exploration, all re-sent
 * on every later request. These tests pin what was cut and the `context`
 * action that replaces the exploration turns. Token counts use o200k_base.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NrekiEngine } from "../src/engine.js";
import { ASTParser } from "../src/parser.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { handleContext, extractTaskIdentifiers, splitTaskIssues, CONTEXT_EDIT_HINT } from "../src/handlers/context-pack.js";
import { handlePrepareRefactor } from "../src/handlers/navigate.js";
import { handleCompress, handleRead } from "../src/handlers/code/read.js";
import { generateRepoMap, repoMapToText } from "../src/repo-map.js";
import type { RouterDependencies } from "../src/router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { get_encoding } = require("tiktoken") as typeof import("tiktoken");
const enc = get_encoding("o200k_base");
const tok = (s: string): number => enc.encode(s).length;
const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? "").join("\n");

function write(dir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
}

const helpers = (prefix: string, n: number, body: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => `export function ${prefix}${String(i).padStart(2, "0")}(value: number): number {\n${body(i)}\n}\n`).join("\n");

/** The three tasks of the Codex A/B, rebuilt: each target hidden among unrelated helpers. */
function benchmarkProject(dir: string): void {
    write(dir, {
        "package.json": "{\"type\":\"module\"}\n",
        "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ["**/src/**/*.ts"] }),
        "small-local/src/math.ts": helpers("scale", 2, i => `    const shifted = value + ${i};\n    return Math.max(0, shifted) % ${i + 3};`) +
            "\n/** Bound value inclusively at minimum and maximum. */\nexport function clamp(value: number, minimum: number, maximum: number): number {\n    return Math.min(Math.max(value, minimum), maximum - 1);\n}\n",
        "small-local/verify.mjs": "import { clamp } from './src/math.ts';\nif (clamp(10, 0, 10) !== 10) throw new Error('clamp');\n",
        "large-local/src/pricing.ts": helpers("price", 40, i => `    const base = value * ${i + 1};\n    const fee = base / 100;\n    return Math.round(base + fee);`) +
            "\nexport function applyDiscount(subtotalCents: number, discountPercent: number): number {\n    return Math.round(subtotalCents * (1 - discountPercent / 100));\n}\n",
        "large-local/verify.mjs": "import { applyDiscount } from './src/pricing.ts';\nif (applyDiscount(1000, -10) !== 1000) throw new Error('discount');\n",
        "cross-file-contract/src/models.ts": helpers("modelValue", 24, i => `    const shifted = value + ${i};\n    return shifted * 2;`) +
            "\ninterface Invoice {\n    amountCents: number;\n    currency: string;\n}\n\nexport type { Invoice };\n",
        "cross-file-contract/src/consumer.ts": "import type { Invoice } from './models.js';\n\n" + helpers("consumerValue", 24, i => `    const scaled = value * ${i};\n    return scaled + 1;`) +
            "\nexport function invoiceTotal(invoice: Invoice): number {\n    return invoice.amountCents;\n}\n",
        "cross-file-contract/verify.mjs": "import { invoiceTotal } from './src/consumer.ts';\nif (invoiceTotal({ totalCents: 5, currency: 'EUR' }) !== 5) throw new Error('total');\n",
    });
}

const TASK = [
    "Resuelve estas tres tareas de TypeScript en el workspace generado indicado abajo.",
    "1. small-local: corrige clamp para que minimum y maximum sean ambos inclusivos y conserva firma y demás comportamiento.",
    "2. large-local: corrige applyDiscount para tratar descuentos menores que cero como cero y mayores que 100 como 100; conserva el redondeo a centavos enteros y su firma.",
    "3. cross-file-contract: migra Invoice de amountCents a totalCents y actualiza invoiceTotal para consumir totalCents; conserva currency y helpers ajenos.",
    "Antes de editar ejecuta la verificación independiente; después vuelve a ejecutarla y corrige hasta que compile TypeScript y pasen los 18 casos.",
].join("\n");

// ─── Fixed cost: tool definitions and instruction files ─────────────

describe("fixed cost paid on every request", () => {
    it("the three tool definitions a native MCP client receives stay under 800 tokens", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-schema-"));
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(repoRoot, "src", "index.ts")],
            cwd: dir,
            stderr: "pipe",
        });
        const client = new Client({ name: "schema-size", version: "0.0.0" });
        try {
            await client.connect(transport);
            const { tools } = await client.listTools();
            const defs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
            expect(defs.map(d => d.name).sort()).toEqual(["nreki_code", "nreki_guard", "nreki_navigate"]);
            const total = tok(JSON.stringify(defs));
            expect(total).toBeLessThan(800); // 2,080 before; advanced options are accepted undeclared
            // Undeclared advanced options still reach the handlers (passthrough).
            const map = await client.callTool({ name: "nreki_navigate", arguments: { action: "map", depth: "full" } });
            expect(JSON.stringify(map.content)).toContain("TOPOLOGY METADATA");
            for (const d of defs) expect(tok(d.description ?? "")).toBeLessThan(160);
            // Every action is still reachable.
            const navActions = JSON.stringify(defs.find(d => d.name === "nreki_navigate"));
            for (const a of ["context", "fast_grep", "search", "definition", "references", "outline", "map", "type_shape", "prepare_refactor", "type_graph", "orphan_oracle"]) {
                expect(navActions).toContain(`"${a}"`);
            }
        } finally {
            await client.close().catch(() => {});
            // Windows: the server may still hold its DB/watch handles for a moment.
            try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* temp dir */ }
        }
    }, 120_000);

    it("instruction templates are short and keep the rules that change an agent's behaviour", () => {
        const read = (f: string) => fs.readFileSync(path.join(repoRoot, "templates", f), "utf8");
        const limits: Record<string, number> = { "AGENTS.md": 550, "CLAUDE.md": 550, "SKILL.md": 800 }; // were 556 / 813 / 1,415
        for (const [file, limit] of Object.entries(limits)) {
            const text = read(file);
            expect(tok(text), file).toBeLessThan(limit);
            for (const rule of ['action:"context"', "batch_edit", 'mode:"patch"', "80 lines", "[Validated", "redundant", "any"]) {
                expect(text, `${file} lost "${rule}"`).toContain(rule);
            }
        }
        expect(read("AGENTS.md")).toContain("NREKI MCP instructions"); // init's upgrade marker
        expect(read("CLAUDE.md")).toContain("# NREKI ACTIVE");
        expect(read("SKILL.md")).toContain("name: nreki-optimizer");
    });
});

// ─── Per-call results ───────────────────────────────────────────────

describe("results carry no decoration", () => {
    let dir: string;
    let engine: NrekiEngine;
    let deps: RouterDependencies;
    let enforcer: CognitiveEnforcer;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-economy-"));
        benchmarkProject(dir);
        engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        await engine.initialize();
        await engine.indexDirectory(dir);
        enforcer = new CognitiveEnforcer(dir);
        deps = { engine, enforcer } as unknown as RouterDependencies;
    });
    afterAll(() => {
        engine.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("compress focus: one header line, the body, its line range and importers; no banners", async () => {
        const r = await handleCompress({ action: "compress", path: path.join(dir, "large-local/src/pricing.ts"), focus: "applyDiscount" }, deps);
        const text = textOf(r);
        expect(r.isError).not.toBe(true);
        expect(text.split("\n")[0]).toMatch(/^pricing\.ts \[applyDiscount\] — \d+ unrelated lines omitted$/);
        expect(text).toContain("export function applyDiscount(subtotalCents: number, discountPercent: number): number {");
        expect(text).toMatch(/\/\* L\d+-L\d+ \*\//);
        expect(text).toContain("// imported by 1 file(s): large-local/verify.mjs");
        for (const banner of ["TFC-Pro", "TOPOLOGICAL LAYOUT", "TFC METADATA", "FOVEA", "Orthogonal logic", "reduction"]) {
            expect(text).not.toContain(banner);
        }
        expect(tok(text)).toBeLessThan(110); // was 234
    });

    it("compress focus shows a short type of another file whole, not as an empty `{ }`", async () => {
        const text = textOf(await handleCompress({ action: "compress", path: path.join(dir, "cross-file-contract/src/consumer.ts"), focus: "invoiceTotal" }, deps));
        expect(text).toContain("interface Invoice {\n    amountCents: number;\n    currency: string;\n}");
        expect(text).not.toContain("interface Invoice { }");
    });

    it("read with focus returns only those symbols (focus used to be ignored: whole files came back)", async () => {
        const r = await handleRead({ action: "read", path: path.join(dir, "large-local/src/pricing.ts"), focus: "applyDiscount" }, deps);
        const text = textOf(r);
        expect(r.isError).not.toBe(true);
        expect(text).toContain("export function applyDiscount(");
        expect(text).not.toContain("price05");
        expect(tok(text)).toBeLessThan(110);
        // And it counts as having read that symbol (no blind-edit block afterwards).
        fs.rmSync(path.join(dir, ".nreki", "enforcer-state.json"), { force: true });
        const fresh = new CognitiveEnforcer(dir);
        fresh.registerSuccess("nreki_code", "read", { path: path.join(dir, "large-local/src/pricing.ts"), focus: "applyDiscount" });
        expect(fresh.evaluate("nreki_code", "batch_edit", { edits: [{ path: "large-local/src/pricing.ts", symbol: "applyDiscount" }] }).blocked).toBe(false);
    });

    it("compress focus on a 17-line file returns the symbol, not the 17 lines", async () => {
        const text = textOf(await handleCompress({ action: "compress", path: path.join(dir, "small-local/src/math.ts"), focus: "clamp" }, deps));
        expect(text).toContain("export function clamp(value: number, minimum: number, maximum: number): number {");
        expect(text).not.toContain("scale00");
        expect(tok(text)).toBeLessThan(80); // the whole file was 133
    });

    it("a focus that is most of the file returns the file, not an error asking for another call", async () => {
        const file = path.join(dir, "big-one.ts");
        fs.writeFileSync(file, "export function onlyOne(x: number): number {\n" +
            Array.from({ length: 110 }, (_, i) => `    x = x + ${i}; // step ${i} of the computation`).join("\n") + "\n    return x;\n}\n");
        const r = await handleCompress({ action: "compress", path: file, focus: "onlyOne" }, deps);
        expect(r.isError).not.toBe(true);
        expect(textOf(r)).toContain("(whole file, 114L: \"onlyOne\" is most of it)");
        expect(textOf(r)).toContain("step 109 of the computation");
    });

    it("an unknown focus lists the file's symbols so the retry needs no outline", async () => {
        const r = await handleCompress({ action: "compress", path: path.join(dir, "large-local/src/pricing.ts"), focus: "applyDiscont" }, deps);
        expect(r.isError).toBe(true);
        // 41 symbols, list capped at 40: the near miss comes first, not last.
        expect(textOf(r)).toContain('Symbol "applyDiscont" not found in pricing.ts. Symbols: applyDiscount, price00, price01');
    });

    it("prepare_refactor prints project-relative paths", async () => {
        const text = textOf(await handlePrepareRefactor({ action: "prepare_refactor", symbol: "amountCents" }, deps));
        expect(text).toContain("cross-file-contract/src/models.ts:L");
        expect(text).not.toContain(dir);
        expect(text).not.toContain("\\");
    });

    it("map depth:full: no fake signatures for JSON, no export listed twice, and a cap that keeps the names", async () => {
        const parser = new ASTParser();
        await parser.initialize();
        const text = repoMapToText(await generateRepoMap(dir, parser), "full", 0);
        expect(text).not.toContain('class: "type":"module"');
        expect(text).not.toContain('class: "compilerOptions"');
        // consumer.ts: 24 helpers + invoiceTotal; the cut must still name invoiceTotal.
        const consumer = text.slice(text.indexOf("consumer.ts"), text.indexOf("models.ts"));
        expect(consumer).toContain("… +10 more: consumerValue15");
        expect(consumer).toContain("invoiceTotal");
        expect(consumer).not.toContain("exports: consumerValue00");
        // Still the documented "full" contract: topology metrics.
        expect(text).toContain("v2:");
        expect(text).toContain("TOPOLOGY METADATA");
    });

    // ─── context ────────────────────────────────────────────────────

    it("context: the task text alone yields the four symbols to edit, nothing unrelated, in < 450 tokens", async () => {
        const r = await handleContext({ action: "context", query: TASK }, deps);
        const text = textOf(r);
        expect(r.isError).not.toBe(true);
        for (const body of [
            "export function clamp(value: number, minimum: number, maximum: number): number {",
            "export function applyDiscount(subtotalCents: number, discountPercent: number): number {",
            "interface Invoice {\n    amountCents: number;",
            "export function invoiceTotal(invoice: Invoice): number {",
        ]) expect(text).toContain(body);
        for (const unrelated of ["scale00", "price05", "modelValue03", "consumerValue07"]) expect(text).not.toContain(unrelated);
        expect(text).toMatch(/\/\/ small-local\/src\/math\.ts:L\d+-L\d+ — imported by small-local\/verify\.mjs/);
        expect(text).toMatch(/amountCents at: cross-file-contract\/src\/(consumer|models)\.ts:L\d+/);
        expect(text).toContain("totalCents at: cross-file-contract/verify.mjs:L2");
        // It says the bodies are complete: in the A/B agents re-read them (one more turn).
        expect(text.split("\n")[0]).toBe("context: 4 symbol(s) the task names — current and complete code; no further read is needed");
        // In the 2026-11-13 holdout every NREKI agent sent batch_edit alone and ran the
        // checker on the next turn; with apply_patch the same agents chained both.
        expect(text.split("\n").at(-1)).toBe(CONTEXT_EDIT_HINT);
        expect(CONTEXT_EDIT_HINT).toContain("in the same cell");
        expect(tok(CONTEXT_EDIT_HINT)).toBeLessThan(40);
        expect(tok(text)).toBeLessThan(510); // 480 before the 33-token hint
    });

    it("context: what it showed counts as read, so editing it is not a blind edit", async () => {
        // Earlier calls in this file persisted their passports: start from none.
        fs.rmSync(path.join(dir, ".nreki", "enforcer-state.json"), { force: true });
        const fresh = new CognitiveEnforcer(dir);
        const batch = { edits: [{ path: "large-local/src/pricing.ts", symbol: "applyDiscount" }] };
        expect(fresh.evaluate("nreki_code", "batch_edit", batch).blocked).toBe(true); // 240-line file, never read
        await handleContext({ action: "context", query: "fix applyDiscount" }, { ...deps, enforcer: fresh } as RouterDependencies);
        expect(fresh.evaluate("nreki_code", "batch_edit", batch).blocked).toBe(false);
    });

    it("context: a name defined in several places goes to the one the task's path points at", async () => {
        write(dir, {
            "a/run-tools.ts": "export function render(x: number): number {\n    return x;\n}\n",
            "b/run-tools.ts": "export function render(x: number): number {\n    return x + 1;\n}\n",
            "parser/run-tools.ts": "export function render(x: number): number {\n    return x + 2;\n}\n",
        });
        await engine.indexDirectory(dir);
        const pointed = textOf(await handleContext({ action: "context", query: "in parser/run-tools.ts make `render` stop early" }, deps));
        expect(pointed).toContain("// parser/run-tools.ts:L1-L3");
        expect(pointed).not.toContain("// a/run-tools.ts");
        // A plain word defined in 3 places, with no path, is a word: not pulled in.
        // The field the task does name leads to the code that uses it.
        const vague = textOf(await handleContext({ action: "context", query: "the render step is slow when discountPercent is large" }, deps));
        expect(vague).not.toContain("run-tools.ts");
        expect(vague).toContain("code holding the names it mentions");
        expect(vague).toContain("export function applyDiscount(subtotalCents: number, discountPercent: number): number {");
        expect(vague).toMatch(/discountPercent at: large-local\/src\/pricing\.ts:L\d+/);
    });

    it("context: a long symbol is a pointer, and the budget turns the rest into one line", async () => {
        write(dir, {
            "long/huge.ts": "export function hugeRoutine(x: number): number {\n" +
                Array.from({ length: 120 }, (_, i) => `    x += ${i};`).join("\n") + "\n    return x;\n}\n",
        });
        await engine.indexDirectory(dir);
        const long = textOf(await handleContext({ action: "context", query: "refactor hugeRoutine" }, deps));
        expect(long).toContain("export function hugeRoutine(x: number): number {\n// … 123 lines: compress focus:\"hugeRoutine\"");
        expect(long).not.toContain("x += 60;");

        const many = "touch clamp, applyDiscount, invoiceTotal, Invoice, price01, price02, price03, price04, price05, price06, price07, price08";
        const tight = textOf(await handleContext({ action: "context", query: many, token_budget: 300 }, deps));
        expect(tight).toContain("over budget, not shown:");
        expect(tok(tight)).toBeLessThan(500);
        const roomy = textOf(await handleContext({ action: "context", query: many }, deps));
        expect(roomy).not.toContain("over budget");
    });

    it("context: a plain word that is also a method name does not win over search", async () => {
        write(dir, { "util/store.ts": "export class Store {\n    missing(): string[] {\n        return [];\n    }\n}\n" });
        await engine.indexDirectory(dir);
        // "missing" is a plain word here; before, the Store.missing method was the whole answer.
        const text = textOf(await handleContext({ action: "context", query: "when a discount is missing or below zero the subtotal must stay unchanged" }, deps));
        expect(text.split("\n")[0]).toContain("best search hits");
        expect(text).toContain("export function applyDiscount(");
    });

    it("context: a task that names no symbol falls back to concept search", async () => {
        const text = textOf(await handleContext({ action: "context", query: "rounding of discounted cents" }, deps));
        expect(text).toContain("best search hits");
        expect(text).toContain("```");
    });

    it("a task with one issue is not split; one with several is, without its instruction-only parts", () => {
        expect(splitTaskIssues("rounding of discounted cents")).toEqual([]);
        expect(splitTaskIssues(
            "Fix three issues in src: late fees charge weekend days although the library is closed; " +
            "password reset tokens never expire after the email is sent; two percentage coupons are computed on the original price. " +
            "Only inspect src; do not read checker or tests.",
        )).toEqual([
            "Fix three issues in src: late fees charge weekend days although the library is closed",
            "password reset tokens never expire after the email is sent",
            "two percentage coupons are computed on the original price. Only inspect src",
        ]);
        // List items win over lines and over their own `;`; instruction-only items drop out.
        expect(splitTaskIssues(
            "Resuelve estas incidencias del proyecto de la biblioteca actual sin tocar la configuración.\n" +
            "1. late fees charge weekend days; the library is closed then\n2. reset tokens never expire after sending\n3. Ejecuta el checker.",
        )).toEqual(["late fees charge weekend days; the library is closed then", "reset tokens never expire after sending"]);
    });

    it("identifier extraction: code-shaped words are strong, plain ones weak, generic ones dropped", () => {
        const ids = extractTaskIdentifiers("fix `run` and applyDiscount in large-local/src, keep the value; Invoice too, call parse() and render");
        expect(ids.strong).toEqual(expect.arrayContaining(["run", "applyDiscount", "Invoice", "parse"]));
        expect(ids.weak).toContain("render");
        expect(ids.weak).not.toContain("value");
        expect(ids.pathHints).toContain("large-local/src");
    });
});

// ─── context for a task that names no code and lists several issues ─────────

/**
 * The pre-registered A/B of 2026-11-13 (3 bugs described by behaviour, no code
 * names): after `context` agents still spent ~2 turns reading. One search for
 * the whole task gave its 4 hits to two issues; the hits were leaves (a rate
 * table, a zone list) while the bug sat in the file importing them; and the
 * agents read whole the small files of the hits and the helpers they import.
 * A different project here (library loans), not the A/B fixture.
 */
function libraryProject(dir: string): void {
    write(dir, {
        "package.json": "{\"type\":\"module\"}\n",
        "src/fees/rates.ts": "/** Late fee charged per overdue day, in cents. */\nexport const DAILY_LATE_FEE_CENTS = 25;\n\nexport function feeForDays(days: number): number {\n    return days * DAILY_LATE_FEE_CENTS;\n}\n",
        "src/calendar/days.ts": "const DAY_MS = 86_400_000;\n\nexport function daysBetween(fromMs: number, toMs: number): number {\n    return Math.floor((toMs - fromMs) / DAY_MS);\n}\n\n/** Saturday and Sunday: the library is closed. */\nexport function isWeekend(ms: number): boolean {\n    const day = new Date(ms).getUTCDay();\n    return day === 0 || day === 6;\n}\n",
        "src/loans/late-fee.ts": "import { feeForDays } from \"../fees/rates.js\";\nimport { daysBetween } from \"../calendar/days.js\";\nimport type { Loan } from \"./loan.js\";\n\nexport function lateFee(loan: Loan, returnedAtMs: number): number {\n    const overdue = daysBetween(loan.dueAtMs, returnedAtMs);\n    return feeForDays(Math.max(0, overdue));\n}\n",
        "src/loans/loan.ts": "export interface Loan {\n    bookId: string;\n    memberId: string;\n    dueAtMs: number;\n}\n",
        "src/members/password-reset.ts": "import { sign } from \"../shared/signing.js\";\nimport { SIGNING_SECRET } from \"../shared/signing.js\";\n\n/** Reset links mailed to members who forgot their password. */\nexport class ResetTokens {\n    private issued = new Map<string, { memberId: string; sentAtMs: number }>();\n\n    send(memberId: string, nowMs: number): string {\n        const token = sign(memberId + nowMs) + SIGNING_SECRET.length;\n        this.issued.set(token, { memberId, sentAtMs: nowMs });\n        return token;\n    }\n\n    consume(token: string): string | undefined {\n        const entry = this.issued.get(token);\n        if (!entry) return undefined;\n        this.issued.delete(token);\n        return entry.memberId;\n    }\n}\n",
        "src/shared/signing.ts": "export const SIGNING_SECRET = \"s3cr3t-value-do-not-print\";\n\nexport function sign(payload: string): string {\n    return payload.split(\"\").reverse().join(\"\");\n}\n",
        "src/shared/money.ts": "export function percentOf(amountCents: number, percent: number): number {\n    return Math.round((amountCents * percent) / 100);\n}\n",
        "src/shop/coupons.ts": "import { percentOf } from \"../shared/money.js\";\n\nexport interface Coupon {\n    code: string;\n    percent: number;\n}\n\n/** Price after every percentage coupon of the basket. */\nexport function applyCoupons(priceCents: number, coupons: Coupon[]): number {\n    let discount = 0;\n    for (const coupon of coupons) discount += percentOf(priceCents, coupon.percent);\n    return Math.max(0, priceCents - discount);\n}\n",
        "src/catalog/books.ts": "export interface Book {\n    id: string;\n    title: string;\n    author: string;\n}\n\nexport function byAuthor(books: Book[], author: string): Book[] {\n    return books.filter(b => b.author === author);\n}\n",
        "src/members/profile.ts": "export function displayName(first: string, last: string): string {\n    return `${first} ${last}`.trim();\n}\n",
    });
}

const LIBRARY_TASK = [
    "1. Late fees on returned books charge weekend days; the library is closed on weekends, so those days must not be charged.",
    "2. Password reset tokens never expire; they must stop working 30 minutes after they are sent.",
    "3. Two percentage coupons are both computed on the original price; each must apply to the already discounted price.",
].join("\n");

describe("context: a task that names no code and lists several issues", () => {
    let dir: string;
    let engine: NrekiEngine;
    let deps: RouterDependencies;

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-library-"));
        libraryProject(dir);
        engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        await engine.initialize();
        await engine.indexDirectory(dir);
        deps = { engine } as unknown as RouterDependencies;
    });
    afterAll(() => {
        engine.shutdown();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    });

    it("every issue gets its code in one call: small files whole, the file where the hits meet, short imported helpers", async () => {
        const r = await handleContext({ action: "context", query: LIBRARY_TASK }, deps);
        const text = textOf(r);
        expect(r.isError).not.toBe(true);
        expect(text.split("\n")[0]).toContain("each of its 3 issues searched");
        expect(text.split("\n")[0]).toContain("no further read of it is needed");
        // Issue 1 lives where rates.ts and days.ts meet; issue 2 and 3 in their files.
        expect(text).toContain("// src/loans/late-fee.ts (whole file, 8L)");
        expect(text).toContain("export function lateFee(loan: Loan, returnedAtMs: number): number {");
        expect(text).toContain("consume(token: string): string | undefined {");
        expect(text).toContain("export function applyCoupons(priceCents: number, coupons: Coupon[]): number {");
        // What that code imports, short: percentOf is shown, not a reason to open money.ts.
        expect(text).toContain("what that code imports (short definitions):");
        expect(text).toContain("export function percentOf(amountCents: number, percent: number): number {");
        // Never a credential-looking definition pulled in from another file.
        expect(text).not.toContain("s3cr3t-value-do-not-print");
        // Unrelated code stays out.
        for (const unrelated of ["byAuthor", "displayName"]) expect(text).not.toContain(unrelated);
        expect(tok(text)).toBeLessThan(1600);
    });

    it("a whole small file counts as read: editing it right away is not a blind edit", async () => {
        fs.rmSync(path.join(dir, ".nreki", "enforcer-state.json"), { force: true });
        const fresh = new CognitiveEnforcer(dir);
        await handleContext({ action: "context", query: LIBRARY_TASK }, { ...deps, enforcer: fresh } as RouterDependencies);
        expect(fresh.evaluate("nreki_code", "batch_edit", { edits: [{ path: "src/shop/coupons.ts", symbol: "applyCoupons" }] }).blocked).toBe(false);
    });
});
