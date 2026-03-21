import { describe, it, expect, afterEach } from "vitest";
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SpectralMath } from "../src/kernel/spectral-topology.js";
import { SpectralTopologist } from "../src/kernel/spectral-topology.js";

describe("SpectralMath.getFiedlerValue", () => {

    it("should return 0 for single node", () => {
        expect(SpectralMath.getFiedlerValue([[0]])).toBe(0);
    });

    it("should return 0 for empty matrix", () => {
        expect(SpectralMath.getFiedlerValue([])).toBe(0);
    });

    it("should return positive value for complete graph K3", () => {
        const adj = [
            [0, 1, 1],
            [1, 0, 1],
            [1, 1, 0],
        ];
        const fiedler = SpectralMath.getFiedlerValue(adj);
        expect(fiedler).toBeGreaterThan(0);
        expect(fiedler).toBeCloseTo(3, 0);
    });

    it("should return 0 for disconnected graph", () => {
        const adj = [
            [0, 0],
            [0, 0],
        ];
        expect(SpectralMath.getFiedlerValue(adj)).toBe(0);
    });

    it("should detect edge removal (fiedler drops)", () => {
        const connected = [
            [0, 1, 0],
            [1, 0, 1],
            [0, 1, 0],
        ];
        const weakened = [
            [0, 1, 0],
            [1, 0, 0],
            [0, 0, 0],
        ];
        const f1 = SpectralMath.getFiedlerValue(connected);
        const f2 = SpectralMath.getFiedlerValue(weakened);
        expect(f1).toBeGreaterThan(f2);
    });

    it("should be deterministic (exact same output for same input)", () => {
        const adj = [
            [0, 1, 0, 1],
            [1, 0, 1, 0],
            [0, 1, 0, 1],
            [1, 0, 1, 0],
        ];
        const r1 = SpectralMath.getFiedlerValue(adj);
        const r2 = SpectralMath.getFiedlerValue(adj);
        expect(r1).toBe(r2);
    });

    it("should symmetrize directed graph", () => {
        const directed = [
            [0, 1, 0],
            [0, 0, 1],
            [0, 0, 0],
        ];
        const fiedler = SpectralMath.getFiedlerValue(directed);
        expect(fiedler).toBeGreaterThan(0);
    });

    it("should reflect weight differences", () => {
        const strong = [
            [0, 1.0],
            [1.0, 0],
        ];
        const weak = [
            [0, 0.5],
            [0.5, 0],
        ];
        expect(SpectralMath.getFiedlerValue(strong)).toBeGreaterThan(
            SpectralMath.getFiedlerValue(weak)
        );
    });

    it("should handle larger graph (10 nodes ring)", () => {
        const N = 10;
        const adj: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
        for (let i = 0; i < N; i++) {
            adj[i][(i + 1) % N] = 1;
            adj[(i + 1) % N][i] = 1;
        }
        const fiedler = SpectralMath.getFiedlerValue(adj);
        expect(fiedler).toBeGreaterThan(0);
        expect(fiedler).toBeLessThan(1);
    });
});

describe("SpectralTopologist integration", () => {
    let tmpDir: string;

    function createProject(files: Record<string, string>): ts.Program {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-spectral-"));
        const tsConfigPath = path.join(tmpDir, "tsconfig.json");
        fs.writeFileSync(tsConfigPath, JSON.stringify({
            compilerOptions: {
                target: "ES2020",
                module: "ES2020",
                moduleResolution: "node",
                strict: true,
                outDir: "./dist",
                declaration: true,
            },
            include: ["./**/*.ts"],
        }));

        const filePaths: string[] = [];
        for (const [name, content] of Object.entries(files)) {
            const fullPath = path.join(tmpDir, name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, content);
            filePaths.push(fullPath);
        }

        return ts.createProgram(filePaths, {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.ES2020,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            strict: true,
            declaration: true,
        });
    }

    afterEach(() => {
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("should extract nodes and edges from a simple project", () => {
        const program = createProject({
            "models.ts": `
                export interface User {
                    id: string;
                    name: string;
                }
                export interface Config {
                    timeout: number;
                }
            `,
            "service.ts": `
                import { User, Config } from "./models.js";
                export function getUser(config: Config): User {
                    return { id: "1", name: "test" };
                }
            `,
        });

        const targetFiles = new Set<string>();
        for (const sf of program.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) {
                targetFiles.add(sf.fileName.replace(/\\/g, "/"));
            }
        }

        const { nodes, edges } = SpectralTopologist.extractConstraintGraph(program, targetFiles);

        expect(nodes.size).toBeGreaterThanOrEqual(3); // User, Config, getUser
        expect(edges.length).toBeGreaterThanOrEqual(2); // getUser -> User, getUser -> Config
    });

    it("should detect fiedler drop when type is widened to any", () => {
        // PRE-EDIT: strong types
        const programPre = createProject({
            "models.ts": `
                export interface RetryConfig {
                    maxRetries: number;
                    delay: number;
                }
            `,
            "service.ts": `
                import { RetryConfig } from "./models.js";
                export function retry(config: RetryConfig): RetryConfig {
                    return config;
                }
            `,
        });

        const targetFilesPre = new Set<string>();
        for (const sf of programPre.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) {
                targetFilesPre.add(sf.fileName.replace(/\\/g, "/"));
            }
        }
        const pre = SpectralTopologist.analyze(programPre, targetFilesPre);

        // POST-EDIT: RetryConfig widened to any (reward hacking)
        const programPost = createProject({
            "models.ts": `
                export interface RetryConfig {
                    maxRetries: number;
                    delay: number;
                }
            `,
            "service.ts": `
                import { RetryConfig } from "./models.js";
                export function retry(config: any): any {
                    return config;
                }
            `,
        });

        const targetFilesPost = new Set<string>();
        for (const sf of programPost.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) {
                targetFilesPost.add(sf.fileName.replace(/\\/g, "/"));
            }
        }
        const post = SpectralTopologist.analyze(programPost, targetFilesPost);

        // Fiedler should drop: type constraints destroyed
        expect(pre.fiedlerValue).toBeGreaterThan(post.fiedlerValue);
        // Volume should drop: edges disappeared
        expect(pre.volume).toBeGreaterThan(post.volume);
    });

    it("should REJECT entropy injection via computeDelta", () => {
        const pre = { fiedlerValue: 2.0, volume: 8, nodeCount: 4, edgeCount: 6 };
        const post = { fiedlerValue: 0.5, volume: 4, nodeCount: 4, edgeCount: 3 };
        const delta = SpectralTopologist.computeDelta(pre, post);
        expect(delta.verdict).toBe("REJECTED_ENTROPY");
        expect(delta.volumeDrop).toBeGreaterThan(0);
        expect(delta.normalizedFiedlerDrop).toBeGreaterThan(0);
    });

    it("should APPROVE legitimate decoupling", () => {
        const pre = { fiedlerValue: 1.5, volume: 10, nodeCount: 5, edgeCount: 8 };
        const post = { fiedlerValue: 0.0, volume: 10, nodeCount: 5, edgeCount: 8 };
        const delta = SpectralTopologist.computeDelta(pre, post);
        expect(delta.verdict).toBe("APPROVED_DECOUPLING");
    });

    it("should APPROVE cosmetic refactor", () => {
        const programA = createProject({
            "utils.ts": `
                export interface Logger {
                    log(msg: string): void;
                }
                export function createLogger(): Logger {
                    return { log: (msg: string) => console.log(msg) };
                }
            `,
        });

        const targetA = new Set<string>();
        for (const sf of programA.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) {
                targetA.add(sf.fileName.replace(/\\/g, "/"));
            }
        }
        const a = SpectralTopologist.analyze(programA, targetA);

        // Same structure, renamed variable (cosmetic)
        const programB = createProject({
            "utils.ts": `
                export interface Logger {
                    log(message: string): void;
                }
                export function createLogger(): Logger {
                    return { log: (message: string) => console.log(message) };
                }
            `,
        });

        const targetB = new Set<string>();
        for (const sf of programB.getSourceFiles()) {
            if (!sf.fileName.includes("node_modules")) {
                targetB.add(sf.fileName.replace(/\\/g, "/"));
            }
        }
        const b = SpectralTopologist.analyze(programB, targetB);

        const delta = SpectralTopologist.computeDelta(a, b);
        expect(delta.verdict).toBe("APPROVED");
    });
});
