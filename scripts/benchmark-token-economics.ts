/**
 * benchmark-token-economics.ts — Empirical per-file-size token cost analysis
 *
 * Measures raw vs compressed token counts across 5 file-size buckets
 * using NREKI's own source code as test corpus.
 *
 * Usage: npx tsx scripts/benchmark-token-economics.ts
 */

import fs from "fs";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { estimateTokens } from "../src/utils/token-estimator.js";
import type { CompressionLevel } from "../src/compressor.js";

const ROOT = path.resolve(".");
const SRC_DIR = path.join(ROOT, "src");
const OUTPUT_JSON = path.join(ROOT, "bench-token-economics.json");

interface FileResult {
  path: string;
  lines: number;
  rawTokens: number;
  compressedTokens: { light: number; medium: number; aggressive: number };
  tokenDeltas: {
    light: number;
    medium: number;
    aggressive: number;
  };
}

interface BucketStats {
  bucket: string;
  lineRange: [number, number];
  N: number;
  rawTokensTotal: number;
  compressedTokensTotal: { light: number; medium: number; aggressive: number };
  savingsTotal: { light: number; medium: number; aggressive: number };
  overheadInstances: { light: number; medium: number; aggressive: number };
  p50Raw: number;
  p50Compressed: { light: number; medium: number; aggressive: number };
  p50Savings: { light: number; medium: number; aggressive: number };
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      out.push(...walkTsFiles(fp));
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      out.push(fp);
    }
  }
  return out;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function assignBucket(lines: number): string {
  if (lines < 50) return "< 50 lines";
  if (lines < 100) return "50-100 lines";
  if (lines < 300) return "100-300 lines";
  if (lines < 1000) return "300-1000 lines";
  return "> 1000 lines";
}

async function main() {
  console.log("NREKI Token Economics — Per-File-Size Benchmark");
  console.log("=".repeat(70));
  console.log();

  const engine = new NrekiEngine({
    dbPath: path.join(ROOT, ".nreki-bench-token-ec.db"),
    watchPaths: [ROOT],
  });
  await engine.initialize();
  await engine.indexDirectory(SRC_DIR);

  const allFiles = walkTsFiles(SRC_DIR);
  console.log(`Found ${allFiles.length} .ts files in src/`);
  console.log();

  const results: FileResult[] = [];
  const levels: CompressionLevel[] = ["light", "medium", "aggressive"];

  for (const filePath of allFiles) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").length;
      const rawTokens = estimateTokens(content);
      const relPath = path.relative(ROOT, filePath);

      const compressedTokens: { light: number; medium: number; aggressive: number } = {
        light: 0, medium: 0, aggressive: 0,
      };
      const tokenDeltas: { light: number; medium: number; aggressive: number } = {
        light: 0, medium: 0, aggressive: 0,
      };

      for (const level of levels) {
        const r = await engine.compressFileAdvanced(filePath, level, content);
        compressedTokens[level] = estimateTokens(r.compressed);
        tokenDeltas[level] = rawTokens - compressedTokens[level];
      }

      results.push({
        path: relPath,
        lines,
        rawTokens,
        compressedTokens,
        tokenDeltas,
      });

      process.stdout.write(".");
    } catch (err) {
      process.stdout.write("x");
    }
  }
  console.log();
  console.log(`Benchmarked ${results.length} files successfully.`);
  console.log();

  // Group by bucket
  const buckets = new Map<string, FileResult[]>();
  const bucketOrder = ["< 50 lines", "50-100 lines", "100-300 lines", "300-1000 lines", "> 1000 lines"];
  for (const b of bucketOrder) buckets.set(b, []);

  for (const r of results) {
    const bucket = assignBucket(r.lines);
    const arr = buckets.get(bucket);
    if (arr) arr.push(r);
  }

  // Compute stats per bucket
  const bucketStats: BucketStats[] = [];

  for (const bucket of bucketOrder) {
    const files = buckets.get(bucket) ?? [];
    if (files.length === 0) continue;

    const rawTokensArr = files.map(f => f.rawTokens);

    const stat: BucketStats = {
      bucket,
      lineRange: bucket === "< 50 lines" ? [1, 49]
        : bucket === "50-100 lines" ? [50, 99]
        : bucket === "100-300 lines" ? [100, 299]
        : bucket === "300-1000 lines" ? [300, 999]
        : [1000, Infinity],
      N: files.length,
      rawTokensTotal: 0,
      compressedTokensTotal: { light: 0, medium: 0, aggressive: 0 },
      savingsTotal: { light: 0, medium: 0, aggressive: 0 },
      overheadInstances: { light: 0, medium: 0, aggressive: 0 },
      p50Raw: median(rawTokensArr),
      p50Compressed: { light: 0, medium: 0, aggressive: 0 },
      p50Savings: { light: 0, medium: 0, aggressive: 0 },
    };

    for (const f of files) {
      stat.rawTokensTotal += f.rawTokens;
      for (const lvl of levels) {
        stat.compressedTokensTotal[lvl] += f.compressedTokens[lvl];
        stat.savingsTotal[lvl] += f.tokenDeltas[lvl];
        if (f.tokenDeltas[lvl] < 0) stat.overheadInstances[lvl]++;
      }
    }

    for (const lvl of levels) {
      const compArr = files.map(f => f.compressedTokens[lvl]);
      const saveArr = files.map(f => f.tokenDeltas[lvl]);
      stat.p50Compressed[lvl] = median(compArr);
      stat.p50Savings[lvl] = median(saveArr);
    }

    bucketStats.push(stat);
  }

  // Print table
  console.log("File size bucket      | N  | Raw p50 | Comp p50 (med) | Saved p50 | Save%  | OVERHEAD inst");
  console.log("-".repeat(110));
  for (const s of bucketStats) {
    const header = s.bucket.padEnd(21);
    const bucketRawTotal = s.rawTokensTotal;
    const bucketCompMed = s.compressedTokensTotal.medium;
    const savePct = bucketRawTotal > 0
      ? ((bucketRawTotal - bucketCompMed) / bucketRawTotal * 100).toFixed(1) + "%"
      : "N/A";
    const overheadStr = `${s.overheadInstances.medium}/${s.N}`;
    console.log(
      `${header} | ${String(s.N).padStart(2)} | ${String(s.p50Raw).padStart(7)} | ${String(s.p50Compressed.medium).padStart(14)} | ${String(s.p50Savings.medium).padStart(8)} | ${savePct.padStart(6)} | ${overheadStr.padStart(6)}`
    );
  }
  console.log();

  // Detailed per-level breakdown for medium
  console.log("--- Per-Level Detail (all buckets) ---");
  console.log("Level       | Total Raw | Total Comp | Total Saved | Save%  | Overhead");
  console.log("-".repeat(85));
  let grandRaw = 0;
  let grandComp: Record<string, number> = { light: 0, medium: 0, aggressive: 0 };
  let grandOverhead: Record<string, number> = { light: 0, medium: 0, aggressive: 0 };

  for (const s of bucketStats) {
    grandRaw += s.rawTokensTotal;
    for (const lvl of levels) {
      grandComp[lvl] += s.compressedTokensTotal[lvl];
      grandOverhead[lvl] += s.overheadInstances[lvl];
    }
  }

  for (const lvl of levels) {
    const saved = grandRaw - grandComp[lvl];
    const pct = grandRaw > 0 ? (saved / grandRaw * 100).toFixed(1) + "%" : "N/A";
    console.log(
      `${lvl.padEnd(11)} | ${String(grandRaw).padStart(9)} | ${String(grandComp[lvl]).padStart(10)} | ${String(saved).padStart(11)} | ${pct.padStart(6)} | ${String(grandOverhead[lvl]).padStart(3)}/${results.length}`
    );
  }
  console.log();

  // Small files detail
  console.log("--- Small File Overhead Detail (< 100 lines) ---");
  const smallFiles = results.filter(f => f.lines < 100);
  let smallOverheadCount = 0;
  for (const f of smallFiles) {
    for (const lvl of levels) {
      if (f.tokenDeltas[lvl] < 0) smallOverheadCount++;
    }
  }
  console.log(`Small files (< 100L): ${smallFiles.length} files`);
  console.log(`Files where ANY level had overhead: ${smallOverheadCount}`);
  for (const f of smallFiles) {
    const worst = Math.min(f.tokenDeltas.light, f.tokenDeltas.medium, f.tokenDeltas.aggressive);
    if (worst < 0) {
      console.log(`  OVERHEAD: ${f.path} (${f.lines}L) raw=${f.rawTokens} med=${f.compressedTokens.medium} Δ=${f.tokenDeltas.medium}`);
    }
  }
  console.log();

  // Output JSON
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify({ bucketStats, smallFiles, grandRaw, grandComp, results }, null, 2));
  console.log(`Full results: ${OUTPUT_JSON}`);

  engine.shutdown();
  try { fs.unlinkSync(path.join(ROOT, ".nreki-bench-token-ec.db")); } catch { /* ok */ }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
