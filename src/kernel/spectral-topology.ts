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
    cyclomaticComplexity?: number;
    activeNodes?: number;
    v2?: Float64Array;
    lambda3?: number;
    v3?: Float64Array;
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
        let phiPre: number, phiPost: number;

        if (pre.nodeCount <= post.nodeCount) {
            // Ghost / Expansion case: nodes stay or grow but lose edges.
            // Density formula Φ = λ₂ * (2V / (N*(N-1))) detects dilution.
            const denPre = pre.nodeCount > 1 ? pre.nodeCount * (pre.nodeCount - 1) : 1;
            phiPre = pre.nodeCount > 0 ? (pre.fiedlerValue * 2 * pre.volume) / denPre : 0;
            const denPost = post.nodeCount > 1 ? post.nodeCount * (post.nodeCount - 1) : 1;
            phiPost = post.nodeCount > 0 ? (post.fiedlerValue * 2 * post.volume) / denPost : 0;
        } else {
            // Decoupling case: nodes were deleted from AST.
            // Original formula respects N_AST reduction.
            phiPre = pre.nodeCount > 0 ? pre.fiedlerValue / pre.nodeCount : 0;
            phiPost = post.nodeCount > 0 ? post.fiedlerValue / post.nodeCount : 0;
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
            return {
                fiedlerValue: 0, volume: 0,
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
            fiedlerValue: state.fiedler,
            volume: state.volume,
            nodeCount: analysisNodes.size,
            edgeCount: analysisEdges.length,
            cyclomaticComplexity,
            v2: state.v2,
            lambda3: state.lambda3,
            v3: state.v3,
            nodeIndex: N > 1 ? nodeIndex : undefined,
        };
    }
}

export class SpectralMath {
    // Discriminated union: spectral vectors are born together or not at all.
    // The first variant covers the early-return paths (N<=1, N>25000) where
    // power iteration is skipped. The second variant is the full result.
    // This enforces the runtime invariant at the type level: a consumer that
    // narrows on `if (result.v2)` gets `lambda3: number` and `v3: Float64Array`
    // for free — no more `lambda3 !== undefined` paranoia checks downstream.
    public static analyzeTopology(N: number, edges: SparseEdge[], normalized: boolean = false):
        | { fiedler: number; volume: number; v2?: never; lambda3?: never; v3?: never }
        | { fiedler: number; volume: number; v2: Float64Array; lambda3: number; v3: Float64Array }
    {
        if (N <= 1) return { fiedler: 0, volume: 0 };

        // Size guard: power iteration is O(N² × 150 iterations).
        // For N>5000 this could block the event loop for hundreds of ms.
        // Return a structural estimate instead.
        if (N > 25000) {
            let volume = 0;
            for (const e of edges) volume += e.weight;
            const avgDegree = (2 * edges.length) / N;
            return { fiedler: avgDegree * 0.5, volume };
        }

        // --- Edge deduplication (IDÉNTICO AL ORIGINAL - NO TOCAR) ---
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

        // --- CSR construction pass 1 (IDÉNTICO AL ORIGINAL - NO TOCAR) ---
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

        // Prefix sum → rowPtr (IDÉNTICO AL ORIGINAL - NO TOCAR)
        const rowPtr = new Int32Array(N + 1);
        for (let i = 0; i < N; i++) rowPtr[i + 1] = rowPtr[i] + neighborCount[i];
        const nnz = rowPtr[N];

        // --- CSR construction pass 2 (IDÉNTICO AL ORIGINAL - NO TOCAR) ---
        const colIdx = new Int32Array(nnz);
        const csrValues = new Float64Array(nnz);
        for (let i = 0; i < N; i++) neighborCount[i] = rowPtr[i];

        for (const [u, row] of edgeMap.entries()) {
            for (const [v, w] of row.entries()) {
                colIdx[neighborCount[u]] = v; csrValues[neighborCount[u]++] = w;
                colIdx[neighborCount[v]] = u; csrValues[neighborCount[v]++] = w;
            }
        }

        // ─── NUEVO: Capturar seed post-mutación + Power Iteration con Deflación ───

        const dataSeed = seed; // Semilla POST-mutación exacta del original

        // ─── DUAL LAPLACIAN: Combinatorio vs Normalizado ───────────────
        // Combinatorio (L = D - A): eigenvalues grow with N. Default for production.
        // Normalizado (L_sym = I - D^{-1/2}AD^{-1/2}): eigenvalues in [0, 2]. For ML pipeline.
        //
        // TRAMPA MORTAL 2: c shift changes with the Laplacian type.
        // Combinatorio: max eigenvalue ≈ 2×maxDegree → c = maxDegree×2+1
        // Normalizado: max eigenvalue = 2 → c = 2.0
        const c = normalized ? 2.0 : maxDegree * 2.0 + 1.0;

        // TRAMPA MORTAL 1: v₁ of L_sym is NOT constant — it's proportional to √D.
        // Pre-compute the normalized v₁ and D^{-1/2} for the normalized case.
        const v1_norm = new Float64Array(N);
        const invSqrtD = new Float64Array(N);

        if (normalized) {
            let vol = 0;
            for (let i = 0; i < N; i++) vol += degree[i];
            const rVol = vol > 0 ? 1.0 / Math.sqrt(vol) : 0;
            for (let i = 0; i < N; i++) {
                // DENORMAL GUARD: subnormal floats (e.g. degree=1e-320 from
                // catastrophic cancellation in weighted graphs) force the CPU
                // FPU into microcode emulation, causing massive pipeline stalls
                // (~100x slowdown), and `1.0 / Math.sqrt(1e-320) ≈ 1e+160`
                // overflows quickly to Infinity in subsequent SpMV products.
                // Threshold 1e-12 is safely above the denormal range (~2.2e-308)
                // and below any realistic graph weight in practice.
                if (degree[i] > 1e-12) {
                    v1_norm[i] = Math.sqrt(degree[i]) * rVol;
                    invSqrtD[i] = 1.0 / Math.sqrt(degree[i]);
                }
                // else: treated as isolated node (v1_norm[i]=0, invSqrtD[i]=0)
            }
        }

        const powerIteration = (
            deflateVectors: Float64Array[],
            seedModifier: number
        ): { val: number; vec: Float64Array } => {
            const vec = new Float64Array(N);
            let currentSeed = (dataSeed + seedModifier) | 0;
            for (let i = 0; i < N; i++) {
                currentSeed = (currentSeed * 1103515245 + 12345) | 0;
                vec[i] = ((currentSeed >>> 16) & 0x7fff) / 32768.0 - 0.5;
            }

            const v_next = new Float64Array(N);
            let mu = 0;
            let prev_mu = -1;
            let prevDelta = Infinity;

            for (let iter = 0; iter < 150; iter++) {
                // 1. Deflate trivial eigenvector
                // TRAMPA MORTAL 1: L_sym's v₁ ∝ √D, NOT constant.
                // Subtracting mean projects against wrong subspace → thermal noise.
                if (normalized) {
                    // Project out v₁ = √D / √vol
                    let dot = 0;
                    for (let i = 0; i < N; i++) dot += vec[i] * v1_norm[i];
                    for (let i = 0; i < N; i++) vec[i] -= dot * v1_norm[i];
                } else {
                    // Combinatorio: v₁ = [1,1,...,1]/√N → subtract mean
                    let sum = 0;
                    for (let i = 0; i < N; i++) sum += vec[i];
                    const mean = sum / N;
                    for (let i = 0; i < N; i++) vec[i] -= mean;
                }

                // 2. Gram-Schmidt orthogonalization against previous vectors
                for (const dv of deflateVectors) {
                    let dot = 0;
                    for (let i = 0; i < N; i++) dot += vec[i] * dv[i];
                    for (let i = 0; i < N; i++) vec[i] -= dot * dv[i];
                }

                // 3. L2 normalization
                let normSq = 0;
                for (let i = 0; i < N; i++) normSq += vec[i] * vec[i];
                if (normSq < 1e-18) break;
                const rNorm = 1.0 / Math.sqrt(normSq);
                for (let i = 0; i < N; i++) vec[i] *= rNorm;

                // 4. Fused SpMV: (cI - L)v + Rayleigh Quotient
                let norm = 0;
                mu = 0;
                for (let i = 0; i < N; i++) {
                    let Lv_i: number;

                    if (normalized) {
                        // L_sym·v = v_i - Σ (w_ij / √(d_i × d_j)) × v_j
                        // ISOLATED NODE EXILE: degree=0 nodes have eigenvalue c in the
                        // shifted matrix (cI - L_sym), which DOMINATES over the Fiedler.
                        // Without exile, power iteration converges to orphan files
                        // instead of the real architectural bottleneck.
                        if (degree[i] === 0) {
                            v_next[i] = 0;
                            continue;
                        }
                        Lv_i = vec[i]; // Diagonal of L_sym = 1.0 for connected nodes
                        const end = rowPtr[i + 1];
                        for (let k = rowPtr[i]; k < end; k++) {
                            const j = colIdx[k];
                            Lv_i -= csrValues[k] * invSqrtD[i] * invSqrtD[j] * vec[j];
                        }
                    } else {
                        // L·v = D·v - A·v (original combinatorio)
                        Lv_i = degree[i] * vec[i];
                        const end = rowPtr[i + 1];
                        for (let k = rowPtr[i]; k < end; k++) {
                            Lv_i -= csrValues[k] * vec[colIdx[k]];
                        }
                    }

                    const val = c * vec[i] - Lv_i;
                    v_next[i] = val;
                    norm += val * val;
                    mu += vec[i] * val;
                }

                // ─── HOT-LOOP THERMAL GUARD ───
                // If SpMV overflows (c·v − L·v → Inf − Inf → NaN), abort the
                // power iteration *immediately* with an explicit return — not
                // a `break`, because `break` would still execute the gauge
                // fixing pass over a corrupted vec array. V8 inlines
                // Number.isFinite to a single native instruction; cost ~0.
                // The outer Numerical Sanity Firewall traps the NaN here and
                // returns the degenerate variant of the discriminated union.
                if (!Number.isFinite(norm) || !Number.isFinite(mu)) {
                    return { val: NaN, vec };
                }

                norm = Math.sqrt(norm);
                if (norm < 1e-9) break;
                // Dual convergence criterion: eigenvalue AND eigenvector stability.
                let maxVecDiff = 0;
                for (let j = 0; j < N; j++) {
                    const diff = Math.abs(vec[j] - v_next[j] / norm);
                    if (diff > maxVecDiff) maxVecDiff = diff;
                }
                for (let i = 0; i < N; i++) vec[i] = v_next[i] / norm;

                const delta = Math.abs(mu - prev_mu);
                if (delta < 1e-7 && maxVecDiff < 1e-6) break;
                // Divergence guard: if eigenvalue delta is growing instead of shrinking, bail out
                if (iter > 20 && delta > prevDelta * 2) break;
                prevDelta = delta;
                prev_mu = mu;
            }

            // GAUGE FIXING (Phase Canonicalization)
            let maxAbs = -1;
            let signMultiplier = 1;
            for (let i = 0; i < N; i++) {
                const absVal = Math.abs(vec[i]);
                if (absVal > maxAbs) {
                    maxAbs = absVal;
                    signMultiplier = vec[i] < 0 ? -1 : 1;
                }
            }
            if (signMultiplier === -1) {
                for (let i = 0; i < N; i++) vec[i] *= -1;
            }

            // ─── 4ta Capa: RAYLEIGH RESIDUAL GUARD ───
            // Verificación post-convergencia: ||Mv - μv||∞ < 1e-3
            // Si la iteración convergió a basura por ruido térmico de 64-bits,
            // dispara NaN que el Numerical Sanity Firewall atrapa.
            let maxResidual = 0;
            for (let i = 0; i < N; i++) {
                let Lv_i: number;

                if (normalized) {
                    if (degree[i] === 0) continue;
                    Lv_i = vec[i]; // Diagonal de L_sym = 1.0
                    const end = rowPtr[i + 1];
                    for (let k = rowPtr[i]; k < end; k++) {
                        const j = colIdx[k];
                        Lv_i -= csrValues[k] * invSqrtD[i] * invSqrtD[j] * vec[j];
                    }
                } else {
                    Lv_i = degree[i] * vec[i]; // Combinatorio
                    const end = rowPtr[i + 1];
                    for (let k = rowPtr[i]; k < end; k++) {
                        Lv_i -= csrValues[k] * vec[colIdx[k]];
                    }
                }

                const val_i = c * vec[i] - Lv_i;
                const residual = Math.abs(val_i - mu * vec[i]);
                if (residual > maxResidual) maxResidual = residual;
            }

            if (maxResidual > 1e-3) {
                return { val: NaN, vec };
            }

            return { val: Math.max(0, c - mu), vec };
        };

        // Extract λ₂ (Fiedler) — seedModifier=0 preserves original behavior
        const res2 = powerIteration([], 0);

        // Short-circuit: if λ₂ already corrupted to NaN, the second power
        // iteration would receive a poisoned `res2.vec` as its deflation
        // basis and contaminate from iter=0. Skip it entirely. The outer
        // firewall would catch the result anyway, but this avoids one
        // wasted SpMV cycle — strict HPC discipline: no thermal waste.
        if (!Number.isFinite(res2.val)) {
            return { fiedler: 0, volume };
        }

        // Extract λ₃ — seedModifier=99991 ensures different subspace, deflating v₂
        const res3 = powerIteration([res2.vec], 99991);

        // ─── NUMERICAL SANITY FIREWALL (Defense in Depth) ───
        // IEEE 754 protection: if power iteration overflows on hub-heavy graphs
        // (c·v − L·v → Inf − Inf → NaN), catch it at the boundary.
        // We let NaN propagate through the hot loop (HPC convention) and trap
        // it here so the solver stays a clean black box. Restores the invariant:
        // "spectral vectors are finite, or they don't exist at all".
        // O(N) tight loop on Float64Array — V8 auto-vectorizes; cost <0.1ms at N=25k.
        let isSane = Number.isFinite(res2.val) && Number.isFinite(res3.val);
        if (isSane) {
            for (let i = 0; i < N; i++) {
                if (!Number.isFinite(res2.vec[i]) || !Number.isFinite(res3.vec[i])) {
                    isSane = false;
                    break;
                }
            }
        }

        if (!isSane) {
            // The graph is mathematically intractable in float64.
            // Fail-closed: drop to the degenerate variant of the discriminated
            // union. Downstream consumers narrow on `if (result.v2)` and route
            // every file to the "orphan" cluster — no phantom bridges produced.
            return { fiedler: 0, volume };
        }

        return {
            fiedler: res2.val,
            volume,
            v2: res2.vec,
            lambda3: res3.val,
            v3: res3.vec,
        };
    }
}
