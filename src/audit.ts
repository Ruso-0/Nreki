/**
 * audit.ts — Architecture Health Index (AHI)
 *
 * Deterministic architectural audit. Not an opinion — a measurement.
 * Combines 5 signals no other tool has:
 *   1. Spectral Integrity (λ₂) — is the project about to fracture?
 *   2. Bus Factor (PageRank concentration) — does one file hold all the power?
 *   3. Type Safety (error density) — how clean is the type system?
 *   4. Core Coverage — do critical files have tests?
 *   5. Stability (Chronos CFI) — which core files break chronically?
 *
 * Auto-scales: Deep Audit (5 signals) if kernel is booted, Fast Audit (3 signals) if not.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import * as fs from "fs";
import * as path from "path";
import { SpectralMath, type SparseEdge } from "./kernel/spectral-topology.js";
import { computePageRank, type DependencyGraph } from "./repo-map.js";
import type { NrekiKernel } from "./kernel/nreki-kernel.js";
import type { ChronosMemory } from "./chronos-memory.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface AuditIssue {
    file: string;
    severity: "critical" | "high" | "medium" | "low";
    type: string;
    detail: string;
    action: string;
    impactOnScore: number;
}

export interface AuditComponent {
    name: string;
    score: number;
    weight: number;
    label: string;
    detail: string;
    available: boolean;
}

export interface AuditReport {
    ahi: number;
    level: "CRITICAL" | "POOR" | "FAIR" | "GOOD" | "HEALTHY";
    mode: "fast" | "deep";
    components: AuditComponent[];
    issues: AuditIssue[];
    recoveryPlan: string;
    filesAnalyzed: number;
    coreFiles: string[];
    timestamp: string;
}

// ─── Score Helpers ──────────────────────────────────────────────────

function bucketScore(value: number, thresholds: [number, number, number]): number {
    if (value >= thresholds[0]) return 1.0;
    if (value >= thresholds[1]) return 0.7;
    if (value >= thresholds[2]) return 0.4;
    return 0.1;
}

function bucketScoreInverse(value: number, thresholds: [number, number, number]): number {
    if (value <= thresholds[0]) return 1.0;
    if (value <= thresholds[1]) return 0.7;
    if (value <= thresholds[2]) return 0.4;
    return 0.1;
}

function scoreToLabel(score: number): string {
    if (score >= 0.9) return "HEALTHY";
    if (score >= 0.7) return "GOOD";
    if (score >= 0.4) return "FAIR";
    if (score >= 0.2) return "POOR";
    return "CRITICAL";
}

function ahiToLevel(ahi: number): AuditReport["level"] {
    if (ahi >= 8.0) return "HEALTHY";
    if (ahi >= 6.0) return "GOOD";
    if (ahi >= 4.0) return "FAIR";
    if (ahi >= 2.0) return "POOR";
    return "CRITICAL";
}

// ─── Test Detection ─────────────────────────────────────────────────

const TEST_PATTERNS = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".test.js", ".spec.js"];
const IGNORE_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next", "__pycache__", ".nreki"]);

function findTestFiles(projectRoot: string): Set<string> {
    const testFiles = new Set<string>();
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!IGNORE_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
                continue;
            }
            if (TEST_PATTERNS.some(p => entry.name.endsWith(p))) {
                testFiles.add(path.join(dir, entry.name));
            }
        }
    };
    walk(projectRoot);
    return testFiles;
}

function fileHasTest(filePath: string, _projectRoot: string, testFiles: Set<string>): boolean {
    const baseName = path.basename(filePath).replace(/\.(ts|tsx|js|jsx)$/, "");
    for (const testFile of testFiles) {
        const testBase = path.basename(testFile);
        if (testBase.startsWith(baseName + ".test.") || testBase.startsWith(baseName + ".spec.")) {
            return true;
        }
        // Check if test file imports the target (first 50 lines for perf)
        try {
            const head = fs.readFileSync(testFile, "utf-8").split("\n").slice(0, 50).join("\n");
            if (head.includes(baseName) && (head.includes("import") || head.includes("require"))) {
                return true;
            }
        } catch { /* skip */ }
    }
    return false;
}

// ─── Main Audit ─────────────────────────────────────────────────────

export async function computeAudit(
    graph: DependencyGraph,
    allFiles: string[],
    projectRoot: string,
    kernel?: NrekiKernel,
    chronos?: ChronosMemory,
): Promise<AuditReport> {
    const isDeep = !!kernel?.isBooted();
    const issues: AuditIssue[] = [];
    const components: AuditComponent[] = [];

    const coreFiles = allFiles.filter(f => graph.tiers.get(f) === "core");

    // ═════════════════════════════════════════════════════════
    // SIGNAL 1: Spectral Integrity (λ₂)
    // ═════════════════════════════════════════════════════════

    const nodeIndex = new Map<string, number>();
    allFiles.forEach((f, i) => nodeIndex.set(f, i));
    const N = allFiles.length;

    const sparseEdges: SparseEdge[] = [];
    for (const [targetFile, consumers] of graph.importedBy.entries()) {
        const targetIdx = nodeIndex.get(targetFile);
        if (targetIdx === undefined) continue;
        for (const consumer of consumers) {
            const consumerIdx = nodeIndex.get(consumer);
            if (consumerIdx !== undefined && consumerIdx !== targetIdx) {
                sparseEdges.push({ u: consumerIdx, v: targetIdx, weight: 1.0 });
            }
        }
    }

    let spectralScore = 0.5;
    let fiedlerValue = 0;
    let phi = 0;

    if (N > 2 && sparseEdges.length > 0) {
        const spectral = SpectralMath.analyzeTopology(N, sparseEdges);
        fiedlerValue = spectral.fiedler;
        phi = N > 0 ? fiedlerValue / N : 0;
        spectralScore = bucketScore(phi, [0.10, 0.05, 0.01]);
    }

    components.push({
        name: "Spectral Integrity",
        score: spectralScore,
        weight: 0.25,
        label: scoreToLabel(spectralScore),
        detail: `λ₂ = ${fiedlerValue.toFixed(4)}, Φ = ${phi.toFixed(4)} (${N} files, ${sparseEdges.length} edges)`,
        available: true,
    });

    if (spectralScore <= 0.4) {
        issues.push({
            file: "project-wide",
            severity: spectralScore <= 0.1 ? "critical" : "high",
            type: "spectral_fracture",
            detail: `λ₂ = ${fiedlerValue.toFixed(4)}. The dependency graph is nearly disconnected.`,
            action: "Add cross-module interfaces to distribute coupling. Consider merging isolated clusters.",
            impactOnScore: 0.8,
        });
    }

    // ═════════════════════════════════════════════════════════
    // SIGNAL 2: Bus Factor (PageRank Concentration)
    // ═════════════════════════════════════════════════════════

    const prScores = computePageRank(allFiles, graph.importedBy);
    const sortedPR = Array.from(prScores.entries()).sort((a, b) => b[1] - a[1]);
    const totalPR = sortedPR.reduce((sum, [, v]) => sum + v, 0);
    const top3PR = sortedPR.slice(0, 3).reduce((sum, [, v]) => sum + v, 0);
    const concentration = totalPR > 0 ? top3PR / totalPR : 0;

    const busFactorScore = bucketScoreInverse(concentration, [0.15, 0.30, 0.50]);

    components.push({
        name: "Bus Factor",
        score: busFactorScore,
        weight: 0.25,
        label: scoreToLabel(busFactorScore),
        detail: `Top 3 files hold ${(concentration * 100).toFixed(1)}% of PageRank: ${sortedPR.slice(0, 3).map(([f]) => path.basename(f)).join(", ")}`,
        available: true,
    });

    if (busFactorScore <= 0.4) {
        for (const [file, pr] of sortedPR.slice(0, 3)) {
            const inDeg = graph.inDegree.get(file) || 0;
            if (totalPR > 0 && pr / totalPR > 0.15) {
                issues.push({
                    file,
                    severity: pr / totalPR > 0.30 ? "critical" : "high",
                    type: "bus_factor",
                    detail: `PageRank: ${pr.toFixed(3)} (${((pr / totalPR) * 100).toFixed(1)}% of total). ${inDeg} files depend on this.`,
                    action: `Split responsibilities. Extract interfaces to reduce coupling. ${inDeg} dependents will break if this file breaks.`,
                    impactOnScore: 0.6,
                });
            }
        }
    }

    // ═════════════════════════════════════════════════════════
    // SIGNAL 3: Type Safety (Deep mode only)
    // ═════════════════════════════════════════════════════════

    let typeSafetyScore = 0.5;
    let typeSafetyAvailable = false;

    if (isDeep && kernel) {
        typeSafetyAvailable = true;
        const errorCount = kernel.getCurrentErrorCount();
        const trackedFiles = kernel.getTrackedFiles();
        const errorDensity = trackedFiles > 0 ? errorCount / trackedFiles : 0;
        typeSafetyScore = bucketScoreInverse(errorDensity, [0.0, 0.05, 0.15]);

        if (errorCount > 0) {
            issues.push({
                file: "project-wide",
                severity: errorDensity > 0.15 ? "critical" : (errorDensity > 0.05 ? "high" : "medium"),
                type: "type_errors",
                detail: `${errorCount} type errors across ${trackedFiles} tracked files (density: ${errorDensity.toFixed(3)}).`,
                action: "Fix type errors in core files first. Use nreki_code action:\"edit\" with NREKI validation.",
                impactOnScore: 0.5,
            });
        }
    }

    components.push({
        name: "Type Safety",
        score: typeSafetyScore,
        weight: isDeep ? 0.20 : 0.0,
        label: typeSafetyAvailable ? scoreToLabel(typeSafetyScore) : "N/A (boot kernel for deep audit)",
        detail: typeSafetyAvailable
            ? `Error density: ${kernel!.getCurrentErrorCount()} errors / ${kernel!.getTrackedFiles()} files`
            : "Kernel not booted. Run with Claude Code for type safety analysis.",
        available: typeSafetyAvailable,
    });

    // ═════════════════════════════════════════════════════════
    // SIGNAL 4: Core Coverage (Test Detection)
    // ═════════════════════════════════════════════════════════

    const testFiles = findTestFiles(projectRoot);
    const coreWithTests = coreFiles.filter(f =>
        fileHasTest(path.join(projectRoot, f), projectRoot, testFiles)
    );
    const coreCoverage = coreFiles.length > 0 ? coreWithTests.length / coreFiles.length : 1.0;
    const coreCoverageScore = bucketScore(coreCoverage, [0.90, 0.70, 0.40]);

    components.push({
        name: "Core Coverage",
        score: coreCoverageScore,
        weight: isDeep ? 0.20 : 0.30,
        label: scoreToLabel(coreCoverageScore),
        detail: `${coreWithTests.length}/${coreFiles.length} core files have tests (${(coreCoverage * 100).toFixed(0)}%)`,
        available: true,
    });

    for (const coreFile of coreFiles) {
        if (!fileHasTest(path.join(projectRoot, coreFile), projectRoot, testFiles)) {
            const inDeg = graph.inDegree.get(coreFile) || 0;
            issues.push({
                file: coreFile,
                severity: inDeg > 20 ? "critical" : (inDeg > 5 ? "high" : "medium"),
                type: "untested_core",
                detail: `☢️ CRITICAL CORE file with ${inDeg} dependents and NO tests.`,
                action: `Add tests for ${path.basename(coreFile)}. If this file breaks, ${inDeg} files break with it.`,
                impactOnScore: inDeg > 20 ? 1.2 : 0.6,
            });
        }
    }

    // ═════════════════════════════════════════════════════════
    // SIGNAL 5: Stability (Chronos CFI — Deep mode only)
    // ═════════════════════════════════════════════════════════

    let stabilityScore = 0.7;
    let stabilityAvailable = false;

    if (chronos) {
        stabilityAvailable = true;
        const fragileCore: Array<{ file: string; cfi: number }> = [];

        for (const coreFile of coreFiles) {
            const cfi = chronos.getFileCFI(coreFile);
            if (cfi >= chronos.CFI_ALERT_THRESHOLD) {
                fragileCore.push({ file: coreFile, cfi });
            }
        }

        if (fragileCore.length === 0) stabilityScore = 1.0;
        else if (fragileCore.length <= 2) stabilityScore = 0.7;
        else if (fragileCore.length <= 5) stabilityScore = 0.4;
        else stabilityScore = 0.1;

        for (const { file, cfi } of fragileCore) {
            issues.push({
                file,
                severity: cfi > 30 ? "critical" : "high",
                type: "chronic_fragility",
                detail: `CFI: ${cfi.toFixed(1)}. This core file breaks repeatedly across sessions.`,
                action: "Add regression tests targeting known failure patterns. Consider refactoring to reduce complexity.",
                impactOnScore: 0.4,
            });
        }
    }

    components.push({
        name: "Stability",
        score: stabilityScore,
        weight: isDeep ? 0.10 : 0.0,
        label: stabilityAvailable ? scoreToLabel(stabilityScore) : "N/A (no session history)",
        detail: stabilityAvailable
            ? `Chronos tracking active. ${coreFiles.length} core files monitored.`
            : "No session history yet. Stability improves with usage.",
        available: stabilityAvailable,
    });

    // ═════════════════════════════════════════════════════════
    // COMPUTE AHI
    // ═════════════════════════════════════════════════════════

    const activeComponents = components.filter(c => c.weight > 0);
    const totalWeight = activeComponents.reduce((sum, c) => sum + c.weight, 0);

    let rawAhi = 0;
    for (const c of activeComponents) {
        rawAhi += c.score * (c.weight / totalWeight);
    }
    const ahi = Math.round(rawAhi * 100) / 10;

    // Sort issues by severity then impact
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    issues.sort((a, b) => {
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return b.impactOnScore - a.impactOnScore;
    });

    // Recovery plan
    const topIssues = issues.slice(0, 5);
    const estimatedRecovery = topIssues.reduce((sum, i) => sum + i.impactOnScore, 0);
    const projectedAhi = Math.min(10, ahi + estimatedRecovery);

    let recoveryPlan = "";
    if (topIssues.length > 0) {
        recoveryPlan = `Fix the top ${topIssues.length} issues to raise your score from ${ahi.toFixed(1)} → ~${projectedAhi.toFixed(1)}:\n\n`;
        topIssues.forEach((issue, i) => {
            const icon = issue.severity === "critical" ? "🔴" : (issue.severity === "high" ? "🟠" : "🟡");
            recoveryPlan += `${i + 1}. ${icon} ${issue.file}\n`;
            recoveryPlan += `   ${issue.detail}\n`;
            recoveryPlan += `   → ${issue.action}\n\n`;
        });
    } else {
        recoveryPlan = "No critical issues found. Your architecture is solid.";
    }

    return {
        ahi,
        level: ahiToLevel(ahi),
        mode: isDeep ? "deep" : "fast",
        components,
        issues,
        recoveryPlan,
        filesAnalyzed: allFiles.length,
        coreFiles,
        timestamp: new Date().toISOString(),
    };
}

// ─── Format Report ──────────────────────────────────────────────────

export function formatAuditReport(report: AuditReport): string {
    const levelIcons: Record<string, string> = {
        CRITICAL: "🔴", POOR: "🟠", FAIR: "🟡", GOOD: "🟢", HEALTHY: "✅",
    };

    const icon = levelIcons[report.level] || "❓";
    const modeLabel = report.mode === "deep" ? "Deep Audit (5 signals)" : "Fast Audit (3 signals)";

    let text = "";
    text += `## NREKI Architecture Audit\n\n`;
    text += `╔══════════════════════════════════════════════════════════╗\n`;
    text += `║  Architecture Health Index: ${report.ahi.toFixed(1)}/10 — ${report.level}  ${icon}\n`;
    text += `║  Mode: ${modeLabel}\n`;
    text += `║  Files analyzed: ${report.filesAnalyzed} (${report.coreFiles.length} core)\n`;
    text += `╚══════════════════════════════════════════════════════════╝\n\n`;

    text += `### Signal Breakdown\n\n`;
    for (const c of report.components) {
        const cIcon = c.score >= 0.7 ? "✅" : (c.score >= 0.4 ? "⚠️" : "🔴");
        const displayScore = c.available ? `${(c.score * 10).toFixed(0)}/10` : "N/A";
        const weightStr = c.weight > 0 ? ` (${(c.weight * 100).toFixed(0)}%)` : " (inactive)";
        text += `${cIcon} **${c.name}**: ${displayScore}${weightStr} — ${c.detail}\n`;
    }

    if (report.issues.length > 0) {
        text += `\n### Top Issues (ordered by blast radius)\n\n`;
        const display = report.issues.slice(0, 7);
        for (let i = 0; i < display.length; i++) {
            const issue = display[i];
            const sIcon = issue.severity === "critical" ? "🔴" : (issue.severity === "high" ? "🟠" : "🟡");
            text += `${i + 1}. ${sIcon} **${issue.file}** — ${issue.type}\n`;
            text += `   ${issue.detail}\n`;
            text += `   → ${issue.action}\n\n`;
        }
        if (report.issues.length > 7) {
            text += `   ... and ${report.issues.length - 7} more issues.\n\n`;
        }
    }

    if (report.issues.length > 0) {
        text += `### Recovery Plan\n\n`;
        text += report.recoveryPlan;
    }

    text += `\n---\n`;
    text += `*This is a deterministic score calculated from your dependency graph, type system, and test coverage. It is not an opinion.*\n`;
    text += `*Run \`nreki_guard action:"audit"\` again after making changes to see your score improve.*`;

    return text;
}
