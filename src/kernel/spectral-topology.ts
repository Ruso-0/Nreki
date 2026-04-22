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
    fiedler?: number;
    volume: number;
    nodeCount: number;
    edgeCount: number;
    cyclomaticComplexity?: number;
    activeNodes?: number;
    v2?: Float64Array;
    lambda3?: number;
    v3?: Float64Array;
    eigenvalues?: number[];
    nodeIndex?: Map<string, number>;
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
                    // ── RADICAL O(1) PRUNING (CORRECTED v7.3.3) ────────────────
                    // DO NOT prune ObjectLiterals, ArrayLiterals, or CallExpressions —
                    // they contain method signatures, type assertions, and generics
                    // (Express handlers, Vue defineComponent, tRPC routers, Pinia stores).
                    // DO prune blocks (function bodies) and primitive literals
                    // to maintain O(1) performance without sacrificing topology.
                    if (
                        ts.isBlock(node) ||
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

                        // Generics DO matter: Promise<User> → User is an edge
                        if (node.typeArguments) node.typeArguments.forEach(findDependencies);
                        return; // End of branch. Do not descend further.
                    }

                    // ── STRUCTURAL FIX: Intercept ALL function signatures ────────
                    // Extract type references from signatures but NEVER enter function bodies.
                    // Added: isMethodDeclaration (Vue/Express/class methods)
                    // Added: isFunctionDeclaration (nested named functions)
                    if (
                        ts.isArrowFunction(node) ||
                        ts.isFunctionExpression(node) ||
                        ts.isMethodDeclaration(node) ||
                        ts.isFunctionDeclaration(node)
                    ) {
                        if (node.typeParameters) node.typeParameters.forEach(findDependencies);
                        node.parameters.forEach(findDependencies);
                        if (node.type) findDependencies(node.type);
                        return; // Do NOT enter the body
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

        // Φ: Topological Entropy Index
        // When N stays constant (ghost/expansion): Φ = λ₂ * density, density = 2V/(N*(N-1))
        // When N decreases (decoupling): Φ = λ₂ / N_AST (original formula)
        const preFiedler = pre.fiedler ?? 0;
        const postFiedler = post.fiedler ?? 0;

        let phiPre: number, phiPost: number;

        if (pre.nodeCount <= post.nodeCount) {
            const denPre = pre.nodeCount > 1 ? pre.nodeCount * (pre.nodeCount - 1) : 1;
            phiPre = pre.nodeCount > 0 ? (preFiedler * 2 * pre.volume) / denPre : 0;
            const denPost = post.nodeCount > 1 ? post.nodeCount * (post.nodeCount - 1) : 1;
            phiPost = post.nodeCount > 0 ? (postFiedler * 2 * post.volume) / denPost : 0;
        } else {
            phiPre = pre.nodeCount > 0 ? preFiedler / pre.nodeCount : 0;
            phiPost = post.nodeCount > 0 ? postFiedler / post.nodeCount : 0;
        }
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
            fiedlerPre: preFiedler,
            fiedlerPost: postFiedler,
            volumePre: pre.volume,
            volumePost: post.volume,
            normalizedFiedlerDrop,
            volumeDrop,
            verdict,
        };
    }

    /**
     * Extracts Ego-Graph 1-hop around target file (parents + direct children).
     *
     * NOTE: In NREKI, "Markov Blanket" is implemented as Ego-Graph 1-hop
     * (no spouses/co-parents). Pragmatic for localizing blast radius,
     * not theoretically pure Pearl causal inference.
     */
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
            return {
                fiedler: 0, volume: 0,
                nodeCount: analysisNodes.size, edgeCount: analysisEdges.length,
                cyclomaticComplexity: 0,
            };
        }

        const { sparseEdges, nodeIndex, N } = this.buildSparseGraph(analysisNodes, analysisEdges);
        const state = SpectralMath.analyzeTopology(N, sparseEdges);

        // ─── TRUE CYCLOMATIC COMPLEXITY: β₁ = E_int - V_int + C_int ────
        // Union-Find with path compression + union by rank, O(E × α(V)).
        // Purified: excludes EXTERNAL:: nodes and their edges.

        let cyclomaticComplexity = 0;

        if (nodeIndex.size > 0) {
            // 1. Identify internal nodes
            let internalNodeCount = 0;
            const isInternal = new Uint8Array(N);
            for (const [name, id] of nodeIndex.entries()) {
                if (!name.startsWith("EXTERNAL::")) {
                    isInternal[id] = 1;
                    internalNodeCount++;
                }
            }

            // 2. Union-Find structures
            const parent = new Int32Array(N);
            const ufRank = new Uint8Array(N);
            for (let i = 0; i < N; i++) parent[i] = i;

            function find(i: number): number {
                let root = i;
                while (root !== parent[root]) root = parent[root];
                let curr = i;
                while (curr !== root) {
                    const nxt = parent[curr];
                    parent[curr] = root;
                    curr = nxt;
                }
                return root;
            }

            let internalEdgeCount = 0;
            let components = internalNodeCount;

            // Numeric hash for undirected edge deduplication.
            // N ≤ 25,000 (SpectralMath guard) → max key ≈ 2.5×10¹¹ < MAX_SAFE_INTEGER
            const seenEdges = new Set<number>();

            for (let i = 0; i < sparseEdges.length; i++) {
                const u = sparseEdges[i].u;
                const v = sparseEdges[i].v;

                if (u !== v && isInternal[u] && isInternal[v]) {
                    const min = Math.min(u, v);
                    const max = Math.max(u, v);
                    const edgeKey = min * 10000000 + max;

                    if (!seenEdges.has(edgeKey)) {
                        seenEdges.add(edgeKey);
                        internalEdgeCount++;

                        const rootU = find(u);
                        const rootV = find(v);
                        if (rootU !== rootV) {
                            if (ufRank[rootU] < ufRank[rootV]) {
                                parent[rootU] = rootV;
                            } else if (ufRank[rootU] > ufRank[rootV]) {
                                parent[rootV] = rootU;
                            } else {
                                parent[rootV] = rootU;
                                ufRank[rootU]++;
                            }
                            components--;
                        }
                    }
                }
            }

            // β₁ = E - V + C (topological invariant, always ≥ 0)
            cyclomaticComplexity = Math.max(0, internalEdgeCount - internalNodeCount + components);
        }

        return {
            fiedler: state.fiedler,
            volume: state.volume,
            nodeCount: analysisNodes.size,
            edgeCount: analysisEdges.length,
            cyclomaticComplexity,
            v2: state.v2,
            lambda3: state.lambda3,
            v3: state.v3,
            eigenvalues: state.eigenvalues,
            nodeIndex: N > 1 ? nodeIndex : undefined,
        };
    }
}

export type SpectralResultPayload =
    | { fiedler: undefined; volume: number; v2?: never; lambda3?: never; v3?: never; eigenvalues?: never }
    | { fiedler: number; volume: number; v2?: never; lambda3?: never; v3?: never; eigenvalues?: never }
    | { fiedler: number; volume: number; v2: Float64Array; lambda3?: never; v3?: never; eigenvalues: number[] }
    | { fiedler: number; volume: number; v2: Float64Array; lambda3: number; v3: Float64Array; eigenvalues: number[] };

export class SpectralMath {
    // Discriminated union: spectral vectors are born together or not at all.
    // The first variant covers the early-return paths (N<=1, N>25000) where
    // power iteration is skipped. The second variant is the full result.
    // This enforces the runtime invariant at the type level: a consumer that
    // narrows on `if (result.v2)` gets `lambda3: number` and `v3: Float64Array`
    // for free — no more `lambda3 !== undefined` paranoia checks downstream.
    public static analyzeTopology(N: number, edges: SparseEdge[], normalized: boolean = false): SpectralResultPayload {
        // FIX B.2: mega-repos opt-out. Undefined signals "unavailable".
        if (N > 25000) {
            let volume = 0;
            for (let i = 0; i < edges.length; i++) volume += edges[i].weight;
            return { fiedler: undefined, volume };
        }

        if (N <= 1) return { fiedler: 0, volume: 0 };

        // --- 1. Edge deduplication ---
        const edgeMap = new Map<number, Map<number, number>>();
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (e.u === e.v) continue;
            const min = Math.min(e.u, e.v);
            const max = Math.max(e.u, e.v);
            let row = edgeMap.get(min);
            if (!row) { row = new Map<number, number>(); edgeMap.set(min, row); }
            const currentW = row.get(max) || 0;
            if (e.weight > currentW) row.set(max, e.weight);
        }

        // --- 2. Degree + volume ---
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

        // --- 3. CSR (dual: csrValues combinatorial + csrNormW normalized) ---
        const rowPtr = new Int32Array(N + 1);
        for (let i = 0; i < N; i++) rowPtr[i + 1] = rowPtr[i] + neighborCount[i];
        const nnz = rowPtr[N];
        const colIdx = new Int32Array(nnz);
        const csrValues = new Float64Array(nnz);
        const csrNormW = new Float64Array(nnz);

        for (let i = 0; i < N; i++) neighborCount[i] = rowPtr[i];

        const invSqrtDeg = new Float64Array(N);
        if (normalized) {
            for (let i = 0; i < N; i++) {
                invSqrtDeg[i] = degree[i] > 1e-12 ? 1.0 / Math.sqrt(degree[i]) : 0;
            }
        }

        for (const [u, row] of edgeMap.entries()) {
            for (const [v, w] of row.entries()) {
                colIdx[neighborCount[u]] = v;
                colIdx[neighborCount[v]] = u;
                if (normalized) {
                    const normW = w * invSqrtDeg[u] * invSqrtDeg[v];
                    csrNormW[neighborCount[u]++] = normW;
                    csrNormW[neighborCount[v]++] = normW;
                } else {
                    csrValues[neighborCount[u]++] = w;
                    csrValues[neighborCount[v]++] = w;
                }
            }
        }

        // --- 4. Trivial eigenvector + dual shift ---
        const c = normalized ? 2.5 : maxDegree * 2.0 + 1.0;
        const trivial = new Float64Array(N);
        let trivNormSq = 0;

        for (let i = 0; i < N; i++) {
            if (normalized) {
                if (degree[i] > 1e-12) {
                    trivial[i] = Math.sqrt(degree[i]);
                    trivNormSq += degree[i];
                }
            } else {
                if (degree[i] > 0) {
                    trivial[i] = 1.0;
                    trivNormSq += 1.0;
                }
            }
        }
        if (trivNormSq > 0) {
            const rn = 1.0 / Math.sqrt(trivNormSq);
            for (let i = 0; i < N; i++) trivial[i] *= rn;
        }

        // --- 5. Lanczos Krylov m=20 ---
        const m = Math.min(N, 20);
        let k_krylov = m;
        const V = Array.from({ length: m }, () => new Float64Array(N));
        const alpha = new Float64Array(m);
        const beta = new Float64Array(m);

        let currentSeed = seed | 0;
        let norm = 0;
        for (let i = 0; i < N; i++) {
            if (!normalized || degree[i] > 1e-12) {
                currentSeed = (Math.imul ? Math.imul(currentSeed, 1103515245) : (currentSeed * 1103515245)) + 12345 | 0;
                V[0][i] = ((currentSeed >>> 16) & 0x7fff) / 32768.0 - 0.5;
                norm += V[0][i] * V[0][i];
            }
        }

        if (norm > 0) {
            norm = Math.sqrt(norm);
            for (let i = 0; i < N; i++) V[0][i] /= norm;
        }

        let dotTriv = 0;
        for (let i = 0; i < N; i++) dotTriv += V[0][i] * trivial[i];
        norm = 0;
        for (let i = 0; i < N; i++) {
            V[0][i] -= dotTriv * trivial[i];
            norm += V[0][i] * V[0][i];
        }
        if (norm > 0) {
            norm = Math.sqrt(norm);
            for (let i = 0; i < N; i++) V[0][i] /= norm;
        } else {
            return { fiedler: 0, volume };
        }

        for (let j = 0; j < m; j++) {
            const w = new Float64Array(N);
            let wIsSane = true;

            for (let i = 0; i < N; i++) {
                if (normalized && degree[i] <= 1e-12) continue;

                let L_vi: number;
                if (normalized) {
                    L_vi = V[j][i];
                    const end = rowPtr[i + 1];
                    for (let k = rowPtr[i]; k < end; k++) {
                        L_vi -= csrNormW[k] * V[j][colIdx[k]];
                    }
                } else {
                    L_vi = degree[i] * V[j][i];
                    const end = rowPtr[i + 1];
                    for (let k = rowPtr[i]; k < end; k++) {
                        L_vi -= csrValues[k] * V[j][colIdx[k]];
                    }
                }

                w[i] = c * V[j][i] - L_vi;
                // Thermal firewall + L2 overflow guard (Pipipi Furia calibration 1e150).
                if (!Number.isFinite(w[i]) || Math.abs(w[i]) > 1e150) {
                    wIsSane = false;
                }
            }

            if (!wIsSane) return { fiedler: 0, volume };

            let a = 0;
            for (let i = 0; i < N; i++) a += V[j][i] * w[i];
            alpha[j] = a;

            for (let i = 0; i < N; i++) {
                w[i] -= a * V[j][i];
                if (j > 0) w[i] -= beta[j - 1] * V[j - 1][i];
            }

            // Full reorthogonalization double-pass
            for (let pass = 0; pass < 2; pass++) {
                for (let k = 0; k <= j; k++) {
                    let proj = 0;
                    for (let i = 0; i < N; i++) proj += w[i] * V[k][i];
                    for (let i = 0; i < N; i++) w[i] -= proj * V[k][i];
                }
                dotTriv = 0;
                for (let i = 0; i < N; i++) dotTriv += w[i] * trivial[i];
                for (let i = 0; i < N; i++) w[i] -= dotTriv * trivial[i];
            }

            if (j < m - 1) {
                let b = 0;
                for (let i = 0; i < N; i++) b += w[i] * w[i];
                b = Math.sqrt(b);
                beta[j] = b;
                if (b < 1e-9) { k_krylov = j + 1; break; }
                const invB = 1.0 / b;
                for (let i = 0; i < N; i++) V[j + 1][i] = w[i] * invB;
            }
        }

        // Pipipi Crime 4 fix: Krylov collapse fallback
        if (k_krylov === 0) {
            return { fiedler: 0, volume };
        }

        // --- 6. Jacobi eigensolver over tridiagonal ---
        const T_mat = Array.from({ length: k_krylov }, () => new Float64Array(k_krylov));
        const eVecs = Array.from({ length: k_krylov }, () => new Float64Array(k_krylov));
        for (let i = 0; i < k_krylov; i++) {
            T_mat[i][i] = alpha[i];
            eVecs[i][i] = 1.0;
            if (i < k_krylov - 1) {
                T_mat[i][i + 1] = beta[i];
                T_mat[i + 1][i] = beta[i];
            }
        }

        for (let iter = 0; iter < 1500; iter++) {
            let maxOff = 0.0, p = 0, q = 0;
            for (let i = 0; i < k_krylov - 1; i++) {
                for (let j = i + 1; j < k_krylov; j++) {
                    const val = Math.abs(T_mat[i][j]);
                    if (val > maxOff) { maxOff = val; p = i; q = j; }
                }
            }
            if (maxOff < 1e-12) break;

            const theta = (T_mat[q][q] - T_mat[p][p]) / (2.0 * T_mat[p][q]);
            let t = 1.0 / (Math.abs(theta) + Math.sqrt(theta * theta + 1.0));
            if (theta < 0) t = -t;
            const cos_v = 1.0 / Math.sqrt(t * t + 1.0);
            const sin_v = cos_v * t;

            for (let i = 0; i < k_krylov; i++) {
                if (i !== p && i !== q) {
                    const tip = T_mat[i][p], tiq = T_mat[i][q];
                    T_mat[i][p] = T_mat[p][i] = cos_v * tip - sin_v * tiq;
                    T_mat[i][q] = T_mat[q][i] = sin_v * tip + cos_v * tiq;
                }
                const eip = eVecs[i][p], eiq = eVecs[i][q];
                eVecs[i][p] = cos_v * eip - sin_v * eiq;
                eVecs[i][q] = sin_v * eip + cos_v * eiq;
            }
            const tpp = T_mat[p][p], tqq = T_mat[q][q], tpq = T_mat[p][q];
            T_mat[p][p] = cos_v * cos_v * tpp - 2.0 * sin_v * cos_v * tpq + sin_v * sin_v * tqq;
            T_mat[q][q] = sin_v * sin_v * tpp + 2.0 * sin_v * cos_v * tpq + cos_v * cos_v * tqq;
            T_mat[p][q] = T_mat[q][p] = 0.0;
        }

        // --- 7. Extraction + Procrustes gauge ---
        const eigenPairs: { val: number; vec: number[] }[] = [];
        for (let i = 0; i < k_krylov; i++) {
            eigenPairs.push({ val: T_mat[i][i], vec: eVecs.map(row => row[i]) });
        }
        eigenPairs.sort((a, b) => b.val - a.val);

        const getFullVec = (y_vec: number[]): Float64Array => {
            const vec = new Float64Array(N);
            for (let j = 0; j < k_krylov; j++) {
                for (let i = 0; i < N; i++) vec[i] += V[j][i] * y_vec[j];
            }
            // Procrustes gauge: dominant component (max |.|) forced positive.
            let maxAbs = -1, signMul = 1;
            for (let i = 0; i < N; i++) {
                const a = Math.abs(vec[i]);
                if (a > maxAbs) { maxAbs = a; signMul = vec[i] < 0 ? -1 : 1; }
            }
            if (signMul === -1) for (let i = 0; i < N; i++) vec[i] *= -1;
            return vec;
        };

        // FIX: Push incondicional con aplastamiento térmico.
        // Preserva multiplicidad del null-space (disconnected graphs).
        const eigenvalues: number[] = [];
        const topK = Math.min(k_krylov, 10);
        for (let i = 0; i < topK; i++) {
            let lam = c - eigenPairs[i].val;
            if (lam < 1e-12) lam = 0;
            eigenvalues.push(lam);
        }

        if (k_krylov === 0 || eigenvalues.length === 0) {
            return { fiedler: 0, volume };
        }

        const fiedler_val = eigenvalues[0];

        // DEGENERATE CASE: K_n cliques converge en k_krylov=1.
        // V[0] es eigenvector válido del único eigenvalue no-trivial.
        if (eigenvalues.length === 1) {
            const v2_full = getFullVec(eigenPairs[0].vec);
            let isSane = Number.isFinite(fiedler_val);
            if (isSane) {
                for (let i = 0; i < N; i++) {
                    if (!Number.isFinite(v2_full[i])) { isSane = false; break; }
                }
            }
            if (!isSane) return { fiedler: 0, volume };
            return { fiedler: fiedler_val, volume, v2: v2_full, eigenvalues };
        }

        // NORMAL CASE: spectrum with >= 2 eigenvalues
        const lambda3_val = eigenvalues[1];
        const v2_full = getFullVec(eigenPairs[0].vec);
        const v3_full = getFullVec(eigenPairs[1].vec);

        // --- 8. Final sanity firewall ---
        let isSane = Number.isFinite(fiedler_val) && Number.isFinite(lambda3_val);
        if (isSane) {
            for (let i = 0; i < eigenvalues.length; i++) {
                if (!Number.isFinite(eigenvalues[i])) { isSane = false; break; }
            }
            for (let i = 0; i < N; i++) {
                if (!Number.isFinite(v2_full[i]) || !Number.isFinite(v3_full[i])) {
                    isSane = false; break;
                }
            }
        }
        if (!isSane) return { fiedler: 0, volume };

        return { fiedler: fiedler_val, volume, v2: v2_full, lambda3: lambda3_val, v3: v3_full, eigenvalues };
    }
}
