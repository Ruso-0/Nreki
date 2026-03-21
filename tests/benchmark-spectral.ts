import * as ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import { SpectralTopologist, SpectralMath } from "../src/kernel/spectral-topology.js";

const projectRoot = path.resolve(process.cwd());
const tsConfigPath = path.join(projectRoot, "tsconfig.json");

console.log("=== NREKI SPECTRAL BENCHMARK ===\n");
console.log(`Project: ${projectRoot}`);

// 1. Create program from tsconfig
const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);

// 2. Collect project files (exclude node_modules and test files)
const targetFiles = new Set<string>();
for (const sf of program.getSourceFiles()) {
    const fileName = sf.fileName.replace(/\\/g, "/");
    if (!fileName.includes("node_modules") && !fileName.includes(".test.") && !fileName.includes("/dist/")) {
        targetFiles.add(fileName);
    }
}

console.log(`Source files: ${targetFiles.size}`);

// 3. Measure graph extraction
const startExtract = performance.now();
const memBefore = process.memoryUsage().heapUsed;

const { nodes, edges } = SpectralTopologist.extractConstraintGraph(program, targetFiles);

const extractMs = (performance.now() - startExtract).toFixed(1);
const memAfter = process.memoryUsage().heapUsed;
const memDeltaKB = ((memAfter - memBefore) / 1024).toFixed(0);

console.log(`\n--- Graph Extraction ---`);
console.log(`Nodes: ${nodes.size}`);
console.log(`Edges: ${edges.length}`);
console.log(`Time: ${extractMs}ms`);
console.log(`RAM delta: ${memDeltaKB}KB`);

// 4. Measure adjacency matrix + Fiedler
const startFiedler = performance.now();

const { matrix, volume } = SpectralTopologist.buildAdjacencyMatrix(nodes, edges);
const fiedlerValue = SpectralMath.getFiedlerValue(matrix);

const fiedlerMs = (performance.now() - startFiedler).toFixed(1);

console.log(`\n--- Spectral Analysis ---`);
console.log(`Matrix size: ${matrix.length}x${matrix.length}`);
console.log(`Volume (symmetrized): ${volume}`);
console.log(`Fiedler Value (λ₂): ${fiedlerValue.toFixed(6)}`);
console.log(`Time: ${fiedlerMs}ms`);

// 5. Full analyze() measurement
const startTotal = performance.now();
const result = SpectralTopologist.analyze(program, targetFiles);
const totalMs = (performance.now() - startTotal).toFixed(1);

console.log(`\n--- Full analyze() ---`);
console.log(`Total time: ${totalMs}ms`);
console.log(`Result: fiedler=${result.fiedlerValue.toFixed(6)}, volume=${result.volume}, nodes=${result.nodeCount}, edges=${result.edgeCount}`);

// 6. Print top connected nodes
const nodeDegree = new Map<string, number>();
for (const edge of edges) {
    nodeDegree.set(edge.sourceId, (nodeDegree.get(edge.sourceId) || 0) + 1);
    nodeDegree.set(edge.targetId, (nodeDegree.get(edge.targetId) || 0) + 1);
}
const topNodes = Array.from(nodeDegree.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

console.log(`\n--- Top 10 Connected Nodes ---`);
for (const [node, degree] of topNodes) {
    const short = node.split("/").slice(-2).join("/");
    console.log(`  ${degree} connections: ${short}`);
}

// 7. Summary
console.log(`\n=== SUMMARY ===`);
console.log(`Graph extraction: ${extractMs}ms`);
console.log(`Fiedler computation: ${fiedlerMs}ms`);
console.log(`Total analyze(): ${totalMs}ms`);
console.log(`Peak RAM delta: ${memDeltaKB}KB`);
console.log(`Matrix: ${matrix.length}x${matrix.length}`);
console.log(`Fiedler (λ₂): ${fiedlerValue.toFixed(6)}`);
console.log(`Volume: ${volume}`);
