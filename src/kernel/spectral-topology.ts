import * as ts from "typescript";

export interface TopologicalEdge {
    sourceId: string;
    targetId: string;
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
                    if (ts.isBlock(node)) return;

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
                                    edges.push({ sourceId, targetId, weight: 1.0 });
                                } else {
                                    const extId = `EXTERNAL::${targetSymbol.getName()}`;
                                    nodes.add(extId);
                                    edges.push({ sourceId, targetId: extId, weight: 1.0 });
                                }
                            }
                        }
                    }

                    ts.forEachChild(node, findDependencies);
                };

                findDependencies(decl);
            }
        }

        return { nodes, edges };
    }

    public static buildAdjacencyMatrix(
        nodes: Set<string>,
        edges: TopologicalEdge[]
    ): { matrix: number[][]; nodeIndex: Map<string, number>; volume: number } {

        const sortedNodes = Array.from(nodes).sort();
        const nodeIndex = new Map<string, number>();
        sortedNodes.forEach((n, i) => nodeIndex.set(n, i));

        const N = sortedNodes.length;
        const matrix: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));

        for (const edge of edges) {
            const i = nodeIndex.get(edge.sourceId);
            const j = nodeIndex.get(edge.targetId);
            if (i !== undefined && j !== undefined && i !== j) {
                matrix[i][j] = Math.max(matrix[i][j], edge.weight);
            }
        }

        // Volume from SYMMETRIZED matrix (aligned with Fiedler's topological space)
        // A_sym = max(A, A^T) — same symmetrization used inside getFiedlerValue
        let volume = 0;
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < N; j++) {
                volume += Math.max(matrix[i][j] || 0, matrix[j][i] || 0);
            }
        }

        return { matrix, nodeIndex, volume };
    }

    public static computeDelta(
        pre: SpectralResult,
        post: SpectralResult,
        epsilonChronos: number = 0.15
    ): SpectralDelta {

        const normalizedPre = pre.nodeCount > 0 ? pre.fiedlerValue / pre.nodeCount : 0;
        const normalizedPost = post.nodeCount > 0 ? post.fiedlerValue / post.nodeCount : 0;
        const normalizedFiedlerDrop = normalizedPre - normalizedPost;
        const volumeDrop = pre.volume - post.volume;

        let verdict: SpectralDelta["verdict"];

        if (volumeDrop > 0 && normalizedFiedlerDrop > normalizedPre * epsilonChronos) {
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

    public static analyze(
        program: ts.Program,
        targetFiles: Set<string>
    ): SpectralResult {

        const { nodes, edges } = this.extractConstraintGraph(program, targetFiles);

        if (nodes.size <= 1) {
            return { fiedlerValue: 0, volume: 0, nodeCount: nodes.size, edgeCount: edges.length };
        }

        const { matrix, volume } = this.buildAdjacencyMatrix(nodes, edges);
        const fiedlerValue = SpectralMath.getFiedlerValue(matrix);

        return {
            fiedlerValue,
            volume,
            nodeCount: nodes.size,
            edgeCount: edges.length,
        };
    }
}

export class SpectralMath {
    public static analyzeTopology(N: number, edges: SparseEdge[]): { fiedler: number; volume: number } {
        if (N <= 1) return { fiedler: 0, volume: 0 };

        const degree = new Float64Array(N);
        const adj: number[][] = Array.from({ length: N }, () => []);
        const weights: number[][] = Array.from({ length: N }, () => []);

        let maxDegree = 0;
        let volume = 0;

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

        let seed = N * 2654435761;

        for (const [u, row] of edgeMap.entries()) {
            for (const [v, w] of row.entries()) {
                adj[u].push(v); weights[u].push(w); degree[u] += w;
                adj[v].push(u); weights[v].push(w); degree[v] += w;

                volume += w;

                if (degree[u] > maxDegree) maxDegree = degree[u];
                if (degree[v] > maxDegree) maxDegree = degree[v];

                seed = ((seed << 5) - seed + (w * 1000 | 0)) | 0;
            }
        }

        const c = maxDegree * 2.0 + 1.0;

        const vec = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            seed = (seed * 1103515245 + 12345) | 0;
            vec[i] = ((seed >>> 16) & 0x7fff) / 32768.0 - 0.5;
        }

        const v_next = new Float64Array(N);
        let mu = 0;
        let prev_mu = -1;

        for (let iter = 0; iter < 100; iter++) {
            let sum = 0;
            for (let i = 0; i < N; i++) sum += vec[i];
            const mean = sum / N;
            for (let i = 0; i < N; i++) vec[i] -= mean;

            let norm = 0;
            for (let i = 0; i < N; i++) {
                let Lv_i = degree[i] * vec[i];
                const neighbors = adj[i];
                const wList = weights[i];
                for (let k = 0; k < neighbors.length; k++) {
                    Lv_i -= wList[k] * vec[neighbors[k]];
                }
                const val = c * vec[i] - Lv_i;
                v_next[i] = val;
                norm += val * val;
            }

            norm = Math.sqrt(norm);
            if (norm < 1e-9) return { fiedler: 0, volume };
            for (let i = 0; i < N; i++) vec[i] = v_next[i] / norm;

            mu = 0;
            for (let i = 0; i < N; i++) {
                let Lv_i = degree[i] * vec[i];
                const neighbors = adj[i];
                const wList = weights[i];
                for (let k = 0; k < neighbors.length; k++) {
                    Lv_i -= wList[k] * vec[neighbors[k]];
                }
                mu += vec[i] * (c * vec[i] - Lv_i);
            }

            if (Math.abs(mu - prev_mu) < 1e-7) break;
            prev_mu = mu;
        }

        return { fiedler: Math.max(0, c - mu), volume };
    }
}
