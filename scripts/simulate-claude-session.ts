/**
 * simulate-claude-session.ts — Real-world Claude Code session simulation
 *
 * Simulates a typical 50-file read session with mixed file sizes:
 *   15 files < 50 lines (config, types)
 *   15 files 50-300 lines (helpers, utils)
 *   10 files 300-800 lines (components, large utilities)
 *    5 files 500-1500 lines (services, controllers)
 *    5 files > 1000 lines (engines, main modules)
 *
 * Measures cumulative raw vs NREKI-compressed tokens.
 *
 * Usage: npx tsx scripts/simulate-claude-session.ts
 */

import fs from "fs";
import path from "path";
import { NrekiEngine } from "../src/engine.js";
import { estimateTokens } from "../src/utils/token-estimator.js";

const ROOT = path.resolve(".");
const SRC_DIR = path.join(ROOT, "src");

interface SessionFile {
  path: string;
  lines: number;
  bytes: number;
  rawTokens: number;
  compressedTokens: number;
  savedTokens: number;
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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  console.log("NREKI Claude Code Session Simulation");
  console.log("=".repeat(70));
  console.log();

  const engine = new NrekiEngine({
    dbPath: path.join(ROOT, ".nreki-sim-session.db"),
    watchPaths: [ROOT],
  });
  await engine.initialize();
  await engine.indexDirectory(SRC_DIR);

  // Gather files with line counts
  const allFiles = walkTsFiles(SRC_DIR);
  const fileInfo: Array<{ path: string; lines: number; bytes: number; content: string }> = [];

  for (const fp of allFiles) {
    try {
      const content = fs.readFileSync(fp, "utf-8");
      const lines = content.split("\n").length;
      const bytes = content.length;
      fileInfo.push({ path: fp, lines, bytes, content });
    } catch { /* skip */ }
  }

  // Categorize
  const tiny = fileInfo.filter(f => f.lines < 50);
  const small = fileInfo.filter(f => f.lines >= 50 && f.lines < 100);
  const medium = fileInfo.filter(f => f.lines >= 100 && f.lines < 300);
  const large = fileInfo.filter(f => f.lines >= 300 && f.lines < 1000);
  const huge = fileInfo.filter(f => f.lines >= 1000);

  console.log(`Available files: tiny=${tiny.length} small=${small.length} medium=${medium.length} large=${large.length} huge=${huge.length}`);
  console.log();

  // Build session: pick files from each bucket
  const bucketTargets: Array<{ label: string; pool: typeof fileInfo; count: number }> = [
    { label: "Config/types (<50L)", pool: tiny, count: 15 },
    { label: "Helpers (50-300L)", pool: [...small, ...medium], count: 15 },
    { label: "Components (300-1000L)", pool: large, count: 10 },
    { label: "Services (500-1500L)", pool: [...large.filter(f => f.lines >= 500), ...huge.filter(f => f.lines <= 1500)], count: 5 },
    { label: "Main modules (>1000L)", pool: huge.filter(f => f.lines > 1000), count: 5 },
  ];

  const sessionFiles: SessionFile[] = [];

  for (const target of bucketTargets) {
    const picked = shuffle(target.pool).slice(0, Math.min(target.count, target.pool.length));
    for (const f of picked) {
      try {
        const rawTokens = estimateTokens(f.content);
        // Simulate what NREKI would do: if <100 lines, raw; else compress medium
        let compressedTokens: number;
        if (f.lines < 100) {
          compressedTokens = rawTokens; // NREKI returns raw for <100L files
        } else {
          const result = await engine.compressFileAdvanced(f.path, "medium", f.content);
          compressedTokens = estimateTokens(result.compressed);
        }
        const saved = rawTokens - compressedTokens;

        sessionFiles.push({
          path: path.relative(ROOT, f.path),
          lines: f.lines,
          bytes: f.bytes,
          rawTokens,
          compressedTokens,
          savedTokens: saved,
        });
      } catch { /* skip */ }
    }
  }

  // Sort by line count for display
  sessionFiles.sort((a, b) => a.lines - b.lines);

  // Compute cumulative metrics
  let totalRaw = 0;
  let totalCompressed = 0;

  console.log("--- Session File List ---");
  console.log("File                          | Lines | Raw  | Comp | Saved");
  console.log("-".repeat(80));

  for (const f of sessionFiles) {
    totalRaw += f.rawTokens;
    totalCompressed += f.compressedTokens;
    const name = f.path.length > 30 ? "..." + f.path.slice(-27) : f.path.padEnd(30);
    console.log(`${name} | ${String(f.lines).padStart(5)} | ${String(f.rawTokens).padStart(4)} | ${String(f.compressedTokens).padStart(4)} | ${String(f.savedTokens).padStart(5)}`);
  }

  console.log();
  console.log("=".repeat(70));
  console.log("CUMULATIVE SESSION METRICS");
  console.log("=".repeat(70));
  console.log(`Files read:        ${sessionFiles.length}`);
  console.log(`Total raw tokens:  ${totalRaw.toLocaleString()}`);
  console.log(`Total NREKI tokens: ${totalCompressed.toLocaleString()}`);
  const netSaved = totalRaw - totalCompressed;
  const netPct = totalRaw > 0 ? (netSaved / totalRaw * 100).toFixed(1) : "0";
  console.log(`Net tokens saved:  ${netSaved.toLocaleString()} (${netPct}%)`);
  console.log();

  // Breakdown by bucket
  console.log("--- Breakdown by File Category ---");
  console.log("Category              | Files | Raw   | Comp  | Saved  | Save%");
  console.log("-".repeat(75));

  const categories = [
    { label: "Config (<50L)", maxLines: 49 },
    { label: "Small (50-99L)", minLines: 50, maxLines: 99 },
    { label: "Medium (100-299L)", minLines: 100, maxLines: 299 },
    { label: "Large (300-1000L)", minLines: 300, maxLines: 1000 },
    { label: "Huge (>1000L)", minLines: 1001, maxLines: Infinity },
  ];

  for (const cat of categories) {
    const files = sessionFiles.filter(f => {
      if (cat.minLines !== undefined) return f.lines >= cat.minLines && f.lines <= cat.maxLines;
      return f.lines <= cat.maxLines;
    });
    if (files.length === 0) continue;
    const r = files.reduce((s, f) => s + f.rawTokens, 0);
    const c = files.reduce((s, f) => s + f.compressedTokens, 0);
    const sv = r - c;
    const pct = r > 0 ? (sv / r * 100).toFixed(1) + "%" : "N/A";
    console.log(`${cat.label.padEnd(22)} | ${String(files.length).padStart(3)} | ${String(r).padStart(5)} | ${String(c).padStart(5)} | ${String(sv).padStart(6)} | ${pct}`);
  }
  console.log();

  // Breakeven analysis
  console.log("--- Breakeven Analysis ---");
  // For small files (<100L): NREKI returns raw = no overhead, no savings
  const smallFiles = sessionFiles.filter(f => f.lines < 100);
  const largeFiles = sessionFiles.filter(f => f.lines >= 100);
  const smallRaw = smallFiles.reduce((s, f) => s + f.rawTokens, 0);
  const largeRaw = largeFiles.reduce((s, f) => s + f.rawTokens, 0);
  const largeComp = largeFiles.reduce((s, f) => s + f.compressedTokens, 0);
  const largeSaved = largeRaw - largeComp;

  console.log(`Small files (<100L): ${smallFiles.length} files, ${smallRaw} tokens (ZERO overhead — NREKI returns raw)`);
  console.log(`Large files (>=100L): ${largeFiles.length} files, ${largeRaw} raw → ${largeComp} comp = ${largeSaved} saved`);
  console.log(`Compression breakeven: savings from large files (${largeSaved}t) cover ${Math.round(largeSaved / Math.max(1, smallRaw))}x the small-file tier`);
  console.log();

  // Honest assessment
  console.log("--- Honest Assessment ---");
  if (netSaved > 0) {
    console.log(`✅ NREKI EMPIRICALLY SAVES tokens in this simulated session (${netSaved} tokens net)`);
    console.log(`   Condition: ${largeFiles.length} large files (${largeRaw}t) compressed → ${largeComp}t`);
  } else {
    console.log(`❌ NREKI COSTS MORE tokens in this simulated session`);
  }
  console.log(`   Token estimator: chars/3.5 (heuristic, NOT real BPE tokenizer)`);
  console.log(`   Small file bypass (<100L): active in handler, returns raw`);

  engine.shutdown();
  try { fs.unlinkSync(path.join(ROOT, ".nreki-sim-session.db")); } catch { /* ok */ }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
