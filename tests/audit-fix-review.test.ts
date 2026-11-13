/**
 * Regressions for the follow-up audit that re-checked the v12.1.0 fixes
 * (I-01, I-02, T-01, T-02). Each test failed before its fix.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { NrekiEngine } from "../src/engine.js";
import { NrekiDB } from "../src/database.js";
import { NrekiKernel } from "../src/kernel/nreki-kernel.js";
import { LspSidecarBase } from "../src/kernel/backends/lsp-sidecar-base.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { handleRead } from "../src/handlers/code/read.js";
import { handleSetPlan } from "../src/handlers/guard.js";
import { applyContextHeartbeat, type RouterDependencies } from "../src/router.js";
import { toPosix } from "../src/utils/to-posix.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockServerPath = path.resolve(__dirname, "mock-lsp-server.ts");
const tsxCli = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

function tmp(prefix: string, files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

class MockLspSidecar extends LspSidecarBase {
    constructor(projectRoot: string, scenario: string) {
        super(projectRoot, [process.execPath, tsxCli, mockServerPath], "mock", { MOCK_LSP_SCENARIO: scenario });
    }
}

describe("I-01: no empty LSP overlay outlives a rollback", () => {
    it("closes the overlay of a file absent on disk instead of leaving an empty buffer open", async () => {
        const dir = tmp("nreki-i01-close-", { "main.py": "x = 1\n" });
        // empty_is_error: an open empty document is an error, as in gopls.
        const sidecar = new MockLspSidecar(dir, "empty_is_error");
        cleanups.push(() => sidecar.shutdown());
        await sidecar.boot();

        const ghost = path.join(dir, "ghost.py"); // never written to disk
        expect(await sidecar.validateEdits([{ filePath: ghost, content: "y = 2\n" }])).toEqual([]);
        await sidecar.validateEdits([{ filePath: ghost, content: null }]); // rollback / resync
        expect(sidecar.hasOpenDocument(ghost)).toBe(false);
        // Errors of every open document are collected: the phantom used to fail this one.
        expect(await sidecar.validateEdits([{ filePath: path.join(dir, "main.py"), content: "x = 2\n" }])).toEqual([]);
    });

    it("restores a collateral file from disk when a failed LSP auto-heal is rolled back", async () => {
        const consumerSrc = "def use():\n    return helper()\n";
        const dir = tmp("nreki-i01-heal-", { "svc.py": "def f():\n    return 1\n", "consumer.py": consumerSrc });
        fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["./**/*.ts"] }));
        const consumer = toPosix(path.join(dir, "consumer.py"));
        const sent: Array<{ filePath: string; content: string | null }> = [];
        const fake = {
            languageId: "python", command: ["fake-pyright"], isDead: false,
            isHealthy: () => true, boot: async () => {}, shutdown: async () => {},
            hasOpenDocument: () => true,
            companionFiles: () => [],
            baselineErrors: async () => [], // consumer.py had no error before this edit
            // The edit breaks consumer.py (open since an earlier edit) and the offered
            // import never lowers the error count, so the heal is rolled back.
            validateEdits: async (edits: Array<{ filePath: string; content: string | null }>) => {
                sent.push(...edits);
                return [{ file: consumer, line: 2, column: 12, code: "python-mock", message: "\"helper\" is not defined" }];
            },
            requestCodeActions: async () => [{
                title: "Add import 'helper'",
                edits: [{ filePath: consumer, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "from lib import helper\n" }],
            }],
        };
        const kernel = new NrekiKernel();
        kernel.boot(dir, "project");
        kernel.registerSidecar(".py", fake as never);

        const r = await kernel.interceptAtomicBatch([{ targetFile: path.join(dir, "svc.py"), proposedContent: "def f():\n    return 2\n" }]);
        expect(r.safe).toBe(false);
        const toConsumer = sent.filter(e => toPosix(e.filePath) === consumer);
        expect(toConsumer.length).toBeGreaterThan(1); // the patched version, then the rollback(s)
        expect(toConsumer.some(e => e.content === null)).toBe(false); // null = empty tombstone of a real file
        expect(toConsumer[toConsumer.length - 1].content).toBe(consumerSrc);
    });
});

describe("I-02: the engram merge between two servers works per key", () => {
    async function seeded(dir: string): Promise<string> {
        const dbFile = path.join(dir, ".nreki.db");
        const seed = new NrekiDB(dbFile, dir);
        await seed.initialize();
        seed.upsertEngram(path.join(dir, "auth.ts"), "verify", "h1", "v1");
        seed.upsertEngram(path.join(dir, "auth.ts"), "sign", "h1", "s1");
        seed.close();
        return dbFile;
    }

    async function open(dbFile: string, dir: string): Promise<NrekiDB> {
        const db = new NrekiDB(dbFile, dir);
        await db.initialize();
        return db;
    }

    it("does not resurrect an engram this server deleted after the other server saved", async () => {
        const dir = tmp("nreki-i02-del-");
        const dbFile = await seeded(dir);
        const a = await open(dbFile, dir);
        const b = await open(dbFile, dir);

        b.setMetadata("nreki_scratchpad", "B's notes");
        b.save(); // the file changes under A
        a.deleteEngram(path.join(dir, "auth.ts"), "verify");
        a.close();
        b.close();

        const reader = await open(dbFile, dir);
        const engrams = reader.getEngramsForFile(path.join(dir, "auth.ts"));
        expect(engrams.has("verify")).toBe(false);
        expect(engrams.get("sign")?.insight).toBe("s1");
        expect(reader.getMetadata("nreki_scratchpad")).toBe("B's notes");
        reader.close();
    });

    it("keeps the other server's update and deletion of keys this server never touched", async () => {
        const dir = tmp("nreki-i02-upd-");
        const dbFile = await seeded(dir);
        const a = await open(dbFile, dir);
        const b = await open(dbFile, dir);

        b.upsertEngram(path.join(dir, "auth.ts"), "verify", "h2", "v2");
        b.deleteEngram(path.join(dir, "auth.ts"), "sign");
        a.upsertEngram(path.join(dir, "pay.ts"), "charge", "h1", "c1"); // A still holds v1 and sign
        a.close();
        b.close();

        const reader = await open(dbFile, dir);
        const auth = reader.getEngramsForFile(path.join(dir, "auth.ts"));
        expect(auth.get("verify")?.insight).toBe("v2");
        expect(auth.has("sign")).toBe(false);
        expect(reader.getEngramsForFile(path.join(dir, "pay.ts")).get("charge")?.insight).toBe("c1");
        reader.close();
    });
});

describe("T-01: verbatim reads count toward total_output", () => {
    it("logs the tokens returned by both verbatim branches of handleRead", async () => {
        const medium = Array.from({ length: 150 }, (_, i) => `export const v${i} = ${i}; // padding to pass 1 KB`).join("\n");
        const dir = tmp("nreki-t01-", { "small.ts": "export const a = 1;\n", "medium.ts": medium });
        const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki-test.db"), watchPaths: [dir] });
        await engine.initialize();
        cleanups.push(() => engine.shutdown());
        const deps = { engine } as unknown as RouterDependencies;
        const outputAfter = async (file: string): Promise<number> => {
            await handleRead({ action: "read", path: file } as never, deps);
            engine.flushUsageSync();
            return engine.getUsageStats().total_output;
        };

        const afterSmall = await outputAfter("small.ts"); // < 100 lines branch
        expect(afterSmall).toBeGreaterThan(0);
        const afterMedium = await outputAfter("medium.ts"); // <= 12k tokens verbatim branch
        expect(afterMedium - afterSmall).toBeGreaterThan(500);
    });
});

describe("T-02: set_plan stores the drift the heartbeat compares against", () => {
    it("does not fire the heartbeat on the next safe call", async () => {
        const dir = tmp("nreki-t02-", { "PLAN.md": "- step 1\n" });
        const metadata: Record<string, string> = { nreki_scratchpad: "notes" };
        const deps = {
            engine: {
                initialize: async () => {},
                getProjectRoot: () => dir,
                getMetadata: (k: string) => metadata[k] ?? null,
                setMetadata: (k: string, v: string) => { metadata[k] = v; },
                // Handlers log the same count as input and as output.
                getUsageStats: () => ({ total_input: 55_000, total_output: 55_000, total_saved: 0, tool_calls: 10 }),
            },
            circuitBreaker: new CircuitBreaker(),
        } as unknown as RouterDependencies;

        const set = await handleSetPlan({ action: "set_plan", text: "PLAN.md" } as never, deps);
        expect(set.isError).not.toBe(true);
        const next = applyContextHeartbeat("read", { content: [{ type: "text", text: "result" }] }, deps);
        expect(next.content[0].text).toBe("result");
    });
});
