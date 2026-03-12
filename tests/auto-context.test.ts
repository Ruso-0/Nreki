/**
 * auto-context.test.ts — Tests for Import-Anchored Auto-Context injection.
 */

import { describe, it, expect } from "vitest";
import {
    extractDependencies,
    cleanSignature,
    isSensitiveSignature,
    escapeRegExp,
} from "../src/utils/imports.js";

describe("Auto-Context: extractDependencies", () => {
    it("handles ESM named imports with aliases (TS/JS)", () => {
        const code = `import { foo, bar as baz } from "./utils/math";`;
        const deps = extractDependencies(code, ".ts");

        expect(deps).toHaveLength(2);
        expect(deps[0]).toEqual({ symbol: "foo", localName: "foo", pathHint: "math" });
        expect(deps[1]).toEqual({ symbol: "bar", localName: "baz", pathHint: "math" });
    });

    it("handles CommonJS require with aliases", () => {
        const code = `const { hash: myHash, verify } = require('../core/crypto.js');`;
        const deps = extractDependencies(code, ".js");

        expect(deps).toHaveLength(2);
        expect(deps[0]).toEqual({ symbol: "hash", localName: "myHash", pathHint: "crypto" });
        expect(deps[1]).toEqual({ symbol: "verify", localName: "verify", pathHint: "crypto" });
    });

    it("ignores node_modules in TS/JS (non-local paths)", () => {
        const code = `import express from "express";\nimport { z } from "zod";`;
        const deps = extractDependencies(code, ".ts");
        expect(deps).toHaveLength(0);
    });

    it("extracts Python from-imports with aliases", () => {
        const code = `from app.core.auth import validate as check_auth, get_user`;
        const deps = extractDependencies(code, ".py");

        expect(deps).toHaveLength(2);
        expect(deps[0]).toEqual({ symbol: "validate", localName: "check_auth", pathHint: "auth" });
        expect(deps[1]).toEqual({ symbol: "get_user", localName: "get_user", pathHint: "auth" });
    });

    it("infers symbols from Go namespace usage", () => {
        const code = `
            import "fmt"
            import "github.com/org/myproject/utils"
            import alias "github.com/org/myproject/crypto"

            func main() {
                utils.HashPassword("secret")
                alias.EncryptData()
                fmt.Println("ignored")
            }
        `;
        const deps = extractDependencies(code, ".go");

        const hash = deps.find(d => d.symbol === "HashPassword");
        expect(hash).toBeDefined();
        expect(hash?.pathHint).toBe("utils");
        expect(hash?.localName).toBe("utils.HashPassword");

        const encrypt = deps.find(d => d.symbol === "EncryptData");
        expect(encrypt?.pathHint).toBe("crypto");
        expect(encrypt?.localName).toBe("alias.EncryptData");

        // fmt.Println should NOT be extracted (stdlib, no slash)
        const println = deps.find(d => d.symbol === "Println");
        expect(println).toBeUndefined();
    });

    it("deduplicates identical imports", () => {
        const code = [
            `import { Hash } from "./crypto";`,
            `import { Hash } from "./crypto";`,
        ].join("\n");
        const deps = extractDependencies(code, ".ts");
        expect(deps).toHaveLength(1);
    });

    it("handles type imports without crashing", () => {
        const code = `import type { UserType } from "./models/user";`;
        const deps = extractDependencies(code, ".ts");
        expect(deps).toHaveLength(1);
        expect(deps[0].symbol).toBe("UserType");
    });
});

describe("Auto-Context: Security Filters", () => {
    it("filters auth-related tokens but allows generic ones", () => {
        expect(isSensitiveSignature("const authToken = '123'")).toBe(true);
        expect(isSensitiveSignature("function getApiKey()")).toBe(true);
        expect(isSensitiveSignature("let master_key = '123'")).toBe(true);
        expect(isSensitiveSignature("const refreshToken = x")).toBe(true);

        // These must NOT be filtered
        expect(isSensitiveSignature("function tokenize(text: string)")).toBe(false);
        expect(isSensitiveSignature("class TokenGuardEngine")).toBe(false);
        expect(isSensitiveSignature("function parseTokenStream()")).toBe(false);
    });

    it("cleanSignature strips multiline without breaking Python", () => {
        const tsSig = `export function foo(\n  a: string\n) /* TG:L1-L3 */`;
        expect(cleanSignature(tsSig)).toBe("export function foo( a: string )");

        const pySig = `def hex_color(): # returns color like #FF0000\n # [TG] compressed`;
        const cleaned = cleanSignature(pySig);
        expect(cleaned).toContain("def hex_color()");
        expect(cleaned).not.toContain("[TG]");
    });

    it("cleanSignature handles empty input", () => {
        expect(cleanSignature("")).toBe("");
        expect(cleanSignature("   ")).toBe("");
    });

    it("escapeRegExp handles ReDoS symbols", () => {
        const escaped = escapeRegExp("$store");
        expect(escaped).toBe("\\$store");

        const regex = new RegExp(
            `(^|[^a-zA-Z0-9_$])${escaped}(?=[^a-zA-Z0-9_$]|$)`,
        );
        expect(regex.test("const a = $store.get()")).toBe(true);
        expect(regex.test("const my$store = 1")).toBe(false);
    });
});
