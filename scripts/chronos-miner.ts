import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ASTParser } from '../src/parser.js';
import { generateRepoMap, computePageRank } from '../src/repo-map.js';
import { SpectralMath, SparseEdge } from '../src/kernel/spectral-topology.js';

/**
 * NREKI Chronos Miner v7 — The True Tectonic Oracle
 * 
 * Cruelty-driven fixes:
 * 1. Single Worktree Checkout (100x faster I/O).
 * 2. ACID Transactional JSONL Buffering (No Time Travel).
 * 3. Dead Letter Log (Poison Pill Crash Recovery).
 * 4. Pure Code-Only Physics updates.
 * 5. Full History Extraction (--first-parent --reverse).
 * 6. Real Graph Edges exported for GATv2.
 * 7. safeFloat sanitizer against NaN tensor poisoning.
 * 
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

const BATCH_LIMIT = 200;
const LOOKAHEAD_WINDOW = 5;

const safeFloat = (val: number | undefined | null) => {
    if (val === undefined || val === null || !Number.isFinite(val) || Number.isNaN(val)) return 0.0;
    return parseFloat(val.toFixed(6));
};

class ImmortalityDrive {
    private stateFile: string;
    public recentLogSizes: number[] = [];
    public fileChurn: Map<string, number> = new Map();
    public slidingWindow: any[] = [];
    private readonly MAD_WINDOW = 500;

    constructor(repoName: string) {
        this.stateFile = path.resolve(process.cwd(), `${repoName}_immortality_drive.json`);
    }

    public load() {
        if (fs.existsSync(this.stateFile)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
                this.recentLogSizes = data.recentLogSizes || [];
                this.fileChurn = new Map(Object.entries(data.fileChurn || {}));
                this.slidingWindow = (data.slidingWindow || []).map((snap: any) => ({
                    ...snap,
                    _filesTouched: new Set(snap._filesTouched)
                }));
            } catch {
                console.error("[IMMORTALITY] State corrupted. Starting fresh.");
            }
        }
    }

    public save() {
        const safeWindow = this.slidingWindow.map(snap => ({
            ...snap,
            _filesTouched: Array.from(snap._filesTouched)
        }));
        const data = {
            recentLogSizes: this.recentLogSizes,
            fileChurn: Object.fromEntries(this.fileChurn),
            slidingWindow: safeWindow
        };
        const tmp = `${this.stateFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, this.stateFile);
    }

    public cleanup() {
        if (fs.existsSync(this.stateFile)) fs.unlinkSync(this.stateFile);
    }

    public updateChurn(files: string[]) {
        for (const key of this.fileChurn.keys()) {
            const decayed = this.fileChurn.get(key)! * 0.95;
            if (decayed < 0.01) this.fileChurn.delete(key);
            else this.fileChurn.set(key, decayed);
        }
        for (const f of files) {
            this.fileChurn.set(f, (this.fileChurn.get(f) || 0) + 1.0);
        }
    }

    public evaluateTectonicShift(files: string[]): { isShotgun: boolean; entropy: number; robustZ: number } {
        const F = files.length;
        if (F === 0) return { isShotgun: false, entropy: 0, robustZ: 0 };

        const dirCounts = new Map<string, number>();
        for (const f of files) {
            const dir = path.dirname(f);
            dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
        }
        let entropy = 0;
        for (const count of dirCounts.values()) {
            const p = count / F;
            entropy -= p * Math.log2(p);
        }

        const logF = Math.log(F);
        this.recentLogSizes.push(logF);
        if (this.recentLogSizes.length > this.MAD_WINDOW) this.recentLogSizes.shift();

        if (this.recentLogSizes.length < 10) return { isShotgun: false, entropy, robustZ: 0 };

        const sorted = [...this.recentLogSizes].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const deviations = sorted.map(x => Math.abs(x - median)).sort((a, b) => a - b);
        const mad = deviations[Math.floor(deviations.length / 2)];

        const safeMad = mad > 0 ? mad : 1e-5;
        const robustZ = (0.6745 * (logF - median)) / safeMad;
        const isShotgun = robustZ > 3.0 && entropy > 1.5 && F >= 5;

        return { isShotgun, entropy, robustZ };
    }
}

export async function mineIndestructibleHistory(repoUrl: string) {
    const repoName = repoUrl.split('/').pop()!.replace('.git', '');
    const cloneDir = path.resolve(`/tmp/nreki-bare-${repoName}`);
    const wtPath = path.resolve(`/tmp/nreki-wt-${repoName}`);
    const outputFile = path.resolve(process.cwd(), `${repoName}_stgt_dataset.jsonl`);

    const activeCommitFile = path.resolve(process.cwd(), `${repoName}_active.tmp`);
    const poisonFile = path.resolve(process.cwd(), `${repoName}_poison.log`);
    const poisonCommits = new Set<string>();

    if (fs.existsSync(poisonFile)) {
        fs.readFileSync(poisonFile, 'utf-8').split('\n').filter(Boolean).forEach(c => poisonCommits.add(c));
    }

    if (fs.existsSync(activeCommitFile)) {
        const poison = fs.readFileSync(activeCommitFile, 'utf-8').trim();
        if (poison) {
            console.log(`\n[CRASH RECOVERY] Detected poison commit (OOM/Timeout): ${poison}. Blacklisting.`);
            fs.appendFileSync(poisonFile, `${poison}\n`);
            poisonCommits.add(poison);
        }
        fs.unlinkSync(activeCommitFile);
    }

    console.log(`[MINER] Repository: ${repoName}`);

    if (!fs.existsSync(cloneDir)) {
        console.log('[MINER] Cloning bare...');
        execSync(`git clone --bare ${repoUrl} ${cloneDir}`, { stdio: 'inherit' });
    }

    if (!fs.existsSync(wtPath)) {
        console.log('[MINER] Creating persistent worktree...');
        execSync(`git worktree add --detach ${wtPath}`, { cwd: cloneDir, stdio: 'ignore' });
    }

    const drive = new ImmortalityDrive(repoName);
    drive.load();

    const processedCommits = new Set<string>();
    let historicalLines = 0;
    let historicalPositives = 0;

    if (fs.existsSync(outputFile)) {
        const rl = readline.createInterface({ input: fs.createReadStream(outputFile), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim()) continue;
            historicalLines++;
            try {
                const parsed = JSON.parse(line);
                processedCommits.add(parsed.commit);
                if (parsed.target_future_collapse === 1) historicalPositives++;
            } catch {}
        }
        console.log(`[MINER] Resuming... Loaded ${historicalLines} samples (${historicalPositives} positive).`);
    }

    for (const snap of drive.slidingWindow) {
        processedCommits.add(snap.commit);
    }

    console.log('[MINER] Fetching chronological timeline...');
    const logRaw = execSync('git log --first-parent --reverse --format="%H|%s"', { cwd: cloneDir, maxBuffer: 1024 * 1024 * 1024 })
        .toString().trim().split('\n').filter(Boolean);

    const parser = new ASTParser();
    await parser.initialize();

    console.log(`[MINER] Executing True Crash-Only Mining on ${logRaw.length} commits...`);

    let extractedThisRun = 0;
    let newPositives = 0;
    const jsonlBuffer: string[] = [];

    for (let i = 0; i < logRaw.length; i++) {
        const [hash, ...msgParts] = logRaw[i].split('|');

        if (processedCommits.has(hash)) continue;
        if (poisonCommits.has(hash)) {
            console.log(`[MINER] ☠️ Skipping poisoned commit: ${hash}`);
            continue;
        }

        const msg = msgParts.join('|').toLowerCase();
        const isCosmetic = /\b(format|lint|prettier|style|docs|typo)\b/i.test(msg);
        const isRevert = /\b(revert|undo|rollback|hotfix)\b/i.test(msg) || msg.includes('this reverts commit');

        let allFilesChanged: string[] = [];
        try {
            const diffRaw = execSync(`git diff-tree -z --no-commit-id --name-only -r -m ${hash}`, { cwd: cloneDir, maxBuffer: 50 * 1024 * 1024 })
                .toString().split('\0');
            allFilesChanged = diffRaw.filter(f => f.trim().length > 0);
        } catch { continue; }

        const codeFilesChanged = allFilesChanged.filter(f =>
            /\.(ts|tsx|js|jsx)$/i.test(f) &&
            !f.endsWith('.d.ts') &&
            !f.includes('.test.') &&
            !f.includes('.spec.')
        );

        if (codeFilesChanged.length === 0) continue;

        drive.updateChurn(codeFilesChanged);
        const analysis = drive.evaluateTectonicShift(codeFilesChanged);

        try {
            fs.writeFileSync(activeCommitFile, hash);
            execSync(`git checkout -qf ${hash} && git clean -qfdx`, { cwd: wtPath, stdio: 'ignore' });

            let killTimer: NodeJS.Timeout | undefined;

            const topologyTask = async () => {
                const repoMap = await generateRepoMap(wtPath, parser);
                if (!repoMap.graph || repoMap.entries.length < 2) throw new Error("INSUFFICIENT_GRAPH");

                const nodeIndex = new Map<string, number>();
                repoMap.entries.forEach((entry, idx) => nodeIndex.set(entry.filePath, idx));
                const N = nodeIndex.size;

                const sparseEdges: SparseEdge[] = [];
                for (const [targetFile, consumers] of repoMap.graph.importedBy.entries()) {
                    const targetIdx = nodeIndex.get(targetFile);
                    if (targetIdx === undefined) continue;
                    for (const consumer of consumers) {
                        const consumerIdx = nodeIndex.get(consumer);
                        if (consumerIdx !== undefined && consumerIdx !== targetIdx) {
                            sparseEdges.push({ u: consumerIdx, v: targetIdx, weight: 1.0 });
                        }
                    }
                }

                if (N <= 1 || sparseEdges.length === 0) throw new Error("NO_EDGES");

                const state = SpectralMath.analyzeTopology(N, sparseEdges);
                const maxEdges = N > 1 ? (N * (N - 1)) : 1;
                const density = sparseEdges.length / maxEdges;
                const prScores = computePageRank(repoMap.entries.map(e => e.filePath), repoMap.graph.importedBy);

                return { N, density, state, prScores, nodeIndex, sparseEdges };
            };

            const timeoutTask = new Promise<never>((_, reject) => {
                killTimer = setTimeout(() => reject(new Error("AST_TIMEOUT_15S")), 15000);
            });

            let topo: any;
            try {
                const pTask = topologyTask().catch(e => { throw e; });
                pTask.catch(() => {});
                topo = await Promise.race([pTask, timeoutTask]);
            } finally {
                if (killTimer) clearTimeout(killTimer);
            }

            const gap = (topo.state.lambda3 ?? 0) - topo.state.fiedler;
            const safe_density = Math.max(topo.density, 1e-9);
            const normalizedGap = Math.sign(gap) * Math.log1p(Math.abs(gap / safe_density));

            drive.slidingWindow.push({
                commit: hash,
                features: {
                    N: topo.N,
                    density: safeFloat(topo.density),
                    spatial_entropy: safeFloat(analysis.entropy),
                    robust_z: safeFloat(analysis.robustZ),
                    normalized_gap: safeFloat(normalizedGap),
                    nodes: Array.from(topo.nodeIndex.entries()).map(([filePath, idx]) => ({
                        id: filePath,
                        v2_signed: safeFloat(topo.state.v2 ? topo.state.v2[idx] : 0),
                        v2_abs: safeFloat(topo.state.v2 ? Math.abs(topo.state.v2[idx]) : 0),
                        v3_signed: safeFloat(topo.state.v3 ? topo.state.v3[idx] : 0),
                        v3_abs: safeFloat(topo.state.v3 ? Math.abs(topo.state.v3[idx]) : 0),
                        pr: safeFloat(topo.prScores.get(filePath) || 0),
                        churn: safeFloat(drive.fileChurn.get(filePath) || 0),
                    })),
                    edges: topo.sparseEdges.map((e: SparseEdge) => [e.u, e.v]),
                },
                _isRevert: isRevert,
                _isShotgun: analysis.isShotgun,
                _isCosmetic: isCosmetic,
                _filesTouched: new Set(codeFilesChanged),
            });

            if (drive.slidingWindow.length > LOOKAHEAD_WINDOW) {
                const target = drive.slidingWindow.shift()!;
                let futureCollapse = 0;

                for (const future of drive.slidingWindow) {
                    if ((future._isRevert || future._isShotgun) && !future._isCosmetic) {
                        const overlap = [...target._filesTouched].some((f: string) => future._filesTouched.has(f));
                        if (overlap) {
                            futureCollapse = 1;
                            break;
                        }
                    }
                }

                jsonlBuffer.push(JSON.stringify({
                    commit: target.commit,
                    features: target.features,
                    target_future_collapse: futureCollapse,
                }));

                extractedThisRun++;
                if (futureCollapse) newPositives++;

                if (extractedThisRun % 50 === 0) {
                    console.log(`[MINER] Buffered ${extractedThisRun} samples. Memory safe.`);
                }

                if (extractedThisRun >= BATCH_LIMIT) {
                    console.log(`\n[NREKI] 💀 BATCH LIMIT (${BATCH_LIMIT}). Committing Atomic Transaction to Disk.`);
                    fs.appendFileSync(outputFile, jsonlBuffer.join('\n') + '\n');
                    drive.save();
                    if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
                    process.exit(0);
                }
            }

            if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);

        } catch (err: any) {
            if (err.message === "AST_TIMEOUT_15S") {
                console.log(`[MINER] ⚠️ AST Timeout en commit ${hash}. Aplicando Zero-Padding temporal.`);
                if (drive.slidingWindow.length > 0) {
                    const lastValid = drive.slidingWindow[drive.slidingWindow.length - 1];
                    drive.slidingWindow.push({
                        ...lastValid,
                        commit: hash,
                        _isRevert: isRevert,
                        _isShotgun: analysis.isShotgun,
                        _isCosmetic: isCosmetic,
                        _filesTouched: new Set(codeFilesChanged)
                    });
                }
            }
            if (fs.existsSync(activeCommitFile)) fs.unlinkSync(activeCommitFile);
        }
    }

    if (jsonlBuffer.length > 0) {
        fs.appendFileSync(outputFile, jsonlBuffer.join('\n') + '\n');
    }
    drive.save();
    drive.cleanup();

    const totalLines = historicalLines + extractedThisRun;
    const totalPositives = historicalPositives + newPositives;
    const pct = totalLines > 0 ? ((totalPositives / totalLines) * 100).toFixed(1) : '0';

    console.log(`\n[MINER] 🎉 Dataset 100% complete! Global samples: ${totalLines} (${pct}% positive)`);
    process.exit(42);
}

const repoUrl = process.argv[2];
if (!repoUrl) { console.error('Usage: npx tsx scripts/chronos-miner.ts <repo-url>'); process.exit(1); }
mineIndestructibleHistory(repoUrl).catch(err => { console.error(`[MINER] Fatal: ${err.message}`); process.exit(1); });
