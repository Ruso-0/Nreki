import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { handleFastGrep } from "../src/handlers/navigate.js";
import type { RouterDependencies } from "../src/router.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (err) {
            lastError = err;
            await sleep(100);
        }
    }
    if (lastError) throw lastError;
}

describe("engine watcher and fast_grep bootstrap", () => {
    let tmpDir: string;
    let engine: NrekiEngine;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-watch-"));
        const srcDir = path.join(tmpDir, "src");
        fs.mkdirSync(srcDir, { recursive: true });
        const watchRoot = srcDir.replace(/\\/g, "/");
        engine = new NrekiEngine({
            dbPath: path.join(tmpDir, ".nreki.db"),
            watchPaths: [watchRoot],
        });
    });

    afterEach(() => {
        engine.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function fastGrepText(query: string): Promise<string> {
        const response = await handleFastGrep(
            { action: "fast_grep", query, limit: 10 },
            { engine } as unknown as RouterDependencies,
        );
        return response.content[0]?.text ?? "";
    }

    function expectFastGrepHit(text: string, query: string): void {
        expect(text).toContain(`## Semantic Fast Grep: "${query}"`);
        expect(text).not.toContain("No matches found");
        expect(text).toContain(query);
    }

    it("bootstraps an empty index synchronously on first fast_grep", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "cold.ts"), [
            "export function coldStart(): string {",
            "    return 'COLD_START_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        expect(engine.getStats().filesIndexed).toBe(0);

        const text = await fastGrepText("COLD_START_TOKEN");

        expectFastGrepHit(text, "COLD_START_TOKEN");
        expect(engine.getStats().filesIndexed).toBe(1);
    });

    it("updates stale chunks after an external write", async () => {
        const changed: string[] = [];
        engine.onExternalFileChange(async file => { changed.push(file); });
        const file = path.join(tmpDir, "src", "reactive.ts");
        fs.writeFileSync(file, [
            "export function reactive(): string {",
            "    return 'REACTIVE_OLD_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        await engine.startWatcher();
        expectFastGrepHit(await fastGrepText("REACTIVE_OLD_TOKEN"), "REACTIVE_OLD_TOKEN");

        fs.writeFileSync(file, [
            "export function reactive(): string {",
            "    return 'REACTIVE_NEW_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await waitFor(async () => {
            expectFastGrepHit(await fastGrepText("REACTIVE_NEW_TOKEN"), "REACTIVE_NEW_TOKEN");
            expect(changed.map(p => path.resolve(p))).toContain(file);
        });
    });

    it("keeps indexing when a semantic refresh fails", async () => {
        const file = path.join(tmpDir, "src", "refresh.ts");
        fs.writeFileSync(file, "export const refresh = 1;\n");
        await engine.initialize();
        await engine.indexFile(file);
        engine.onExternalFileChange(async () => { throw new Error("temporary semantic failure"); });
        await engine.startWatcher();
        fs.writeFileSync(file, 'export const refresh = "REFRESH_RECOVERY_TOKEN";\n');
        await waitFor(async () => {
            expectFastGrepHit(await fastGrepText("REFRESH_RECOVERY_TOKEN"), "REFRESH_RECOVERY_TOKEN");
        });
    });

    it("does not duplicate chunks during watcher and fast_grep bootstrap race", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "race.ts"), [
            "export function race(): string {",
            "    return 'RACE_BOOTSTRAP_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        engine.startWatcher();
        const before = engine.getStats().totalChunks;
        const text = await fastGrepText("RACE_BOOTSTRAP_TOKEN");
        await sleep(700);
        const after = engine.getStats().totalChunks;

        expect(before).toBe(0);
        expectFastGrepHit(text, "RACE_BOOTSTRAP_TOKEN");
        expect(after).toBe(1);
    });

    it("configures the watcher as reactive-only", () => {
        const source = fs.readFileSync(path.resolve("src", "engine.ts"), "utf-8");
        expect(source).toContain("ignoreInitial: true");
    });

    it("starts the watcher without indexing initial files", async () => {
        fs.writeFileSync(path.join(tmpDir, "src", "idle.ts"), [
            "export function idle(): string {",
            "    return 'IDLE_BOOT_TOKEN';",
            "}",
        ].join("\n"), "utf-8");

        await engine.initialize();
        await engine.startWatcher();

        expect(engine.getStats().filesIndexed).toBe(0);
        expect(engine.getStats().totalChunks).toBe(0);
    });

    it("starts the reactive watcher after server connect", () => {
        const source = fs.readFileSync(path.resolve("src", "index.ts"), "utf-8");
        const connectIndex = source.indexOf("await server.connect(transport);");
        const watcherIndex = source.indexOf("engine.startWatcher();", connectIndex);

        expect(connectIndex).toBeGreaterThan(-1);
        expect(watcherIndex).toBeGreaterThan(connectIndex);
    });

    it("ignores back-to-back internal edits and still detects a subsequent external edit", async () => {
        const externalEvents: string[] = [];
        engine.onExternalFileChange(async file => { externalEvents.push(path.resolve(file)); });
        const file = path.join(tmpDir, "src", "seq.ts");
        fs.writeFileSync(file, "export const seq = 'V0';\n", "utf-8");

        await engine.initialize();
        await engine.indexFile(file);
        await engine.startWatcher();

        const v1 = "export const seq = 'INTERNAL_V1';\n";
        const v2 = "export const seq = 'INTERNAL_V2';\n";
        engine.expectInternalEdit(file, v1);
        fs.writeFileSync(file, v1, "utf-8");
        engine.expectInternalEdit(file, v2);
        fs.writeFileSync(file, v2, "utf-8");

        await waitFor(async () => {
            expectFastGrepHit(await fastGrepText("INTERNAL_V2"), "INTERNAL_V2");
        });
        await sleep(150);
        expect(externalEvents).toEqual([]);

        // Now an external edit reverts back to V1: must NOT be swallowed by superseded V1 ticket!
        fs.writeFileSync(file, v1, "utf-8");
        await waitFor(async () => {
            expectFastGrepHit(await fastGrepText("INTERNAL_V1"), "INTERNAL_V1");
            expect(externalEvents).toContain(path.resolve(file));
        });
    });

    it("notifies externalFileChange and invalidates dependency graph on external unlink", async () => {
        const externalEvents: string[] = [];
        engine.onExternalFileChange(async file => { externalEvents.push(path.resolve(file)); });
        const base = path.join(tmpDir, "src", "base.ts");
        const leaf = path.join(tmpDir, "src", "leaf.ts");
        fs.writeFileSync(base, "export const shared = 1;\n", "utf-8");
        fs.writeFileSync(leaf, "import { shared } from './base.js';\nexport const val = shared;\n", "utf-8");

        await engine.initialize();
        await engine.indexDirectory(path.join(tmpDir, "src"));
        expect(await engine.findDependents("base.ts")).toContain("leaf.ts");

        await engine.startWatcher();
        fs.unlinkSync(leaf);

        await waitFor(async () => {
            expect(externalEvents).toContain(path.resolve(leaf));
            expect(await engine.findDependents("base.ts")).not.toContain("leaf.ts");
        });
    });
});
