/**
 * scripts/eval-type-ledger-accuracy.ts
 *
 * Phase 1 — E2 kill-criterion script.
 * Mide accuracy de extracción de firmas I/O via tree-sitter (heurístico)
 * vs vanilla ts.createProgram + TypeChecker (ground truth).
 *
 * Kill criterion: failure rate >20% → ABORT_SPRINT.
 *
 * Caveat: ground truth proviene de vanilla TS Compiler, NO de
 * TsCompilerWrapper de NREKI. Ver `caveat_oracle` en el JSON output.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { ASTParser } from "../src/parser.js";
import {
    UNWRAP_GENERICS,
    DISCARD_NAMES,
    TYPE_TOKEN,
    PARAM_TYPE_RX,
    RETURN_TYPE_RX,
    isDiscarded,
    unwrapHeuristic,
    extractParamTypes,
    extractReturnType,
} from "../src/utils/type-extractor.js";

interface IO {
    consumes: string[];
    produces: string[];
}

interface ExtractionResult {
    file: string;
    symbol: string;
    treesitter: IO;
    tscompiler: IO;
    match: boolean;
    reason?: string;
}

async function extractViaTreeSitter(
    parser: ASTParser,
    filePath: string,
): Promise<Map<string, { io: IO; symbolName: string; line: number }>> {
    const source = fs.readFileSync(filePath, "utf-8");
    const result = await parser.parse(filePath, source);
    const out = new Map<string, { io: IO; symbolName: string; line: number }>();
    for (const chunk of result.chunks) {
        if (chunk.nodeType !== "func" && chunk.nodeType !== "method") continue;
        const key = `${chunk.symbolName}@L${chunk.startLine}`;
        out.set(key, {
            io: {
                consumes: extractParamTypes(chunk.rawCode),
                produces: extractReturnType(chunk.rawCode),
            },
            symbolName: chunk.symbolName,
            line: chunk.startLine,
        });
    }
    return out;
}

function unwrapTsType(type: ts.Type, depth: number = 0): string | null {
    if (depth > 8) return null;
    const sym = type.getSymbol();
    if (!sym) return null;
    const name = sym.getName();
    if (isDiscarded(name)) return null;
    if (UNWRAP_GENERICS.has(name)) {
        const ref = type as ts.TypeReference;
        const args = ref.typeArguments;
        if (args && args.length > 0) {
            return unwrapTsType(args[0], depth + 1);
        }
    }
    return name;
}

function extractViaTsCompiler(
    program: ts.Program,
    sourceFile: ts.SourceFile,
): Map<string, IO> {
    const checker = program.getTypeChecker();
    const out = new Map<string, IO>();

    function visit(node: ts.Node): void {
        if (ts.isFunctionDeclaration(node) && node.name && node.body) {
            const name = node.name.getText(sourceFile);
            const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
            const startLine = line + 1;
            const consumes: string[] = [];
            for (const param of node.parameters) {
                if (param.type) {
                    const t = checker.getTypeAtLocation(param.type);
                    const unwrapped = unwrapTsType(t);
                    if (unwrapped) consumes.push(unwrapped);
                }
            }
            let produces: string[] = [];
            if (node.type) {
                const t = checker.getTypeAtLocation(node.type);
                const unwrapped = unwrapTsType(t);
                if (unwrapped) produces = [unwrapped];
            }
            out.set(`${name}@L${startLine}`, { consumes, produces });
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return out;
}

const SYNTHETIC_NAMES = new Set(["__type", "__object", "_", ""]);
function isSynthetic(t: string): boolean {
    return SYNTHETIC_NAMES.has(t) || t.startsWith("(Anonymous");
}

function compareExtractions(
    tsx: IO,
    tsc: IO,
): { match: boolean; reason?: string } {
    const tscC = new Set([...tsc.consumes].filter((t) => !isSynthetic(t)));
    const tscP = new Set([...tsc.produces].filter((t) => !isSynthetic(t)));
    const tsxC = new Set(tsx.consumes);
    const tsxP = new Set(tsx.produces);

    const consumesOk = [...tscC].every((c) => tsxC.has(c));
    const producesOk = [...tscP].every((p) => tsxP.has(p));

    if (consumesOk && producesOk) return { match: true };

    const missing: string[] = [];
    for (const c of tscC) if (!tsxC.has(c)) missing.push(`consumes:${c}`);
    for (const p of tscP) if (!tsxP.has(p)) missing.push(`produces:${p}`);
    return { match: false, reason: `missing ${missing.join(",")}` };
}

/**
 * Strict bidirectional comparison: tsx and (synthetic-filtered) tsc must
 * be set-equal. Penalizes both Over-Unwrap (heuristic emits types absent
 * in oracle) and Under-Unwrap (heuristic misses types present in oracle).
 */
function compareExtractionsStrict(tsx: IO, tsc: IO): boolean {
    const tscC = new Set([...tsc.consumes].filter((t) => !isSynthetic(t)));
    const tscP = new Set([...tsc.produces].filter((t) => !isSynthetic(t)));
    const tsxC = new Set(tsx.consumes);
    const tsxP = new Set(tsx.produces);

    if (tscC.size !== tsxC.size || tscP.size !== tsxP.size) return false;
    for (const c of tscC) if (!tsxC.has(c)) return false;
    for (const p of tscP) if (!tsxP.has(p)) return false;
    return true;
}

function collectTsFiles(dir: string, maxFiles: number): string[] {
    const out: string[] = [];
    const queue: string[] = [dir];
    while (queue.length > 0 && out.length < maxFiles) {
        const current = queue.shift()!;
        if (current.includes("node_modules") || current.includes(".git")) continue;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(full);
            } else if (
                entry.isFile() &&
                (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
                !entry.name.endsWith(".d.ts") &&
                !entry.name.endsWith(".test.ts") &&
                !entry.name.endsWith(".spec.ts")
            ) {
                out.push(full);
                if (out.length >= maxFiles) break;
            }
        }
    }
    return out;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const smoke = args.includes("--smoke");
    const corpusDir = args.find((a) => !a.startsWith("--"));
    if (!corpusDir) {
        console.error("Usage: tsx scripts/eval-type-ledger-accuracy.ts <corpus-dir> [--smoke]");
        process.exit(1);
    }
    const absCorpus = path.resolve(corpusDir);

    const startTime = Date.now();
    let files: string[];
    if (smoke) {
        const corpusBase = path.basename(absCorpus);
        const SMOKE_FILES_BY_CORPUS: Record<string, string[]> = {
            colinhacks__zod: [
                "packages/zod/src/v4/classic/schemas.ts",
                "packages/zod/src/v4/core/api.ts",
                "packages/zod/src/v4/classic/checks.ts",
            ],
            withastro__astro: [
                "packages/astro/src/core/messages/runtime.ts",
                "packages/astro/src/i18n/index.ts",
                "packages/astro/src/content/utils.ts",
            ],
        };
        const SMOKE_FILES = SMOKE_FILES_BY_CORPUS[corpusBase];
        if (!SMOKE_FILES) {
            console.error(`No smoke file list configured for corpus basename "${corpusBase}". Add it to SMOKE_FILES_BY_CORPUS.`);
            process.exit(1);
        }
        files = SMOKE_FILES.map((p) => path.join(absCorpus, p)).filter((f) => fs.existsSync(f));
        if (files.length !== SMOKE_FILES.length) {
            console.error(`Smoke files missing: ${SMOKE_FILES.length - files.length}/${SMOKE_FILES.length} not found`);
            process.exit(1);
        }
        console.log(`SMOKE MODE: 3 hand-picked files from ${absCorpus} (${corpusBase})`);
    } else {
        files = collectTsFiles(absCorpus, 10000);
        console.log(`Evaluating ${files.length} TypeScript files from ${absCorpus}`);
    }

    // ─── Vanilla TS program (ground truth) ───
    const tsconfigPath = ts.findConfigFile(absCorpus, ts.sys.fileExists, "tsconfig.json");
    let compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
        skipLibCheck: true,
    };
    let rootNames: string[] = files;
    if (tsconfigPath) {
        const parsed = ts.parseJsonConfigFileContent(
            ts.readConfigFile(tsconfigPath, ts.sys.readFile).config,
            ts.sys,
            absCorpus,
        );
        compilerOptions = parsed.options;
        rootNames = Array.from(new Set([...parsed.fileNames, ...files]));
    }
    compilerOptions.skipLibCheck = true;
    const program = ts.createProgram(rootNames, compilerOptions);

    // ─── Tree-sitter parser (heuristic under test) ───
    const parser = new ASTParser();
    await parser.initialize();

    const results: ExtractionResult[] = [];
    let totalSymbols = 0;
    let matchedSymbols = 0;
    let matchedSymbolsStrict = 0;

    // Pre-2.2 baseline counters (read-only metrics, zero impact on extractor logic)
    let chunksFuncMethod = 0;
    let chunksWithIO = 0;
    let totalConsumes = 0;
    let totalProduces = 0;
    let chunksWithEmptyExtractorButOracleHasTypes = 0;

    for (const file of files) {
        try {
            const sf = program.getSourceFile(file);
            if (!sf) continue;

            const tsResult = await extractViaTreeSitter(parser, file);
            const tscResult = extractViaTsCompiler(program, sf);

            for (const [key, tsEntry] of tsResult.entries()) {
                // Coverage / density (over ALL func/method chunks the heuristic produced,
                // independent of whether the oracle has a matching entry)
                chunksFuncMethod++;
                const cN = tsEntry.io.consumes.length;
                const pN = tsEntry.io.produces.length;
                totalConsumes += cN;
                totalProduces += pN;
                if (cN + pN > 0) chunksWithIO++;

                const tscExtr = tscResult.get(key);
                if (!tscExtr) continue;
                totalSymbols++;
                const cmp = compareExtractions(tsEntry.io, tscExtr);
                if (cmp.match) matchedSymbols++;
                if (compareExtractionsStrict(tsEntry.io, tscExtr)) matchedSymbolsStrict++;
                if (cN === 0 && pN === 0 && (tscExtr.consumes.length + tscExtr.produces.length) > 0) {
                    chunksWithEmptyExtractorButOracleHasTypes++;
                }
                results.push({
                    file: path.relative(absCorpus, file),
                    symbol: key,
                    treesitter: tsEntry.io,
                    tscompiler: tscExtr,
                    match: cmp.match,
                    reason: cmp.reason,
                });
            }
        } catch (err) {
            console.error(`Failed ${file}: ${(err as Error).message}`);
        }
    }

    const accuracy = totalSymbols > 0 ? (matchedSymbols / totalSymbols) * 100 : 0;
    const accuracyStrict = totalSymbols > 0 ? (matchedSymbolsStrict / totalSymbols) * 100 : 0;
    const failureRate = 100 - accuracy;

    function bucketize(reason: string | undefined): string {
        if (!reason) return "no-reason";
        const items = reason.replace(/^missing\s+/, "").split(",");
        const tokens = items.map((s) => (s.split(":")[1] ?? "").trim());
        const isAnon = (t: string) => t === "__type";
        const isGenericLetter = (t: string) => /^[A-Z][0-9]?$/.test(t);
        const allAnon = tokens.length > 0 && tokens.every(isAnon);
        const allGeneric = tokens.length > 0 && tokens.every(isGenericLetter);
        const anyAnon = tokens.some(isAnon);
        const anyGeneric = tokens.some(isGenericLetter);
        if (allAnon) return "anon-type-literal";
        if (allGeneric) return "generic-type-param";
        if (anyAnon && anyGeneric) return "mixed-anon-and-generic";
        if (anyAnon) return "mixed-anon-and-named";
        if (anyGeneric) return "mixed-generic-and-named";
        return "named-type-missed";
    }

    const failures = results.filter((r) => !r.match);
    const bucketCounts: Record<string, number> = {};
    const bucketExamples: Record<string, ExtractionResult[]> = {};
    for (const f of failures) {
        const b = bucketize(f.reason);
        bucketCounts[b] = (bucketCounts[b] ?? 0) + 1;
        if (!bucketExamples[b]) bucketExamples[b] = [];
        if (bucketExamples[b].length < 2) bucketExamples[b].push(f);
    }

    const sortedBuckets = Object.entries(bucketCounts).sort((a, b) => b[1] - a[1]);
    const breakdown_by_reason = sortedBuckets.map(([name, count]) => ({
        bucket: name,
        count,
        pct_of_failures: ((count / failures.length) * 100).toFixed(1) + "%",
        examples: bucketExamples[name],
    }));

    // Sub-bucket the named-type-missed failures (heuristic gaps)
    const namedSub: Record<string, number> = {};
    for (const f of failures) {
        if (bucketize(f.reason) !== "named-type-missed") continue;
        const tokens = (f.reason ?? "").replace(/^missing\s+/, "").split(",").map((s) => (s.split(":")[1] ?? "").trim());
        const hasDollar = tokens.some((t) => t.startsWith("$"));
        const isArray = tokens.some((t) => t === "Array");
        const sb = hasDollar
            ? "dollar-prefix-type"
            : isArray
                ? "array-resolution-asymmetry"
                : "plain-named-missed";
        namedSub[sb] = (namedSub[sb] ?? 0) + 1;
    }
    const named_type_sub_buckets = Object.entries(namedSub)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ sub_bucket: name, count }));

    let cumulativeFiltered = 0;
    const filter_projection: Array<{
        filter_through: string;
        cumulative_filtered: number;
        remaining_total: number;
        projected_accuracy: string;
        passes_60_smoke_threshold: boolean;
        passes_80_kill_threshold: boolean;
    }> = [];
    for (const [name, count] of sortedBuckets) {
        cumulativeFiltered += count;
        const remaining = totalSymbols - cumulativeFiltered;
        const proj = remaining > 0 ? (matchedSymbols / remaining) * 100 : 0;
        filter_projection.push({
            filter_through: name,
            cumulative_filtered: cumulativeFiltered,
            remaining_total: remaining,
            projected_accuracy: proj.toFixed(1) + "%",
            passes_60_smoke_threshold: proj >= 60,
            passes_80_kill_threshold: proj >= 80,
        });
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const report = {
        corpus: absCorpus,
        elapsedSec: elapsedSec + "s",
        filesEvaluated: files.length,
        totalSymbols,
        matchedSymbols_legacy: matchedSymbols,
        matchedSymbols_strict: matchedSymbolsStrict,
        accuracy_legacy_subset: accuracy.toFixed(1) + "%",
        accuracy_strict_bidirectional: accuracyStrict.toFixed(1) + "%",
        failureRate: failureRate.toFixed(1) + "%",
        killCriterion: failureRate > 20 ? "ABORT_SPRINT" : "PROCEED",
        coverage: {
            chunksFuncMethod,
            chunksWithIO,
            coveragePct: chunksFuncMethod > 0
                ? (chunksWithIO / chunksFuncMethod * 100).toFixed(2) + "%"
                : "0.00%",
        },
        density: {
            avgConsumesPerChunk: chunksFuncMethod > 0 ? +(totalConsumes / chunksFuncMethod).toFixed(2) : 0,
            avgProducesPerChunk: chunksFuncMethod > 0 ? +(totalProduces / chunksFuncMethod).toFixed(2) : 0,
            avgTotalIOPerChunk: chunksFuncMethod > 0 ? +((totalConsumes + totalProduces) / chunksFuncMethod).toFixed(2) : 0,
        },
        oracleAgreement: {
            chunksMatchingOracle: matchedSymbols,
            matchPct: accuracy.toFixed(1) + "%",
            chunksWithEmptyExtractorButOracleHasTypes,
        },
        whitelist_unwrap: {
            applied_on_both_sides: true,
            unwrap: ["Promise", "Awaitable", "Array", "ReadonlyArray", "T[]", "readonly T[]"],
            keep_container_name: ["Map", "Set", "WeakMap", "WeakSet", "Result", "Option", "Either", "Maybe", "any custom generic not in unwrap list"],
            discard: Array.from(DISCARD_NAMES).filter(s => s !== "").concat(["(Anonymous*"]),
        },
        regex_change: {
            from: "[A-Z][A-Za-z0-9_]*",
            to: "[a-zA-Z_$][a-zA-Z0-9_$]*",
            rationale: "Accept $-prefix and underscore-prefix valid TypeScript identifiers.",
        },
        caveat_oracle:
            "Ground truth from vanilla ts.createProgram, NOT from TsCompilerWrapper. " +
            "Production accuracy may diverge ~2-5% in edge cases (deep re-exports, " +
            "complex generics, monorepo paths). Acceptable as Phase 1 proxy. " +
            "If accuracy lands 78-82%, re-validate with TsCompilerWrapper harness " +
            "before kill decision.",
        known_heuristic_gaps: [
            "Regex ^[^{]+ for signature extraction may truncate at { in generic bounds (e.g. T extends { id: string }).",
            "Regex extracts single-token types only — does not handle qualified names like core.SomeType (captures only 'core').",
            "Regex generic group <[^>]+> stops at first >, so deeply nested generics like Promise<Map<K,V>> may misparse.",
        ],
        breakdown_by_reason,
        named_type_sub_buckets,
        filter_projection,
        worstFailures: failures.slice(0, 20),
    };

    console.log("\n=== TYPE LEDGER ACCURACY REPORT ===");
    console.log(JSON.stringify(report, null, 2));

    fs.writeFileSync(
        path.join("scripts", "eval-type-ledger-report.json"),
        JSON.stringify(report, null, 2),
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
