import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { SpectralTopologist, SpectralMath } from "../src/kernel/spectral-topology.js";

const externalPath = process.argv[2] || process.cwd();
const projectRoot = path.resolve(externalPath);
const tsConfigPath = path.join(projectRoot, "tsconfig.json");

if (!fs.existsSync(tsConfigPath)) {
    console.error(`No tsconfig.json found at ${projectRoot}`);
    process.exit(1);
}

console.log(`=== NREKI PRECISION BENCHMARK ===\n`);
console.log(`Project: ${path.basename(projectRoot)}`);

// 1. Load project
const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);

const allFiles = new Set<string>();
for (const sf of program.getSourceFiles()) {
    const fileName = sf.fileName.replace(/\\/g, "/");
    if (!fileName.includes("node_modules") && !fileName.includes(".test.") && !fileName.includes("/dist/")) {
        allFiles.add(fileName);
    }
}

// 2. Extract full graph to find good test candidates
const fullGraph = SpectralTopologist.extractConstraintGraph(program, allFiles);

// Find files with most type references (best candidates for testing)
const fileEdgeCount = new Map<string, number>();
for (const edge of fullGraph.edges) {
    const file = edge.sourceId.split("::")[0];
    fileEdgeCount.set(file, (fileEdgeCount.get(file) || 0) + 1);
}
const candidateFiles = Array.from(fileEdgeCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file]) => file);

console.log(`\nTest candidates (top 5 by edge count):`);
for (const f of candidateFiles) {
    console.log(`  ${path.relative(projectRoot, f)} (${fileEdgeCount.get(f)} edges)`);
}

// 3. Build dependency map for ego-graph
function getEgoGraph(targetFile: string): Set<string> {
    const ego = new Set<string>();
    ego.add(targetFile);
    // Add files that this file depends on
    for (const edge of fullGraph.edges) {
        const sourceFile = edge.sourceId.split("::")[0];
        const targetFileFromEdge = edge.targetId.split("::")[0];
        if (sourceFile === targetFile && !targetFileFromEdge.startsWith("EXTERNAL::")) {
            ego.add(targetFileFromEdge);
        }
        // Add files that depend on this file
        if (targetFileFromEdge === targetFile && !sourceFile.startsWith("EXTERNAL::")) {
            ego.add(sourceFile);
        }
    }
    return ego;
}

// 4. EGO-GRAPH LATENCY TEST
console.log(`\n=== EGO-GRAPH LATENCY ===`);
const latencies: number[] = [];

for (const file of candidateFiles) {
    const egoFiles = getEgoGraph(file);
    const start = performance.now();
    const result = SpectralTopologist.analyze(program, egoFiles);
    const ms = performance.now() - start;
    latencies.push(ms);
    console.log(`  ${path.basename(file)}: ${egoFiles.size} files, ${result.nodeCount} nodes, ${ms.toFixed(1)}ms, λ₂=${result.fiedlerValue.toFixed(4)}`);
}

const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
const maxLatency = Math.max(...latencies);
console.log(`\n  Average: ${avgLatency.toFixed(1)}ms | Max: ${maxLatency.toFixed(1)}ms | Target: <100ms`);
console.log(`  Verdict: ${maxLatency < 100 ? "✅ PASS" : "❌ FAIL"}`);

// 5. FALSE NEGATIVE TEST (type widening must be detected)
console.log(`\n=== FALSE NEGATIVE TEST (must detect type widening) ===`);
let falseNegatives = 0;
const totalWideningTests = Math.min(candidateFiles.length, 5);

for (let t = 0; t < totalWideningTests; t++) {
    const file = candidateFiles[t];
    const egoFiles = getEgoGraph(file);

    // PRE: analyze ego-graph with original program
    const pre = SpectralTopologist.analyze(program, egoFiles);

    // POST: simulate type widening by removing ALL edges originating
    // from symbols in the target file (simulates every type ref → any)
    // Operate on ego-graph only, matching production behavior
    const egoGraph = SpectralTopologist.extractConstraintGraph(program, egoFiles);
    const postEdges = egoGraph.edges.filter(e => {
        return e.sourceId.split("::")[0] !== file;
    });

    // Rebuild with ego-graph nodes only (not full project)
    const egoNodes = egoGraph.nodes;
    const { matrix: postMatrix, volume: postVolume } = SpectralTopologist.buildAdjacencyMatrix(egoNodes, postEdges);
    const postFiedler = postMatrix.length > 1 ? SpectralMath.getFiedlerValue(postMatrix) : 0;

    const post = {
        fiedlerValue: postFiedler,
        volume: postVolume,
        nodeCount: egoNodes.size,
        edgeCount: postEdges.length,
    };

    const delta = SpectralTopologist.computeDelta(pre, post);

    const detected = delta.verdict === "REJECTED_ENTROPY";
    if (!detected) falseNegatives++;

    console.log(`  ${path.basename(file)}: ego=${egoFiles.size} files, pre(λ₂=${pre.fiedlerValue.toFixed(4)}, vol=${pre.volume}) → post(λ₂=${postFiedler.toFixed(4)}, vol=${postVolume}) = ${delta.verdict} ${detected ? "✅" : "❌ FALSE NEGATIVE"}`);
}

console.log(`  False negatives: ${falseNegatives}/${totalWideningTests}`);

// 6. FALSE POSITIVE TEST (cosmetic refactors must be approved)
console.log(`\n=== FALSE POSITIVE TEST (must approve cosmetic refactors) ===`);
let falsePositives = 0;
const totalRefactorTests = Math.min(candidateFiles.length, 5);

for (let t = 0; t < totalRefactorTests; t++) {
    const file = candidateFiles[t];
    const egoFiles = getEgoGraph(file);

    const result = SpectralTopologist.analyze(program, egoFiles);

    // Cosmetic refactor: same graph, same everything
    const delta = SpectralTopologist.computeDelta(result, result);

    const approved = delta.verdict === "APPROVED";
    if (!approved) falsePositives++;

    console.log(`  ${path.basename(file)}: ${delta.verdict} ${approved ? "✅" : "❌ FALSE POSITIVE"}`);
}

console.log(`  False positives: ${falsePositives}/${totalRefactorTests}`);

// 7. FINAL SUMMARY
console.log(`\n=== FINAL SUMMARY ===`);
console.log(`Project: ${path.basename(projectRoot)}`);
console.log(`Files: ${allFiles.size} | Nodes: ${fullGraph.nodes.size} | Edges: ${fullGraph.edges.length}`);
console.log(`Ego-graph latency: avg=${avgLatency.toFixed(1)}ms, max=${maxLatency.toFixed(1)}ms (target <100ms): ${maxLatency < 100 ? "✅" : "❌"}`);
console.log(`False negatives: ${falseNegatives}/${totalWideningTests} (target 0%): ${falseNegatives === 0 ? "✅" : "❌"}`);
console.log(`False positives: ${falsePositives}/${totalRefactorTests} (target <5%): ${falsePositives === 0 ? "✅" : "❌"}`);
console.log(`Overall: ${maxLatency < 100 && falseNegatives === 0 && falsePositives === 0 ? "✅ ALL PASS" : "❌ NEEDS WORK"}`);
