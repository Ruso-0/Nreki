import * as ts from "typescript";

export interface TopologicalEdge {
    sourceId: string;
    targetId: string;
    sourceFile: string;
    targetFile: string;
    weight: number;
}

export interface SparseEdge {
    u: number;
    v: number;
    weight: number;
}

export interface SpectralResult {
    fiedlerValue: number;
    volume: number;
    nodeCount: number;
    edgeCount: number;
}

export interface SpectralDelta {
    fiedlerPre: number;
    fiedlerPost: number;
    volumePre: number;
    volumePost: number;
    normalizedFiedlerDrop: number;
    volumeDrop: number;
    verdict: "APPROVED" | "REJECTED_ENTROPY" | "APPROVED_DECOUPLING";
}

export class SpectralTopologist {

    public static extractConstraintGraph(
        program: ts.Program,
        targetFiles: Set<string>
    ): { nodes: Set<string>; edges: TopologicalEdge[] } {

        const checker = program.getTypeChecker();
        const nodes = new Set<string>();
        const edges: TopologicalEdge[] = [];

        for (const posixPath of targetFiles) {
            const sf = program.getSourceFile(posixPath);
            if (!sf) continue;

            const fileSymbol = checker.getSymbolAtLocation(sf);
            if (!fileSymbol || !fileSymbol.exports) continue;

            for (const exp of checker.getExportsOfModule(fileSymbol)) {
                const decl = exp.valueDeclaration || exp.declarations?.[0];
                if (!decl || decl.getSourceFile().fileName !== posixPath) continue;

                const sourceId = `${posixPath}::${exp.getName()}`;
                nodes.add(sourceId);

                const findDependencies = (node: ts.Node) => {
                    // ── PODADO RADICAL O(1) ──────────────────────────────
                    // Solo necesitamos TypeReferenceNode en firmas y declaraciones.
                    // Todo valor de ejecución se ignora inmediatamente.
                    // Esto reduce la exploración de millones de nodos a miles.
                    if (
                        ts.isBlock(node) ||
                        ts.isObjectLiteralExpression(node) ||
                        ts.isArrayLiteralExpression(node) ||
                        ts.isCallExpression(node) ||
                        ts.isBinaryExpression(node) ||
                        ts.isTemplateExpression(node) ||
                        ts.isStringLiteral(node) ||
                        ts.isNumericLiteral(node) ||
                        ts.isNoSubstitutionTemplateLiteral(node)
                    ) {
                        return;
                    }

                    if (node.kind === ts.SyntaxKind.AnyKeyword || node.kind === ts.SyntaxKind.UnknownKeyword) {
                        return;
                    }

                    if (ts.isTypeReferenceNode(node)) {
                        let targetSymbol = checker.getSymbolAtLocation(node.typeName);

                        if (targetSymbol) {
                            if (targetSymbol.flags & ts.SymbolFlags.Alias) {
                                targetSymbol = checker.getAliasedSymbol(targetSymbol);
                            }

                            const targetDecl = targetSymbol.valueDeclaration || targetSymbol.declarations?.[0];
                            if (targetDecl) {
                                const targetPath = targetDecl.getSourceFile().fileName.replace(/\\/g, "/");

                                if (!targetPath.includes("/node_modules/")) {
                                    const targetId = `${targetPath}::${targetSymbol.getName()}`;
                                    nodes.add(targetId);
                                    edges.push({ sourceId, targetId, sourceFile: posixPath, targetFile: targetPath, weight: 1.0 });
                                } else {
                                    const extId = `EXTERNAL::${targetSymbol.getName()}`;
                                    nodes.add(extId);
                                    edges.push({ sourceId, targetId: extId, sourceFile: posixPath, targetFile: "EXTERNAL", weight: 1.0 });
                                }
                            }
                        }

                        // Los genéricos SÍ importan: Promise<User> → User es un edge
                        if (node.typeArguments) node.typeArguments.forEach(findDependencies);
                        return; // FIN de la rama. No bajamos más.
                    }

                    // Arrow/function expressions: solo firmas, NO body
                    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
                        if (node.typeParameters) node.typeParameters.forEach(findDependencies);
                        node.parameters.forEach(findDependencies);
                        if (node.type) findDependencies(node.type);
                        return; // NO entrar al body
                    }

                    ts.forEachChild(node, findDependencies);
                };

                findDependencies(decl);
            }
        }

        return { nodes, edges };
    }

    public static buildSparseGraph(
        nodes: Set<string>,
        edges: TopologicalEdge[]
    ): { sparseEdges: SparseEdge[]; nodeIndex: Map<string, number>; N: number } {

        const sortedNodes = Array.from(nodes).sort();
        const nodeIndex = new Map<string, number>();
        sortedNodes.forEach((n, i) => nodeIndex.set(n, i));

        const N = sortedNodes.length;
        const sparseEdges: SparseEdge[] = [];

        for (const edge of edges) {
            const u = nodeIndex.get(edge.sourceId);
            const v = nodeIndex.get(edge.targetId);
            if (u !== undefined && v !== undefined && u !== v) {
                sparseEdges.push({ u, v, weight: edge.weight });
            }
        }

        return { sparseEdges, nodeIndex, N };
    }

    public static computeDelta(
        pre: SpectralResult,
        post: SpectralResult
    ): SpectralDelta {

        // Φ = λ₂ / N_AST (Topological Entropy Index)
        // N_AST = nodeCount = physical nodes in code (NOT activeNodes)
        // Ghost nodes (any-widened, zero-degree) stay in N_AST denominator
        // Deleted nodes disappear from N_AST — legitimate decoupling
        const phiPre = pre.nodeCount > 0 ? pre.fiedlerValue / pre.nodeCount : 0;
        const phiPost = post.nodeCount > 0 ? post.fiedlerValue / post.nodeCount : 0;
        const normalizedFiedlerDrop = phiPre - phiPost;
        const dropRatio = phiPre > 0 ? normalizedFiedlerDrop / phiPre : 0;
        const volumeDrop = pre.volume - post.volume;

        // Adaptive epsilon with hard bounds [0.10, 0.30]
        // N_AST=3 → ε≈0.30 (ghost in K3 = 33% drop, always caught)
        // N_AST=50 → ε≈0.15 (standard)
        // N_AST=500 → ε≈0.10 (floor, never less sensitive than 10%)
        const baseEpsilon = 0.15;
        const scaleFactor = Math.sqrt(50 / Math.max(1, pre.nodeCount));
        const epsilonDynamic = Math.max(0.10, Math.min(0.30, baseEpsilon * scaleFactor));

        let verdict: SpectralDelta["verdict"];

        if (volumeDrop > 0 && dropRatio > epsilonDynamic) {
            verdict = "REJECTED_ENTROPY";
        } else if (volumeDrop <= 0 && normalizedFiedlerDrop > 0) {
            verdict = "APPROVED_DECOUPLING";
        } else {
            verdict = "APPROVED";
        }

        return {
            fiedlerPre: pre.fiedlerValue,
            fiedlerPost: post.fiedlerValue,
            volumePre: pre.volume,
            volumePost: post.volume,
            normalizedFiedlerDrop,
            volumeDrop,
            verdict,
        };
    }

    public static getMarkovBlanket(
        targetFile: string,
        edges: TopologicalEdge[]
    ): Set<string> {
        const blanket = new Set<string>();
        blanket.add(targetFile);

        for (const edge of edges) {
            const sourceFile = edge.sourceFile;
            const targetFileFromEdge = edge.targetFile;

            if (sourceFile === targetFile && !targetFileFromEdge.startsWith("EXTERNAL")) {
                blanket.add(targetFileFromEdge);
            }
            if (targetFileFromEdge === targetFile && !sourceFile.startsWith("EXTERNAL")) {
                blanket.add(sourceFile);
            }
        }

        return blanket;
    }

    public static filterFirstCrown(
        targetFile: string,
        nodes: Set<string>,
        edges: TopologicalEdge[]
    ): { crownNodes: Set<string>; crownEdges: TopologicalEdge[] } {

        const targetPrefix = `${targetFile}::`;

        const coreNodes = new Set<string>();
        for (const n of nodes) {
            if (n.startsWith(targetPrefix)) coreNodes.add(n);
        }

        const validNodes = new Set<string>(coreNodes);
        for (const e of edges) {
            if (coreNodes.has(e.sourceId)) validNodes.add(e.targetId);
            if (coreNodes.has(e.targetId)) validNodes.add(e.sourceId);
        }

        const crownEdges = edges.filter(e =>
            validNodes.has(e.sourceId) && validNodes.has(e.targetId)
        );

        return { crownNodes: validNodes, crownEdges };
    }

    public static analyze(
        program: ts.Program,
        targetFiles: Set<string>,
        targetFile?: string
    ): SpectralResult {

        const { nodes, edges } = this.extractConstraintGraph(program, targetFiles);

        let analysisNodes = nodes;
        let analysisEdges = edges;

        if (targetFile) {
            const blanket = this.getMarkovBlanket(targetFile, edges);
            analysisNodes = new Set<string>();
            analysisEdges = [];
            for (const edge of edges) {
                const sourceFile = edge.sourceFile;
                const targetFileFromEdge = edge.targetFile;
                if (blanket.has(sourceFile) && (blanket.has(targetFileFromEdge) || targetFileFromEdge.startsWith("EXTERNAL"))) {
                    analysisNodes.add(edge.sourceId);
                    analysisNodes.add(edge.targetId);
                    analysisEdges.push(edge);
                }
            }
        }

        if (analysisNodes.size <= 1) {
            return { fiedlerValue: 0, volume: 0, nodeCount: analysisNodes.size, edgeCount: analysisEdges.length };
        }

        const { sparseEdges, N } = this.buildSparseGraph(analysisNodes, analysisEdges);
        const { fiedler, volume } = SpectralMath.analyzeTopology(N, sparseEdges);

        return {
            fiedlerValue: fiedler,
            volume,
            nodeCount: analysisNodes.size,
            edgeCount: analysisEdges.length,
        };
    }
}

export class SpectralMath {
    public static analyzeTopology(N: number, edges: SparseEdge[]): { fiedler: number; volume: number } {
        if (N <= 1) return { fiedler: 0, volume: 0 };

        // --- Edge deduplication ---
        const edgeMap = new Map<number, Map<number, number>>();

        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (e.u === e.v) continue;

            const min = Math.min(e.u, e.v);
            const max = Math.max(e.u, e.v);

            let row = edgeMap.get(min);
            if (!row) {
                row = new Map<number, number>();
                edgeMap.set(min, row);
            }

            const currentW = row.get(max) || 0;
            if (e.weight > currentW) row.set(max, e.weight);
        }

        // --- CSR construction pass 1: count neighbors, degree, volume, seed ---
        const degree = new Float64Array(N);
        const neighborCount = new Int32Array(N);
        let maxDegree = 0;
        let volume = 0;
        let seed = N * 2654435761;

        for (const [u, row] of edgeMap.entries()) {
            for (const [v, w] of row.entries()) {
                neighborCount[u]++; neighborCount[v]++;
                degree[u] += w; degree[v] += w;
                volume += w;
                if (degree[u] > maxDegree) maxDegree = degree[u];
                if (degree[v] > maxDegree) maxDegree = degree[v];
                seed = ((seed << 5) - seed + (w * 1000 | 0)) | 0;
            }
        }

        // Prefix sum → rowPtr
        const rowPtr = new Int32Array(N + 1);
        for (let i = 0; i < N; i++) rowPtr[i + 1] = rowPtr[i] + neighborCount[i];
        const nnz = rowPtr[N];

        // --- CSR construction pass 2: fill colIdx + values ---
        const colIdx = new Int32Array(nnz);
        const csrValues = new Float64Array(nnz);
        for (let i = 0; i < N; i++) neighborCount[i] = rowPtr[i]; // reuse as cursor

        for (const [u, row] of edgeMap.entries()) {
            for (const [v, w] of row.entries()) {
                colIdx[neighborCount[u]] = v; csrValues[neighborCount[u]++] = w;
                colIdx[neighborCount[v]] = u; csrValues[neighborCount[v]++] = w;
            }
        }

        // --- Initialization ---
        const c = maxDegree * 2.0 + 1.0;

        const vec = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            seed = (seed * 1103515245 + 12345) | 0;
            vec[i] = ((seed >>> 16) & 0x7fff) / 32768.0 - 0.5;
        }

        const v_next = new Float64Array(N);
        let mu = 0;
        let prev_mu = -1;

        // --- Fused power iteration (CSR SpMV + Rayleigh quotient) ---
        for (let iter = 0; iter < 100; iter++) {
            // Center vec
            let sum = 0;
            for (let i = 0; i < N; i++) sum += vec[i];
            const mean = sum / N;

            // Center + compute norm² for re-normalization
            let normSq = 0;
            for (let i = 0; i < N; i++) { vec[i] -= mean; normSq += vec[i] * vec[i]; }
            if (normSq < 1e-18) return { fiedler: 0, volume };
            const rNorm = 1.0 / Math.sqrt(normSq);
            for (let i = 0; i < N; i++) vec[i] *= rNorm;

            // Fused SpMV + Rayleigh (vec is unit-norm → mu = vᵀ(cI−L)v)
            let norm = 0;
            mu = 0;
            for (let i = 0; i < N; i++) {
                let Lv_i = degree[i] * vec[i];
                const end = rowPtr[i + 1];
                for (let k = rowPtr[i]; k < end; k++) {
                    Lv_i -= csrValues[k] * vec[colIdx[k]];
                }
                const val = c * vec[i] - Lv_i;
                v_next[i] = val;
                norm += val * val;
                mu += vec[i] * val;
            }

            norm = Math.sqrt(norm);
            if (norm < 1e-9) return { fiedler: 0, volume };
            for (let i = 0; i < N; i++) vec[i] = v_next[i] / norm;

            if (Math.abs(mu - prev_mu) < 1e-7) break;
            prev_mu = mu;
        }

        return { fiedler: Math.max(0, c - mu), volume };
    }
}
