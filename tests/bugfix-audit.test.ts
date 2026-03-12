import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("Bug 1: Path normalization in Circuit Breaker", () => {
    it("should treat relative and absolute paths as the same file", () => {
        const cb = new CircuitBreaker();
        const cwd = process.cwd();
        const relativePath = "src/app.ts";
        const absolutePath = path.resolve(cwd, relativePath);

        // Simulate 3 failures with mixed path formats
        cb.recordToolCall("tg_code:edit", "TypeError: fail", relativePath);
        cb.recordToolCall("tg_code:edit", "TypeError: fail", absolutePath);
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/app.ts");

        const state = cb.getState();
        // Should be tripped — all 3 failures are on the SAME normalized file
        expect(state.tripped).toBe(true);
    });

    it("should normalize Windows backslashes", () => {
        const cb = new CircuitBreaker();

        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src\\app.ts");
        cb.recordToolCall("tg_code:edit", "TypeError: fail", "src/app.ts");

        const state = cb.getState();
        // Both should map to the same key
        const uniqueFiles = new Set(
            state.history.map(r => r.filePath).filter(Boolean)
        );
        expect(uniqueFiles.size).toBe(1);
    });
});

describe("Bug 3: Plaintext fallback for unsupported languages", () => {
    it("should index a .rs file as plaintext chunk", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-lang-"));
        const rustFile = path.join(tmpDir, "main.rs");
        fs.writeFileSync(rustFile, 'fn main() {\n    println!("hello");\n}');

        const { TokenGuardEngine } = await import("../src/engine.js");
        const engine = new TokenGuardEngine({
            dbPath: path.join(tmpDir, "test.db"),
            watchPaths: [tmpDir],
        });
        await engine.initialize();

        const result = await engine.indexFile(rustFile);

        // Should NOT be null — should have indexed as plaintext
        expect(result).not.toBeNull();
        expect(result!.chunks.length).toBeGreaterThan(0);
        expect(result!.chunks[0].nodeType).toBe("file");
        expect(result!.chunks[0].rawCode).toContain("fn main()");

        // Cleanup
        engine.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should find Rust code via BM25 search after plaintext indexing", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-search-"));
        const rustFile = path.join(tmpDir, "auth.rs");
        fs.writeFileSync(rustFile, [
            "pub fn validate_token(token: &str) -> bool {",
            "    token.len() > 0",
            "}",
            "",
            "pub fn hash_password(pwd: &str) -> String {",
            '    format!("hashed_{}", pwd)',
            "}",
        ].join("\n"));

        const { TokenGuardEngine } = await import("../src/engine.js");
        const engine = new TokenGuardEngine({
            dbPath: path.join(tmpDir, "test.db"),
            watchPaths: [tmpDir],
        });
        await engine.initialize();
        await engine.indexFile(rustFile);

        // BM25 search should find the Rust file
        const results = await engine.search("validate_token", 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].rawCode).toContain("validate_token");

        engine.shutdown();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
