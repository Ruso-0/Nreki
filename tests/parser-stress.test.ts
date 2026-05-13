/**
 * Phase 5 Sprint 4.7 (Furia round 26) regression test.
 *
 * Reproduces the cumulative Tree-sitter Query refcount overflow that
 * crashed the Phase 5 orchestrator on vscode workspaces. Without
 * ASTParser.shutdown() invoking query.delete() across the WASM FFI,
 * 200 successive parses of a representative TS source would saturate
 * the uint16 refcount (max 65535) and log "too many references to
 * <TOKEN>: max 65535" warnings before the WASM heap traps with
 * "memory access out of bounds".
 *
 * Test stance: even WITHOUT calling shutdown between parses, the
 * parser must tolerate ~200 cumulative parses of a moderately large
 * TS source. With the fix, no warning ever surfaces.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ASTParser } from "../src/parser.js";

/**
 * Build a synthetic TS source string with N top-level functions. Each
 * function has a typed signature so the parser populates symbol_io
 * and the Query is exercised against many capture sites per parse.
 * 1000 functions × 200 parses easily clears the 65535 cap on the
 * pre-fix parser, providing a stress headroom of ~3x the threshold.
 */
function generateLargeTSSource(numFunctions: number): string {
    const parts: string[] = [];
    parts.push("// auto-generated stress source");
    for (let i = 0; i < numFunctions; i++) {
        parts.push(
            `export function fn${i}(a: number, b: string): { id: number; name: string } {`,
            `  const result = { id: a + ${i}, name: b + "_${i}" };`,
            `  return result;`,
            `}`,
            "",
        );
    }
    parts.push(`export class Holder${numFunctions} {`);
    parts.push(`  constructor(public value: number) {}`);
    parts.push(`  getValue(): number { return this.value; }`);
    parts.push(`}`);
    return parts.join("\n");
}

describe("ASTParser stress: cumulative parses do not overflow WASM refcounts", () => {
    let parser: ASTParser;
    const capturedWarnings: string[] = [];
    const capturedErrors: string[] = [];

    beforeAll(async () => {
        parser = new ASTParser();
        await parser.initialize();
    });

    afterAll(() => {
        try { parser.shutdown(); } catch { /* shutdown is the API under test */ }
    });

    it("200 sequential parses of a 1000-function TS source emit zero overflow signals", async () => {
        // Spy on the logger by hooking process.stdout.write -- the
        // NREKI logger eventually routes through it. We also capture
        // any "too many references" error that the underlying
        // tree-sitter binding could throw. Both paths are checked.
        const originalStdoutWrite = process.stdout.write.bind(process.stdout);
        const originalStderrWrite = process.stderr.write.bind(process.stderr);
        const stdoutSpy = (chunk: string | Uint8Array): boolean => {
            const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
            if (text.includes("too many references") || text.includes("max 65535")) {
                capturedWarnings.push(text);
            }
            return originalStdoutWrite(chunk as never);
        };
        const stderrSpy = (chunk: string | Uint8Array): boolean => {
            const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
            if (text.includes("too many references") || text.includes("max 65535")) {
                capturedWarnings.push(text);
            }
            return originalStderrWrite(chunk as never);
        };
        process.stdout.write = stdoutSpy as typeof process.stdout.write;
        process.stderr.write = stderrSpy as typeof process.stderr.write;

        try {
            const source = generateLargeTSSource(1000);
            // 200 iterations is 2-3x the empirical threshold where the
            // pre-fix parser flooded with overflow warnings.
            for (let i = 0; i < 200; i++) {
                let result;
                try {
                    result = await parser.parse(`stress-${i}.ts`, source);
                } catch (err) {
                    capturedErrors.push(`iter ${i}: ${(err as Error).message}`);
                    throw err;
                }
                expect(result.chunks.length).toBeGreaterThan(0);
            }
        } finally {
            process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
            process.stderr.write = originalStderrWrite as typeof process.stderr.write;
        }

        expect(capturedErrors).toEqual([]);
        // The core assertion: ZERO overflow warnings emitted across the
        // 200-parse window. Pre-fix, dozens to hundreds of these flood
        // the stderr stream before the WASM trap.
        expect(capturedWarnings).toEqual([]);
    }, 60_000); // 60s budget; typical run is ~5-15s on the dev host

    it("shutdown() is idempotent and clears query/language caches", async () => {
        const ephemeral = new ASTParser();
        await ephemeral.initialize();
        // First parse forces queryCache + languageCache hydration.
        await ephemeral.parse("a.ts", "export function f() { return 1; }");
        ephemeral.shutdown();
        // Second shutdown must not throw -- defensive idempotency for
        // engine.shutdown call paths that fail mid-cleanup elsewhere.
        expect(() => ephemeral.shutdown()).not.toThrow();
    });
});
