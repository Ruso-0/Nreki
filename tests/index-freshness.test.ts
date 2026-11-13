import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { handleFastGrep, handleSearch } from "../src/handlers/navigate.js";
import type { RouterDependencies } from "../src/router.js";

const roots: string[] = [];
const engines: NrekiEngine[] = [];
const OLD = "PREVIOUS_TOKEN_ZEBRA";
const CURRENT = "CURRENT_TOKEN_ZEBRA";
const DELETED = "REMOVED_TOKEN_ZEBRA";
const ADDED = "ADDED_TOKEN_ZEBRA";
const currentSource = `// moved while the server was stopped\n\n// current implementation\nexport function changingValue(): string { return "${CURRENT}"; }\n`;

function open(root: string): NrekiEngine {
    const engine = new NrekiEngine({ dbPath: path.join(root, ".nreki.db"), watchPaths: [root] });
    engines.push(engine);
    return engine;
}


describe("cold initialization lifecycle", () => {
    it("can reopen cleanly after shutdown interrupts the first lookup", async () => {
        const { engine } = await offlineChanges();
        const pending = engine.fastGrep(CURRENT, 20);
        engine.shutdown();
        await expect(pending).rejects.toThrow("Index session closed");
        expect(engine.hasFreshIndex()).toBe(false);
        expect((await engine.fastGrep(CURRENT, 20)).some(hit => hit.raw_code.includes(CURRENT))).toBe(true);
        expect(engine.hasFreshIndex()).toBe(true);
    });
});


async function offlineChanges(): Promise<{ root: string; engine: NrekiEngine }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-freshness-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "changed.ts"), `export function changingValue(): string { return "${OLD}"; }\n`);
    fs.writeFileSync(path.join(root, "removed.ts"), `export function removedValue(): string { return "${DELETED}"; }\n`);
    fs.writeFileSync(path.join(root, "keep.ts"), 'export function stableValue(): string { return "UNCHANGED_TOKEN_ZEBRA"; }\n');
    const first = open(root);
    await first.indexDirectory(root);
    first.shutdown();
    fs.writeFileSync(path.join(root, "changed.ts"), currentSource);
    fs.unlinkSync(path.join(root, "removed.ts"));
    fs.writeFileSync(path.join(root, "added.ts"), `export function addedValue(): string { return "${ADDED}"; }\n`);
    return { root, engine: open(root) };
}


describe("reconciliation failures and lifecycle", () => {
    it("does not certify a failed refresh and retries after the parser recovers", async () => {
        const { engine } = await offlineChanges();
        await engine.initialize();
        const parser = engine.getParser();
        const original = parser.parse.bind(parser);
        const parse = vi.spyOn(parser, "parse").mockImplementation(async (file, content) => {
            if (path.basename(file) === "changed.ts") throw new Error("simulated parser failure");
            return original(file, content);
        });
        await expect(engine.search("changingValue", 10)).rejects.toThrow("Index reconciliation failed");
        expect(engine.hasFreshIndex()).toBe(false);
        parse.mockRestore();
        const results = await engine.search("changingValue", 10);
        expect(results.find(r => r.symbolName === "changingValue")?.rawCode).toContain(CURRENT);
        expect(engine.hasFreshIndex()).toBe(true);
    });

    it("does not reopen the engine or write parsed chunks after shutdown", async () => {
        const { engine } = await offlineChanges();
        await engine.initialize();
        const initializing = vi.spyOn(engine, "initialize");
        const parser = engine.getParser();
        const original = parser.parse.bind(parser);
        let entered!: () => void;
        let resume!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { resume = resolve; });
        vi.spyOn(parser, "parse").mockImplementation(async (file, content) => {
            const result = await original(file, content);
            if (path.basename(file) === "changed.ts") {
                entered();
                await gate;
            }
            return result;
        });
        const lookup = engine.search("changingValue", 10);
        await started;
        engine.shutdown();
        const calls = initializing.mock.calls.length;
        resume();
        await expect(lookup).rejects.toThrow("Index session closed");
        expect(engine.hasFreshIndex()).toBe(false);
        expect(initializing).toHaveBeenCalledTimes(calls);
    });
});


afterEach(() => {
    vi.restoreAllMocks();
    for (const engine of engines.splice(0)) engine.shutdown();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persisted index freshness", () => {
    it("reconciles changed bodies, line numbers, additions and deletions before the first direct search", async () => {
        const { engine } = await offlineChanges();
        const results = await engine.search("changingValue", 10);
        const changed = results.find(r => r.symbolName === "changingValue");
        expect(changed?.rawCode).toContain(CURRENT);
        expect(changed?.rawCode).not.toContain(OLD);
        expect(changed?.startLine).toBe(4);
        expect((await engine.search("addedValue", 10)).some(r => r.rawCode.includes(ADDED))).toBe(true);
        expect((await engine.search("removedValue", 10)).some(r => r.rawCode.includes(DELETED))).toBe(false);
    });

    it("refreshes RAM fast_grep before serving a reopened database without watcher events", async () => {
        const { engine } = await offlineChanges();
        const deps = { engine } as RouterDependencies;
        const old = await handleFastGrep({ action: "fast_grep", query: OLD }, deps);
        expect(old.content[0].text).toContain("No matches found");
        const current = await handleFastGrep({ action: "fast_grep", query: CURRENT }, deps);
        expect(current.content[0].text).toContain("changingValue (L4)");
        expect((await engine.fastGrep(DELETED, 20))).toEqual([]);
        expect((await engine.fastGrep(ADDED, 20))).toHaveLength(1);
    });

    it("returns pending instead of stale source during MCP background reconciliation", async () => {
        const { engine } = await offlineChanges();
        const deps = { engine } as RouterDependencies;
        const pending = await handleSearch({ action: "search", query: "changingValue", include_raw: true }, deps);
        // Drain the shared indexing job before assertions/teardown, including on a failed assertion.
        await engine.fastGrep(CURRENT, 20);
        expect(pending.content[0].text).toContain("Index pending");
        expect(pending.content[0].text).not.toContain(OLD);
        const fresh = await handleSearch({ action: "search", query: "changingValue", include_raw: true }, deps);
        expect(fresh.content[0].text).toContain(CURRENT);
        expect(fresh.content[0].text).toContain("changed.ts:L4-L4");
    });

    it("shares one reconciliation between concurrent lookups and skips unchanged file hashes", async () => {
        const { engine } = await offlineChanges();
        await engine.initialize();
        const indexing = vi.spyOn(engine, "indexDirectory");
        const [search, grep] = await Promise.all([
            engine.search("changingValue", 10),
            engine.fastGrep(CURRENT, 20),
        ]);
        expect(search.some(r => r.rawCode.includes(CURRENT))).toBe(true);
        expect(grep.some(r => r.raw_code.includes(CURRENT))).toBe(true);
        expect(indexing).toHaveBeenCalledTimes(1);
        const stats = await indexing.mock.results[0].value;
        expect(stats).toEqual({ indexed: 2, skipped: 1, errors: 0 });
    });

    it("prunes vanished paths on explicit reindex without clearing neighbouring directories", async () => {
        const { root, engine } = await offlineChanges();
        const firstDir = path.join(root, "first");
        const neighbour = path.join(root, "first-neighbour");
        fs.mkdirSync(firstDir);
        fs.mkdirSync(neighbour);
        const gone = path.join(firstDir, "gone.ts");
        fs.writeFileSync(gone, 'export const GONE_SUBTREE_MARKER = "gone";\n');
        fs.writeFileSync(path.join(neighbour, "keep.ts"), 'export const NEIGHBOUR_MARKER = "keep";\n');
        await engine.indexDirectory(root);
        fs.unlinkSync(gone);
        await engine.indexDirectory(firstDir);
        expect(await engine.fastGrep("GONE_SUBTREE_MARKER", 20)).toEqual([]);
        expect(await engine.fastGrep("NEIGHBOUR_MARKER", 20)).toHaveLength(1);
    });

    it("purges a cached file that is now inside an ignored directory", async () => {
        const { root, engine } = await offlineChanges();
        const hidden = path.join(root, ".hidden");
        fs.mkdirSync(hidden);
        const ignored = path.join(hidden, "cached.ts");
        fs.writeFileSync(ignored, 'export const IGNORED_CACHED_MARKER = "old";\n');
        // Simulate a prior version/configuration that indexed a path excluded by the current walk.
        await engine.indexFile(ignored);
        await engine.indexDirectory(root);
        expect(await engine.fastGrep("IGNORED_CACHED_MARKER", 20)).toEqual([]);
    });
});
