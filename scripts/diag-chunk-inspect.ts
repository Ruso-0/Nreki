/**
 * scripts/diag-chunk-inspect.ts
 * Diagnostic: dump tree-sitter chunks for one zod symbol so we can
 * see why extractParamTypes is returning empty arrays.
 */
import * as fs from "node:fs";
import { ASTParser } from "../src/parser.js";

async function main(): Promise<void> {
    const filePath = "D:/Nreki/corpus/colinhacks__zod/packages/zod/src/v4/classic/schemas.ts";
    const parser = new ASTParser();
    await parser.initialize();
    const source = fs.readFileSync(filePath, "utf-8");
    const result = await parser.parse(filePath, source);
    const targetNames = new Set(["int", "array", "keyof", "nullable"]);
    for (const chunk of result.chunks) {
        if (!targetNames.has(chunk.symbolName)) continue;
        console.log("=== symbol:", chunk.symbolName);
        console.log("nodeType:", JSON.stringify(chunk.nodeType));
        console.log("startLine:", chunk.startLine, "endLine:", chunk.endLine);
        console.log("rawCode (first 300 chars):");
        console.log(chunk.rawCode.slice(0, 300));
        console.log("---");
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
