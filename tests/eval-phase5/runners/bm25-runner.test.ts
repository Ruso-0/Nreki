/**
 * Phase 5 C.3.C BM25 runner tests.
 *
 * Standalone Okapi BM25 — pure functions over in-memory state.
 * Uses real fs only for buildBM25Index / runBM25 end-to-end paths,
 * via per-test tmpdir workspaces.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    tokenizeForBM25,
    buildBM25Index,
    scoreBM25,
    runBM25,
    BM25_K1,
    BM25_B,
    type BM25DocStats,
} from "../../../scripts/eval-phase5/runners/bm25-runner.js";
import type { PolyBenchTask } from "../../../scripts/eval-phase5/types.js";

function mkTask(problem: string, overrides: Partial<PolyBenchTask> = {}): PolyBenchTask {
    return {
        repo: "owner/repo",
        pr_number: 1,
        instance_id: "owner__repo-1",
        base_commit: "abc",
        patch: "",
        test_patch: "",
        problem_statement: problem,
        modified_nodes: [],
        task_category: "Bug Fix",
        F2P: [],
        P2P: [],
        dockerfile: "",
        test_command: "",
        language: "TypeScript",
        ...overrides,
    };
}

describe("tokenizeForBM25", () => {
    it("decomposes CamelCase identifiers into subtokens (plus lowered original)", () => {
        const toks = tokenizeForBM25("SuggestModel.triggerWith");
        expect(toks).toContain("suggestmodel");
        expect(toks).toContain("triggerwith");
        expect(toks).toContain("suggest");
        expect(toks).toContain("model");
        expect(toks).toContain("trigger");
        expect(toks).toContain("with");
    });

    it("decomposes snake_case identifiers", () => {
        const toks = tokenizeForBM25("parse_modified_nodes");
        expect(toks).toContain("parse_modified_nodes");
        expect(toks).toContain("parse");
        expect(toks).toContain("modified");
        expect(toks).toContain("nodes");
    });

    it("does NOT filter stopwords (BM25 uses IDF instead)", () => {
        const toks = tokenizeForBM25("the quick brown fox");
        expect(toks).toContain("the");
        expect(toks).toContain("quick");
        expect(toks).toContain("brown");
        expect(toks).toContain("fox");
    });

    it("drops single-character tokens", () => {
        expect(tokenizeForBM25("a")).toEqual([]);
    });

    it("splits path-like input on slashes and dots", () => {
        const toks = tokenizeForBM25("src/foo/bar.ts");
        expect(toks).toContain("src");
        expect(toks).toContain("foo");
        expect(toks).toContain("bar");
        expect(toks).toContain("ts");
    });

    it("returns [] for empty input", () => {
        expect(tokenizeForBM25("")).toEqual([]);
    });
});

describe("buildBM25Index", () => {
    let ws: string;
    beforeEach(async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), "bm25-test-"));
    });
    afterEach(async () => {
        await fs.rm(ws, { recursive: true, force: true });
    });

    async function writeFile(rel: string, content: string): Promise<void> {
        const abs = path.join(ws, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");
    }

    it("counts only non-test files in total_docs", async () => {
        await writeFile("src/a.ts", "export const A = 1;");
        await writeFile("src/b.ts", "export const B = 2;");
        await writeFile("src/c.ts", "export const C = 3;");
        await writeFile("tests/foo.test.ts", "// excluded");
        const idx = await buildBM25Index(ws);
        expect(idx.total_docs).toBe(3);
        const paths = idx.docs.map(d => d.path);
        expect(paths).not.toContain("tests/foo.test.ts");
    });

    it("computes avg_doc_length", async () => {
        await writeFile("src/short.ts", "x y");
        await writeFile("src/long.ts", "alpha beta gamma delta");
        const idx = await buildBM25Index(ws);
        const sum = idx.docs.reduce((acc, d) => acc + d.length, 0);
        expect(idx.avg_doc_length).toBeCloseTo(sum / idx.total_docs, 5);
    });

    it("populates doc_freq for terms shared across docs", async () => {
        await writeFile("src/a.ts", "alpha beta");
        await writeFile("src/b.ts", "alpha gamma");
        await writeFile("src/c.ts", "alpha delta");
        const idx = await buildBM25Index(ws);
        expect(idx.doc_freq.get("alpha")).toBe(3);
        expect(idx.doc_freq.get("beta")).toBe(1);
        expect(idx.doc_freq.get("delta")).toBe(1);
    });
});

describe("scoreBM25", () => {
    function mkDoc(p: string, tokens: string[]): BM25DocStats {
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        return { path: p, tokens, term_freq: tf, length: tokens.length };
    }

    it("returns positive score when the doc contains all query terms", () => {
        const docs = [
            mkDoc("a.ts", ["foo", "bar", "baz"]),
            mkDoc("b.ts", ["qux", "quux"]),
        ];
        const docFreq = new Map<string, number>();
        for (const d of docs) for (const t of d.term_freq.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        const idx = {
            docs,
            avg_doc_length: (docs[0].length + docs[1].length) / 2,
            doc_freq: docFreq,
            total_docs: 2,
        };
        const s = scoreBM25(docs[0], ["foo", "bar"], idx);
        expect(s).toBeGreaterThan(0);
    });

    it("returns 0 when the doc contains no query terms", () => {
        const docs = [
            mkDoc("a.ts", ["foo", "bar"]),
            mkDoc("b.ts", ["qux"]),
        ];
        const docFreq = new Map<string, number>();
        for (const d of docs) for (const t of d.term_freq.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        const idx = {
            docs,
            avg_doc_length: (docs[0].length + docs[1].length) / 2,
            doc_freq: docFreq,
            total_docs: 2,
        };
        const s = scoreBM25(docs[0], ["zzz"], idx);
        expect(s).toBe(0);
    });

    it("length normalization: short doc with same TF outranks long doc", () => {
        // Construct two docs with identical tf("foo")=1 but
        // very different lengths. The shorter doc should score higher.
        const short = mkDoc("short.ts", ["foo", "bar"]); // |D| = 2
        const long: BM25DocStats = {
            path: "long.ts",
            tokens: ["foo", ...Array.from({ length: 200 }, () => "bar")],
            term_freq: new Map([["foo", 1], ["bar", 200]]),
            length: 201,
        };
        const docFreq = new Map<string, number>([
            ["foo", 2],
            ["bar", 2],
        ]);
        const idx = {
            docs: [short, long],
            avg_doc_length: (short.length + long.length) / 2,
            doc_freq: docFreq,
            total_docs: 2,
        };
        const sShort = scoreBM25(short, ["foo"], idx);
        const sLong = scoreBM25(long, ["foo"], idx);
        expect(sShort).toBeGreaterThan(sLong);
    });

    it("IDF: term present in every doc contributes near-zero score", () => {
        const docs = [
            mkDoc("a.ts", ["common"]),
            mkDoc("b.ts", ["common"]),
            mkDoc("c.ts", ["common"]),
        ];
        const docFreq = new Map<string, number>([["common", 3]]);
        const idx = {
            docs,
            avg_doc_length: 1,
            doc_freq: docFreq,
            total_docs: 3,
        };
        const s = scoreBM25(docs[0], ["common"], idx);
        // ln((3-3+0.5)/(3+0.5)+1) = ln(1 + 0.5/3.5) ≈ 0.134 — small
        expect(s).toBeLessThan(0.5);
        expect(s).toBeGreaterThan(0);
    });

    it("exposes k1 and b parameters", () => {
        const doc = mkDoc("a.ts", ["foo", "foo", "foo"]);
        const idx = {
            docs: [doc],
            avg_doc_length: 3,
            doc_freq: new Map<string, number>([["foo", 1]]),
            total_docs: 1,
        };
        const sLow = scoreBM25(doc, ["foo"], idx, 0.1, BM25_B);
        const sHigh = scoreBM25(doc, ["foo"], idx, 5.0, BM25_B);
        // Higher k1 saturates more slowly → higher score for tf=3
        expect(sHigh).toBeGreaterThan(sLow);
    });
});

describe("runBM25 end-to-end", () => {
    let ws: string;
    beforeEach(async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), "bm25-e2e-"));
    });
    afterEach(async () => {
        await fs.rm(ws, { recursive: true, force: true });
    });

    async function writeFile(rel: string, content: string): Promise<void> {
        const abs = path.join(ws, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");
    }

    it("happy path: top-1 is the file with most query term hits", async () => {
        await writeFile(
            "src/SuggestModel.ts",
            "export class SuggestModel { triggerWith(): void {} }",
        );
        await writeFile("src/CompletionModel.ts", "export class CompletionModel {}");
        await writeFile("src/utils.ts", "export function parseTokens() {}");
        const task = mkTask("SuggestModel.triggerWith fails on null context");
        const res = await runBM25(task, ws, 3);
        expect(res.error).toBeUndefined();
        expect(res.retriever).toBe("bm25");
        expect(res.retrieved_files[0]).toBe("src/SuggestModel.ts");
    });

    it("respects top-K cap", async () => {
        for (let i = 0; i < 10; i++) {
            await writeFile(`src/f${i}.ts`, "alpha beta gamma");
        }
        const task = mkTask("alpha");
        const res = await runBM25(task, ws, 3);
        expect(res.retrieved_files.length).toBeLessThanOrEqual(3);
    });

    it("anti-tests filter excludes test files from results", async () => {
        await writeFile("src/foo.ts", "alpha beta");
        await writeFile("tests/foo.test.ts", "alpha beta gamma");
        const task = mkTask("alpha");
        const res = await runBM25(task, ws, 5);
        expect(res.retrieved_files).toContain("src/foo.ts");
        expect(res.retrieved_files).not.toContain("tests/foo.test.ts");
    });

    it("RetrievalResult shape: token_cost populated via universal tokenizer, retriever=bm25", async () => {
        await writeFile("src/a.ts", "alpha beta");
        const task = mkTask("alpha");
        const res = await runBM25(task, ws, 3);
        expect(res.retriever).toBe("bm25");
        // C.3.E.1 retrofit: token_cost is now mandatory and counts the
        // payload tiktoken cl100k_base.
        expect(res.token_cost.total_tokens).toBeGreaterThan(0);
        expect(res.token_cost.output_tokens).toBe(0);
        // File-level chunk for the single retrieved file.
        expect(res.retrieved_chunks).toHaveLength(1);
        expect(res.retrieved_chunks[0].file_path).toBe("src/a.ts");
        expect(res.retrieved_chunks[0].start_line).toBe(1);
        expect(typeof res.latency_ms).toBe("number");
        expect(res.instance_id).toBe("owner__repo-1");
    });
});
