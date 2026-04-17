/**
 * scripts/demo-outline.ts — live demo of NREKI parasitic signals in outline.
 *
 * Clones colinhacks/zod (shallow, cached under ~/.nreki-demo-cache/zod) and
 * runs NREKI's handleOutline against real zod v4 source. Output is exactly
 * what a Claude Code / Cursor agent sees when it asks for an outline on a
 * known-public codebase.
 *
 * Used by scripts/demo.tape to record the landing-page GIF.
 *   1. npm install
 *   2. vhs scripts/demo.tape        # produces docs/demo.gif
 *
 * Pre-warm the cache once (speeds up the recording):
 *   npx tsx scripts/demo-outline.ts
 */
import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";
import { NrekiEngine } from "../src/engine.js";
import { handleOutline } from "../src/handlers/navigate.js";
import type { RouterDependencies } from "../src/router.js";
import { SpectralTopologist, SpectralMath } from "../src/kernel/spectral-topology.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

const CACHE_ROOT = path.join(os.homedir(), ".nreki-demo-cache");
const ZOD_REPO = path.join(CACHE_ROOT, "zod");

const TARGETS: Array<{ label: string; relInWork: string }> = [
    { label: "packages/zod/src/v4/core/parse.ts",  relInWork: "v4/core/parse.ts" },
    { label: "packages/zod/src/v4/core/errors.ts", relInWork: "v4/core/errors.ts" },
];

function ensureZodClone(): void {
    if (fs.existsSync(path.join(ZOD_REPO, ".git"))) return;
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    process.stdout.write(`${DIM}# First run: cloning colinhacks/zod (shallow, one-time)...${RESET}\n`);
    childProcess.execFileSync(
        "git",
        ["clone", "--depth=1", "--quiet", "https://github.com/colinhacks/zod.git", ZOD_REPO],
        { stdio: ["ignore", "inherit", "inherit"] },
    );
}

function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirRecursive(s, d);
        else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
            fs.copyFileSync(s, d);
        }
    }
}

function prepareWorkDir(): string {
    // Copy zod's v4/core directory into a throwaway work dir so the ghost
    // oracle sees real cross-file references (public API symbols get tagged
    // correctly: internal-only = ghost, consumed elsewhere = not ghost).
    // A minimal tsconfig sidesteps zod's monorepo pnpm workspace complexity.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-demo-zod-"));
    fs.writeFileSync(path.join(work, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022", module: "Node16", moduleResolution: "Node16",
            strict: true, esModuleInterop: true, rootDir: ".", skipLibCheck: true,
            allowJs: false, noEmit: true,
        },
        include: ["./**/*.ts"], exclude: ["node_modules", "dist"],
    }));

    // Copy ALL of packages/zod/src (~2.8MB, ~116 files) so the ghost
    // oracle sees the full zod internal ref graph. Exports consumed by
    // v4/classic/mini layers will NOT get ghost-tagged; only truly
    // leaf-exported symbols will.
    const zodSrc = path.join(ZOD_REPO, "packages/zod/src");
    if (!fs.existsSync(zodSrc)) {
        throw new Error(`Expected zod src dir not found: packages/zod/src (did the repo layout change?)`);
    }
    copyDirRecursive(zodSrc, work);
    return work;
}

function colorize(text: string): string {
    return text
        .replace(/⚠️ \[[^\]]+\]/g, (m) => `${YELLOW}${m}${RESET}`)
        .replace(/👻 \[0 ext refs\]/g, (m) => `${CYAN}${m}${RESET}`)
        .replace(/\[HIGH[^\]]*\]/g, (m) => `${MAGENTA}${m}${RESET}`);
}

async function main(): Promise<void> {
    ensureZodClone();
    const work = prepareWorkDir();

    try {
        const engine = new NrekiEngine({
            dbPath: path.join(work, ".nreki-demo.db"),
            watchPaths: [work],
        });
        await engine.initialize();
        await engine.indexDirectory(work);
        const deps = { engine } as unknown as RouterDependencies;

        for (const t of TARGETS) {
            process.stdout.write(
                `\n${DIM}# Target:${RESET} ${BOLD}colinhacks/zod${RESET} ${DIM}:${RESET} ${t.label}\n` +
                `${BOLD}$ nreki_navigate action:"outline" path:"${t.relInWork}"${RESET}\n\n`,
            );
            const t0 = Date.now();
            const response = await handleOutline({ action: "outline", path: t.relInWork }, deps);
            const ms = Date.now() - t0;
            const text = (response.content[0] as { text?: string }).text ?? "";
            // Trim to first ~14 meaningful symbol lines so the GIF stays readable.
            const lines = text.split("\n");
            const trimmed = lines.length > 18 ? [...lines.slice(0, 18), `${DIM}... (truncated)${RESET}`] : lines;
            process.stdout.write(colorize(trimmed.join("\n")));
            process.stdout.write(`\n${DIM}# Built in ${ms}ms.${RESET}\n`);
        }

        await engine.shutdown();

        // ─── Scene 3: Spectral topology benchmark ───
        // Runs against the cached zod clone directly (needs its tsconfig base
        // for TS program construction). All RAM, zero writes.
        process.stdout.write(
            `\n${DIM}# ────────────────────────────────────────────────────${RESET}\n` +
            `${DIM}# Scene 3:${RESET} ${BOLD}Spectral Topology${RESET} ${DIM}on the full zod codebase${RESET}\n\n`,
        );
        runSpectralBenchmark();
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

function runSpectralBenchmark(): void {
    const tsconfigPath = path.join(ZOD_REPO, ".configs/tsconfig.base.json");
    const effectiveTsconfig = fs.existsSync(tsconfigPath)
        ? tsconfigPath
        : path.join(ZOD_REPO, "tsconfig.json");

    const configFile = ts.readConfigFile(effectiveTsconfig, ts.sys.readFile);
    const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config, ts.sys, path.dirname(effectiveTsconfig),
    );

    // Gather every .ts file under packages/zod/src (excluding tests/dist).
    const zodSrc = path.join(ZOD_REPO, "packages/zod/src");
    const rootFiles: string[] = [];
    const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile() && /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
                rootFiles.push(p);
            }
        }
    };
    walk(zodSrc);

    const program = ts.createProgram(rootFiles, parsedConfig.options);
    const targetFiles = new Set<string>();
    for (const sf of program.getSourceFiles()) {
        const fn = sf.fileName.replace(/\\/g, "/");
        if (!fn.includes("node_modules") && !fn.includes("/dist/")) targetFiles.add(fn);
    }

    process.stdout.write(`${BOLD}$ npx tsx tests/benchmark-spectral-external.ts ~/.nreki-demo-cache/zod${RESET}\n\n`);
    process.stdout.write(`Project: zod\nSource files: ${targetFiles.size}\n\n`);

    const memBefore = process.memoryUsage().heapUsed;
    const tExtract0 = performance.now();
    const { nodes, edges } = SpectralTopologist.extractConstraintGraph(program, targetFiles);
    const extractMs = performance.now() - tExtract0;

    const { sparseEdges, N } = SpectralTopologist.buildSparseGraph(nodes, edges);
    const tFiedler0 = performance.now();
    const { fiedler, volume } = SpectralMath.analyzeTopology(N, sparseEdges);
    const fiedlerMs = performance.now() - tFiedler0;
    const memAfter = process.memoryUsage().heapUsed;

    const fiedlerColored = fiedlerMs < 100
        ? `${YELLOW}${fiedlerMs.toFixed(1)}ms${RESET}`
        : `${fiedlerMs.toFixed(1)}ms`;

    process.stdout.write(
        `--- Results ---\n` +
        `Nodes: ${nodes.size}  |  Edges: ${edges.length}  |  Sparse edges: ${sparseEdges.length}\n` +
        `Fiedler (λ₂): ${fiedler.toFixed(6)}  |  Volume: ${volume}\n` +
        `Extract: ${extractMs.toFixed(1)}ms  |  ${BOLD}Fiedler (sparse): ${fiedlerColored}${BOLD}${RESET}\n` +
        `RAM delta: ${((memAfter - memBefore) / 1024).toFixed(0)}KB\n` +
        `\n${DIM}# Spectral topology of an entire library in one V8 event-loop tick.${RESET}\n`,
    );
}

main().catch((err) => {
    process.stderr.write(`demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
