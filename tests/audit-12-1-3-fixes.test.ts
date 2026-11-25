import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { TokenMonitor } from "../src/monitor.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { ChronosMemory } from "../src/chronos-memory.js";
import { handleCode, handleNavigate, type RouterDependencies } from "../src/router.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
});

function makeProject(files: Record<string, string>): { dir: string; deps: RouterDependencies } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-audit-1213-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
    }
    const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
    const sandbox = new AstSandbox();
    const kernel = new NrekiKernel();
    const enforcer = new CognitiveEnforcer(dir);
    const chronos = new ChronosMemory(dir);
    cleanups.push(() => {
        engine.shutdown();
        sandbox.shutdown();
    });
    const deps: RouterDependencies = {
        engine,
        sandbox,
        kernel,
        enforcer,
        chronos,
        monitor: new TokenMonitor(),
        circuitBreaker: new CircuitBreaker(dir),
        nrekiMode: "project",
    };
    return { dir, deps };
}

const fillerLines = (n: number, prefix = "pad"): string =>
    Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n");

describe("CognitiveEnforcer zero-false-positive alignment with compress & context", () => {
    it("unlocks resolved symbol after substring compress focus, without unlocking homonym methods on sibling classes", async () => {
        const code = [
            "export function calculateInvoiceTotal(amount: number): number {",
            "    return amount * 2;",
            "}",
            "export class RecoveryCodes {",
            "    redeem(code: string): boolean {",
            "        return code.length > 4;",
            "    }",
            "}",
            "export class InviteCodes {",
            "    redeem(code: string): boolean {",
            "        return code.startsWith('INV-');",
            "    }",
            "}",
            fillerLines(115),
        ].join("\n");

        const { deps } = makeProject({ "src/billing.ts": code });
        await deps.engine.initialize();
        await deps.engine.indexDirectory(deps.engine.getProjectRoot());

        // Substring focus "InvoiceTotal" shows calculateInvoiceTotal in full -> must unlock replace on calculateInvoiceTotal
        const comp = await handleCode("compress", { action: "compress", path: "src/billing.ts", focus: "InvoiceTotal" }, deps);
        expect(comp.isError).toBeFalsy();
        expect(comp.content[0]?.text).toContain("calculateInvoiceTotal");
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/billing.ts", symbol: "calculateInvoiceTotal", mode: "replace",
        }).blocked).toBe(false);

        // Unseen symbols remain protected
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/billing.ts", symbol: "InviteCodes.redeem", mode: "replace",
        }).blocked).toBe(true);

        // Focused qualified read on RecoveryCodes.redeem unlocks ONLY RecoveryCodes.redeem, NOT InviteCodes.redeem (F-09)
        const compMethod = await handleCode("compress", { action: "compress", path: "src/billing.ts", focus: "RecoveryCodes.redeem" }, deps);
        expect(compMethod.isError).toBeFalsy();
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/billing.ts", symbol: "RecoveryCodes.redeem", mode: "replace",
        }).blocked).toBe(false);
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/billing.ts", symbol: "InviteCodes.redeem", mode: "replace",
        }).blocked).toBe(true);
    });

    it("unlocks the file when compress focus trips the density shield and returns the whole file", async () => {
        const bigBody = Array.from({ length: 105 }, (_, i) => `    total += ${i};`).join("\n");
        const code = [
            "export function dominantFunction(seed: number): number {",
            "    let total = seed;",
            bigBody,
            "    return total;",
            "}",
            "export function helperTail(): number {",
            "    return 42;",
            "}",
        ].join("\n");

        const { deps } = makeProject({ "src/dominant.ts": code });
        await deps.engine.initialize();

        const comp = await handleCode("compress", { action: "compress", path: "src/dominant.ts", focus: "dominantFunction" }, deps);
        expect(comp.isError).toBeFalsy();
        expect(comp.content[0]?.text).toContain("whole file");

        // Since the entire file was returned verbatim, editing helperTail must NOT be blocked as blind
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/dominant.ts", symbol: "helperTail", mode: "replace",
        }).blocked).toBe(false);
    });

    it("preserves qualified symbol identity in context and unlocks methods when their enclosing class was shown verbatim", async () => {
        const longPad = Array.from({ length: 85 }, (_, i) => `    readonly field${i} = ${i};`).join("\n");
        const code = [
            "export class ShortContainer {",
            "    applyAdjustment(id: string): string {",
            "        return `short:${id}`;",
            "    }",
            "}",
            "export class AlphaLedger {",
            longPad,
            "    reconcileAccount(id: string): string {",
            "        // unique needle: ALPHA_VOUCHER_SETTLEMENT",
            "        return `alpha:${id}`;",
            "    }",
            "}",
            "export class BetaLedger {",
            "    reconcileAccount(id: string): string {",
            "        return `beta:${id}`;",
            "    }",
            "}",
            fillerLines(30),
        ].join("\n");

        const { deps } = makeProject({ "src/ledger.ts": code });
        await deps.engine.initialize();
        await deps.engine.indexDirectory(deps.engine.getProjectRoot());

        // 1. Showing ShortContainer whole (<= 80L) unlocks ShortContainer.applyAdjustment, not BetaLedger.reconcileAccount
        const ctxClass = await handleNavigate("context", { action: "context", query: "inspect ShortContainer" }, deps);
        expect(ctxClass.isError).toBeFalsy();
        expect(ctxClass.content[0]?.text).toContain("short:");
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/ledger.ts", symbol: "ShortContainer.applyAdjustment", mode: "replace",
        }).blocked).toBe(false);
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/ledger.ts", symbol: "BetaLedger.reconcileAccount", mode: "replace",
        }).blocked).toBe(true);

        // 2. Search-led context showing ONLY AlphaLedger.reconcileAccount unlocks it without unlocking BetaLedger.reconcileAccount
        const ctxMethod = await handleNavigate("context", { action: "context", query: "investigate alpha voucher settlement" }, deps);
        expect(ctxMethod.isError).toBeFalsy();
        expect(ctxMethod.content[0]?.text).toContain("ALPHA_VOUCHER_SETTLEMENT");
        expect(ctxMethod.content[0]?.text).not.toContain("return `beta:${id}`");

        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/ledger.ts", symbol: "AlphaLedger.reconcileAccount", mode: "replace",
        }).blocked).toBe(false);
        expect(deps.enforcer!.evaluate("nreki_code", "edit", {
            path: "src/ledger.ts", symbol: "BetaLedger.reconcileAccount", mode: "replace",
        }).blocked).toBe(true);
    });

    it("registers post-Auto-Heal content with expectInternalEdit so watcher does not fire false externalFileChange", async () => {
        const { dir, deps } = makeProject({
            "tsconfig.json": JSON.stringify({
                compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true },
                include: ["src/**/*.ts"],
            }),
            "src/helper.ts": "export function formatCents(n: number): string {\n    return `$${n}`;\n}\n",
            "src/service.ts": "export function buildReceipt(n: number): string {\n    return String(n);\n}\n",
        });

        const externalChanges: string[] = [];
        deps.engine.onExternalFileChange(async file => { externalChanges.push(path.resolve(file)); });
        await deps.engine.initialize();
        await deps.engine.indexDirectory(dir);
        await deps.engine.startWatcher();

        // Edit buildReceipt referencing formatCents WITHOUT importing it -> TS CodeFix Auto-Heal injects import!
        const res = await handleCode("edit", {
            action: "edit",
            path: "src/service.ts",
            symbol: "buildReceipt",
            mode: "replace",
            new_code: "export function buildReceipt(n: number): string {\n    return formatCents(n);\n}",
        }, deps);
        expect(res.isError).toBeFalsy();
        expect(res.content[0]?.text).toContain("[OK]");

        await new Promise(resolve => setTimeout(resolve, 400));
        expect(externalChanges).toEqual([]);
    });
});
