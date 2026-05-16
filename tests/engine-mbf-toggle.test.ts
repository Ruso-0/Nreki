/**
 * Phase 5 C.3.E.2 runtime MBF toggle tests.
 *
 * Covers EngineConfig.enableMarkovBlanket default coercion + the
 * isMarkovBlanketEnabled() getter, plus a smoke that confirms the
 * flag does NOT contaminate fast_grep (Furia round 19 P1 hypothesis:
 * lexical retrieval must remain stable across the ablation cells).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NrekiEngine } from "../src/engine.js";

const FILE_SUGGEST = `export class SuggestModel {
    private context: unknown = null;
    triggerWith(ctx: unknown): string[] {
        if (ctx === null) return [];
        return ["one", "two"];
    }
}
`;
const FILE_COMPLETION = `export class CompletionModel {
    private cache = new Map<string, string[]>();
    read(key: string): string[] | undefined { return this.cache.get(key); }
}
`;
const FILE_UTILS = `export function parseTokens(input: string): string[] {
    return input.split(/\\s+/).filter(t => t.length > 0);
}
`;

async function buildEngine(
    workspace: string,
    enableMarkovBlanket?: boolean,
): Promise<NrekiEngine> {
    const config: ConstructorParameters<typeof NrekiEngine>[0] = {
        dbPath: path.join(workspace, ".nreki.db"),
        watchPaths: [workspace],
    };
    if (enableMarkovBlanket !== undefined) {
        config.enableMarkovBlanket = enableMarkovBlanket;
    }
    const engine = new NrekiEngine(config);
    await engine.initialize();
    return engine;
}

async function writeFile(ws: string, rel: string, content: string): Promise<void> {
    const abs = path.join(ws, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
}

async function seedWorkspace(ws: string): Promise<void> {
    await writeFile(ws, "src/SuggestModel.ts", FILE_SUGGEST);
    await writeFile(ws, "src/CompletionModel.ts", FILE_COMPLETION);
    await writeFile(ws, "src/utils.ts", FILE_UTILS);
}

describe("EngineConfig.enableMarkovBlanket", () => {
    let ws: string;
    let engine: NrekiEngine | undefined;
    let engineOff: NrekiEngine | undefined;

    beforeEach(async () => {
        ws = await fs.mkdtemp(path.join(os.tmpdir(), "mbf-toggle-"));
    });

    afterEach(async () => {
        engine?.shutdown();
        engine = undefined;
        engineOff?.shutdown();
        engineOff = undefined;
        await fs.rm(ws, { recursive: true, force: true });
    });

    it("defaults to true when the field is omitted from EngineConfig", async () => {
        engine = new NrekiEngine({
            dbPath: path.join(ws, ".nreki.db"),
            watchPaths: [ws],
        });
        expect(engine.isMarkovBlanketEnabled()).toBe(true);
    });

    it("is true when explicitly set to true", async () => {
        engine = new NrekiEngine({
            dbPath: path.join(ws, ".nreki.db"),
            watchPaths: [ws],
            enableMarkovBlanket: true,
        });
        expect(engine.isMarkovBlanketEnabled()).toBe(true);
    });

    it("is false when explicitly set to false", async () => {
        engine = new NrekiEngine({
            dbPath: path.join(ws, ".nreki.db"),
            watchPaths: [ws],
            enableMarkovBlanket: false,
        });
        expect(engine.isMarkovBlanketEnabled()).toBe(false);
    });

    it("toggle does NOT affect fastGrep / indexer behavior", async () => {
        await seedWorkspace(ws);

        engine = await buildEngine(ws, true);
        await engine.indexDirectory(ws);
        const hitsOn = await engine.fastGrep("SuggestModel", 10);

        // Re-seed under a sibling workspace so the second engine builds
        // a fresh DB (cleaner than reusing the first DB file).
        const ws2 = await fs.mkdtemp(path.join(os.tmpdir(), "mbf-toggle-off-"));
        try {
            await seedWorkspace(ws2);
            engineOff = await buildEngine(ws2, false);
            await engineOff.indexDirectory(ws2);
            const hitsOff = await engineOff.fastGrep("SuggestModel", 10);

            // Both engines must surface SuggestModel hits identically.
            const fileSetOn = new Set(hitsOn.map(h => path.basename(h.path)));
            const fileSetOff = new Set(hitsOff.map(h => path.basename(h.path)));
            expect(fileSetOn).toEqual(fileSetOff);
            expect(fileSetOn.has("SuggestModel.ts")).toBe(true);

            expect(engine.isMarkovBlanketEnabled()).toBe(true);
            expect(engineOff.isMarkovBlanketEnabled()).toBe(false);
        } finally {
            await fs.rm(ws2, { recursive: true, force: true });
        }
    });
});
