// Untracked scratch tool — Mesa Autopsias Bilateral Sub-sprint 2.2.2 cierre.
// Extrae chunks bucket E (spurious tokens no-A/B/C/D + oracle empty para
// la dimensión que tiene el spurious) y muestrea N por corpus.
//
// Uso:
//   npx tsx scripts/autopsy-extract.ts <suspects.json> <N> [--counts-only]

import { readFileSync } from "node:fs";

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

const path = process.argv[2];
const n = parseInt(process.argv[3] ?? "15");
const countsOnly = process.argv.includes("--counts-only");

const data = JSON.parse(readFileSync(path, "utf-8")) as SuspectsFile;

const buckets: Record<Cat, Suspect[]> = { A: [], B: [], C: [], D: [], E: [], F: [] };

for (const s of data.suspects) {
    const oracleEmptyConsumes = s.tsc_consumes.length === 0;
    const oracleEmptyProduces = s.tsc_produces.length === 0;
    const allSpurious = [
        ...s.spurious_consumes.map(t => ({ t, oracleEmpty: oracleEmptyConsumes })),
        ...s.spurious_produces.map(t => ({ t, oracleEmpty: oracleEmptyProduces })),
    ];
    if (allSpurious.length === 0) continue;
    const cats = new Set<Cat>();
    for (const { t, oracleEmpty } of allSpurious) {
        cats.add(classify(t, oracleEmpty));
    }
    // Pure-E chunk: ALL spurious tokens classify to E (no contamination)
    if (cats.size === 1 && cats.has("E")) {
        buckets.E.push(s);
        continue;
    }
    // Mixed bucket — assign to highest priority non-E cat for accounting
    if (cats.has("A")) buckets.A.push(s);
    else if (cats.has("B")) buckets.B.push(s);
    else if (cats.has("C")) buckets.C.push(s);
    else if (cats.has("D")) buckets.D.push(s);
    else if (cats.has("F")) buckets.F.push(s);
    else if (cats.has("E")) buckets.E.push(s);
}

if (countsOnly) {
    console.log(`${data.corpus}: total=${data.total_suspects} A=${buckets.A.length} B=${buckets.B.length} C=${buckets.C.length} D=${buckets.D.length} E=${buckets.E.length} F=${buckets.F.length}`);
    process.exit(0);
}

// Random sample N from bucket E
const shuffled = buckets.E.slice().sort(() => Math.random() - 0.5);
const sample = shuffled.slice(0, n);

console.log(JSON.stringify({
    corpus: data.corpus,
    bucket_E_total: buckets.E.length,
    sample_size: sample.length,
    sample
}, null, 2));
