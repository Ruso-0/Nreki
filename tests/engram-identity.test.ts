/**
 * Engram identity regressions (v12.1.0):
 *  - two symbols with the same bare name: the engram used to land on the first
 *    one and be DELETED by the next outline because the second did not match
 *  - engrams were keyed by the absolute path as typed: a different drive-letter
 *    case (or a moved project folder) made them invisible
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { NrekiDB } from "../src/database.js";
import { handleOutline, handleSearch } from "../src/handlers/navigate.js";
import { handleEngram } from "../src/handlers/guard.js";
import { ASTParser } from "../src/parser.js";
import type { RouterDependencies } from "../src/router.js";
import {
    ENGRAM_MAX_CHARS, engramHash, placeEngrams, qualifiedNames, resolveEngramTarget, type EngramSymbol,
} from "../src/utils/engram-identity.js";

const JOBS = [
    "export class Alpha {",
    "    run(): number {",
    "        const a = 1; const b = 2; return a + b;",
    "    }",
    "}",
    "",
    "export class Beta {",
    "    run(): number {",
    "        const x = 10; const y = 20; return x * y;",
    "    }",
    "}",
    "",
].join("\n");

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

async function project(files: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-engram-"));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki-test.db"), watchPaths: [dir] });
    await engine.initialize();
    cleanups.push(() => { engine.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
    const deps = { engine } as unknown as RouterDependencies;
    const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? "";
    return {
        dir, engine,
        engram: async (p: string, symbol: string, insight: string) =>
            text(await handleEngram({ action: "engram", path: p, symbol, text: insight } as never, deps)),
        outline: async (p: string) => text(await handleOutline({ action: "outline", path: p, signatures: true } as never, deps)),
    };
}

const sym = (qualified: string, body: string, startLine = 1): EngramSymbol =>
    ({ qualified, bare: qualified.split(".").pop()!, body, startLine });

describe("qualifiedNames", () => {
    it("qualifies methods by their class and Go methods by their receiver", async () => {
        const parser = new ASTParser();
        await parser.initialize();
        const ts = await parser.parse("jobs.ts", JOBS);
        expect(qualifiedNames(ts.chunks)).toEqual(["Alpha", "Alpha.run", "Beta", "Beta.run"]);

        const go = await parser.parse("srv.go", "package main\n\ntype Server struct{}\n\nfunc (s *Server) Handle() int {\n\treturn 1\n}\n\nfunc main() {}\n");
        const names = qualifiedNames(go.chunks);
        expect(names).toContain("Server.Handle");
        expect(names).toContain("main");
    });
});

describe("placeEngrams", () => {
    const a = sym("Alpha.run", "return 1;", 2);
    const b = sym("Beta.run", "return 2;", 8);

    it("does not delete an engram because a same-named sibling differs", () => {
        const p = placeEngrams([a, b], new Map([["Beta.run", { astHash: engramHash(b.body), insight: "beta note" }]]));
        expect(p.shown.get(1)).toEqual(["beta note"]);
        expect(p.shown.has(0)).toBe(false);
        expect(p.invalidated).toEqual([]);
    });

    it("moves a legacy bare-name engram to the symbol whose body matches", () => {
        const p = placeEngrams([a, b], new Map([["run", { astHash: engramHash(b.body), insight: "legacy" }]]));
        expect(p.shown.get(1)).toEqual(["legacy"]);
        expect(p.rekeyed).toEqual([{ from: "run", to: "Beta.run" }]);
    });

    it("invalidates only when no symbol of that name still has the saved body; ASSERT survives", () => {
        const stale = placeEngrams([a, b], new Map([["Beta.run", { astHash: "0".repeat(64), insight: "old" }]]));
        expect(stale.invalidated).toEqual(["Beta.run"]);
        expect(stale.invalidatedAt.has(1)).toBe(true);

        const immortal = placeEngrams([a, b], new Map([["Beta.run", { astHash: "0".repeat(64), insight: "  ASSERT idempotent" }]]));
        expect(immortal.shown.get(1)).toEqual(["  ASSERT idempotent"]);
        expect(immortal.invalidated).toEqual([]);
    });

    it("leaves engrams of symbols missing from the parse untouched (renamed or mid-edit)", () => {
        const p = placeEngrams([a], new Map([["Gamma.run", { astHash: "x", insight: "keep me" }]]));
        expect(p.invalidated).toEqual([]);
        expect(p.shown.size).toBe(0);
    });

    it("rejects an ambiguous bare name and lists the qualified candidates", () => {
        const r = resolveEngramTarget([a, b], "run");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("Alpha.run (L2), Beta.run (L8)");
        const ok = resolveEngramTarget([a, b], "Beta.run");
        expect(ok.ok && ok.symbol.qualified).toBe("Beta.run");
    });
});

describe("engram handlers end to end", () => {
    it("anchors to the qualified symbol and keeps it across outlines until its code changes", async () => {
        const p = await project({ "src/jobs.ts": JOBS });
        expect(await p.engram("src/jobs.ts", "run", "x")).toContain("ambiguous");
        expect(await p.engram("src/jobs.ts", "Beta.run", "Beta.run must stay idempotent")).toContain("`Beta.run` (L8)");

        for (let i = 0; i < 2; i++) {
            const out = await p.outline("src/jobs.ts");
            const lines = out.split("\n");
            const at = lines.findIndex(l => l.includes("[Engram]: Beta.run must stay idempotent"));
            expect(at).toBeGreaterThan(0);
            expect(lines.slice(0, at).reverse().find(l => l.startsWith("- "))).toContain("L8-L10");
            expect(out).not.toContain("Engram invalidated");
        }

        fs.writeFileSync(path.join(p.dir, "src/jobs.ts"), JOBS.replace("return x * y;", "return x - y;"));
        expect(await p.outline("src/jobs.ts")).toContain("Engram invalidated");
        expect(await p.outline("src/jobs.ts")).not.toContain("Beta.run must stay idempotent");
    });

    it("finds the engram whatever path spelling was used to save it", async (ctx) => {
        if (process.platform !== "win32") ctx.skip("drive-letter case only exists on Windows");
        const p = await project({ "src/jobs.ts": JOBS });
        const abs = path.join(p.dir, "src", "jobs.ts");
        const flipped = abs.replace(/^([A-Za-z]):/, (_m, d: string) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()) + ":");
        await p.engram(flipped.toUpperCase(), "Alpha", "ASSERT Alpha is the public entry");
        expect(await p.outline("src/jobs.ts")).toContain("[Engram]: ASSERT Alpha is the public entry");
    });

    it("shows the engram under the matching search result only", async () => {
        const p = await project({ "src/jobs.ts": JOBS });
        await p.engine.indexDirectory(p.dir);
        await p.engram("src/jobs.ts", "Beta.run", "Beta.run must stay idempotent");
        const deps = { engine: p.engine } as unknown as RouterDependencies;
        const res = await handleSearch({ action: "search", query: "run number" } as never, deps);
        const blocks = (res.content[0]?.text ?? "").split(/\n(?=\d+\. )/);
        const beta = blocks.find(b => b.includes("jobs.ts:L8-L10"));
        const alpha = blocks.find(b => b.includes("jobs.ts:L2-L4"));
        expect(beta).toContain("[Engram]: Beta.run must stay idempotent");
        expect(alpha ?? "").not.toContain("[Engram]");
    });

    it("search keeps an ASSERT engram on a method after its body changes, and never shows it on a twin", async () => {
        const twins = [
            "export class Alpha {",
            "    run(): number {",
            "        return 42;",
            "    }",
            "}",
            "export class Beta {",
            "    run(): number {",
            "        return 42;",
            "    }",
            "}",
            "",
        ].join("\n");
        const p = await project({ "src/twins.ts": twins });
        await p.engine.indexDirectory(p.dir);
        await p.engram("src/twins.ts", "Beta.run", "ASSERT Beta.run must hold the ledger lock");

        const file = path.join(p.dir, "src/twins.ts");
        fs.writeFileSync(file, twins.replace(/(class Beta \{\n    run\(\): number \{\n        )return 42;/, "$1return 43;"));
        expect(fs.readFileSync(file, "utf8")).toContain("return 43;"); // Beta.run's body really changed
        await p.engine.indexFile(file);

        const deps = { engine: p.engine } as unknown as RouterDependencies;
        const res = await handleSearch({ action: "search", query: "run number" } as never, deps);
        const blocks = (res.content[0]?.text ?? "").split(/\n(?=\d+\. )/);
        expect(blocks.find(b => b.includes("twins.ts:L7-L9"))).toContain("[Engram]: ASSERT Beta.run must hold the ledger lock");
        expect(blocks.find(b => b.includes("twins.ts:L2-L4")) ?? "").not.toContain("[Engram]");
    });

    it("rejects oversized engram text", async () => {
        const p = await project({ "src/jobs.ts": JOBS });
        expect(await p.engram("src/jobs.ts", "Alpha", "x".repeat(ENGRAM_MAX_CHARS + 1))).toContain(`max ${ENGRAM_MAX_CHARS}`);
    });

    it("migrates engrams stored under absolute paths by older versions", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-engram-legacy-"));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        fs.mkdirSync(path.join(dir, "src"));
        fs.writeFileSync(path.join(dir, "src", "a.ts"), "export function f() { return 1; }\n");
        const dbPath = path.join(dir, "legacy.db");

        const old = new NrekiDB(dbPath); // no project root: stores the absolute path, like <= 12.0.0
        await old.initialize();
        old.upsertEngram(path.join(dir, "src", "a.ts"), "f", "h", "ASSERT legacy note");
        old.close();

        const db = new NrekiDB(dbPath, dir);
        await db.initialize();
        expect(db.getEngramsForFile(path.join(dir, "src", "a.ts")).get("f")?.insight).toBe("ASSERT legacy note");
        db.close();
    });
});
