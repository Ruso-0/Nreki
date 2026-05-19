#!/usr/bin/env node
// analyze-symbol-sizes.mjs — empirical symbol-size distribution.
// Walks each sample directory, parses .ts files via TypeScript Compiler API,
// extracts every function/method/arrow/class declaration with its line count,
// emits a JSON report with buckets + percentiles + false-positive rates.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const SAMPLES = [
    { name: "nreki-src", root: path.join(repoRoot, "src") },
    { name: "zod", root: path.join(repoRoot, "node_modules", "zod", "src") },
    { name: "ajv", root: path.join(repoRoot, "node_modules", "ajv", "lib") },
    { name: "eventsource", root: path.join(repoRoot, "node_modules", "eventsource", "src") },
    { name: "ajv-formats", root: path.join(repoRoot, "node_modules", "ajv-formats", "src") },
];

const BUCKETS = [
    [0, 20], [20, 40], [40, 60], [60, 80],
    [80, 100], [100, 150], [150, 200], [200, Infinity],
];

const THRESHOLDS_TO_TEST = [40, 50, 60, 70, 80, 100, 120, 150];

function walkTs(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "tests") continue;
            out.push(...walkTs(full));
        } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function extractSymbols(filePath, sourceCode) {
    const sourceFile = ts.createSourceFile(filePath, sourceCode, ts.ScriptTarget.Latest, true);
    const symbols = [];

    function lineCount(node) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        return end.line - start.line + 1;
    }

    function isRealFunction(node) {
        return (
            ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isConstructorDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node) ||
            (ts.isArrowFunction(node) && node.body && ts.isBlock(node.body)) ||
            (ts.isFunctionExpression(node) && node.body && ts.isBlock(node.body))
        );
    }

    function visit(node, depth = 0) {
        if (isRealFunction(node) && node.body) {
            const lines = lineCount(node);
            let name = "<anonymous>";
            if (node.name && ts.isIdentifier(node.name)) name = node.name.text;
            else if (ts.isMethodDeclaration(node) && node.name) name = node.name.getText(sourceFile);
            else if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.text;
            else if (node.parent && ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) name = node.parent.name.text;
            symbols.push({ name, lines, kind: ts.SyntaxKind[node.kind] });
        }
        ts.forEachChild(node, (child) => visit(child, depth + 1));
    }

    visit(sourceFile);
    return symbols;
}

function percentile(sortedAsc, p) {
    if (sortedAsc.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
    return sortedAsc[Math.max(0, Math.min(idx, sortedAsc.length - 1))];
}

function analyze(sample) {
    const files = walkTs(sample.root);
    const symbols = [];
    for (const f of files) {
        try {
            const src = fs.readFileSync(f, "utf8");
            symbols.push(...extractSymbols(f, src));
        } catch (e) {
            // Skip parse errors
        }
    }

    const lineCounts = symbols.map((s) => s.lines).sort((a, b) => a - b);

    const buckets = BUCKETS.map(([lo, hi]) => ({
        range: hi === Infinity ? `>=${lo}L` : `${lo}-${hi}L`,
        count: symbols.filter((s) => s.lines >= lo && s.lines < hi).length,
    }));

    const blockedPctByThreshold = {};
    for (const t of THRESHOLDS_TO_TEST) {
        const blocked = symbols.filter((s) => s.lines > t).length;
        blockedPctByThreshold[t] = {
            count: blocked,
            pct: symbols.length === 0 ? 0 : +(100 * blocked / symbols.length).toFixed(2),
        };
    }

    return {
        sample: sample.name,
        root: path.relative(repoRoot, sample.root),
        fileCount: files.length,
        symbolCount: symbols.length,
        meanLines: symbols.length === 0 ? 0 : +(lineCounts.reduce((a, b) => a + b, 0) / lineCounts.length).toFixed(2),
        medianLines: percentile(lineCounts, 50),
        p75: percentile(lineCounts, 75),
        p90: percentile(lineCounts, 90),
        p95: percentile(lineCounts, 95),
        p99: percentile(lineCounts, 99),
        maxLines: lineCounts[lineCounts.length - 1] || 0,
        buckets,
        blockedPctByThreshold,
    };
}

const reports = SAMPLES.map(analyze);

const aggregateAll = (() => {
    const all = [];
    for (const sample of SAMPLES) {
        const files = walkTs(sample.root);
        for (const f of files) {
            try {
                const src = fs.readFileSync(f, "utf8");
                all.push(...extractSymbols(f, src));
            } catch (e) {}
        }
    }
    const lineCounts = all.map((s) => s.lines).sort((a, b) => a - b);
    const buckets = BUCKETS.map(([lo, hi]) => ({
        range: hi === Infinity ? `>=${lo}L` : `${lo}-${hi}L`,
        count: all.filter((s) => s.lines >= lo && s.lines < hi).length,
    }));
    const blockedPctByThreshold = {};
    for (const t of THRESHOLDS_TO_TEST) {
        const blocked = all.filter((s) => s.lines > t).length;
        blockedPctByThreshold[t] = {
            count: blocked,
            pct: all.length === 0 ? 0 : +(100 * blocked / all.length).toFixed(2),
        };
    }
    return {
        sample: "AGGREGATE",
        symbolCount: all.length,
        meanLines: all.length === 0 ? 0 : +(lineCounts.reduce((a, b) => a + b, 0) / lineCounts.length).toFixed(2),
        medianLines: percentile(lineCounts, 50),
        p75: percentile(lineCounts, 75),
        p90: percentile(lineCounts, 90),
        p95: percentile(lineCounts, 95),
        p99: percentile(lineCounts, 99),
        maxLines: lineCounts[lineCounts.length - 1] || 0,
        buckets,
        blockedPctByThreshold,
    };
})();

const result = { samples: reports, aggregate: aggregateAll, generatedAt: new Date().toISOString() };

const outPath = path.join(repoRoot, "scripts", "symbol-size-report.json");
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(`\n=== EMPIRICAL SYMBOL SIZE ANALYSIS ===\n`);
for (const r of reports) {
    console.log(`[${r.sample}]  files=${r.fileCount}  symbols=${r.symbolCount}  mean=${r.meanLines}L  median=${r.medianLines}L  p75=${r.p75}L  p95=${r.p95}L  p99=${r.p99}L  max=${r.maxLines}L`);
}
console.log(`\n[AGGREGATE]  symbols=${aggregateAll.symbolCount}  mean=${aggregateAll.meanLines}L  median=${aggregateAll.medianLines}L  p75=${aggregateAll.p75}L  p95=${aggregateAll.p95}L  p99=${aggregateAll.p99}L  max=${aggregateAll.maxLines}L`);

console.log(`\n=== BLOCKED % BY THRESHOLD (aggregate) ===`);
for (const t of THRESHOLDS_TO_TEST) {
    const b = aggregateAll.blockedPctByThreshold[t];
    console.log(`  >${t}L: ${b.count} symbols  (${b.pct}% of total)`);
}
console.log(`\nReport written: ${path.relative(repoRoot, outPath)}\n`);
