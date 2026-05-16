import * as fs from "node:fs";

const RESERVED_INITIAL = new Set([
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

type Cat = "A" | "B" | "C" | "D" | "E" | "F";

function classify(t: string, oracleEmpty: boolean): Cat {
    if (RESERVED_INITIAL.has(t)) return "A";
    if (SHORT_GEN_RX.test(t)) return "B";
    if (UTILITIES.has(t)) return "C";
    if (NON_IDENT_RX.test(t)) return "D";
    if (oracleEmpty) return "E";
    return "F";
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

const FILES = [
    "scripts/eval-type-ledger-suspects-colinhacks__zod.json",
    "scripts/eval-type-ledger-suspects-withastro__astro.json",
    "scripts/eval-type-ledger-suspects-prisma__prisma.json",
];

interface Stats {
    name: string;
    aTokens: Map<string, number>;
    bTokens: Map<string, number>;
    dSamples: string[];
    dDelimBreakdown: { brace: number; bracket: number; paren: number; newline: number };
    overlapAB: number;
    overlapAD: number;
    overlapBD: number;
    overlapABD: number;
    chunksWithA: Set<string>;
    chunksWithB: Set<string>;
    chunksWithD: Set<string>;
}

function newStats(name: string): Stats {
    return {
        name,
        aTokens: new Map(),
        bTokens: new Map(),
        dSamples: [],
        dDelimBreakdown: { brace: 0, bracket: 0, paren: 0, newline: 0 },
        overlapAB: 0, overlapAD: 0, overlapBD: 0, overlapABD: 0,
        chunksWithA: new Set(), chunksWithB: new Set(), chunksWithD: new Set(),
    };
}

function processFile(file: string): Stats {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as SuspectsFile;
    const stats = newStats(data.corpus);

    for (const s of data.suspects) {
        const oracleEmpty = (s.tsc_consumes.length + s.tsc_produces.length) === 0;
        const all = [...s.spurious_consumes, ...s.spurious_produces];
        const chunkKey = `${s.file}::${s.symbol}`;
        const chunkCats = new Set<Cat>();

        for (const t of all) {
            const c = classify(t, oracleEmpty);
            chunkCats.add(c);
            if (c === "A") stats.aTokens.set(t, (stats.aTokens.get(t) ?? 0) + 1);
            if (c === "B") stats.bTokens.set(t, (stats.bTokens.get(t) ?? 0) + 1);
            if (c === "D") {
                if (stats.dSamples.length < 8) stats.dSamples.push(t);
                if (t.includes("{")) stats.dDelimBreakdown.brace++;
                if (t.includes("[")) stats.dDelimBreakdown.bracket++;
                if (t.includes("(")) stats.dDelimBreakdown.paren++;
                if (t.includes("\n")) stats.dDelimBreakdown.newline++;
            }
        }

        if (chunkCats.has("A")) stats.chunksWithA.add(chunkKey);
        if (chunkCats.has("B")) stats.chunksWithB.add(chunkKey);
        if (chunkCats.has("D")) stats.chunksWithD.add(chunkKey);

        const hasA = chunkCats.has("A");
        const hasB = chunkCats.has("B");
        const hasD = chunkCats.has("D");
        if (hasA && hasB) stats.overlapAB++;
        if (hasA && hasD) stats.overlapAD++;
        if (hasB && hasD) stats.overlapBD++;
        if (hasA && hasB && hasD) stats.overlapABD++;
    }

    return stats;
}

const all = FILES.map(processFile);

console.log("\n=== CATEGORY A (RESERVED_WORD) — full token frequency ===");
const allATokens = new Set<string>();
for (const s of all) {
    console.log(`\n## ${s.name} (${[...s.aTokens.values()].reduce((a, b) => a + b, 0)} A spurious)`);
    const sorted = [...s.aTokens.entries()].sort((a, b) => b[1] - a[1]);
    for (const [t, n] of sorted) {
        const inSet = RESERVED_INITIAL.has(t) ? "(in initial spec)" : "(NOT in initial spec)";
        console.log(`  ${String(n).padStart(3)}x  "${t}"  ${inSet}`);
        allATokens.add(t);
    }
}
console.log(`\nDistinct A tokens cross-corpus: ${allATokens.size}`);
console.log(`Initial spec set: ${[...RESERVED_INITIAL].join(", ")}`);
const aOutside = [...allATokens].filter(t => !RESERVED_INITIAL.has(t));
console.log(`Tokens detected but NOT in initial spec: ${aOutside.length === 0 ? "(none)" : aOutside.join(", ")}`);

console.log("\n\n=== CATEGORY B (SHORT_GENERIC) — full token frequency ===");
const allBTokens = new Set<string>();
const knownAcronymTypes = new Set([
    "ID", "URL", "URI", "OK", "DB", "API", "UI", "IO", "OS", "JS", "TS",
    "JSX", "CSS", "JS", "OS", "AI", "ML", "GPU", "CPU", "RAM",
]);
for (const s of all) {
    console.log(`\n## ${s.name} (${[...s.bTokens.values()].reduce((a, b) => a + b, 0)} B spurious)`);
    const sorted = [...s.bTokens.entries()].sort((a, b) => b[1] - a[1]);
    for (const [t, n] of sorted) {
        const acronymFlag = knownAcronymTypes.has(t) ? "  ⚠ POSSIBLE FALSE-POSITIVE (real acronym)" : "";
        console.log(`  ${String(n).padStart(3)}x  "${t}"${acronymFlag}`);
        allBTokens.add(t);
    }
}
console.log(`\nDistinct B tokens cross-corpus: ${allBTokens.size}`);
const possibleAcronyms = [...allBTokens].filter(t => knownAcronymTypes.has(t));
console.log(`B tokens that are KNOWN ACRONYMS (false-positive risk): ${possibleAcronyms.length === 0 ? "(none detected)" : possibleAcronyms.join(", ")}`);

console.log("\n\n=== CATEGORY D (INLINE_OBJECT_LITERAL) — samples + delimiter breakdown ===");
for (const s of all) {
    const dTotal = s.dDelimBreakdown.brace + s.dDelimBreakdown.bracket + s.dDelimBreakdown.paren + s.dDelimBreakdown.newline;
    console.log(`\n## ${s.name}`);
    console.log(`  Delimiter occurrences (NOT mutually exclusive — a single token can have multiple):`);
    console.log(`    contains '{':  ${s.dDelimBreakdown.brace}`);
    console.log(`    contains '[':  ${s.dDelimBreakdown.bracket}`);
    console.log(`    contains '(':  ${s.dDelimBreakdown.paren}`);
    console.log(`    contains '\\n': ${s.dDelimBreakdown.newline}`);
    console.log(`  Samples (up to 8):`);
    for (const sample of s.dSamples) {
        const safe = sample.length > 80 ? sample.slice(0, 77) + "..." : sample;
        const oneLine = safe.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t");
        console.log(`    "${oneLine}"`);
    }
}

console.log("\n\n=== OVERLAP A+B+D ===");
console.log(`Corpus           | chunks_A | chunks_B | chunks_D | A∩B | A∩D | B∩D | A∩B∩D`);
console.log(`-----------------|----------|----------|----------|-----|-----|-----|------`);
for (const s of all) {
    console.log(
        `${s.name.padEnd(16)} | ${String(s.chunksWithA.size).padStart(8)} | ${String(s.chunksWithB.size).padStart(8)} | ${String(s.chunksWithD.size).padStart(8)} | ${String(s.overlapAB).padStart(3)} | ${String(s.overlapAD).padStart(3)} | ${String(s.overlapBD).padStart(3)} | ${String(s.overlapABD).padStart(4)}`,
    );
}

let totalChunksAffectedABD = 0;
for (const s of all) {
    const union = new Set<string>([...s.chunksWithA, ...s.chunksWithB, ...s.chunksWithD]);
    totalChunksAffectedABD += union.size;
    console.log(`${s.name.padEnd(16)} union(A,B,D) chunks: ${union.size}`);
}
console.log(`\nTotal cross-corpus chunks with at least one A/B/D spurious: ${totalChunksAffectedABD}`);
