/**
 * sprint80-foveal-epicenter.test.ts
 *
 * Sprint 8.0 Phase 1.2 — Binary verification: does foveal compression
 * preserve the focus symbol's body and elide non-focus bodies?
 *
 * Findings being pinned (so a future refactor cannot silently break them):
 *  A. The focus symbol's `rawCode` appears verbatim in the compressed payload
 *  B. A non-focus symbol's body (>3 lines of distinctive code) does NOT
 *     appear verbatim in the compressed payload (only its signature can)
 *  C. The focus body is preceded by its line-range comment (L<start>-L<end>)
 *     when a focus was resolved (sanity; the old "FOVEA (100% Resolution)"
 *     banner was cut for token cost)
 *
 * Note on scope (Sprint 8.0 honest):
 *  This test verifies the focus-symbol preservation rule. It does NOT yet
 *  test the proposed anti-elision rule "preserve body of TOPOLOGICAL
 *  EPICENTERS even when they are NOT the focus". That rule is a Sprint
 *  8.0.1 PROPOSAL — the current code elides non-focus bodies regardless
 *  of tier. This test pins what is REAL today.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ASTParser } from "../src/parser.js";
import { tfcCompress } from "../src/compressor-foveal.js";
import type { NrekiEngine } from "../src/engine.js";

let tmpDir: string;
let parser: ASTParser;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprint80-foveal-"));
    parser = new ASTParser();
    await parser.initialize();
});

afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/**
 * Build a minimal NrekiEngine stub sufficient for tfcCompress with
 * crossFileOpts.maxCrossFile = 0 (no Type Ledger walk).
 */
function makeStubEngine(): NrekiEngine {
    return {
        getParser: () => parser,
        getProjectRoot: () => tmpDir,
        findDependents: async () => [],
        resolveImportSignatures: () => [],
        incrementAutoContext: () => {},
    } as unknown as NrekiEngine;
}

/** Construct a synthetic TS file ≥100 lines with two large functions. */
function buildSyntheticSource(): { source: string; epicenterBody: string; neighborBody: string } {
    // Each function body has a distinctive payload string that we'll grep
    // for in the compressed output. The bodies are 30+ lines each so the
    // file clears the 100-line bypass at compressor-foveal.ts:109.
    const epicenterBody = Array.from({ length: 35 }, (_, i) =>
        `    const epicenterSecret_${i} = "EPICENTER_PAYLOAD_${i}_distinctive_marker";`
    ).join("\n");
    const neighborBody = Array.from({ length: 35 }, (_, i) =>
        `    const neighborSecret_${i} = "NEIGHBOR_PAYLOAD_${i}_distinctive_marker";`
    ).join("\n");
    const source = [
        "// synthetic file for Sprint 8.0 Phase 1.2",
        "export type SessionToken = string;",
        "",
        "export function helperUtil(x: number): number {",
        "    return x * 2;",
        "}",
        "",
        "/**",
        " * The EPICENTER under test — this is what the agent focuses on.",
        " */",
        "export function validateToken(token: SessionToken): boolean {",
        epicenterBody,
        "    return token.length > 0;",
        "}",
        "",
        "/**",
        " * A neighboring (non-focus) symbol that exercises distinct logic.",
        " */",
        "export function refreshSession(id: string): SessionToken {",
        neighborBody,
        "    return id + \"-refreshed\";",
        "}",
        "",
        "/** Orthogonal dark-matter that should not even be summarized. */",
        "function darkMatter_unrelated(): void {",
        "    const orthogonalMarker = \"DARK_MATTER_unique_payload\";",
        "    console.log(orthogonalMarker);",
        "}",
        "",
        "// Padding to clear the 100-line bypass at compressor-foveal.ts:109",
        ...Array.from({ length: 40 }, (_, i) => `// padding line ${i}`),
    ].join("\n");
    return { source, epicenterBody, neighborBody };
}

describe("Sprint 8.0 Phase 1.2 — foveal binary findings", () => {
    it("A. focus symbol body appears verbatim in compressed payload", async () => {
        const { source } = buildSyntheticSource();
        const filePath = path.join(tmpDir, "session.ts");
        fs.writeFileSync(filePath, source, "utf-8");

        const result = await tfcCompress(
            filePath,
            source,
            "validateToken",
            makeStubEngine(),
            { maxCrossFile: 0 },
        );

        expect(result.kind).toBe("success");
        if (result.kind !== "success") return;

        // The focus body's distinctive marker MUST appear (verbatim copy of rawCode).
        expect(result.data.compressed).toContain("EPICENTER_PAYLOAD_0_distinctive_marker");
        expect(result.data.compressed).toContain("EPICENTER_PAYLOAD_34_distinctive_marker");
        // The focus body is announced by its line range.
        expect(result.data.compressed).toMatch(/\/\* L\d+-L\d+ \*\/\n[^\n]*validateToken/);
        // And the foci metadata names the focus symbol.
        expect(result.data.zones.foveas).toContain("validateToken");
    });

    it("B. non-focus symbol body is elided (only signature surfaces)", async () => {
        const { source } = buildSyntheticSource();
        const filePath = path.join(tmpDir, "session2.ts");
        fs.writeFileSync(filePath, source, "utf-8");

        const result = await tfcCompress(
            filePath,
            source,
            "validateToken",  // focus
            makeStubEngine(),
            { maxCrossFile: 0 },
        );

        expect(result.kind).toBe("success");
        if (result.kind !== "success") return;

        // The NEIGHBOR's distinctive markers must NOT appear (its body is elided).
        // We sample a few; any one leaking is a finding.
        expect(result.data.compressed).not.toContain("NEIGHBOR_PAYLOAD_0_distinctive_marker");
        expect(result.data.compressed).not.toContain("NEIGHBOR_PAYLOAD_17_distinctive_marker");
        expect(result.data.compressed).not.toContain("NEIGHBOR_PAYLOAD_34_distinctive_marker");

        // Dark-matter body must also be absent (it is omitted entirely).
        expect(result.data.compressed).not.toContain("DARK_MATTER_unique_payload");
    });

    it("C. tiny files: a focus returns that symbol; a focus that is the whole file trips the shield (the handler returns the file)", async () => {
        // No small-file bypass any more (it returned 17 lines for a 4-line focus);
        // the shield still keeps a focus from costing more than the file.
        const tinySource = [
            "export function tinyFoo() { return 1; }",
            "export function tinyBar() { return 2; }",
        ].join("\n");
        const filePath = path.join(tmpDir, "tiny.ts");
        fs.writeFileSync(filePath, tinySource, "utf-8");

        const one = await tfcCompress(filePath, tinySource, "tinyFoo", makeStubEngine(), { maxCrossFile: 0 });
        expect(one.kind).toBe("success");
        if (one.kind !== "success") return;
        expect(one.data.compressed).toContain("tinyFoo");
        expect(one.data.compressed).not.toContain("tinyBar");

        const single = "export function onlyFn() { return 1; }\n";
        const singlePath = path.join(tmpDir, "single.ts");
        fs.writeFileSync(singlePath, single, "utf-8");
        const whole = await tfcCompress(singlePath, single, "onlyFn", makeStubEngine(), { maxCrossFile: 0 });
        expect(whole.kind).toBe("shield_tripped");
    });

    it("C2. on a small file a focus on one symbol among several returns only that symbol", async () => {
        const helpers = Array.from({ length: 6 }, (_, i) =>
            `export function helper${i}(value: number): number {\n    const shifted = value + ${i};\n    return shifted * ${i + 2};\n}`).join("\n\n");
        const smallSource = `${helpers}\n\nexport function target(x: number): number {\n    return x - 1;\n}\n`;
        const filePath = path.join(tmpDir, "small.ts");
        fs.writeFileSync(filePath, smallSource, "utf-8");

        const result = await tfcCompress(filePath, smallSource, "target", makeStubEngine(), { maxCrossFile: 0 });

        expect(result.kind).toBe("success");
        if (result.kind !== "success") return;
        expect(result.data.compressed).toContain("export function target(x: number): number {");
        expect(result.data.compressed).not.toContain("helper3");
        expect(result.data.compressed.length).toBeLessThan(smallSource.length / 2);
    });
});

describe("Sprint 8.0 — FOVEAL_OFF=1 control arm (symmetric to Phase 1.2)", () => {
    const PRIOR = process.env.FOVEAL_OFF;
    afterEach(() => {
        // Restore env so the flag never leaks into other suites.
        if (PRIOR === undefined) delete process.env.FOVEAL_OFF;
        else process.env.FOVEAL_OFF = PRIOR;
    });

    it("D. FOVEAL_OFF=1 forces raw passthrough on a LARGE file (no elision, ratio 0)", async () => {
        process.env.FOVEAL_OFF = "1";
        const { source } = buildSyntheticSource();
        const filePath = path.join(tmpDir, "ctrl-on.ts");
        fs.writeFileSync(filePath, source, "utf-8");

        const result = await tfcCompress(
            filePath,
            source,
            "validateToken",
            makeStubEngine(),
            { maxCrossFile: 0 },
        );

        expect(result.kind).toBe("success");
        if (result.kind !== "success") return;

        // Control arm = vanilla raw read: compressed === content, ratio 0.
        expect(result.data.compressed).toBe(source);
        expect(result.data.ratio).toBe(0);
        // BOTH focus and neighbor bodies are present (nothing elided).
        expect(result.data.compressed).toContain("EPICENTER_PAYLOAD_0_distinctive_marker");
        expect(result.data.compressed).toContain("NEIGHBOR_PAYLOAD_0_distinctive_marker");
        expect(result.data.compressed).toContain("DARK_MATTER_unique_payload");
        // No foveal structure injected.
        expect(result.data.compressed).not.toContain("NREKI TFC-PRO");
        expect(result.data.compressed).not.toMatch(/FOVEA \(100% Resolution/);
    });

    it("E. FOVEAL_OFF=0 (unset) on the SAME large file still compresses (byte-identical to Phase 1.2)", async () => {
        delete process.env.FOVEAL_OFF;
        const { source } = buildSyntheticSource();
        const filePath = path.join(tmpDir, "ctrl-off.ts");
        fs.writeFileSync(filePath, source, "utf-8");

        const result = await tfcCompress(
            filePath,
            source,
            "validateToken",
            makeStubEngine(),
            { maxCrossFile: 0 },
        );

        expect(result.kind).toBe("success");
        if (result.kind !== "success") return;

        // With the flag off, the foveal path runs: focus kept, neighbor elided.
        expect(result.data.ratio).toBeGreaterThan(0);
        expect(result.data.compressed).toContain("EPICENTER_PAYLOAD_0_distinctive_marker");
        expect(result.data.compressed).not.toContain("NEIGHBOR_PAYLOAD_0_distinctive_marker");
        expect(result.data.compressed).toMatch(/\/\* L\d+-L\d+ \*\/\n[^\n]*validateToken/);
    });
});
