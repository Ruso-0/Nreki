import * as fs from "node:fs";

const RESERVED = new Set([
    "typeof", "asserts", "keyof", "infer", "extends",
    "is", "in", "as", "satisfies", "readonly",
]);
const UTILITIES = new Set([
    "Pick", "Omit", "Record", "Partial", "Required", "Readonly",
    "ReturnType", "Parameters", "InstanceType", "ConstructorParameters",
    "NonNullable", "Exclude", "Extract", "Awaited", "ThisType",
    "Uppercase", "Lowercase", "Capitalize", "Uncapitalize",
]);
const SHORT_GEN_RX = /^[A-Z][A-Z0-9]?$/;
const NON_IDENT_RX = /[{\[\(\n]/;

type Cat =
    | "A_RESERVED_WORD"
    | "B_SINGLE_SHORT_GENERIC"
    | "C_UTILITY_TYPE"
    | "D_INLINE_OBJECT_LITERAL"
    | "E_ORACLE_PROXY_FAILURE_LIKELY"
    | "F_UNCATEGORIZED";

const CATS: Cat[] = [
    "A_RESERVED_WORD",
    "B_SINGLE_SHORT_GENERIC",
    "C_UTILITY_TYPE",
    "D_INLINE_OBJECT_LITERAL",
    "E_ORACLE_PROXY_FAILURE_LIKELY",
    "F_UNCATEGORIZED",
];

function classify(t: string, oracleEmpty: boolean): Cat {
    if (RESERVED.has(t)) return "A_RESERVED_WORD";
    if (SHORT_GEN_RX.test(t)) return "B_SINGLE_SHORT_GENERIC";
    if (UTILITIES.has(t)) return "C_UTILITY_TYPE";
    if (NON_IDENT_RX.test(t)) return "D_INLINE_OBJECT_LITERAL";
    if (oracleEmpty) return "E_ORACLE_PROXY_FAILURE_LIKELY";
    return "F_UNCATEGORIZED";
}

interface Suspect {
    file: string;
    symbol: string;
    line: number;
    tsx_consumes: string[];
    tsx_produces: string[];
    tsc_consumes: string[];
    tsc_produces: string[];
    spurious_consumes: string[];
    spurious_produces: string[];
}

interface SuspectsFile {
    corpus: string;
    zone: string;
    total_suspects: number;
    suspects: Suspect[];
}

interface CorpusStats {
    name: string;
    totalSuspects: number;
    totalSpuriousTypes: number;
    typeCounts: Record<Cat, number>;
    chunkSets: Record<Cat, number>;
    examples: Record<Cat, Array<{ file: string; symbol: string; type: string }>>;
    chunkCategoryCount: number[];
    fTypeFrequency: Record<string, number>;
    fEmptyOracleCount: number;
    fTotalCount: number;
}

function newStats(name: string): CorpusStats {
    const typeCounts = {} as Record<Cat, number>;
    const chunkSets = {} as Record<Cat, number>;
    const examples = {} as Record<Cat, Array<{ file: string; symbol: string; type: string }>>;
    for (const c of CATS) {
        typeCounts[c] = 0;
        chunkSets[c] = 0;
        examples[c] = [];
    }
    return {
        name,
        totalSuspects: 0,
        totalSpuriousTypes: 0,
        typeCounts,
        chunkSets,
        examples,
        chunkCategoryCount: [0, 0, 0, 0, 0, 0, 0],
        fTypeFrequency: {},
        fEmptyOracleCount: 0,
        fTotalCount: 0,
    };
}

const FILES = [
    "scripts/eval-type-ledger-suspects-colinhacks__zod.json",
    "scripts/eval-type-ledger-suspects-withastro__astro.json",
    "scripts/eval-type-ledger-suspects-prisma__prisma.json",
];

function processFile(file: string): CorpusStats {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as SuspectsFile;
    const stats = newStats(data.corpus);
    stats.totalSuspects = data.total_suspects;

    for (const s of data.suspects) {
        const oracleEmpty = (s.tsc_consumes.length + s.tsc_produces.length) === 0;
        const chunkCats = new Set<Cat>();
        const allSpurious = [...s.spurious_consumes, ...s.spurious_produces];
        stats.totalSpuriousTypes += allSpurious.length;

        for (const t of allSpurious) {
            const cat = classify(t, oracleEmpty);
            stats.typeCounts[cat]++;
            chunkCats.add(cat);
            if (stats.examples[cat].length < 5) {
                stats.examples[cat].push({ file: s.file, symbol: s.symbol, type: t });
            }
            if (cat === "F_UNCATEGORIZED") {
                stats.fTypeFrequency[t] = (stats.fTypeFrequency[t] ?? 0) + 1;
            }
        }

        for (const c of chunkCats) stats.chunkSets[c]++;
        stats.chunkCategoryCount[chunkCats.size]++;

        if (chunkCats.has("F_UNCATEGORIZED")) {
            stats.fTotalCount++;
            if (oracleEmpty) stats.fEmptyOracleCount++;
        }
    }

    return stats;
}

const all = FILES.map(processFile);

// ─── Tabla cruzada ───
console.log("\n=== TABLA CRUZADA — count (%) de spurious types por categoría ===\n");
const colHeaders = all.map(s => s.name.padEnd(28));
console.log(`${"Cat".padEnd(35)} | ${colHeaders.join(" | ")}`);
console.log(`${"-".repeat(35)} | ${all.map(() => "-".repeat(28)).join("-+-")}`);
for (const cat of CATS) {
    const cells = all.map(s => {
        const c = s.typeCounts[cat];
        const pct = s.totalSpuriousTypes > 0
            ? ((c / s.totalSpuriousTypes) * 100).toFixed(1)
            : "0.0";
        return `${String(c).padStart(5)} types (${pct.padStart(5)}%)`.padEnd(28);
    });
    console.log(`${cat.padEnd(35)} | ${cells.join(" | ")}`);
}
const totalRow = all.map(s =>
    `${String(s.totalSpuriousTypes).padStart(5)} total spurious     `.padEnd(28),
);
console.log(`${"TOTAL spurious types".padEnd(35)} | ${totalRow.join(" | ")}`);

const suspectsRow = all.map(s =>
    `${String(s.totalSuspects).padStart(5)} suspects           `.padEnd(28),
);
console.log(`${"TOTAL suspects (chunks)".padEnd(35)} | ${suspectsRow.join(" | ")}`);

// ─── Distribución de chunks por categoría (chunkSets) ───
console.log("\n=== CHUNKS por categoría — # chunks con AT LEAST ONE spurious in esa categoría ===\n");
console.log(`${"Cat".padEnd(35)} | ${colHeaders.join(" | ")}`);
console.log(`${"-".repeat(35)} | ${all.map(() => "-".repeat(28)).join("-+-")}`);
for (const cat of CATS) {
    const cells = all.map(s => {
        const c = s.chunkSets[cat];
        const pct = s.totalSuspects > 0
            ? ((c / s.totalSuspects) * 100).toFixed(1)
            : "0.0";
        return `${String(c).padStart(5)} chunks (${pct.padStart(5)}%)`.padEnd(28);
    });
    console.log(`${cat.padEnd(35)} | ${cells.join(" | ")}`);
}

// ─── Samples ───
console.log("\n=== SAMPLES — 5 ejemplos representativos por (corpus, categoría) ===");
for (const s of all) {
    console.log(`\n## ${s.name}`);
    for (const cat of CATS) {
        if (s.examples[cat].length === 0) continue;
        console.log(`\n  ${cat}:`);
        for (const ex of s.examples[cat]) {
            const safe = ex.type.length > 60 ? ex.type.slice(0, 57) + "..." : ex.type;
            console.log(`    ${ex.file} :: ${ex.symbol} → "${safe}"`);
        }
    }
}

// ─── Overlap ───
console.log("\n=== OVERLAP — # chunks con N categorías distintas simultáneas ===\n");
console.log(`${"Corpus".padEnd(28)} |    0 |    1 |    2 |    3 |    4 |    5 |    6`);
console.log(`${"-".repeat(28)} | ${Array(7).fill("----").join(" | ")}`);
for (const s of all) {
    const row = s.chunkCategoryCount.map(n => String(n).padStart(4));
    console.log(`${s.name.padEnd(28)} | ${row.join(" | ")}`);
}
const overlapMultiCat = all.map(s => ({
    name: s.name,
    multi: s.chunkCategoryCount.slice(2).reduce((a, b) => a + b, 0),
    total: s.totalSuspects,
}));
console.log("\nChunks con >= 2 categorías simultáneas (doblemente sucios):");
for (const o of overlapMultiCat) {
    const pct = o.total > 0 ? ((o.multi / o.total) * 100).toFixed(1) : "0.0";
    console.log(`  ${o.name.padEnd(28)} ${o.multi} / ${o.total} (${pct}%)`);
}

// ─── F deep-dive ───
console.log("\n=== CATEGORÍA F — UNCATEGORIZED deep-dive (probable Over-Unwrap real) ===");
for (const s of all) {
    console.log(`\n## ${s.name}`);
    console.log(`  chunks con al menos un F:           ${s.fTotalCount}`);
    const pctF = s.fTotalCount > 0
        ? ((s.fEmptyOracleCount / s.fTotalCount) * 100).toFixed(1)
        : "0.0";
    console.log(`  de esos, oracle TOTALMENTE vacío:   ${s.fEmptyOracleCount} (${pctF}%)`);
    console.log(`  Top-10 spurious types en F:`);
    const sorted = Object.entries(s.fTypeFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    for (const [type, count] of sorted) {
        const safe = type.length > 50 ? type.slice(0, 47) + "..." : type;
        console.log(`    ${String(count).padStart(4)}x  "${safe}"`);
    }
}
