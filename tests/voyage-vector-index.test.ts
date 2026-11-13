/**
 * Opt-in Voyage whole-repository index (mocked fetch, no network):
 *  - off unless NREKI_SEMANTIC=voyage (a VOYAGE_API_KEY alone never sends code)
 *  - every eligible chunk embedded once as "document"; sensitive files never sent
 *  - vectors persist (restart = no API calls) and unchanged chunks are reused
 *  - finds a chunk that shares NO words with the query (BM25 cannot)
 *  - invalid key stops indexing, 429 is retried, search always falls back to BM25
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { NrekiDB } from "../src/database.js";
import { VectorIndex } from "../src/search/vector-index.js";
import { resolveVoyageConfig } from "../src/search/voyage.js";

const FILES: Record<string, string> = {
    "src/guard/limits.ts":
        "export function ensureContained(root: string, target: string): string {\n" +
        "    if (target.startsWith(\"..\")) { throw new Error(\"traversal\"); }\n" +
        "    return target;\n" +
        "}\n",
    "src/format/counts.ts":
        "export function formatTokenCount(n: number): string {\n" +
        "    return `${n} tokens consumed so far in this run`;\n" +
        "}\n",
    "src/.env.ts": "export const API_KEY = \"xyz-secret-value-do-not-send-abcdefghijklmnopqrstuvwxyz\";\n",
};
const CONCEPT_QUERY = "how do we keep paths inside the workspace boundary";

/** Deterministic fake embeddings: one axis per concept. */
function conceptVector(text: string): number[] {
    const t = text.toLowerCase();
    const v = [0, 0, 0, 0.05];
    if (/traversal|contained|inside the workspace/.test(t)) v[0] = 1;
    if (/token/.test(t)) v[1] = 1;
    if (/api_key/.test(t)) v[2] = 1;
    return v;
}

type Body = { input: string[]; model: string; input_type: string };
function voyageMock(status = 200) {
    const calls: Body[] = [];
    const fn = vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Body;
        calls.push(body);
        if (status !== 200) return { ok: false, status, headers: new Headers(), json: async () => ({}) };
        return {
            ok: true, status: 200, headers: new Headers(),
            json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: conceptVector(text) })) }),
        };
    });
    const docTexts = () => calls.filter(c => c.input_type === "document").flatMap(c => c.input);
    return { fn, calls, docTexts };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-voyage-"));
    for (const [rel, content] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

async function openEngine(dir: string): Promise<NrekiEngine> {
    const engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki-test.db"), watchPaths: [dir] });
    await engine.initialize();
    cleanups.push(() => engine.shutdown());
    return engine;
}

const optIn = () => {
    vi.stubEnv("NREKI_SEMANTIC", "voyage");
    vi.stubEnv("VOYAGE_API_KEY", "pa-test");
};

describe("Voyage semantic index (opt-in)", () => {
    it("is off with only VOYAGE_API_KEY set: no vectors, no network", async () => {
        vi.stubEnv("NREKI_SEMANTIC", "");
        vi.stubEnv("VOYAGE_API_KEY", "pa-test");
        const mock = voyageMock();
        vi.stubGlobal("fetch", mock.fn);
        expect(resolveVoyageConfig()).toBeNull();

        const engine = await openEngine(makeProject());
        await engine.indexDirectory(engine.getProjectRoot());
        expect(await engine.syncSemanticIndex()).toBeNull();
        await engine.search(CONCEPT_QUERY, 5);
        expect(mock.fn).not.toHaveBeenCalled();
    });

    it("embeds each eligible chunk once, never sensitive files, and reuses stored vectors", async () => {
        optIn();
        const mock = voyageMock();
        vi.stubGlobal("fetch", mock.fn);
        const dir = makeProject();

        const engine = await openEngine(dir);
        await engine.indexDirectory(dir);
        const coverage = await engine.syncSemanticIndex();
        expect(coverage).not.toBeNull();
        expect(coverage!.embedded).toBe(coverage!.total);
        expect(coverage!.total).toBeGreaterThanOrEqual(2);

        const sent = mock.docTexts();
        expect(sent.length).toBe(coverage!.total);
        expect(sent.join("\n")).not.toContain("xyz-secret");
        expect(mock.calls.every(c => c.model === "voyage-code-4")).toBe(true);

        // Same process, nothing changed → no calls.
        await engine.syncSemanticIndex();
        expect(mock.docTexts().length).toBe(sent.length);

        // Restart on the same DB → vectors come from disk.
        engine.shutdown();
        const reopened = await openEngine(dir);
        await reopened.syncSemanticIndex();
        expect(mock.docTexts().length).toBe(sent.length);

        // One file changes → only its chunk is embedded again.
        const file = path.join(dir, "src/format/counts.ts");
        fs.writeFileSync(file, FILES["src/format/counts.ts"].replace("so far", "until now"));
        await reopened.indexFile(file);
        await reopened.syncSemanticIndex();
        const fresh = mock.docTexts().slice(sent.length);
        expect(fresh.length).toBeGreaterThan(0);
        expect(fresh.every(t => t.includes("counts.ts"))).toBe(true);
    });

    it("finds a chunk that shares no words with the query, which BM25 alone cannot", async () => {
        const dir = makeProject();

        vi.stubEnv("NREKI_SEMANTIC", "");
        const lexical = await openEngine(dir);
        await lexical.indexDirectory(dir);
        const bm25 = await lexical.search(CONCEPT_QUERY, 5);
        expect(bm25.some(r => r.path.endsWith("limits.ts"))).toBe(false);
        lexical.shutdown();

        optIn();
        vi.stubGlobal("fetch", voyageMock().fn);
        const semantic = await openEngine(dir);
        await semantic.syncSemanticIndex();
        const hits = await semantic.search(CONCEPT_QUERY, 5);
        expect(hits[0]?.path.endsWith("limits.ts")).toBe(true);
    });

    it("stops on an invalid key without retrying, and search still answers from BM25", async () => {
        optIn();
        const mock = voyageMock(401);
        vi.stubGlobal("fetch", mock.fn);
        const engine = await openEngine(makeProject());
        await engine.indexDirectory(engine.getProjectRoot());
        const coverage = await engine.syncSemanticIndex();
        expect(coverage?.embedded).toBe(0);
        expect(mock.calls.filter(c => c.input_type === "document").length).toBe(1);
        const res = await engine.search("formatTokenCount tokens", 5);
        expect(res[0]?.path.endsWith("counts.ts")).toBe(true);
    });

    it("retries a 429 and then stores the vectors", async () => {
        const dir = makeProject();
        const db = new NrekiDB(path.join(dir, "direct.db"), dir);
        await db.initialize();
        cleanups.push(() => db.close());
        db.insertChunk(path.join(dir, "src/guard/limits.ts"), "fn", FILES["src/guard/limits.ts"], "function", 1, 4, 0, 10, "ensureContained");

        let first = true;
        vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
            if (first) {
                first = false;
                return { ok: false, status: 429, headers: new Headers(), json: async () => ({}) };
            }
            const body = JSON.parse(init.body) as Body;
            return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: body.input.map((t, index) => ({ index, embedding: conceptVector(t) })) }) };
        }));
        const index = new VectorIndex(db, { apiKey: "k", model: "voyage-code-4" }, dir, { retryBaseMs: 1 });
        await index.sync();
        expect(index.coverage()).toEqual({ embedded: 1, total: 1 });
    });

    it("adapts to an account limited to 3 RPM / 10K TPM: smaller batches, paced, everything embedded", async () => {
        const dir = makeProject();
        const db = new NrekiDB(path.join(dir, "limited.db"), dir);
        await db.initialize();
        cleanups.push(() => db.close());
        // 40 chunks of ~1,700 chars (~490 tokens each, ~19.5K in all): one default
        // batch (≤ 64 texts, ≤ 60K tokens) is twice the per-minute token limit.
        for (let i = 0; i < 40; i++) {
            const body = `export function helper${i}(x: number): number {\n` + `    x = x + ${i}; // padding line for size\n`.repeat(45) + "    return x;\n}\n";
            db.insertChunk(path.join(dir, `src/h${i}.ts`), "fn", body, "function", 1, 48, 0, body.length, `helper${i}`);
        }

        // A Voyage that enforces what its 429 says, per 40 ms "minute".
        const WINDOW = 40;
        const detail = "You have not yet added your payment method in the billing page and will have reduced rate limits of 3 RPM and 10K TPM.";
        const accepted: number[] = [];
        let recent: Array<{ at: number; tokens: number }> = [];
        vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => {
            const body = JSON.parse(init.body) as Body;
            const tokens = Math.ceil(body.input.reduce((n, t) => n + t.length, 0) / 3.5);
            const now = Date.now();
            recent = recent.filter(r => now - r.at < WINDOW);
            const used = recent.reduce((n, r) => n + r.tokens, 0);
            if (recent.length >= 3 || used + tokens > 10_000) {
                recent.push({ at: now, tokens: 0 });
                return { ok: false, status: 429, headers: new Headers(), text: async () => JSON.stringify({ detail }), json: async () => ({ detail }) };
            }
            recent.push({ at: now, tokens });
            accepted.push(tokens);
            return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: body.input.map((t, index) => ({ index, embedding: conceptVector(t) })) }) };
        }));

        const index = new VectorIndex(db, { apiKey: "k", model: "voyage-code-4" }, dir, { retryBaseMs: 1, rateWindowMs: WINDOW });
        await index.sync();
        expect(index.coverage()).toEqual({ embedded: 40, total: 40 });
        expect(Math.max(...accepted)).toBeLessThanOrEqual(8_000); // 80 % of the stated TPM
    });
});

describe("parseRateLimits", () => {
    it("reads the limits Voyage states for an account without a payment method", async () => {
        const { parseRateLimits } = await import("../src/search/voyage.js");
        expect(parseRateLimits("reduced rate limits of 3 RPM and 10K TPM. To unlock")).toEqual({ rpm: 3, tpm: 10_000 });
        expect(parseRateLimits("limits of 2000 RPM and 3M TPM")).toEqual({ rpm: 2000, tpm: 3_000_000 });
        expect(parseRateLimits("rate limited")).toBeNull();
    });
});
