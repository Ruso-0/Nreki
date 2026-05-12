/**
 * Phase 5 C.4.B.0c tests for the Type Ledger density helper.
 *
 * Stubs the DensityEngine interface end-to-end so we never touch
 * SQLite. The Gate 4 smoke test exercises the real engine path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    computeNrekiDensity,
    walkWorkspaceSources,
    type DensityEngine,
} from "../../../scripts/eval-phase5/runners/nreki-density.js";

let REPO: string;

async function seed(rel: string, body = "// x"): Promise<string> {
    const abs = path.join(REPO, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf-8");
    return abs;
}

interface FakeChunk {
    id: number;
    rel: string;
    consumes: string[];
    produces: string[];
}

function makeEngine(repoRoot: string, chunks: FakeChunk[]): DensityEngine {
    const consumesIndex = new Map<string, number[]>();
    const producesIndex = new Map<string, number[]>();
    const chunkById = new Map<number, FakeChunk>();
    for (const c of chunks) {
        chunkById.set(c.id, c);
        for (const t of c.consumes) {
            if (!consumesIndex.has(t)) consumesIndex.set(t, []);
            consumesIndex.get(t)!.push(c.id);
        }
        for (const t of c.produces) {
            if (!producesIndex.has(t)) producesIndex.set(t, []);
            producesIndex.get(t)!.push(c.id);
        }
    }
    const allTypes = new Set<string>([...consumesIndex.keys(), ...producesIndex.keys()]);
    return {
        getAllTypeNames: () => [...allTypes],
        getChunksByConsumedType: t => consumesIndex.get(t) ?? [],
        getChunksByProducedType: t => producesIndex.get(t) ?? [],
        getChunksByIds: ids => ids
            .map(id => chunkById.get(id))
            .filter((c): c is FakeChunk => c !== undefined)
            .map(c => ({ path: path.join(repoRoot, c.rel) })),
    };
}

beforeEach(async () => {
    REPO = await fs.mkdtemp(path.join(os.tmpdir(), "nreki-density-"));
});

afterEach(async () => {
    await fs.rm(REPO, { recursive: true, force: true });
});

describe("walkWorkspaceSources", () => {
    it("buckets .ts/.tsx as TS and .js/.jsx as JS", async () => {
        await seed("src/a.ts");
        await seed("src/b.tsx");
        await seed("legacy/c.js");
        await seed("legacy/d.jsx");
        const { tsFiles, jsFiles } = await walkWorkspaceSources(REPO);
        expect(tsFiles.has("src/a.ts")).toBe(true);
        expect(tsFiles.has("src/b.tsx")).toBe(true);
        expect(jsFiles.has("legacy/c.js")).toBe(true);
        expect(jsFiles.has("legacy/d.jsx")).toBe(true);
    });

    it("ignores .d.ts declaration files", async () => {
        await seed("src/a.ts");
        await seed("types/global.d.ts");
        const { tsFiles } = await walkWorkspaceSources(REPO);
        expect(tsFiles.has("src/a.ts")).toBe(true);
        expect(tsFiles.has("types/global.d.ts")).toBe(false);
    });

    it("skips node_modules, .git, dist, build, coverage, .next", async () => {
        await seed("src/a.ts");
        await seed("node_modules/lib/x.ts");
        await seed(".git/HEAD", "ref: refs/heads/main");
        await seed("dist/bundle.js");
        await seed("build/out.ts");
        await seed("coverage/report.js");
        await seed(".next/cache.ts");
        const { tsFiles, jsFiles } = await walkWorkspaceSources(REPO);
        expect(tsFiles.size).toBe(1);
        expect(tsFiles.has("src/a.ts")).toBe(true);
        expect(jsFiles.size).toBe(0);
    });

    it("returns empty sets for a workspace with no source files", async () => {
        await seed("README.md", "# docs");
        const { tsFiles, jsFiles } = await walkWorkspaceSources(REPO);
        expect(tsFiles.size).toBe(0);
        expect(jsFiles.size).toBe(0);
    });

    it("normalises paths to forward slashes regardless of OS", async () => {
        await seed("src/nested/deep/x.ts");
        const { tsFiles } = await walkWorkspaceSources(REPO);
        for (const p of tsFiles) {
            expect(p).not.toContain("\\");
        }
        expect(tsFiles.has("src/nested/deep/x.ts")).toBe(true);
    });
});

describe("computeNrekiDensity", () => {
    it("happy path: 3 TS files, 2 with edges, 1 isolated", async () => {
        await seed("src/a.ts");
        await seed("src/b.ts");
        await seed("src/c.ts");
        const engine = makeEngine(REPO, [
            { id: 1, rel: "src/a.ts", consumes: ["UserId"], produces: ["User"] },
            { id: 2, rel: "src/b.ts", consumes: ["User"], produces: [] },
            // src/c.ts: no chunks in symbol_io -> isolated
        ]);
        const d = await computeNrekiDensity(REPO, engine);
        expect(d.ts_files_count).toBe(3);
        // edges: a consumes 1 + produces 1 = 2; b consumes 1 = 1. Total 3.
        expect(d.ts_edges_count).toBe(3);
        // density = edges/files = 3/3 = 1.0
        expect(d.ts_density).toBeCloseTo(1.0);
        // isolated: 1/3
        expect(d.ts_isolated_pct).toBeCloseTo(1 / 3);
        // era: all TS, no JS -> 1.0
        expect(d.era_pct_ts_files).toBe(1);
    });

    it("zero TS files -> zeroed density without divide-by-zero", async () => {
        await seed("README.md");
        const engine = makeEngine(REPO, []);
        const d = await computeNrekiDensity(REPO, engine);
        expect(d.ts_files_count).toBe(0);
        expect(d.ts_edges_count).toBe(0);
        expect(d.ts_density).toBe(0);
        expect(d.ts_isolated_pct).toBe(0);
        expect(d.era_pct_ts_files).toBe(0);
    });

    it("era_pct_ts_files: mixed .ts / .js workspace", async () => {
        // 2 TS + 2 JS -> 50% TS
        await seed("src/a.ts");
        await seed("src/b.ts");
        await seed("legacy/c.js");
        await seed("legacy/d.js");
        const engine = makeEngine(REPO, []);
        const d = await computeNrekiDensity(REPO, engine);
        expect(d.era_pct_ts_files).toBeCloseTo(0.5);
        expect(d.ts_files_count).toBe(2);
        // All TS files are isolated because no chunks in symbol_io.
        expect(d.ts_isolated_pct).toBe(1);
    });

    it("edges in JS files do NOT count as non-isolated TS", async () => {
        await seed("src/a.ts");
        await seed("legacy/b.js");
        const engine = makeEngine(REPO, [
            { id: 1, rel: "legacy/b.js", consumes: ["X"], produces: ["Y"] },
        ]);
        const d = await computeNrekiDensity(REPO, engine);
        // 1 TS file, no TS chunks with edges -> isolated_pct = 1
        expect(d.ts_isolated_pct).toBe(1);
        // edges still count globally (2 rows from b.js)
        expect(d.ts_edges_count).toBe(2);
        // density = edges/ts_files_count = 2/1 (we report per TS file
        // even when edges came from JS; this preserves the audit signal)
        expect(d.ts_density).toBe(2);
    });

    it("Type Ledger empty (no symbol_io rows) -> isolated=1, edges=0", async () => {
        await seed("src/a.ts");
        await seed("src/b.ts");
        const engine = makeEngine(REPO, []);
        const d = await computeNrekiDensity(REPO, engine);
        expect(d.ts_edges_count).toBe(0);
        expect(d.ts_density).toBe(0);
        expect(d.ts_isolated_pct).toBe(1);
        expect(d.ts_files_count).toBe(2);
    });

    it("dense Type Ledger -> isolated_pct=0, density>1", async () => {
        for (let i = 0; i < 4; i++) await seed(`src/f${i}.ts`);
        const engine = makeEngine(REPO, [
            { id: 1, rel: "src/f0.ts", consumes: ["A", "B"], produces: ["C"] },
            { id: 2, rel: "src/f1.ts", consumes: ["C"], produces: ["D"] },
            { id: 3, rel: "src/f2.ts", consumes: ["D"], produces: ["E"] },
            { id: 4, rel: "src/f3.ts", consumes: ["E"], produces: ["A"] },
        ]);
        const d = await computeNrekiDensity(REPO, engine);
        expect(d.ts_files_count).toBe(4);
        // edges: 3 + 2 + 2 + 2 = 9
        expect(d.ts_edges_count).toBe(9);
        expect(d.ts_density).toBeCloseTo(9 / 4);
        expect(d.ts_isolated_pct).toBe(0);
    });
});
