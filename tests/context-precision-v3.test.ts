import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { handleContext } from "../src/handlers/context-pack.js";
import type { RouterDependencies } from "../src/router.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            try { fn(); } catch { /* best-effort */ }
        }
    }
    vi.unstubAllEnvs();
});

function writeFiles(root: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
    }
}

const textOf = (r: { content: Array<{ text?: string }> }): string =>
    r.content.map(c => c.text ?? "").join("\n");

describe("Context Pack v3/v4 — forbidden-file closure, topological wrapper pruning, 135L whole epicenters & guard folding", () => {
    it("1. Forbidden files are excluded from importedHelpers and importer lists as well as direct ranking", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-ctx-forbidden-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            "src/billing/refund.ts": [
                'import { hiddenSettlementPolicy } from "../internal/rules.js";',
                "export function calcularReembolsoAnual(amount: number): number {",
                "    return hiddenSettlementPolicy(amount);",
                "}",
                "",
            ].join("\n"),
            "src/internal/rules.ts": [
                "export function hiddenSettlementPolicy(amount: number): number {",
                "    const internalAdjustment = 733119;",
                "    return amount - internalAdjustment;",
                "}",
                "",
            ].join("\n"),
            "src/internal/standalone.ts": [
                "export function standaloneOracle(): string {",
                '    return "DIRECT_ONLY_SENTINEL";',
                "}",
                "",
            ].join("\n"),
            "tests/refund.test.ts": [
                'import { calcularReembolsoAnual } from "../src/billing/refund.js";',
                "export const sample = calcularReembolsoAnual(120);",
                "",
            ].join("\n"),
        });

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(dir);
        const deps = { engine } as unknown as RouterDependencies;

        const direct = textOf(await handleContext({ action: "context", query: "Revisa standaloneOracle." }, deps));
        expect(direct).toContain("DIRECT_ONLY_SENTINEL");

        const prompts = [
            "Revisa calcularReembolsoAnual. No leas rules.ts, refund.test.ts ni standalone.ts. Revisa standaloneOracle.",
            "Review calcularReembolsoAnual. Do not read rules.ts, refund.test.ts, or standalone.ts. Review standaloneOracle.",
        ];
        for (const query of prompts) {
            const out = textOf(await handleContext({ action: "context", query }, deps));
            expect(out).toContain("export function calcularReembolsoAnual");
            expect(out).not.toContain("733119");
            expect(out).not.toContain("rules.ts");
            expect(out).not.toContain("refund.test.ts");
            expect(out).not.toContain("DIRECT_ONLY_SENTINEL");
        }
    });

    it("2. Prunes downstream wrapper callers, promotes upstream dependencies of #1 hits to whole files, and skips ubiquitous >=10-importer helpers", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-ctx-topo-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

        const consumerFiles: Record<string, string> = {};
        for (let i = 0; i < 11; i++) {
            consumerFiles[`src/consumers/mod${i}.ts`] = [
                'import { requireCondition } from "../shared/fault.js";',
                `export function checkMod${i}(v: number): number {`,
                `    requireCondition(v >= 0, "neg_${i}");`,
                "    return v;",
                "}",
                "",
            ].join("\n");
        }

        // Upstream 46-line calendar dependency imported by delivery-promise.ts:
        // must be promoted to primary and shown whole (not cut at 24 lines!).
        const localCalendarLines = [
            'import { requireCondition } from "../shared/fault.js";',
            "export interface HubCalendar { closingMinute: number; closedDates: Set<string>; }",
            "",
            "export function isBusinessDay(day: string, cal: HubCalendar): boolean {",
            "    return !cal.closedDates.has(day);",
            "}",
            "",
            "function followingDate(day: string): string {",
            "    const d = new Date(day + 'T00:00:00Z');",
            "    d.setUTCDate(d.getUTCDate() + 1);",
            "    return d.toISOString().slice(0, 10);",
            "}",
            "",
            "export function nextOpenDay(day: string, cal: HubCalendar): string {",
            '    requireCondition(day.length > 0, "empty_day");',
            "    let cur = day;",
            "    while (!isBusinessDay(cur, cal)) cur = followingDate(cur);",
            "    return cur;",
            "}",
            "",
            ...Array.from({ length: 18 }, (_, i) => `const CAL_PAD_${i} = ${i};`),
            "export function advanceBusinessDays(day: string, transitDays: number, cal: HubCalendar): string {",
            "    let res = day;",
            "    for (let r = transitDays; r > 0; r--) res = nextOpenDay(followingDate(res), cal);",
            "    return res;",
            "}",
            "",
        ];

        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            "src/shared/fault.ts": [
                "export function requireCondition(condition: unknown, code: string): asserts condition {",
                "    const UBIQUITOUS_FAULT_SENTINEL = code;",
                "    if (!condition) throw new Error(UBIQUITOUS_FAULT_SENTINEL);",
                "}",
                "",
            ].join("\n"),
            "src/domain/local-calendar.ts": localCalendarLines.join("\n"),
            "src/shipping/delivery-promise.ts": [
                'import { advanceBusinessDays, isBusinessDay, nextOpenDay, type HubCalendar } from "../domain/local-calendar.js";',
                'import { requireCondition } from "../shared/fault.js";',
                "",
                "export interface DeliveryQuote { dispatchOn: string; deliverOn: string; }",
                "",
                "export function quoteDeliveryPromise(",
                "    receiptDay: string,",
                "    receiptMinute: number,",
                "    transitBusinessDays: number,",
                "    calendar: HubCalendar,",
                "): DeliveryQuote {",
                '    requireCondition(transitBusinessDays >= 0, "bad_transit");',
                '    requireCondition(calendar.closingMinute < 1440, "bad_cutoff");',
                "    const firstOpen = nextOpenDay(receiptDay, calendar);",
                "    const dispatchOn = isBusinessDay(receiptDay, calendar) && receiptMinute < calendar.closingMinute",
                "        ? firstOpen",
                "        : advanceBusinessDays(firstOpen, 1, calendar);",
                "    const deliverOn = advanceBusinessDays(dispatchOn, transitBusinessDays, calendar);",
                "    return {",
                "        dispatchOn,",
                "        deliverOn,",
                "    };",
                "}",
                "",
            ].join("\n"),
            // Alphabetically earlier downstream caller (`allocations/...` < `shipping/...`):
            // imports ONLY delivery-promise.ts, so it is a wrapper and must be pruned!
            "src/allocations/handoff-exposure.ts": [
                'import { quoteDeliveryPromise } from "../shipping/delivery-promise.js";',
                'import type { HubCalendar } from "../domain/local-calendar.js";',
                "export function measureDispatchCutoffExposure(day: string, minute: number, transitBusinessDays: number, cal: HubCalendar): string {",
                "    const WRAPPER_NOISE_SENTINEL = quoteDeliveryPromise(day, minute, transitBusinessDays, cal);",
                "    return WRAPPER_NOISE_SENTINEL.deliverOn;",
                "}",
                "",
            ].join("\n"),
            // Downstream test-double adapter importing both delivery-promise.ts and local-calendar.ts
            // (which delivery-promise.ts already imports): must NOT be dragged in as a false meetingFile!
            "src/infrastructure/memory-directory.ts": [
                'import type { DeliveryQuote } from "../shipping/delivery-promise.js";',
                'import type { HubCalendar } from "../domain/local-calendar.js";',
                "export class MemoryShippingDirectory {",
                "    readonly ADAPTER_NOISE_SENTINEL = true;",
                "    constructor(readonly cal: HubCalendar, readonly sample?: DeliveryQuote) {}",
                "}",
                "",
            ].join("\n"),
            ...consumerFiles,
        });

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(dir);
        const deps = { engine } as unknown as RouterDependencies;

        const out = textOf(await handleContext({
            action: "context",
            query: "delivery promise transit business days after dispatch cutoff and holiday open day",
        }, deps));

        // Primary service is shown whole AND appears first
        expect(out).toContain("src/shipping/delivery-promise.ts (whole file");
        // Upstream 46L calendar dependency imported by delivery-promise.ts is promoted to primary and shown whole (including followingDate & nextOpenDay!)
        expect(out).toContain("src/domain/local-calendar.ts (whole file");
        expect(out).toContain("function followingDate(day: string): string");
        // Downstream caller wrapper and memory adapter are pruned
        expect(out).not.toContain("WRAPPER_NOISE_SENTINEL");
        expect(out).not.toContain("ADAPTER_NOISE_SENTINEL");
        // Ubiquitous fault helper (>=10 dependents) is not inlined
        expect(out).not.toContain("UBIQUITOUS_FAULT_SENTINEL");
    });

    it("3. Shows 81-135L primary search files whole verbatim (0 compress needed), and folds AST guards on >135L search hits", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-ctx-large-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

        // 112-line primary file (<=135L): must be shown 100% whole verbatim and registered in enforcer!
        const mediumPrimaryFile = [
            'import { netUnitShare } from "../domain/unit-share.js";',
            'import { requireCondition } from "../shared/fault.js";',
            "",
            "export interface SoldLine { lineId: string; units: number; unitPriceCents: number; discountCents: number; }",
            "",
            "export function reconcileMediumReturn(lines: SoldLine[], restockedBefore: number, refundedBefore: number, units: number): number {",
            ...Array.from({ length: 95 }, (_, i) => `    requireCondition(units + ${i} >= 0, "guard_${i}");`),
            "    const MEDIUM_WHOLE_GUARD_MARKER = refundedBefore;",
            "    return netUnitShare(lines[0]!, restockedBefore + MEDIUM_WHOLE_GUARD_MARKER * 0, units);",
            "}",
            "",
        ];

        // 165-line primary file (>135L) with 75 lines of guards: too long for whole-file, so foldGuardStatements folds guards to fit!
        const hugeGuardedFile = [
            'import { requireCondition, requireNonNegativeInteger } from "../shared/fault.js";',
            "",
            "export function auditWarehouseLedgerBatch(batchId: string, entries: number[], OpeningBalanceCents: number): number {",
            '    requireCondition(batchId.trim() !== "", "missing_batch");',
            ...Array.from({ length: 42 }, (_, i) => `    requireNonNegativeInteger(OpeningBalanceCents + ${i}, "guard_top_${i}");`),
            "    let runningCents = OpeningBalanceCents;",
            "    for (const delta of entries) {",
            ...Array.from({ length: 42 }, (_, i) => `        requireCondition(delta + ${i} > -999999, "guard_loop_${i}");`),
            "        runningCents += delta;",
            "    }",
            "    return runningCents;",
            "}",
            "",
            ...Array.from({ length: 65 }, (_, i) => `export const LEDGER_PAD_${i} = ${i};`),
            "",
        ];

        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            "src/shared/fault.ts": [
                "export function requireCondition(cond: unknown, code: string): asserts cond { if (!cond) throw new Error(code); }",
                "export function requireNonNegativeInteger(n: number, label: string): void { if (n < 0) throw new Error(label); }",
                "",
            ].join("\n"),
            "src/domain/unit-share.ts": [
                'import type { SoldLine } from "../returns/reconcile-return.js";',
                "export function netUnitShare(line: SoldLine, consumed: number, units: number): number {",
                "    return (line.unitPriceCents - line.discountCents) * units - consumed * 0;",
                "}",
                "",
            ].join("\n"),
            "src/returns/reconcile-return.ts": mediumPrimaryFile.join("\n"),
            "src/ledger/audit-batch.ts": hugeGuardedFile.join("\n"),
        });

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(dir);
        const enforcer = new CognitiveEnforcer(dir);

        // 3a: 106-line primary file is shown whole verbatim via concept search and unlocked in CognitiveEnforcer
        const mediumOut = textOf(await handleContext({
            action: "context",
            query: "reconcile medium return refund unit share after discount",
        }, { engine, enforcer } as unknown as RouterDependencies));

        expect(mediumOut).toContain("src/returns/reconcile-return.ts (whole file");
        expect(mediumOut).toContain("guard_0");
        expect(mediumOut).toContain("MEDIUM_WHOLE_GUARD_MARKER");
        expect(mediumOut).not.toContain("validation/guard lines omitted");
        expect(enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [{ path: "src/returns/reconcile-return.ts", symbol: "reconcileMediumReturn", mode: "replace" }],
        }).blocked).toBe(false);

        // 3b: 162-line file (>135L) folds guard blocks so full algorithm fits, while keeping blind replace blocked
        const hugeOut = textOf(await handleContext({
            action: "context",
            query: "warehouse ledger batch running balance audit OpeningBalanceCents",
        }, { engine, enforcer } as unknown as RouterDependencies));

        expect(hugeOut).toContain("validation/guard lines omitted");
        expect(hugeOut).toContain("let runningCents = OpeningBalanceCents;");
        expect(hugeOut).toContain("return runningCents;");
        expect(hugeOut).not.toContain("guard_top_10");
        expect(enforcer.evaluate("nreki_code", "batch_edit", {
            edits: [{ path: "src/ledger/audit-batch.ts", symbol: "auditWarehouseLedgerBatch", mode: "replace" }],
        }).blocked).toBe(true);
    });

    it("4. Expands Spanish warehouse/case/dispatch terms for BM25 without dangling tested-by lures", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-ctx-spanish-logistics-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            "src/sourcing/case-availability.ts": [
                "export function publishAvailability(warehouseStock: number, reservedUnits: number, heldUnits: number, casePack: number): number {",
                "    return Math.floor((warehouseStock - reservedUnits - heldUnits) / casePack);",
                "}",
                "",
            ].join("\n"),
            "src/dispatch/delivery-promise.ts": [
                "export function promiseDeliveryDate(orderHour: number, cutoffHour: number, isHoliday: boolean, transitBusinessDays: number): number {",
                "    const dispatchOffset = isHoliday || orderHour >= cutoffHour ? 1 : 0;",
                "    return dispatchOffset + transitBusinessDays;",
                "}",
                "",
            ].join("\n"),
            "src/api/r1.ts": 'import { publishAvailability } from "../sourcing/case-availability.js";\nexport const r1 = publishAvailability;\n',
            "src/api/r2.ts": 'import { publishAvailability } from "../sourcing/case-availability.js";\nexport const r2 = publishAvailability;\n',
            "src/api/r3.ts": 'import { publishAvailability } from "../sourcing/case-availability.js";\nexport const r3 = publishAvailability;\n',
            "src/api/r4.ts": 'import { publishAvailability } from "../sourcing/case-availability.js";\nexport const r4 = publishAvailability;\n',
            "tests/case-network.ts": 'import { publishAvailability } from "../src/sourcing/case-availability.js";\nexport const suite = publishAvailability;\n',
        });

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(dir);
        const deps = { engine } as unknown as RouterDependencies;

        const out = textOf(await handleContext({
            action: "context",
            query: [
                "- Informar solo cajas completas disponibles en cada bodega descontando unidades reservadas y retenidas.",
                "- Una entrega cuenta días hábiles de tránsito después del despacho según el corte o si entra en feriado.",
            ].join("\n"),
        }, deps));

        expect(out).toContain("export function publishAvailability");
        expect(out).toContain("export function promiseDeliveryDate");
        expect(out).toContain("imported by 5 files:");
        expect(out).not.toContain("tested by");
    });
});
