#!/usr/bin/env node
/**
 * scripts/measure-cross-language-savings.mjs
 *
 * Indicative (NOT empirical) measurement of NREKI shorthand-based
 * token savings on non-TypeScript languages. Measures ONLY the
 * local foveal shorthand compression — does NOT measure the
 * cross-file Type Ledger pruning that TS gets and Kotlin/Java/C++
 * do not (because Type Ledger DB only indexes TS today).
 *
 * Token proxy: code.length / 4 (canonical "~4 chars per token"
 * GPT-tokenizer rule of thumb). For paper-grade numbers, swap in
 * tiktoken — already in devDeps.
 *
 * Usage:
 *   node scripts/measure-cross-language-savings.mjs <file-or-dir> [more...]
 *
 * Run from repo root. Output: JSON to stdout.
 */

import { readFileSync, statSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { ASTParser } from "../dist/parser.js";

const SUPPORTED = new Set([".java", ".kt", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".c", ".h"]);

function collectFiles(target) {
    const acc = [];
    const visit = (p) => {
        let st;
        try { st = statSync(p); } catch { return; }
        if (st.isFile()) {
            if (SUPPORTED.has(extname(p).toLowerCase())) acc.push(p);
            return;
        }
        if (st.isDirectory()) {
            let entries;
            try { entries = readdirSync(p); } catch { return; }
            for (const e of entries) visit(join(p, e));
        }
    };
    visit(target);
    return acc;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
    console.error("Usage: node scripts/measure-cross-language-savings.mjs <file-or-dir> [...]");
    process.exit(2);
}

const allFiles = [...new Set(targets.flatMap(collectFiles))];
if (allFiles.length === 0) {
    console.error("No supported source files found under the given targets.");
    process.exit(2);
}

const parser = new ASTParser();
await parser.initialize();

const perFile = [];
const perLang = new Map();

for (const filePath of allFiles) {
    const ext = extname(filePath).toLowerCase();
    let code;
    try {
        code = readFileSync(filePath, "utf-8");
    } catch (e) {
        perFile.push({ filePath, ext, error: `read: ${e.message}` });
        continue;
    }

    let result;
    try {
        result = await parser.parse(filePath, code);
    } catch (e) {
        perFile.push({ filePath, ext, error: `parse: ${e.message}` });
        continue;
    }

    const rawChars = code.length;
    const rawTokens = rawChars / 4;
    const chunkCount = result.chunks?.length ?? 0;
    const shorthandChars = (result.chunks ?? [])
        .reduce((acc, c) => acc + (typeof c.shorthand === "string" ? c.shorthand.length : 0), 0);
    const compressedTokens = shorthandChars / 4;
    const saving = rawTokens > 0 ? 1 - (compressedTokens / rawTokens) : 0;

    const row = {
        filePath: relative(process.cwd(), filePath),
        ext,
        bytes: rawChars,
        chunks: chunkCount,
        rawTokensApprox: Math.round(rawTokens),
        compressedTokensApprox: Math.round(compressedTokens),
        savingPercent: Math.round(saving * 1000) / 10,
    };
    perFile.push(row);

    const agg = perLang.get(ext) ?? {
        ext,
        files: 0,
        bytes: 0,
        chunks: 0,
        rawTokens: 0,
        compressedTokens: 0,
    };
    agg.files += 1;
    agg.bytes += rawChars;
    agg.chunks += chunkCount;
    agg.rawTokens += rawTokens;
    agg.compressedTokens += compressedTokens;
    perLang.set(ext, agg);
}

parser.shutdown?.();

const summary = [...perLang.values()].map(a => ({
    ext: a.ext,
    files: a.files,
    totalBytes: a.bytes,
    totalChunks: a.chunks,
    aggregateRawTokensApprox: Math.round(a.rawTokens),
    aggregateCompressedTokensApprox: Math.round(a.compressedTokens),
    aggregateSavingPercent: a.rawTokens > 0
        ? Math.round((1 - a.compressedTokens / a.rawTokens) * 1000) / 10
        : null,
}));

console.log(JSON.stringify({
    disclosure: {
        scope: "LOCAL foveal shorthand compression only; cross-file Type Ledger pruning NOT measured (TS-only today empírico).",
        tokenProxy: "code.length / 4; swap in tiktoken for paper-grade numbers.",
        corpusWarning: "Verify corpus is representative; tiny/synthetic files inflate or deflate savings irrelevantly.",
    },
    summary,
    perFile,
}, null, 2));
