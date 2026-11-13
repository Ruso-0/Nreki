/**
 * `Class.method` as a symbol name. In the pre-registered A/B of 2026-11-13 two
 * of three NREKI sessions sent batch_edit with symbol "RecoveryCodes.redeem",
 * got "Symbol not found … Available: … redeem", and resent the whole batch
 * (one more turn, ~20k tokens); references "RecoveryCodes.pending" answered
 * "No references found" although the method is called. These tests pin every
 * tool that takes a symbol name.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { semanticEdit, batchSemanticEdit } from "../src/semantic-edit.js";
import { ASTParser } from "../src/parser.js";
import { AstSandbox } from "../src/ast-sandbox.js";
import { NrekiEngine } from "../src/engine.js";
import { CognitiveEnforcer } from "../src/hooks/cognitive-enforcer.js";
import { handleCompress } from "../src/handlers/code/read.js";
import { handleDefinition, handleReferences } from "../src/handlers/navigate.js";
import { splitQualifiedName, memberName } from "../src/utils/qualified-name.js";
import type { RouterDependencies } from "../src/router.js";

const RECOVERY = [
    "export class RecoveryCodes {",
    "    private codes = new Map<string, number>();",
    "",
    "    issue(userId: string): string {",
    "        this.codes.set(userId, Date.now());",
    "        return userId;",
    "    }",
    "",
    "    redeem(code: string): string | undefined {",
    "        return this.codes.has(code) ? code : undefined;",
    "    }",
    "}",
    "",
    "export class InviteCodes {",
    "    redeem(code: string): boolean {",
    "        return code.length > 0;",
    "    }",
    "}",
    "",
].join("\n");

const ROUTE = "import { RecoveryCodes } from './recovery.js';\n\nexport function reset(codes: RecoveryCodes, code: string): boolean {\n    return codes.redeem(code) !== undefined;\n}\n";

const textOf = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? "").join("\n");

function tmp(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-qualified-"));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

let parser: ASTParser;
let sandbox: AstSandbox;
beforeAll(async () => {
    parser = new ASTParser();
    sandbox = new AstSandbox();
    await parser.initialize();
    await sandbox.initialize();
});

describe("qualified-name parsing", () => {
    it("splits Class.method, Class::method, Class#method, Class->method and nested containers", () => {
        expect(splitQualifiedName("RecoveryCodes.redeem")).toEqual({ container: "RecoveryCodes", member: "redeem" });
        expect(splitQualifiedName("Store::get")).toEqual({ container: "Store", member: "get" });
        expect(splitQualifiedName("Repo#save")).toEqual({ container: "Repo", member: "save" });
        expect(splitQualifiedName("Node->next")).toEqual({ container: "Node", member: "next" });
        expect(splitQualifiedName("Outer.Inner.run")).toEqual({ container: "Inner", member: "run" });
        for (const plain of ["redeem", ".btn", "a.b.", "a b", "\"key\""]) expect(splitQualifiedName(plain)).toBeNull();
        expect(memberName("RecoveryCodes.redeem")).toBe("redeem");
        expect(memberName("redeem")).toBe("redeem");
    });
});

describe("edit and batch_edit accept Class.method", () => {
    it("batch_edit patches RecoveryCodes.redeem (the A/B call that was rejected) and only that method", async () => {
        const dir = tmp({ "recovery.ts": RECOVERY });
        const res = await batchSemanticEdit([{
            path: "recovery.ts", symbol: "RecoveryCodes.redeem", mode: "patch",
            search_text: "return this.codes.has(code) ? code : undefined;",
            replace_text: "return this.codes.has(code) ? code.trim() : undefined;",
        }], parser, sandbox, dir);
        expect(res.error).toBeUndefined();
        expect(res.success).toBe(true);
        const after = fs.readFileSync(path.join(dir, "recovery.ts"), "utf8");
        expect(after).toContain("? code.trim() : undefined;");
        expect(after).toContain("    redeem(code: string): boolean {\n        return code.length > 0;"); // InviteCodes untouched
    });

    it("the same method name in two classes: the bare name is ambiguous and says how to name one; Class.method picks it", async () => {
        const dir = tmp({ "recovery.ts": RECOVERY });
        const bare = await batchSemanticEdit([{ path: "recovery.ts", symbol: "redeem", new_code: "redeem(code: string): boolean {\n    return false;\n}" }], parser, sandbox, dir);
        expect(bare.success).toBe(false);
        expect(bare.error).toContain("Class.redeem");

        const res = await batchSemanticEdit([{ path: "recovery.ts", symbol: "InviteCodes.redeem", new_code: "redeem(code: string): boolean {\n    return code.length > 1;\n}" }], parser, sandbox, dir);
        expect(res.error).toBeUndefined();
        const after = fs.readFileSync(path.join(dir, "recovery.ts"), "utf8");
        expect(after).toContain("return code.length > 1;");
        expect(after).toContain("return this.codes.has(code) ? code : undefined;"); // RecoveryCodes.redeem untouched
    });

    it("single edit takes InviteCodes::redeem too", async () => {
        const dir = tmp({ "recovery.ts": RECOVERY });
        const abs = path.join(dir, "recovery.ts");
        const res = await semanticEdit(abs, "InviteCodes::redeem", undefined, parser, sandbox, dir, "patch", false,
            "return code.length > 0;", "return code.length > 2;");
        expect(res.error).toBeUndefined();
        expect(fs.readFileSync(abs, "utf8")).toContain("return code.length > 2;");
    });

    it("Python: Class.method", async () => {
        const dir = tmp({ "a.py": "class A:\n    def m(self):\n        return 1\n\n\nclass B:\n    def m(self):\n        return 2\n" });
        const res = await batchSemanticEdit([{ path: "a.py", symbol: "B.m", mode: "patch", search_text: "return 2", replace_text: "return 3" }], parser, sandbox, dir);
        expect(res.error).toBeUndefined();
        expect(fs.readFileSync(path.join(dir, "a.py"), "utf8")).toBe("class A:\n    def m(self):\n        return 1\n\n\nclass B:\n    def m(self):\n        return 3\n");
    });

    it("an unknown container is still not found (no guessing)", async () => {
        const dir = tmp({ "recovery.ts": RECOVERY });
        const res = await batchSemanticEdit([{ path: "recovery.ts", symbol: "Nope.redeem", mode: "patch", search_text: "return", replace_text: "return" }], parser, sandbox, dir);
        expect(res.success).toBe(false);
        expect(res.error).toContain('Symbol "Nope.redeem" not found');
    });
});

describe("read, navigate and the blind-edit guard accept Class.method", () => {
    let dir: string;
    let engine: NrekiEngine;
    let deps: RouterDependencies;

    beforeAll(async () => {
        // > 100 lines so the blind-edit guard applies to it.
        const filler = Array.from({ length: 110 }, (_, i) => `export const pad${i} = ${i};`).join("\n");
        dir = tmp({ "src/recovery.ts": RECOVERY + filler + "\n", "src/route.ts": ROUTE });
        engine = new NrekiEngine({ dbPath: path.join(dir, ".nreki.db"), watchPaths: [dir] });
        await engine.initialize();
        await engine.indexDirectory(dir);
        deps = { engine } as unknown as RouterDependencies;
    });
    afterAll(() => {
        engine.shutdown();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    });

    it("compress focus RecoveryCodes.redeem returns that method, not InviteCodes.redeem", async () => {
        const r = await handleCompress({ action: "compress", path: path.join(dir, "src/recovery.ts"), focus: "RecoveryCodes.redeem" }, deps);
        const text = textOf(r);
        expect(r.isError).not.toBe(true);
        expect(text).toContain("return this.codes.has(code) ? code : undefined;");
        expect(text).not.toContain("return code.length > 0;");
    });

    it("definition RecoveryCodes.redeem: the method inside that class only", async () => {
        const text = textOf(await handleDefinition({ action: "definition", symbol: "RecoveryCodes.redeem" }, deps));
        expect(text).toContain("Found 1 definition(s)");
        expect(text).toContain("return this.codes.has(code) ? code : undefined;");
        const none = textOf(await handleDefinition({ action: "definition", symbol: "Nope.redeem" }, deps));
        expect(none).toContain("No definition found");
    });

    it("references RecoveryCodes.redeem finds the call site (it answered 'No references found')", async () => {
        const text = textOf(await handleReferences({ action: "references", symbol: "RecoveryCodes.redeem" }, deps));
        expect(text).not.toContain("No references found");
        expect(text).toContain("src/route.ts");
        expect(text).toContain('Matched by member name "redeem"');
    });

    it("blind-edit guard: reading redeem covers editing RecoveryCodes.redeem, and the other way round", () => {
        const stateFile = path.join(dir, ".nreki", "enforcer-state.json");
        const edit = (symbol: string) => ({ edits: [{ path: "src/recovery.ts", symbol }] });

        fs.rmSync(stateFile, { force: true });
        const a = new CognitiveEnforcer(dir);
        expect(a.evaluate("nreki_code", "batch_edit", edit("RecoveryCodes.redeem")).blocked).toBe(true);
        a.registerSuccess("nreki_code", "compress", { path: "src/recovery.ts", focus: "redeem" });
        expect(a.evaluate("nreki_code", "batch_edit", edit("RecoveryCodes.redeem")).blocked).toBe(false);

        fs.rmSync(stateFile, { force: true });
        const b = new CognitiveEnforcer(dir);
        b.registerSuccess("nreki_code", "read", { path: "src/recovery.ts", focus: "RecoveryCodes.redeem" });
        expect(b.evaluate("nreki_code", "batch_edit", edit("redeem")).blocked).toBe(false);
        expect(b.evaluate("nreki_code", "batch_edit", edit("issue")).blocked).toBe(true);
    });
});
