import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { handleContext } from "../src/handlers/context-pack.js";
import { expandSpanishContextQuery } from "../src/utils/spanish-query.js";
import type { RouterDependencies } from "../src/router.js";

type VoyageReqBody = { input: string[]; model: string; input_type: "document" | "query" };

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) {
            try { fn(); } catch { /* best-effort */ }
        }
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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

describe("Voyage first-call readiness, relocated prewarm reuse & Context Pack 2.0", () => {
    it("1. First cold handleContext/search awaits in-flight Voyage sync instead of returning 0 query calls", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-voyage-cold-first-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            // Shares ZERO words with the Spanish/English conceptual query — only Voyage vector matches it
            "src/ledger/reversal.ts": [
                "export function computeClawbackDelta(principalCents: number, usedRatio: number): number {",
                "    const retained = Math.round(principalCents * Math.min(1, Math.max(0, usedRatio)));",
                "    return Math.max(0, principalCents - retained);",
                "}",
                "",
            ].join("\n"),
            "src/ui/banner.ts": [
                "export function renderWelcomeTitle(userName: string): string {",
                "    return `Hello, ${userName}!`;",
                "}",
                "",
            ].join("\n"),
        });

        vi.stubEnv("NREKI_SEMANTIC", "voyage");
        vi.stubEnv("NREKI_VOYAGE_API_KEY", "pa-test-cold");

        const calls: VoyageReqBody[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
            const body = JSON.parse(init.body) as VoyageReqBody;
            calls.push(body);
            // Simulate realistic network latency on initial document embedding batch
            if (body.input_type === "document") {
                await new Promise(resolve => setTimeout(resolve, 60));
            }
            const vecFor = (text: string): number[] => {
                if (body.input_type === "query") return [1, 0, 0, 0];
                if (text.includes("computeClawbackDelta")) return [0.99, 0.05, 0, 0];
                return [0.05, 0.99, 0, 0];
            };
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    data: body.input.map((t, index) => ({ index, embedding: vecFor(t) })),
                }),
            };
        }));

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();

        // NO manual syncSemanticIndex() call: call handleContext cold, exactly like an MCP session!
        const res = await handleContext(
            { action: "context", query: "negative credit when cancelling an annual membership early" },
            { engine } as unknown as RouterDependencies,
        );
        const out = textOf(res);

        expect(calls.filter(c => c.input_type === "query").length).toBeGreaterThanOrEqual(1);
        expect(out).toContain("computeClawbackDelta");
    });

    it("2. Copying a prewarmed workspace + .nreki.db to a new directory reuses all vectors (0 document re-embeds) and persists syncSemanticIndex immediately", async () => {
        const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-voyage-template-"));
        const copiedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-voyage-copied-"));
        cleanups.push(() => fs.rmSync(templateDir, { recursive: true, force: true }));
        cleanups.push(() => fs.rmSync(copiedDir, { recursive: true, force: true }));

        writeFiles(templateDir, {
            "package.json": '{"type":"module"}\n',
            "src/billing/proration.ts": [
                "export function prorationCredit(paidCents: number, remainingDays: number, totalDays: number): number {",
                "    if (totalDays <= 0) return 0;",
                "    return Math.round((paidCents * remainingDays) / totalDays);",
                "}",
                "",
            ].join("\n"),
            "src/classes/waitlist.ts": [
                "export function promoteNextMember(queue: string[]): string | null {",
                "    return queue.shift() ?? null;",
                "}",
                "",
            ].join("\n"),
        });

        vi.stubEnv("NREKI_SEMANTIC", "voyage");
        vi.stubEnv("NREKI_VOYAGE_API_KEY", "pa-test-relocate");

        const calls: VoyageReqBody[] = [];
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
            const body = JSON.parse(init.body) as VoyageReqBody;
            calls.push(body);
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({
                    data: body.input.map((t, index) => ({
                        index,
                        embedding: t.includes("proration") || body.input_type === "query" ? [0.95, 0.1, 0, 0] : [0.1, 0.95, 0, 0],
                    })),
                }),
            };
        }));

        // 1. Prewarm in templateDir and copy .nreki.db IMMEDIATELY after syncSemanticIndex() BEFORE shutdown()
        //    (reproducing a prewarm script that copies or exits before the 1s debounce timer!)
        const prewarmEngine = new NrekiEngine({ dbPath: path.join(templateDir, ".nreki.db"), watchPaths: [templateDir] });
        cleanups.push(() => prewarmEngine.shutdown());
        await prewarmEngine.syncSemanticIndex();

        const prewarmDocCalls = calls.filter(c => c.input_type === "document").length;
        expect(prewarmDocCalls).toBeGreaterThan(0);

        // Copy workspace + .nreki.db to copiedDir right away
        fs.cpSync(templateDir, copiedDir, { recursive: true });
        prewarmEngine.shutdown();

        // 2. Open engine in copiedDir and run handleContext: must make ZERO new document embedding calls,
        //    make >=1 query call, and return zero ghost paths from templateDir!
        calls.length = 0;
        const sessionEngine = new NrekiEngine({ dbPath: path.join(copiedDir, ".nreki.db"), watchPaths: [copiedDir] });
        cleanups.push(() => sessionEngine.shutdown());
        const res = await handleContext(
            { action: "context", query: "unused days credit when switching membership" },
            { engine: sessionEngine } as unknown as RouterDependencies,
        );
        // Wait for any background sync that ensureIndexed triggered
        await sessionEngine.syncSemanticIndex();

        const docEmbedsInSession = calls.filter(c => c.input_type === "document");
        const queryEmbedsInSession = calls.filter(c => c.input_type === "query");
        expect(docEmbedsInSession).toHaveLength(0);
        expect(queryEmbedsInSession.length).toBeGreaterThanOrEqual(1);
        expect(textOf(res)).not.toContain(path.basename(templateDir));
        expect(textOf(res)).toContain("prorationCredit");
    });

    it("3. Context includes 7-18 line imported helpers/types, 1-line signatures for >18L called imports, test pointers on >4 importers, and focused windows inside >80L search hits", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-context-v2-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

        const bigServiceLines = [
            "import { daysInBillingWindow, reconcileLargeLedger, type BillingWindow } from \"../shared/ledger-math.js\";",
            "",
            "export function settleAnnualCancellation(window: BillingWindow, paidCents: number, accountId: string): number {",
            ...Array.from({ length: 70 }, (_, i) => `    const preStep${i} = paidCents + ${i};`),
            "    // Refund proration calculation on timezone-shifted renewal boundary",
            "    const totalWindowDays = daysInBillingWindow(window);",
            "    const clawback = Math.round(paidCents / Math.max(1, totalWindowDays));",
            "    const audited = reconcileLargeLedger(accountId, clawback);",
            ...Array.from({ length: 70 }, (_, i) => `    const postStep${i} = audited + ${i};`),
            "    return postStep0 + preStep0 - paidCents;",
            "}",
            "",
        ];

        writeFiles(dir, {
            "package.json": '{"type":"module"}\n',
            "src/shared/ledger-math.ts": [
                "export interface BillingWindow {",
                "    startIso: string;",
                "    endIso: string;",
                "    tzId: string;",
                "    graceCount: number;",
                "    anchorDay: number;",
                "    inclusiveEnd: boolean;",
                "}",
                "",
                "export function daysInBillingWindow(win: BillingWindow): number {",
                "    const startMs = Date.parse(win.startIso);",
                "    const endMs = Date.parse(win.endIso);",
                "    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {",
                "        return 0;",
                "    }",
                "    const rawDays = Math.floor((endMs - startMs) / 86_400_000);",
                "    return win.inclusiveEnd ? rawDays + 1 : rawDays;",
                "}",
                "",
                "export function reconcileLargeLedger(accountId: string, deltaCents: number): number {",
                ...Array.from({ length: 22 }, (_, i) => `    const adj${i} = deltaCents + ${i} + accountId.length;`),
                "    return adj0 - accountId.length;",
                "}",
                "",
                "export function formatStatementCsv(rows: string[]): string {",
                ...Array.from({ length: 45 }, (_, i) => `    const col${i} = rows[${i} % Math.max(1, rows.length)] ?? "";`),
                "    return col0;",
                "}",
                "",
            ].join("\n"),
            "src/billing/settlement.ts": bigServiceLines.join("\n"),
            "src/api/routeA.ts": 'import { settleAnnualCancellation } from "../billing/settlement.js";\nexport const a = settleAnnualCancellation;\n',
            "src/api/routeB.ts": 'import { settleAnnualCancellation } from "../billing/settlement.js";\nexport const b = settleAnnualCancellation;\n',
            "src/api/routeC.ts": 'import { settleAnnualCancellation } from "../billing/settlement.js";\nexport const c = settleAnnualCancellation;\n',
            "src/api/routeD.ts": 'import { settleAnnualCancellation } from "../billing/settlement.js";\nexport const d = settleAnnualCancellation;\n',
            "tests/billing/settlement.test.ts": 'import { settleAnnualCancellation } from "../../src/billing/settlement.js";\nexport const t = settleAnnualCancellation;\n',
            "verify.mjs": 'export function timezoneProrationOracle() { throw new Error("secret oracle"); }\n',
        });

        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        cleanups.push(() => engine.shutdown());
        await engine.initialize();
        await engine.indexDirectory(dir);

        const res = await handleContext({
            action: "context",
            query: "El prorrateo de reembolso anual con zona horaria calcula mal los días. No leas verify.mjs.",
        }, { engine } as unknown as RouterDependencies);
        const text = textOf(res);

        // 1. Spanish expansion bridged prorrateo + reembolso + anual + zona -> proration refund annual timezone
        expect(expandSpanishContextQuery("prorrateo de reembolso anual por zona horaria")).toEqual(
            expect.stringContaining("proration"),
        );

        // 2. Forbidden oracle file named in negative imperative ("No leas verify.mjs") is never returned
        expect(text).not.toContain("secret oracle");
        expect(text).not.toContain("// verify.mjs");

        // 3. Focused interior window inside >80L `settleAnnualCancellation` shows the matched lines around `daysInBillingWindow`
        expect(text).toContain("export function settleAnnualCancellation(");
        expect(text).toContain("const totalWindowDays = daysInBillingWindow(window);");
        expect(text).not.toContain("const preStep0 =");

        // 4. 9-line imported helper `daysInBillingWindow` and 8-line `BillingWindow` interface ARE included
        expect(text).toContain("export function daysInBillingWindow(win: BillingWindow): number {");
        expect(text).toContain("interface BillingWindow {");

        // 5. >18L called import `reconcileLargeLedger` gets a compact 1-line signature pointer (not dropped, not dumped whole)
        expect(text).toContain("export function reconcileLargeLedger(accountId: string, deltaCents: number): number");
        expect(text).not.toContain("const adj10 =");

        // 6. Truncated >4 importer list stays concise without dangling test-file lures
        expect(text).toContain("imported by 5 files:");
        expect(text).not.toContain("tested by");
    });
});
