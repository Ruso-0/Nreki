import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type Parser from "web-tree-sitter";
import { isSensitivePath, safePath } from "../utils/path-jail.js";
import { readSource } from "../utils/read-source.js";
import { captureFileTraits, withTraits, applyModeTraits, contentDigest, readSourceForEdit } from "../utils/file-traits.js";
import { toPosix as toPosixUtil } from "../utils/to-posix.js";
import { logger, setTxId, clearTxId } from "../utils/logger.js";
import { latencyTracker } from "../utils/latency-tracker.js";
import { TsCompilerWrapper } from "./backends/ts-compiler-wrapper.js";
import type { LspSidecarBase } from "./backends/lsp-sidecar-base.js";
import { AsyncMutex } from "./mutex.js";
import type {
    NrekiStructuredError, NrekiEdit,
    NrekiInterceptResult, LspDependentsCoverage,
    TsHealingContext, LspHealingContext,
} from "./types.js";
import { extractRawSignatures, detectSignatureRegression, isToxicType } from "./ttrd.js";
import { attemptAutoHealing, attemptLspAutoHealing } from "./healer.js";
import { countErrors, errorsBeyondBaseline, type ErrorBaseline } from "./error-baseline.js";
import { formatErrorList } from "./error-format.js";

export { AsyncMutex } from "./mutex.js";
export type {
    NrekiStructuredError, NrekiEdit, TypeRegression,
    NrekiInterceptResult, NrekiMode, PreEditContract, LspDependentsCoverage,
} from "./types.js";



// ─── NREKI Kernel ─────────────────────────────────────────────────
//
// Cross-file semantic and syntactic verification for AI coding agents.
// Uses the TypeScript Compiler API with a Virtual File System in RAM.
// Validates edits before they touch disk. Rolls back on failure.
//
// @author Jherson Eddie Tintaya Holguin (Ruso-0)


/**
 * LineMap — precomputes newline offsets for O(1) line extraction.
 * Used by predictBlastRadius to avoid O(N × refs) split operations.
 * Cached per ts.SourceFile via WeakMap (auto-invalidated on rebuild).
 */
/**
 * Thrown by commitToDisk() when a file changed on disk between the moment the
 * edit was computed and the commit (IDE save, formatter, another agent).
 * Nothing is written (NREKI-INT-03).
 */
export class NrekiConflictError extends Error {
    constructor(public readonly files: string[]) {
        super(
            `[NREKI] CONFLICT: ${files.join(", ")} changed on disk while NREKI was validating the edit ` +
            `(external editor, formatter or another agent). Nothing was written. Re-read the file(s) and retry.`,
        );
        this.name = "NrekiConflictError";
    }
}

/** Paths NREKI must never write as a side effect of auto-heal. */
const HEAL_FORBIDDEN_SEGMENT = /(?:^|[\\/])(?:node_modules|\.git|\.nreki)(?:[\\/]|$)/i;
/** Legit WAL backups are always <8 hex>.bak directly inside .nreki/transactions. */
const WAL_BACKUP_NAME = /^[0-9a-f]{8}\.bak$/;

/** True when `pid` names a live process other than this one. */
function isLiveForeignPid(pid: unknown): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

class LineMap {
    private offsets: number[];
    constructor(text: string) {
        this.offsets = [0];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') this.offsets.push(i + 1);
        }
    }
    getLine(lineNum: number, text: string): string {
        if (lineNum < 0 || lineNum >= this.offsets.length) return "";
        const start = this.offsets[lineNum];
        const end = this.offsets[lineNum + 1] ?? text.length;
        return text.slice(start, end).replace(/\n$/, '');
    }
}

export class NrekiKernel {
    private projectRoot!: string;
    private vfs = new Map<string, string | null>();
    private vfsDirectories = new Set<string>();
    private vfsClock = new Map<string, Date>();
    private logicalTime = Date.now();

    private mutex = new AsyncMutex();
    private compilerOptions!: ts.CompilerOptions;
    private rootNames!: Set<string>;
    // Exposed for test access (JIT holography tests use (kernel as any).host)
    public host!: ts.CompilerHost;
    private booted = false;
    private _healingStats = { applied: 0, failed: 0 };

    /** Read-only view of healing statistics. */
    public get healingStats(): Readonly<{ applied: number; failed: number }> {
        return { applied: this._healingStats.applied, failed: this._healingStats.failed };
    }
    private mutatedFiles = new Set<string>();
    private bootErrorCount: number = -1;

    /**
     * Monotonic per-file version for content that lives on DISK (not in the
     * VFS). Bumped whenever NREKI itself changes a file on disk (commit,
     * undo). Without it getScriptVersion() fell back to a constant "1" after
     * commitToDisk() cleared vfsClock, so a LanguageService that had cached the
     * pre-edit snapshot at version "1" kept serving it (NREKI-ROB-02).
     */
    private diskVersions = new Map<string, number>();
    private diskVersionCounter = 0;

    /** Digest of the on-disk content each pending edit was based on (NREKI-INT-03). */
    private diskExpectations = new Map<string, string>();

    // ─── LSP Sidecars (Go, Python — async child processes) ────
    private lspSidecars = new Map<string, LspSidecarBase>();
    /** Dependents (same package + importers) a sidecar opens per edit, at most. */
    public static readonly LSP_DEPENDENT_CAP = 50;
    private tsBuildInfoPath!: string;

    // ─── TypeScript Compiler Wrapper ──────────────────────────
    // Direct composition. No polymorphic interface. The kernel
    // owns the VFS + ACID; the wrapper encapsulates TS API brujería.
    private tsBackend = new TsCompilerWrapper();

    // Performance Modes
    public mode: "file" | "project" | "hologram" = "project";

    /** Max file size for JIT classification. Files larger than this are
     *  skipped to prevent synchronous event loop blocking during
     *  TypeScript's module resolution (readFileSync + Tree-sitter parse). */
    private static readonly JIT_MAX_FILE_SIZE = 150_000; // 150KB

    // ─── Hologram mode ─────────────────────────────────
    private prunedFiles = new Set<string>();
    private shadowContent = new Map<string, string>();  // tsPath -> .d.ts content
    private ambientFiles: string[] = [];
    private currentEditTargets = new Set<string>();
    // O(1) pre-computed lookups (built once in setShadows, rebuilt after harvest)
    private shadowDtsLookup = new Set<string>();   // .d.ts paths that exist as shadows
    private prunedTsLookup = new Set<string>();    // .ts paths that are hidden

    // ─── JIT Holography (v6.1) ─────────────────────────────────
    // On-demand shadow generation: no upfront scan needed
    private jitMode = false;           // true when booting without pre-computed shadows
    private jitParser?: Parser;        // web-tree-sitter Parser instance
    private jitTsLanguage?: Parser.Language; // web-tree-sitter Language for TypeScript
    private jitClassifiedCache = new Set<string>();  // tsPath → already classified
    private jitClassifyFn?: (filePath: string, content: string, parser: Parser, lang: Parser.Language) => { prunable: boolean; shadow: string | null };
    /** v10.5.2: cache LineMaps per SourceFile to avoid O(N × refs) splits in predictBlastRadius. */
    private lineMapCache = new WeakMap<ts.SourceFile, LineMap>();

    // P26: POSIX normalization — delegates to shared utility
    private toPosix(p: string): string { return toPosixUtil(p); }

    // P30: Only TypeScript-compatible files enter rootNames
    private isTypeScriptFile(filePath: string): boolean {
        // A-05: Specific patterns (d.ts) before general (tsx?) to avoid shadowing
        if (/\.(d\.ts|d\.mts|d\.cts|tsx?|mts|cts)$/i.test(filePath)) return true;
        // AUDIT FIX: Only allow JS files if tsconfig.json explicitly enables allowJs
        if (this.compilerOptions?.allowJs && /\.(jsx?|mjs|cjs)$/i.test(filePath)) return true;
        return false;
    }

    /**
     * Convierte una posición LSP (Línea, Carácter 0-indexed)
     * a un índice absoluto de string. Sobrevive \r\n (Windows).
     */
    private getLspOffset(content: string, line: number, character: number): number {
        let offset = 0;
        for (let currentLine = 0; currentLine < line; currentLine++) {
            const nl = content.indexOf('\n', offset);
            // LSP spec: a line past the end of the document means end of document.
            if (nl === -1) return content.length;
            offset = nl + 1;
        }
        // LSP spec: a character past the end of the line means end of line
        // (never spill into the next line, never split a \r\n pair).
        let lineEnd = content.indexOf('\n', offset);
        if (lineEnd === -1) lineEnd = content.length;
        else if (lineEnd > offset && content[lineEnd - 1] === '\r') lineEnd--;
        return Math.min(offset + Math.max(0, character), lineEnd);
    }

    // ─── Path policy helpers ──────────────────────────────────────────

    /**
     * May NREKI write `filePath` as a SIDE EFFECT (auto-heal)? Requires the
     * real path to stay inside the project (symlink-aware), not be a sensitive
     * file (.env, .git/hooks, .claude/settings.json…), and not live under
     * node_modules/.git/.nreki (NREKI-SEC-02).
     */
    private isHealWritable(filePath: string): boolean {
        try {
            const resolved = safePath(this.projectRoot, filePath);
            if (HEAL_FORBIDDEN_SEGMENT.test(path.relative(this.projectRoot, resolved))) return false;
            // A collateral file (not in this transaction's VFS) is read from disk
            // with the lenient decoder: a Latin-1 / UTF-16 file would be written
            // back with U+FFFD. Heal only files NREKI can round-trip (I-03, INT-07).
            if (!this.vfs.has(this.toPosix(resolved)) && fs.existsSync(resolved)) readSourceForEdit(resolved);
            return true;
        } catch {
            return false;
        }
    }

    /** Validate a commit target: inside the project (symlink-aware) and not sensitive. */
    private assertCommitTarget(osPath: string): void {
        safePath(this.projectRoot, osPath);
    }

    private bumpDiskVersion(posixPath: string): void {
        this.diskVersions.set(posixPath, ++this.diskVersionCounter);
    }

    /**
     * Record the disk state a pending edit is based on. An explicit
     * baseContent (what the caller actually read) always wins; otherwise the
     * current disk content is captured once.
     */
    private captureDiskExpectation(posixPath: string, baseContent?: string | null): void {
        if (baseContent !== undefined) {
            this.diskExpectations.set(posixPath, contentDigest(baseContent));
            return;
        }
        if (this.diskExpectations.has(posixPath)) return;
        let base: string | null;
        try { base = readSource(path.normalize(posixPath)); } catch { base = null; }
        this.diskExpectations.set(posixPath, contentDigest(base));
    }

    /** Files whose disk content no longer matches what the edit was computed from. */
    private findDiskConflicts(files: Iterable<string>): string[] {
        const conflicts: string[] = [];
        for (const posixPath of files) {
            const expected = this.diskExpectations.get(posixPath);
            if (expected === undefined) continue;
            let current: string | null;
            try { current = readSource(path.normalize(posixPath)); } catch { current = null; }
            if (contentDigest(current) !== expected) {
                conflicts.push(path.relative(this.projectRoot, posixPath).replace(/\\/g, "/"));
            }
        }
        return conflicts;
    }

    /**
     * Crash recovery from .nreki/transactions/wal.json.
     *
     * The WAL lives inside the repository, so it is UNTRUSTED input: a cloned
     * repo can ship one. Every entry is validated before touching the disk
     * (NREKI-SEC-01): backups must be <8hex>.bak regular files directly inside
     * the transactions dir, targets must resolve (symlink-aware) inside the
     * project, must not be sensitive and must not live under .git/.nreki.
     * A WAL owned by another live NREKI process is left alone (it is
     * mid-commit), as is its transactions directory.
     */
    private recoverFromWal(): void {
        const txDir = path.join(this.projectRoot, ".nreki", "transactions");
        if (!fs.existsSync(txDir)) return;
        let keepTxDir = false;

        // One WAL per committing process (wal-<pid>.json) so concurrent NREKI
        // instances never recover or delete each other's log; "wal.json" is the
        // pre-12.1.0 name.
        let walFiles: string[] = [];
        try {
            walFiles = fs.readdirSync(txDir).filter(n => /^wal(?:-\d+)?\.json$/.test(n));
        } catch { /* unreadable dir: nothing to recover */ }

        for (const name of walFiles) {
            const walPath = path.join(txDir, name);
            try {
                const wal = JSON.parse(fs.readFileSync(walPath, "utf-8")) as {
                    status?: unknown; pid?: unknown; files?: unknown;
                };
                if (wal && wal.status === "pending" && Array.isArray(wal.files)) {
                    if (isLiveForeignPid(wal.pid)) {
                        keepTxDir = true;
                        logger.warn(`WAL ${name} belongs to live process ${String(wal.pid)} (another NREKI is committing). Recovery skipped.`);
                        continue;
                    }
                    logger.warn(`WAL recovery: restoring ${wal.files.length} file(s) from crashed transaction`);
                    for (const entry of wal.files as Array<{ target?: unknown; backup?: unknown }>) {
                        // Per-entry try-catch: one failed restore must not abort the rest.
                        try {
                            this.recoverWalEntry(entry, txDir);
                        } catch (entryErr) {
                            logger.error(`WAL recovery failed for ${String(entry?.target)}: ${entryErr}`);
                        }
                    }
                }
                fs.unlinkSync(walPath);
            } catch (walErr) {
                logger.error(`WAL recovery failed: ${walErr}`);
            }
        }
        if (!keepTxDir) {
            try { fs.rmSync(txDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    }

    private recoverWalEntry(entry: { target?: unknown; backup?: unknown }, txDir: string): void {
        if (!entry || typeof entry.target !== "string" || entry.target.length === 0) {
            throw new Error("malformed entry");
        }
        // Throws on traversal, symlink escape and sensitive targets.
        const target = safePath(this.projectRoot, entry.target);
        if (/(?:^|[\\/])(?:\.git|\.nreki)(?:[\\/]|$)/i.test(path.relative(this.projectRoot, target))) {
            throw new Error("refusing target inside .git/.nreki");
        }

        if (entry.backup === null || entry.backup === undefined) {
            // File was newly created in the crashed tx — remove it.
            if (fs.existsSync(target)) fs.unlinkSync(target);
            return;
        }
        if (typeof entry.backup !== "string") throw new Error("malformed backup");

        const backup = safePath(this.projectRoot, entry.backup);
        const sameDir = process.platform === "win32"
            ? path.dirname(backup).toLowerCase() === path.resolve(txDir).toLowerCase()
            : path.dirname(backup) === path.resolve(txDir);
        if (!sameDir || !WAL_BACKUP_NAME.test(path.basename(backup))) {
            throw new Error(`refusing backup outside the transactions directory: ${entry.backup}`);
        }
        if (!fs.existsSync(backup)) return;
        if (!fs.lstatSync(backup).isFile()) throw new Error("backup is not a regular file");
        fs.renameSync(backup, target);
    }

    /**
     * TTRD Sintáctico - Micro-Scanner Híbrido (O(N), Cero dependencias).
     * Extrae firmas de Python y Go crudas del VFS a prueba de
     * formateadores (Black/Ruff/gofmt) y strings embebidos.
     * Usa Regex SOLO para anclar el inicio (def/func), y un
     * Bracket Balancer para parsear el interior.
     */
    // DRY: Config loading delegated to backend (Strangler Fig Phase 2A).
    // Kernel copies references after the call. All 32 usages of this.rootNames
    // and 13 usages of this.compilerOptions continue working unchanged.
    private initConfig(): void {
        this.tsBackend.initConfig(this.projectRoot);
        this.compilerOptions = this.tsBackend.compilerOptions;
        this.rootNames = this.tsBackend.rootNames;
        this.tsBuildInfoPath = this.tsBackend.tsBuildInfoPath;
    }

    /** Validate cache against current TS version. Returns true if cache is usable. */
    private validateBuildInfoCache(): boolean {
        const versionFile = path.join(path.dirname(this.tsBuildInfoPath), "ts-version");
        try {
            if (!fs.existsSync(this.tsBuildInfoPath)) return false;
            if (!fs.existsSync(versionFile)) {
                fs.unlinkSync(this.tsBuildInfoPath);
                return false;
            }
            const cached = fs.readFileSync(versionFile, "utf-8").trim();
            if (cached !== ts.version) {
                fs.unlinkSync(this.tsBuildInfoPath);
                logger.warn(`TS version changed (${cached} -> ${ts.version}). Cache purged.`);
                return false;
            }
            return true;
        } catch {
            return false; // First boot or corrupted cache
        }
    }

    /** Write TS version guard file alongside the cache. */
    private writeTsVersionGuard(): void {
        const dir = path.dirname(this.tsBuildInfoPath);
        const versionFile = path.join(dir, "ts-version");
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(versionFile, ts.version, "utf-8");
        } catch { /* Non-fatal */ }
    }

    /**
     * Boot the kernel. Applies CompilerHost overrides for VFS I/O.
     * Cost: ~5-10s for initial semantic graph. Runs in background.
     */
    public boot(workspacePath: string, mode?: "file" | "project" | "hologram"): void {
        if (this.booted) throw new Error("[NREKI] Kernel already booted");
        if (mode) this.mode = mode;
        logger.info(`Booting VFS-LSP Kernel (${this.mode} mode). Applying CompilerHost overrides...`);
        this.projectRoot = this.toPosix(path.resolve(workspacePath));
        // D2: WAL-aware crash recovery. Runs FIRST so tsconfig, the program and
        // the baseline are all built from the recovered disk state.
        this.recoverFromWal();
        this.initConfig();

        // Hologram mode: override rootNames and compilerOptions
        if (this.mode === "hologram") {
            if (this.hasJitHologram() && this.prunedFiles.size === 0) {
                // JIT mode: no pre-computed shadows. Keep only .d.ts/.d.mts/.d.cts from rootNames.
                this.jitMode = true;
                this.rootNames = new Set(
                    [...this.rootNames].filter(f => /\.d\.[mc]?ts$/i.test(f)),
                );
                logger.info(`JIT Holography active. rootNames: ${this.rootNames.size} (.d.ts only). Shadows on-demand.`);
            } else {
                // Eager mode: pre-computed shadows available
                this.jitMode = false;
                const ambientSet = new Set(
                    this.ambientFiles.map(f => this.toPosix(path.resolve(this.projectRoot, f))),
                );
                this.rootNames = new Set(
                    [...this.rootNames].filter(f => ambientSet.has(f)),
                );
            }
            // CompilerOptions: always set for hologram
            this.compilerOptions.noEmit = false;
            this.compilerOptions.declaration = true;
            this.compilerOptions.emitDeclarationOnly = true;
            this.compilerOptions.isolatedModules = false;
            // Sync filtered rootNames back to backend (hologram creates new Set)
            this.tsBackend.rootNames = this.rootNames;
        }

        // ─── Delegate CompilerHost creation to backend (Strangler Fig 2B) ───
        // The kernel creates VfsAdapter closures over its own state.
        // The backend uses them to create CompilerHost + LanguageService.
        // VFS, hologram, JIT state stay in the kernel. Always.
        const self = this;
        const vfsAdapter: import("./backends/ts-compiler-wrapper.js").VfsAdapter = {
            readFile(fileName: string): string | undefined {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));

                // HOLOGRAM INTERCEPT: serve shadow .d.ts or hide pruned .ts
                if (self.mode === "hologram") {
                    if (/\.d\.[mc]?ts$/i.test(fileName)) {
                        const tsPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1ts");
                        const shadow = self.shadowContent.get(tsPath);
                        if (shadow !== undefined) return shadow;
                        const tsxPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1tsx");
                        const shadow2 = self.shadowContent.get(tsxPath);
                        if (shadow2 !== undefined) return shadow2;
                        if (self.jitMode) {
                            if (!self.jitClassifiedCache.has(tsPath)) {
                                self.jitClassifyFile(tsPath);
                                const shadowJ = self.shadowContent.get(tsPath);
                                if (shadowJ !== undefined) return shadowJ;
                            }
                            if (!self.jitClassifiedCache.has(tsxPath)) {
                                self.jitClassifyFile(tsxPath);
                                const shadowJ2 = self.shadowContent.get(tsxPath);
                                if (shadowJ2 !== undefined) return shadowJ2;
                            }
                        }
                    }
                    if (self.prunedTsLookup.has(posixPath) && !self.currentEditTargets.has(posixPath)) {
                        // FIX: Check VFS FIRST. A pruned file that was edited in a prior
                        // transaction has real content in RAM that the compiler must see.
                        if (self.vfs.has(posixPath)) {
                            const content = self.vfs.get(posixPath);
                            return content === null ? undefined : content;
                        }
                        return undefined;
                    }
                }

                if (self.vfs.has(posixPath)) {
                    const content = self.vfs.get(posixPath);
                    return content === null ? undefined : content;
                }
                if (isSensitivePath(posixPath)) {
                    return undefined;
                }
                // Fallback to disk via backend's original readFile
                return self.tsBackend.originalReadFile.call(self.tsBackend.host, fileName);
            },

            fileExists(fileName: string): boolean {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));
                // Consistent with readFile(): sensitive files do not exist for the compiler.
                if (isSensitivePath(posixPath)) return false;

                if (self.mode === "hologram") {
                    if (self.currentEditTargets.has(posixPath)) {
                        return self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName);
                    }
                    if (self.prunedTsLookup.has(posixPath)) return false;
                    if (self.shadowDtsLookup.has(posixPath)) return true;

                    if (self.jitMode) {
                        if (/\.tsx?$/.test(fileName) && !/\.d\.[mc]?ts$/i.test(fileName)) {
                            if (self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName)) {
                                self.jitClassifyFile(posixPath);
                                if (self.prunedTsLookup.has(posixPath)) return false;
                            }
                        }
                        if (/\.d\.[mc]?ts$/i.test(fileName)) {
                            const tsPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1ts");
                            const tsxPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1tsx");
                            if (!self.jitClassifiedCache.has(tsPath) && self.tsBackend.originalFileExists.call(self.tsBackend.host, tsPath)) {
                                if (self.jitClassifyFile(tsPath)) return true;
                            }
                            if (!self.jitClassifiedCache.has(tsxPath) && self.tsBackend.originalFileExists.call(self.tsBackend.host, tsxPath)) {
                                if (self.jitClassifyFile(tsxPath)) return true;
                            }
                        }
                    }
                }

                if (self.vfs.has(posixPath)) return self.vfs.get(posixPath) !== null;
                return self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName);
            },

            getModifiedTime(fileName: string): Date {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));
                if (self.vfsClock.has(posixPath)) return self.vfsClock.get(posixPath)!;
                return ts.sys.getModifiedTime?.(fileName) ?? new Date();
            },

            directoryExists(dirName: string): boolean {
                const posixDir = self.toPosix(path.resolve(self.projectRoot, dirName));
                if (ts.sys.directoryExists(dirName)) return true;
                return self.vfsDirectories.has(posixDir);
            },

            getScriptVersion(fileName: string): string {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));
                const staged = self.vfsClock.get(posixPath);
                if (staged) return staged.getTime().toString();
                // Disk-backed content: monotonic per file, bumped on every NREKI write.
                return `d${self.diskVersions.get(posixPath) ?? 0}`;
            },

            getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
                const posixPath = self.toPosix(path.resolve(self.projectRoot, fileName));

                // HOLOGRAM INTERCEPT for LanguageService
                if (self.mode === "hologram" && /\.d\.[mc]?ts$/i.test(fileName)) {
                    const tsPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1ts");
                    const shadow = self.shadowContent.get(tsPath);
                    if (shadow !== undefined) return ts.ScriptSnapshot.fromString(shadow);
                    const tsxPath = posixPath.replace(/\.d\.([mc]?)ts$/i, ".$1tsx");
                    const shadow2 = self.shadowContent.get(tsxPath);
                    if (shadow2 !== undefined) return ts.ScriptSnapshot.fromString(shadow2);
                }

                if (self.vfs.has(posixPath)) {
                    const content = self.vfs.get(posixPath);
                    if (content === null || content === undefined) return undefined;
                    return ts.ScriptSnapshot.fromString(content);
                }
                // NREKI-SEC-05: the LanguageService reads through here, not readFile().
                if (isSensitivePath(posixPath)) return undefined;
                if (!self.tsBackend.originalFileExists.call(self.tsBackend.host, fileName)) return undefined;
                const content = self.tsBackend.originalReadFile.call(self.tsBackend.host, fileName);
                if (!content) return undefined;
                return ts.ScriptSnapshot.fromString(content);
            },
        };

        this.tsBackend.createCompilerInfra(this.projectRoot, vfsAdapter);

        // Sync host reference for test access (JIT holography tests)
        this.host = this.tsBackend.host;
        // ──────────────────────────────────────────────────────────────

        // Incremental cache: delegate to backend
        if (this.validateBuildInfoCache()) {
            try {
                const readBuildHost: ts.ReadBuildProgramHost = {
                    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
                    getCurrentDirectory: () => this.projectRoot,
                    readFile: (fileName: string) => {
                        if (fileName.endsWith(".tsbuildinfo")) {
                            return ts.sys.readFile(fileName);
                        }
                        return this.tsBackend.host.readFile(fileName);
                    },
                };
                const oldProgram = ts.readBuilderProgram(
                    this.tsBackend.compilerOptions, readBuildHost
                ) as ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined;
                if (oldProgram) {
                    this.tsBackend._injectBuilderProgram(oldProgram);
                }
            } catch {
                // Corrupted cache, cold boot — backend starts fresh
            }
        }

        this.tsBackend.updateProgram();
        // Hologram/file mode: skip boot baseline - JIT baseline in interceptAtomicBatch
        // handles it scoped to target files.
        if (this.mode === "project") {
            this.tsBackend.captureBaseline(undefined, this.mode);
        }

        // Capture initial error count at boot (immutable after this point)
        this.bootErrorCount = this.getBaselineErrorCount();

        this.booted = true;
        // Log backend info for diagnostics
        logger.info(`Backend: ${this.tsBackend.name} (healing: ${this.tsBackend.capabilities.supportsAutoHealing}, ttrd: ${this.tsBackend.capabilities.supportsTTRD})`);
        logger.info(
            `Kernel booted. Tracking ${this.rootNames.size} files. ` +
            `Baseline: ${this.tsBackend.baselineCount} invariants. ` +
            `Boot errors: ${this.bootErrorCount}.`
        );
    }

    public isBooted(): boolean {
        return this.booted;
    }

    /**
     * Project-relative POSIX paths of the program's files that import `files`,
     * resolved by the compiler (aliases included). null: not available.
     */
    public async findTypeScriptImporters(files: string[]): Promise<string[] | null> {
        if (!this.booted || files.length === 0) return null;
        return this.mutex.withLock(async () => {
            try {
                this.tsBackend.updateProgram();
                const targets = new Set(files.map(f => this.toPosix(path.resolve(this.projectRoot, f))));
                const found = this.tsBackend.importersOf(targets);
                return found ? found.map(f => this.toPosix(path.relative(this.projectRoot, f))) : null;
            } catch {
                return null;
            }
        });
    }

    // ─── TTRD: Temporal Type Regression Detection ─────────────────────

    /**
     * Extract the compiler's resolved type for each locally-declared export.
     * Uses TypeChecker to read resolved types, not AST text.
     * Cost: O(K) where K = exports in the given files only.
     */
    // extractCanonicalTypes moved to backend (Strangler Fig Act 4)

    /**
     * Check if a type string contains toxic type patterns.
     * Uses word boundaries to avoid false positives on identifiers
     * like "Company" or "ManyToMany".
     *
     * Shared with file fragility tracker via static method.
     */
    public static isToxicType(typeStr: string): boolean {
        return isToxicType(typeStr);
    }

    /**
     * Walk a ts.Type tree and compute a toxicity score using TypeFlags.
     * No regex. No string matching. Reads bits directly from the TypeChecker.
     *
     * Asymmetric weights:
     *   any = 10 (disables all checking)
     *   unknown = 2 (safe but unresolved)
     *   Function = 5 (callable but untyped)
     *
     * Depth limit prevents CPU freeze on deeply nested types (Prisma, tRPC).
     * Cycle-safe via Set<ts.Type> pointer comparison (TS interns types).
     */
    // getToxicityScoreFromType + computeTypeRegressions moved to backend (Strangler Fig Act 4)

    // ─── NREKI L3.3: Self-Healing Agent Loop ─────────────────────────


    /**
     * SINGLE ENTRY POINT (P21, P22).
     * Atomic batch validation: inject all edits into VFS, evaluate macro-state.
     * Triple shield: Global → Syntactic → Semantic.
     */
    public async interceptAtomicBatch(
        edits: NrekiEdit[],
        dependents: string[] = [],
        computeDiff: boolean = false
    ): Promise<NrekiInterceptResult> {
        if (!this.booted) throw new Error("[NREKI] Kernel not booted");
        if (!edits || edits.length === 0) return { safe: true, exitCode: 0, latencyMs: "0.00" };

        return this.mutex.withLock(async () => {
        // Corruption guard: if a previous timeout left the VFS in a partial state, rebuild
        // Moved inside mutex to prevent concurrent purgeCache() calls.
        if (this.tsBackend.isCorrupted) {
            this.tsBackend.purgeCache();
            logger.warn("Rebuilding after timeout-corrupted state.");
        }
        const txId = crypto.randomBytes(4).toString("hex");
        setTxId(txId);
        logger.info(`interceptAtomicBatch: ${edits.length} file(s)`);
        try {
        const t0 = performance.now();

        const rollbackState = new Map<string, {
            content: string | null | undefined;
            time: Date | undefined;
            wasInRoot: boolean;
        }>();

            // B6: Save logicalTime for rollback
            const savedLogicalTime = this.logicalTime;
            this.logicalTime += 1000;
            const explicitlyEditedFiles = new Set<string>();
            // A-02: Snapshot vfsDirectories for rollback
            const savedDirectories = new Set(this.vfsDirectories);

            // Track which files THIS transaction adds to mutatedFiles.
            // On rollback, only these are removed — preserving prior valid mutations.
            const transactionMutated = new Set<string>();

            // Pre-populate rollback state BEFORE
            // the hologram block modifies rootNames. This captures the TRUE
            // wasInRoot value (false for new files). phase1_injectVfs has a
            // guard (!rollbackState.has) so it won't overwrite this snapshot.
            for (const edit of edits) {
                if (edit.proposedContent !== null) {
                    const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                    if (!rollbackState.has(posixPath)) {
                        rollbackState.set(posixPath, {
                            content: this.vfs.has(posixPath) ? this.vfs.get(posixPath) : undefined,
                            time: this.vfsClock.get(posixPath),
                            wasInRoot: this.rootNames.has(posixPath),
                        });
                    }
                }
            }

            // HOLOGRAM: set currentEditTargets so VFS hooks show them as real .ts
            if (this.mode === "hologram") {
                for (const edit of edits) {
                    if (edit.proposedContent !== null) {
                        const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                        this.currentEditTargets.add(posixPath);
                        // Ensure edited file is in rootNames for hologram lazy subgraph
                        if (this.isTypeScriptFile(posixPath) && !this.rootNames.has(posixPath)) {
                            this.rootNames.add(posixPath);
                        }
                    }
                }
            }

            // TTRD PRE-SCAN: Identify files that will be edited (before VFS mutation)
            for (const edit of edits) {
                if (edit.proposedContent !== null) {
                    const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                    explicitlyEditedFiles.add(posixPath);
                }
            }

            // Importers of Go/Python files go to their LSP sidecar (phase 2.5), in
            // every mode; the rest are TypeScript importers for file/hologram mode.
            const lspDependents: string[] = [];
            const tsDependents: string[] = [];
            for (const dep of dependents) {
                (this.lspSidecars.has(path.extname(dep).toLowerCase()) ? lspDependents : tsDependents).push(dep);
            }

            // TOPOLOGICAL INJECTION: unveil dependents in hologram mode
            const filesToEvaluate = new Set<string>(explicitlyEditedFiles);
            const temporarilyUnveiled = new Set<string>();

            if (this.mode === "file") {
                // NREKI-INT-06: file mode only type-checks the evaluated set. When the
                // caller passes the direct importers of a changed API, check them too
                // (they are already in rootNames; baseline below is scoped to them).
                for (const dep of tsDependents) {
                    filesToEvaluate.add(this.toPosix(path.resolve(this.projectRoot, dep)));
                }
            } else if (this.mode === "hologram") {
                for (const dep of tsDependents) {
                    const posixDep = this.toPosix(path.resolve(this.projectRoot, dep));
                    filesToEvaluate.add(posixDep);
                    if (this.prunedTsLookup.has(posixDep)) {
                        this.prunedTsLookup.delete(posixDep);
                        this.shadowDtsLookup.delete(posixDep.replace(/\.([mc]?)tsx?$/, ".d.$1ts"));
                        if (!this.rootNames.has(posixDep)) {
                            this.rootNames.add(posixDep);
                        }
                        temporarilyUnveiled.add(posixDep);
                    }
                }
            }

            // JIT baseline: recapture baseline scoped to files we will evaluate
            if (this.mode === "hologram" || this.mode === "file") {
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
                this.tsBackend.captureBaseline(filesToEvaluate, this.mode);
                if (this.bootErrorCount === -1) {
                    this.bootErrorCount = this.getBaselineErrorCount();
                }
            }

            // TTRD: Extract pre-mutation type contracts (before VFS injection)
            const preContracts = await this.tsBackend.extractCanonicalTypes(explicitlyEditedFiles);

            // File/hologram mode check the edited files and their direct importers.
            // What the others can see of the edit is compared after it: global
            // declarations in both modes, the emitted .d.ts in file mode.
            const surfaceFiles = new Set([...explicitlyEditedFiles].filter(f => this.isTypeScriptFile(f)));
            const preSurface = (this.mode === "file" || this.mode === "hologram")
                && surfaceFiles.size > 0 && edits.every(e => e.proposedContent !== null)
                ? this.tsBackend.declarationSurface(surfaceFiles, this.mode === "file")
                : null;
            const compareSurface = (): { exportedApiUnchanged?: boolean; declaresGlobals?: boolean; programChanged?: boolean } => {
                const post = preSurface ? this.tsBackend.declarationSurface(surfaceFiles, this.mode === "file") : null;
                if (!preSurface || !post) return {};
                // A file entering or leaving the program (an import added or removed)
                // can change what every other file sees: nothing can be claimed.
                const programChanged = this.mode === "file" && preSurface.programFiles !== post.programFiles;
                let exportedApiUnchanged: boolean | undefined;
                if (preSurface.declarations !== null && post.declarations !== null && !programChanged) {
                    exportedApiUnchanged = preSurface.declarations === post.declarations;
                }
                const declaresGlobals = exportedApiUnchanged !== true && (preSurface.globalScope || post.globalScope);
                return { exportedApiUnchanged, declaresGlobals: declaresGlobals || undefined, programChanged: programChanged || undefined };
            };

            // TTRD SINTÁCTICO PRE-SCAN: Python/Go
            const preRawSignatures = new Map<string, Map<string, string>>();
            const rootPosixTTRD = this.toPosix(path.resolve(this.projectRoot));
            for (const edit of edits) {
                if (edit.proposedContent !== null) {
                    const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
                    // PATH JAIL: Block traversal BEFORE any I/O.
                    // Without this, the LLM can read arbitrary files via targetFile.
                    if (!posixPath.startsWith(rootPosixTTRD + "/") && posixPath !== rootPosixTTRD) {
                        continue; // Phase 1 will throw the security error — skip silently here
                    }
                    const ext = path.extname(posixPath).toLowerCase();
                    if (ext === ".py" || ext === ".go") {
                        const vfsEntry = this.vfs.has(posixPath) ? this.vfs.get(posixPath) : undefined;
                        const oldContent = vfsEntry !== undefined ? (vfsEntry ?? "") : (this.tsBackend.host.readFile(posixPath) ?? "");
                        preRawSignatures.set(posixPath, extractRawSignatures(oldContent, ext));
                    }
                }
            }

            // ─── PRE-MUTATION TOPOLOGY (OPT-IN LATENCY SHIELD) ───
            const isStructuralBatch = computeDiff
                && explicitlyEditedFiles.size > 1
                && this.rootNames.size <= 1000;

            let preTopology: { fiedler?: number; volume: number; nodeCount: number; edgeCount: number; cyclomaticComplexity?: number; activeNodes?: number; v2?: Float64Array; lambda3?: number; v3?: Float64Array; eigenvalues?: number[]; nodeIndex?: Map<string, number> } | undefined;
            if (isStructuralBatch && this.mode === "project" && this.tsBackend.tsProgram) {
                try {
                    const { SpectralTopologist } = await import("./spectral-topology.js");
                    preTopology = SpectralTopologist.analyze(this.tsBackend.tsProgram, this.rootNames);
                } catch { /* silent on hot path */ }
            }

            // Helper DRY: reused in healed path AND clean path
            const computeArchitectureDiff = async (): Promise<string | undefined> => {
                if (!isStructuralBatch || !preTopology
                    || this.mode !== "project" || !this.tsBackend.tsProgram) return undefined;
                try {
                    const { SpectralTopologist } = await import("./spectral-topology.js");
                    const postTopology = SpectralTopologist.analyze(
                        this.tsBackend.tsProgram, this.rootNames);

                    const eulerPre = preTopology.cyclomaticComplexity ?? 0;
                    const eulerPost = postTopology.cyclomaticComplexity ?? 0;
                    const eulerShift = eulerPost - eulerPre;
                    const eulerShiftStr = eulerShift > 0 ? `+${eulerShift}` : `${eulerShift}`;
                    const eulerIcon = eulerShift < 0 ? "📉 (Decoupled)"
                        : eulerShift > 0 ? "🍝 (Tangled)"
                        : "⚖️ (Stable)";

                    const delta = SpectralTopologist.computeDelta(preTopology, postTopology);
                    const preFiedlerTopo = preTopology.fiedler ?? 0;
                    const fiedlerShift = preFiedlerTopo > 0
                        ? ((delta.fiedlerPost - delta.fiedlerPre) / preFiedlerTopo) * 100
                        : 0;
                    const icon = delta.verdict === "APPROVED" ? "✅"
                        : delta.verdict === "APPROVED_DECOUPLING" ? "🚀 DECOUPLED"
                        : "⚠️ FRACTURE RISK";

                    // Combinatorial Laplacian: λ₂ not scale-invariant across different N.
                    // Valid here: pre/post share same rootNames within a batch.
                    return `\n\n**[NREKI ARCHITECTURE DIFF]** *(symbol-level topology)*\n` +
                        `λ₂ (Algebraic Connectivity): ${delta.fiedlerPre.toFixed(4)} → ` +
                        `${delta.fiedlerPost.toFixed(4)} ` +
                        `(${fiedlerShift > 0 ? '+' : ''}${fiedlerShift.toFixed(1)}%) ${icon}\n` +
                        `Circuit Rank β₁: ${eulerPre} → ${eulerPost} ` +
                        `(${eulerShiftStr}) ${eulerIcon}\n` +
                        `Verdict: ${delta.verdict.replace(/_/g, " ")}`;
                } catch { return undefined; }
            };

            // A-01: Wrap Phase 1-4 so partial VFS mutations are rolled back on throw
            // Sidecar edits hoisted for catch-path compensatory rollback
            let sidecarEdits = new Map<LspSidecarBase, Array<{filePath: string; content: string | null}>>();
            try {

            // PHASE 1: Inject entire batch into VFS
            this.phase1_injectVfs(edits, rollbackState, transactionMutated, explicitlyEditedFiles);

            // PHASE 2: Rebuild incremental program
            this.tsBackend.updateProgram();

            // BUG 3 FIXED: Compute AI errors exactly ONCE.
            const originalFatalErrors = await this.tsBackend.getDiagnostics(filesToEvaluate, explicitlyEditedFiles, this.mode);

            // ─── Phase 2.5: LSP Sidecar Validation (Go, Python) ─────────
            const sidecarResult = await this.phase2_validateSidecars(edits, originalFatalErrors, rollbackState, lspDependents);
            sidecarEdits = sidecarResult.sidecarEdits;
            const sidecarWarnings = sidecarResult.sidecarWarnings;
            const degradedLanguages = sidecarResult.degradedLanguages.length > 0
                ? sidecarResult.degradedLanguages : undefined;
            const lspCoverage = sidecarResult.lspCoverage.length > 0
                ? sidecarResult.lspCoverage : undefined;
            // ─── End Phase 2.5 ───────────────────────────────────────────

            // ─── TTRD SINTÁCTICO: Evaluación Post-Mutación ───
            for (const [posixPath, oldSigsMap] of preRawSignatures.entries()) {
                const newContent = this.vfs.get(posixPath) ?? "";
                const ext = path.extname(posixPath).toLowerCase();
                const newSigsMap = extractRawSignatures(newContent, ext);
                for (const [symbol, oldSig] of oldSigsMap.entries()) {
                    const newSig = newSigsMap.get(symbol);
                    if (newSig) {
                        const { isRegression, reason } = detectSignatureRegression(oldSig, newSig, ext);
                        if (isRegression) {
                            sidecarWarnings.push(
                                `[⚠️ TTRD WARNING] Type degradation detected in ${path.basename(posixPath)}::${symbol}().\n  Reason: ${reason}\n  Old: \`${oldSig}\`\n  New: \`${newSig}\``
                            );
                        }
                    }
                }
            }

            // PHASE 4: Verdict
            if (originalFatalErrors.length > 0) {

                // ─── NREKI L3.3: Iterative Auto-Healing (Dual Cascade) ─────────────────
                const tHealStart = performance.now();
                const healing = await this.phase4_healingCascade(
                    originalFatalErrors, explicitlyEditedFiles, filesToEvaluate, transactionMutated,
                    sidecarResult.sidecarBaselines,
                );

                if (healing.healed) {
                    const latency = (performance.now() - t0).toFixed(2);
                    const healLatency = (performance.now() - tHealStart).toFixed(2);

                    // Patch notice: tell the agent what NOT to overwrite in its next edit
                    let extraFilesWarning = "";
                    if (healing.newlyTouchedFiles.size > 0) {
                        const files = Array.from(healing.newlyTouchedFiles)
                            .map(f => path.relative(this.projectRoot, f)).join(", ");
                        extraFilesWarning = `\nWARNING: NREKI also auto-patched collateral files: ${files}. Do NOT revert them.`;
                    }

                    const patchNotice =
                        `\n\nIMPORTANT: NREKI applied these patches automatically.\n` +
                        `Your code on disk already contains these fixes. ` +
                        `Do not revert or overwrite them in your next edit.` +
                        extraFilesWarning;

                    // Group fixes by type for readable output
                    const tsFixes = healing.appliedFixes.filter(f => !f.includes("LSP Auto-Heal"));
                    const lspFixes = healing.appliedFixes.filter(f => f.includes("LSP Auto-Heal"));

                    let fixSummary = "";
                    if (tsFixes.length > 0) {
                        fixSummary += `\n  TypeScript (CodeFix API):\n${tsFixes.join("\n")}`;
                    }
                    if (lspFixes.length > 0) {
                        fixSummary += `\n  Go/Python (LSP codeAction):\n${lspFixes.join("\n")}`;
                    }

                    // TTRD post-contracts (healed path)
                    const finalEditedFiles = new Set(explicitlyEditedFiles);
                    for (const f of healing.newlyTouchedFiles) finalEditedFiles.add(f);
                    const postContracts = await this.tsBackend.extractCanonicalTypes(finalEditedFiles);
                    const regressions = this.tsBackend.computeTypeRegressions(preContracts, postContracts);
                    // The healer also edited other files: never claim an unchanged API here.
                    const { declaresGlobals, programChanged } = compareSurface();

                    this.restoreHologramVeil(temporarilyUnveiled);

                    const architectureDiff = await computeArchitectureDiff();

                    return {
                        safe: true,
                        exitCode: 0,
                        latencyMs: latency,
                        healedFiles: Array.from(healing.newlyTouchedFiles),
                        errorText:
                            `[NREKI AUTO-HEAL: ${healLatency}ms] ` +
                            `Your code had structural errors. NREKI applied deterministic fixes in RAM:\n` +
                            fixSummary +
                            patchNotice,
                        regressions: regressions.length > 0 ? regressions : undefined,
                        postContracts: postContracts.size > 0
                            ? new Map([...postContracts].map(([file, syms]) =>
                                [file, new Map([...syms].map(([sym, contract]) => [sym, contract.typeStr]))]
                              ))
                            : undefined,
                        warnings: sidecarWarnings.length > 0 ? sidecarWarnings : undefined,
                        architectureDiff,
                        degradedLanguages,
                        lspCoverage,
                        declaresGlobals,
                        programChanged,
                    };
                }
                // ─── END Auto-Healing ────────────────────────────────────

                // Healing failed. Use the ORIGINAL error matrix (do not recalculate).
                const structured = originalFatalErrors; // Already NrekiStructuredError[]

                // ACID rollback of the original edit
                for (const [posixPath, state] of rollbackState.entries()) {
                    if (state.content !== undefined) this.vfs.set(posixPath, state.content);
                    else this.vfs.delete(posixPath);

                    if (state.time) this.vfsClock.set(posixPath, state.time);
                    else this.vfsClock.delete(posixPath);

                    if (state.wasInRoot) this.rootNames.add(posixPath);
                    else this.rootNames.delete(posixPath);
                }
                // Compensatory rollback: restore sidecar VFS to pre-transaction state
                // Without this, the LSP's internal VFS retains the rejected
                // edit and future validations run against a phantom state.
                await this.rollbackSidecars(sidecarEdits, rollbackState);

                // Remove this transaction's files from mutatedFiles
                // to prevent ghost deletion in the next commitToDisk().
                for (const file of transactionMutated) {
                    this.mutatedFiles.delete(file);
                    this.diskExpectations.delete(file);
                }

                // B6: Restore logicalTime on rollback
                this.logicalTime = savedLogicalTime;
                // A-02: Restore vfsDirectories
                this.vfsDirectories = savedDirectories;
                // FIX: Clear hologram edit targets to prevent ghost unpruning
                this.currentEditTargets.clear();
                // P17 + P2 WARM-PATH: Advance clock instead of destroying program.
                this.logicalTime += 1000;
                for (const [posixPath] of rollbackState.entries()) {
                    this.vfsClock.set(posixPath, new Date(this.logicalTime));
                }
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend

                const latency = (performance.now() - t0).toFixed(2);
                latencyTracker.record("intercept", parseFloat(latency));

                this.restoreHologramVeil(temporarilyUnveiled);

                return {
                    safe: false, exitCode: 2, latencyMs: latency, structured,
                    errorText:
                        `[Edit rejected - ${latency}ms] Atomic transaction aborted. ` +
                        `${originalFatalErrors.length} violation(s) detected in RAM.\n` +
                        formatErrorList(structured, {
                            isPrimary: (e) => explicitlyEditedFiles.has(this.toPosix(path.resolve(this.projectRoot, e.file))),
                        }) +
                        `\nACTION: Disk untouched. Fix the code and retry.`,
                };
            }

            // TTRD post-contracts (clean path)
            const postContracts = await this.tsBackend.extractCanonicalTypes(explicitlyEditedFiles);
            const regressions = this.tsBackend.computeTypeRegressions(preContracts, postContracts);

            // Same declarations and same program files: nothing beyond the checked
            // files can change. Otherwise the footer asks for tsc.
            const surface = compareSurface();

            this.restoreHologramVeil(temporarilyUnveiled);

            const architectureDiff = await computeArchitectureDiff();

            return {
                safe: true,
                exitCode: 0,
                latencyMs: (() => { const l = (performance.now() - t0).toFixed(2); latencyTracker.record("intercept", parseFloat(l)); return l; })(),
                regressions: regressions.length > 0 ? regressions : undefined,
                postContracts: postContracts.size > 0
                    ? new Map([...postContracts].map(([file, syms]) =>
                        [file, new Map([...syms].map(([sym, contract]) => [sym, contract.typeStr]))]
                      ))
                    : undefined,
                warnings: sidecarWarnings.length > 0 ? sidecarWarnings : undefined,
                architectureDiff,
                degradedLanguages,
                lspCoverage,
                ...surface,
            };

            } catch (phaseError) {
                // A-01: Rollback partial VFS mutations from Phase 1 on any throw
                for (const [posixPath, state] of rollbackState.entries()) {
                    if (state.content !== undefined) this.vfs.set(posixPath, state.content);
                    else this.vfs.delete(posixPath);
                    if (state.time) this.vfsClock.set(posixPath, state.time);
                    else this.vfsClock.delete(posixPath);
                    if (state.wasInRoot) this.rootNames.add(posixPath);
                    else this.rootNames.delete(posixPath);
                }
                // Compensatory rollback on crash path: restore sidecar VFS
                await this.rollbackSidecars(sidecarEdits, rollbackState);

                // Remove this transaction's files from mutatedFiles (crash path)
                for (const file of transactionMutated) {
                    this.mutatedFiles.delete(file);
                    this.diskExpectations.delete(file);
                }

                // A-02: Restore vfsDirectories
                this.vfsDirectories = savedDirectories;
                this.logicalTime = savedLogicalTime;
                // FIX: Clear hologram edit targets to prevent ghost unpruning
                this.currentEditTargets.clear();
                this.restoreHologramVeil(temporarilyUnveiled);
                // FIX: Poison the compiler cache to force cold rebuild.
                // Without this, the TypeScript BuilderProgram retains state
                // from the failed transaction, causing phantom errors on
                // the next interceptAtomicBatch call.
                this.tsBackend.purgeCache(true);
                throw phaseError;
            }
        } finally {
            clearTxId();
        }
        });
    }

    // ─── Extracted Phases (v8.3) ──────────────────────────────────────

    private phase1_injectVfs(
        edits: NrekiEdit[],
        rollbackState: Map<string, { content: string | null | undefined; time: Date | undefined; wasInRoot: boolean }>,
        transactionMutated: Set<string>,
        explicitlyEditedFiles: Set<string>,
    ): void {
        for (const edit of edits) {
            const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
            const rootPosix = this.toPosix(path.resolve(this.projectRoot));

            if (!posixPath.startsWith(rootPosix + "/") && posixPath !== rootPosix) {
                throw new Error(
                    `[NREKI] Security rejection: Path traversal blocked. ` +
                    `"${edit.targetFile}" resolves outside project root.`
                );
            }

            const currentlyInRoots = this.rootNames.has(posixPath);

            if (!rollbackState.has(posixPath)) {
                rollbackState.set(posixPath, {
                    content: this.vfs.has(posixPath) ? this.vfs.get(posixPath) : undefined,
                    time: this.vfsClock.get(posixPath),
                    wasInRoot: currentlyInRoots,
                });
            }

            // INT-03: remember which disk state this edit was computed from.
            this.captureDiskExpectation(posixPath, edit.baseContent);

            this.vfs.set(posixPath, edit.proposedContent);
            this.vfsClock.set(posixPath, new Date(this.logicalTime));
            if (!this.mutatedFiles.has(posixPath)) transactionMutated.add(posixPath);
            this.mutatedFiles.add(posixPath);

            if (edit.proposedContent === null) {
                this.rootNames.delete(posixPath);
            } else {
                explicitlyEditedFiles.add(posixPath);
                if (!currentlyInRoots && this.isTypeScriptFile(posixPath)) {
                    this.rootNames.add(posixPath);
                }
                let dir = path.posix.dirname(posixPath);
                const rootPosixDir = this.toPosix(path.resolve(this.projectRoot));
                while (dir.length >= rootPosixDir.length && dir !== rootPosixDir && dir !== ".") {
                    this.vfsDirectories.add(dir);
                    dir = path.posix.dirname(dir);
                }
            }
        }
    }

    private async phase2_validateSidecars(
        edits: NrekiEdit[],
        originalFatalErrors: NrekiStructuredError[],
        rollbackState: ReadonlyMap<string, { content: string | null | undefined }>,
        lspDependents: readonly string[] = [],
    ): Promise<{
        sidecarEdits: Map<LspSidecarBase, Array<{ filePath: string; content: string | null }>>;
        sidecarWarnings: string[];
        degradedLanguages: string[];
        sidecarBaselines: Map<LspSidecarBase, ErrorBaseline>;
        lspCoverage: LspDependentsCoverage[];
    }> {
        const sidecarEdits = new Map<LspSidecarBase, Array<{ filePath: string; content: string | null }>>();
        // The same files at their content BEFORE this transaction (baseline input).
        const preEdit = new Map<LspSidecarBase, Array<{ filePath: string; content: string | null }>>();
        const sidecarBaselines = new Map<LspSidecarBase, ErrorBaseline>();
        const sidecarWarnings: string[] = [];
        const degradedLanguages: string[] = [];
        const lspCoverage: LspDependentsCoverage[] = [];

        for (const edit of edits) {
            const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.targetFile));
            const ext = path.extname(posixPath).toLowerCase();
            const sidecar = this.lspSidecars.get(ext);
            if (!sidecar) continue;
            const list = sidecarEdits.get(sidecar) || [];
            list.push({ filePath: posixPath, content: edit.proposedContent });
            sidecarEdits.set(sidecar, list);
            // A deletion is not opened just to be measured: it stays a no-op for
            // a file the server never had open.
            if (edit.proposedContent === null) continue;
            const staged = rollbackState.get(posixPath)?.content;
            const before = staged !== undefined ? staged
                : edit.baseContent !== undefined ? edit.baseContent
                : this.diskContentOrNull(posixPath);
            const pre = preEdit.get(sidecar) || [];
            pre.push({ filePath: posixPath, content: before });
            preEdit.set(sidecar, pre);
        }

        for (const [sidecar, scEdits] of sidecarEdits) {
            if (!sidecar.isHealthy()) {
                try {
                    await sidecar.boot();
                } catch {
                    degradedLanguages.push(sidecar.languageId);
                    sidecarWarnings.push(
                        `[⚠️ NREKI WARNING: '${sidecar.command[0]}' not found or crashed. ` +
                        `Layer 2 Semantic Shield OFFLINE for ${sidecar.languageId} files. ` +
                        `Code passed syntax only. Install to enable strict validation.]`,
                    );
                    continue;
                }
            }
            try {
                // The server reports the errors of EVERY open document. Those that
                // exist before the edit are the baseline; only what the edit adds
                // is fatal (as for TypeScript). Without it, one old error rejected
                // each later edit in that language.
                //
                // The server reports OPEN documents only, so the files that can break
                // because of this edit (same package, importers) are opened before
                // the baseline is taken: an edit that changed `Greet` to return int
                // was accepted while main.go, never opened, no longer compiled.
                const watch = this.sidecarWatchList(sidecar, scEdits, lspDependents);
                const baseline = countErrors(await sidecar.baselineErrors(
                    [...(preEdit.get(sidecar) ?? []), ...watch.staged],
                    watch.fromDisk,
                ));
                sidecarBaselines.set(sidecar, baseline);
                lspCoverage.push({
                    languageId: sidecar.languageId,
                    // A dependent the graph still lists but that is gone from disk is not open.
                    checked: watch.stagedDependents + watch.fromDisk.filter(p => sidecar.hasOpenDocument(p)).length,
                    skipped: watch.skipped,
                });
                const sidecarErrors = await sidecar.validateEdits(scEdits);
                originalFatalErrors.push(...errorsBeyondBaseline(sidecarErrors, baseline));
            } catch (err) {
                const reason = (err as Error)?.message ?? String(err);
                degradedLanguages.push(sidecar.languageId);
                sidecarWarnings.push(
                    `[⚠️ NREKI WARNING: ${sidecar.languageId} validation failed (${reason.slice(0, 160)}). ` +
                    `Code passed without semantic check.]`,
                );
            }
        }

        return { sidecarEdits, sidecarWarnings, degradedLanguages, sidecarBaselines, lspCoverage };
    }

    /**
     * The documents a sidecar must have open besides the edited ones:
     *  - `fromDisk`: dependents of the edited files — files compiled with them
     *    (sidecar.companionFiles) first, then the importers the caller found in
     *    the dependency graph — capped at LSP_DEPENDENT_CAP. The sidecar opens
     *    them from disk and keeps them equal to it.
     *  - `staged`: files of this language still staged in the VFS (an earlier
     *    uncommitted transaction), pinned at their staged content.
     */
    private sidecarWatchList(
        sidecar: LspSidecarBase,
        scEdits: ReadonlyArray<{ filePath: string }>,
        lspDependents: readonly string[],
    ): {
        fromDisk: string[];
        staged: Array<{ filePath: string; content: string | null }>;
        /** How many entries of `staged` are dependents (the rest are only pinned). */
        stagedDependents: number;
        skipped: number;
    } {
        const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
        const rootPosix = this.toPosix(path.resolve(this.projectRoot));
        const seen = new Set(scEdits.map(e => fold(e.filePath)));
        const candidates: string[] = [];
        const consider = (raw: string): void => {
            const posixPath = this.toPosix(path.resolve(this.projectRoot, raw));
            if (!posixPath.startsWith(rootPosix + "/") || seen.has(fold(posixPath))) return;
            seen.add(fold(posixPath));
            candidates.push(posixPath);
        };
        for (const edit of scEdits) {
            for (const companion of sidecar.companionFiles(edit.filePath)) consider(companion);
        }
        for (const dep of lspDependents) {
            if (this.lspSidecars.get(path.extname(dep).toLowerCase()) === sidecar) consider(dep);
        }

        const fromDisk: string[] = [];
        const staged: Array<{ filePath: string; content: string | null }> = [];
        let skipped = 0;
        for (const posixPath of candidates) {
            if (fromDisk.length + staged.length >= NrekiKernel.LSP_DEPENDENT_CAP) { skipped++; continue; }
            if (!this.vfs.has(posixPath)) { fromDisk.push(posixPath); continue; }
            const content = this.vfs.get(posixPath);
            // A dependent pending deletion has nothing left to break.
            if (content !== null && content !== undefined) staged.push({ filePath: posixPath, content });
        }
        const stagedDependents = staged.length;
        // Not dependents, but staged: the sidecar must not reset them to the disk.
        for (const [posixPath, content] of this.vfs) {
            if (seen.has(fold(posixPath))) continue;
            if (this.lspSidecars.get(path.extname(posixPath).toLowerCase()) !== sidecar) continue;
            staged.push({ filePath: posixPath, content });
        }
        return { fromDisk, staged, stagedDependents, skipped };
    }

    private async phase4_healingCascade(
        originalFatalErrors: NrekiStructuredError[],
        explicitlyEditedFiles: Set<string>,
        filesToEvaluate: Set<string>,
        transactionMutated: Set<string>,
        sidecarBaselines: ReadonlyMap<LspSidecarBase, ErrorBaseline>,
    ): Promise<{
        healed: boolean;
        appliedFixes: string[];
        newlyTouchedFiles: Set<string>;
        finalErrors: NrekiStructuredError[];
    }> {
        const tsOnlyErrors = originalFatalErrors.filter(e => this.isTypeScriptFile(e.file));
        const lspOnlyErrors = originalFatalErrors.filter(e => !this.isTypeScriptFile(e.file));

        let isFullyHealed = true;
        const allAppliedFixes: string[] = [];
        const allNewlyTouchedFiles = new Set<string>();

        let remainingTsErrors: NrekiStructuredError[] = tsOnlyErrors;
        if (tsOnlyErrors.length > 0) {
            const tsContext: TsHealingContext = {
                mode: this.mode,
                readContent: (p) => {
                    // v10.5.2: distinguish tombstone (null) from absent (undefined).
                    // Tombstone = file deleted in pending tx → return "" (no zombie disk read).
                    // Absent = file not in VFS → fall through to disk.
                    if (this.vfs.has(p)) {
                        const v = this.vfs.get(p);
                        return v ?? "";
                    }
                    // INT-03: a collateral file is about to be patched from its disk state.
                    this.captureDiskExpectation(p);
                    return this.tsBackend.host.readFile(p) ?? "";
                },
                // SEC-02: drop any fix that would write outside the project, through a
                // symlink, into a sensitive file, or under node_modules/.git/.nreki.
                getAutoFixes: async (f, e) => {
                    const fixes = await this.tsBackend.getAutoFixes(f, e);
                    return fixes.filter(fix => fix.changes.every(c => this.isHealWritable(c.filePath)));
                },
                createSavepoint: (p) => ({
                    content: this.vfs.has(p) ? this.vfs.get(p) : undefined,
                    time: this.vfsClock.get(p),
                    wasInRoot: this.rootNames.has(p),
                }),
                applyMicroPatch: (p, content) => {
                    if (!this.isHealWritable(p)) {
                        throw new Error(`[NREKI] Security rejection: auto-heal may not write "${p}".`);
                    }
                    this.vfs.set(p, content);
                    this.vfsClock.set(p, new Date(this.logicalTime));
                    if (this.isTypeScriptFile(p) && !this.rootNames.has(p)) {
                        this.rootNames.add(p);
                    }
                },
                recompileAndEvaluate: async (evalSet, editSet) => {
                    this.logicalTime += 1000;
                    this.tsBackend.updateProgram();
                    return await this.tsBackend.getDiagnostics(evalSet, editSet, this.mode);
                },
                executeRollback: (undoLog, isMacro) => {
                    for (const [p, state] of undoLog.entries()) {
                        if (state.content !== undefined) this.vfs.set(p, state.content);
                        else this.vfs.delete(p);
                        if (state.time) this.vfsClock.set(p, state.time);
                        else this.vfsClock.delete(p);
                        if (state.wasInRoot) this.rootNames.add(p);
                        else this.rootNames.delete(p);
                    }
                    this.logicalTime += 1000;
                    if (isMacro) {
                        for (const p of undoLog.keys()) {
                            if (this.vfs.has(p)) this.vfsClock.set(p, new Date(this.logicalTime));
                        }
                    }
                    this.tsBackend.updateProgram();
                },
                recordStat: (healed) => {
                    if (healed) this._healingStats.applied++;
                    else this._healingStats.failed++;
                },
            };

            const tsHealing = await attemptAutoHealing(
                tsOnlyErrors, explicitlyEditedFiles, filesToEvaluate, tsContext
            );
            if (!tsHealing.healed) isFullyHealed = false;
            remainingTsErrors = tsHealing.finalErrors;
            allAppliedFixes.push(...tsHealing.appliedFixes);
            for (const f of tsHealing.newlyTouchedFiles) allNewlyTouchedFiles.add(f);
            if (tsHealing.healed) {
                for (const f of tsHealing.newlyTouchedFiles) explicitlyEditedFiles.add(f);
            }
        }

        let remainingLspErrors: NrekiStructuredError[] = lspOnlyErrors;
        if (isFullyHealed && lspOnlyErrors.length > 0) {
            const errorsBySidecar = new Map<LspSidecarBase, NrekiStructuredError[]>();
            // An error no backend can fix (a global TypeScript diagnostic, the cascade
            // limit) stays an error. It used to be dropped here, and the edit was
            // reported as auto-healed with no fix applied.
            const unhealable: NrekiStructuredError[] = [];
            for (const err of lspOnlyErrors) {
                const ext = path.extname(err.file).toLowerCase();
                const sidecar = this.lspSidecars.get(ext);
                if (sidecar) {
                    const arr = errorsBySidecar.get(sidecar) || [];
                    arr.push(err);
                    errorsBySidecar.set(sidecar, arr);
                } else {
                    unhealable.push(err);
                }
            }
            remainingLspErrors = [...unhealable];
            if (unhealable.length > 0) {
                isFullyHealed = false;
                for (const errors of errorsBySidecar.values()) remainingLspErrors.push(...errors);
                errorsBySidecar.clear(); // the edit is rejected anyway: no LSP fix is tried
            }
            for (const [sidecar, errors] of errorsBySidecar.entries()) {
                const lspContext: LspHealingContext = {
                    languageId: sidecar.languageId,
                    isDead: () => sidecar.isDead,
                    readContent: (p) => {
                        const v = this.vfs.get(p);
                        if (v !== undefined && v !== null) return v;
                        this.captureDiskExpectation(p);
                        // BOM-stripped like every other NREKI read (offsets stay aligned).
                        return readSource(p);
                    },
                    // SEC-02: lexical startsWith() let symlinks and sensitive files through.
                    resolvePath: (rawPath) => {
                        const resolved = this.toPosix(path.resolve(this.projectRoot, rawPath));
                        return this.isHealWritable(resolved) ? resolved : null;
                    },
                    getLspOffset: (content, line, character) =>
                        this.getLspOffset(content, line, character),
                    // AUDIT FIX (Patch 5 / v10.5.9): `as any` removed — the
                    // sidecar now returns the canonical LspCodeAction[] shape.
                    requestCodeActions: (file, diagnostic) =>
                        sidecar.requestCodeActions(file, diagnostic),
                    validateLspEdits: async (editedFiles) => {
                        this.logicalTime += 1000;
                        const scEdits = Array.from(editedFiles).map(f => ({
                            filePath: f, content: this.vfs.get(f) ?? null,
                        }));
                        // Same baseline as the verdict: a fix is judged on the
                        // errors this transaction introduced, not on old ones.
                        return errorsBeyondBaseline(
                            await sidecar.validateEdits(scEdits),
                            sidecarBaselines.get(sidecar),
                        );
                    },
                    createSavepoint: (p) => ({
                        content: this.vfs.has(p) ? this.vfs.get(p) : undefined,
                        time: this.vfsClock.get(p),
                    }),
                    applyMicroPatch: (p, content) => {
                        if (!this.isHealWritable(p)) {
                            throw new Error(`[NREKI] Security rejection: auto-heal may not write "${p}".`);
                        }
                        this.vfs.set(p, content);
                        this.vfsClock.set(p, new Date(this.logicalTime));
                    },
                    executeRollback: async (undoLog, isMacro) => {
                        const rollbacks: Array<{ filePath: string; content: string | null }> = [];
                        for (const [p, state] of undoLog.entries()) {
                            if (state.content !== undefined) this.vfs.set(p, state.content);
                            else this.vfs.delete(p);
                            if (state.time) this.vfsClock.set(p, state.time);
                            else this.vfsClock.delete(p);
                            // undefined = not staged before the fix (a collateral file): the
                            // LSP goes back to its DISK content. `?? null` tombstoned a real
                            // file, leaving an empty overlay behind for every later edit.
                            rollbacks.push({
                                filePath: p,
                                content: state.content !== undefined ? state.content : this.diskContentOrNull(p),
                            });
                        }
                        if (isMacro) this.logicalTime += 1000;
                        if (rollbacks.length > 0) {
                            try {
                                await sidecar.validateEdits(rollbacks);
                            } catch {
                                sidecar.isDead = true;
                            }
                        }
                    },
                    recordStat: (healed) => {
                        if (healed) this._healingStats.applied++;
                        else this._healingStats.failed++;
                    },
                };

                const lspHealing = await attemptLspAutoHealing(errors, explicitlyEditedFiles, lspContext);
                if (!lspHealing.healed) {
                    isFullyHealed = false;
                    remainingLspErrors.push(...lspHealing.finalErrors);
                } else {
                    allAppliedFixes.push(...lspHealing.appliedFixes);
                    for (const f of lspHealing.newlyTouchedFiles) allNewlyTouchedFiles.add(f);
                    for (const f of lspHealing.newlyTouchedFiles) explicitlyEditedFiles.add(f);
                }
            }
        }

        const healed = isFullyHealed && (remainingTsErrors.length + remainingLspErrors.length) === 0;

        if (healed) {
            for (const f of allNewlyTouchedFiles) {
                if (!this.mutatedFiles.has(f)) transactionMutated.add(f);
                this.mutatedFiles.add(f);
            }
        }

        return {
            healed,
            appliedFixes: allAppliedFixes,
            newlyTouchedFiles: allNewlyTouchedFiles,
            finalErrors: [...remainingTsErrors, ...remainingLspErrors],
        };
    }

    /**
     * Two-Phase Atomic Commit with physical rollback (P2, P18, P27, P32).
     * Phase 1: Backup existing files to .bak
     * Phase 2: Write new content via temp+rename
     * Phase 3: Clean backups on success
     * On failure: restore all .bak files
     */
    public async commitToDisk(): Promise<void> {
        return this.mutex.withLock(async () => {
        const physicalUndoLog: { target: string; backup: string | null }[] = [];
        const createdTmps: string[] = [];

        // Scope writes to files mutated in the current transaction only.
        // Prevents stale VFS entries from prior intercepts leaking into this commit.
        const filesToCommit = new Set(this.mutatedFiles);
        // Per-process WAL: a concurrent NREKI instance in the same repo must never
        // recover (or delete) a log that belongs to a commit still in flight.
        const walPath = path.join(this.projectRoot, ".nreki", "transactions", `wal-${process.pid}.json`);
        let walWritten = false;

        try {
            // PHASE 0: Pre-flight. Every target must be a legitimate project file
            // (defense in depth for SEC-02), and nothing may have changed on disk
            // since the edit was computed (INT-03 — IDE save, formatter, 2nd agent).
            for (const posixPath of filesToCommit) this.assertCommitTarget(path.normalize(posixPath));
            const conflicts = this.findDiskConflicts(filesToCommit);
            if (conflicts.length > 0) throw new NrekiConflictError(conflicts);

            // PHASE 1: Physical backup
            for (const posixPath of filesToCommit) {
                const osPath = path.normalize(posixPath);
                if (fs.existsSync(osPath)) {
                    const txDir = path.join(this.projectRoot, ".nreki", "transactions");
                    if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });
                    const bak = path.join(txDir, `${crypto.randomBytes(4).toString("hex")}.bak`);
                    fs.copyFileSync(osPath, bak);
                    physicalUndoLog.push({ target: osPath, backup: bak });
                } else {
                    physicalUndoLog.push({ target: osPath, backup: null });
                }
            }

            // WAL: Write intent log before destructive Phase 2.
            // If the process crashes between Phase 1 (backup) and Phase 2 (write),
            // boot() will find this WAL and automatically restore from backups.
            // The WAL is mandatory: without it a crash mid-Phase-2 leaves a
            // multi-file commit half-applied with no recovery path. A failure
            // here aborts the commit before anything destructive happens.
            if (physicalUndoLog.length > 0) {
                const txDir = path.dirname(walPath);
                if (!fs.existsSync(txDir)) fs.mkdirSync(txDir, { recursive: true });
                // Atomic write via temp+rename. writeFileSync overwrites in-place
                // and is NOT atomic — OOM/crash mid-write truncates the WAL.
                const walTmpPath = `${walPath}.tmp`;
                fs.writeFileSync(walTmpPath, JSON.stringify({
                    status: "pending",
                    pid: process.pid, // lets a 2nd NREKI instance tell "crashed" from "mid-commit"
                    ts: new Date().toISOString(),
                    files: physicalUndoLog.map(l => ({ target: l.target, backup: l.backup })),
                }), "utf-8");
                fs.renameSync(walTmpPath, walPath);
                walWritten = true;
            }

            // PHASE 2: Destructive writes
            for (const posixPath of filesToCommit) {
                const content = this.vfs.get(posixPath) ?? null;
                const osPath = path.normalize(posixPath);
                if (content === null) {
                    if (fs.existsSync(osPath)) fs.unlinkSync(osPath);
                } else {
                    const dir = path.dirname(osPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    // INT-07: keep the original BOM and permission bits (+x scripts).
                    const traits = captureFileTraits(osPath);
                    const tmp = `${osPath}.nreki-${crypto.randomBytes(4).toString("hex")}.tmp`;
                    createdTmps.push(tmp); // Push BEFORE write so catch can clean up on ENOSPC
                    fs.writeFileSync(tmp, withTraits(content, traits), "utf-8");
                    applyModeTraits(tmp, traits);
                    fs.renameSync(tmp, osPath);
                    createdTmps.pop(); // Rename succeeded — no longer orphan
                }
                this.bumpDiskVersion(posixPath);
            }

            // INT-02: shadows (.d.ts served for pruned files) were generated from the
            // PREVIOUS disk content. Drop them for every committed file, otherwise the
            // next edit elsewhere type-checks against the stale signature.
            if (this.mode === "hologram") {
                let shadowsChanged = false;
                for (const posixPath of filesToCommit) {
                    this.jitClassifiedCache.delete(posixPath);
                    if (this.shadowContent.delete(posixPath)) shadowsChanged = true;
                    if (this.prunedFiles.delete(posixPath)) shadowsChanged = true;
                }
                if (shadowsChanged) this.buildShadowLookups();
            }

            // P18: VFS clear and rebuild
            // C-02: Save VFS state before clearing so we can restore on rebuild failure
            const savedVfs = new Map(this.vfs);
            const savedClock = new Map(this.vfsClock);
            const savedDirs = new Set(this.vfsDirectories);
            this.vfs.clear();
            this.vfsClock.clear();
            this.vfsDirectories.clear();
            this.tsBackend.purgeCache();
            try {
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
                this.tsBackend.captureBaseline(undefined, this.mode);
            } catch (rebuildErr) {
                // A-10: Force full rebuild on next operation
                this.tsBackend.purgeCache();
                // Restore VFS to pre-clear state for consistency with rolled-back disk
                for (const [k, v] of savedVfs) this.vfs.set(k, v);
                for (const [k, v] of savedClock) this.vfsClock.set(k, v);
                for (const d of savedDirs) this.vfsDirectories.add(d);
                throw rebuildErr;
            }

            // Persist build state for next session (warm boot)
            try {
                this.tsBackend.tsBuilder!.emit(
                    undefined,
                    (fileName, text) => {
                        // Only write .tsbuildinfo, not .js/.d.ts
                        if (fileName.endsWith(".tsbuildinfo")) {
                            const dir = path.dirname(fileName);
                            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                            fs.writeFileSync(fileName, text, "utf-8");
                        }
                    },
                    undefined,
                    true, // emitOnlyDtsFiles - suppresses .js output
                );
                this.writeTsVersionGuard();
            } catch { /* Non-fatal: next boot will cold-start */ }

            // A-01: Phase 3 AFTER successful rebuild - backups survive if rebuild throws
            for (const log of physicalUndoLog) {
                if (log.backup && fs.existsSync(log.backup)) fs.unlinkSync(log.backup);
            }
            // WAL: Transaction complete — delete OUR intent log only
            if (walWritten) {
                try { fs.unlinkSync(walPath); } catch { /* best effort */ }
            }

            // Release stale AST versions from DocumentRegistry
            this.tsBackend.releaseMutatedDocuments(this.mutatedFiles);
            this.mutatedFiles.clear();
            this.diskExpectations.clear();

            logger.info("Atomic commit materialized. Disk synchronized.");
        } catch (error) {
            // PHYSICAL ROLLBACK
            logger.error(error instanceof NrekiConflictError
                ? `Commit aborted before any write: ${error.message}`
                : `OS write failure! Physical rollback: ${error}`);
            this.diskExpectations.clear();

            // AUDIT FIX: Clean orphan .tmp files written before the crash
            for (const tmpPath of createdTmps) {
                try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best effort */ }
            }

            let rollbackClean = true;
            for (const log of physicalUndoLog) {
                try {
                    if (log.backup) {
                        if (fs.existsSync(log.backup)) fs.renameSync(log.backup, log.target);
                    } else {
                        if (fs.existsSync(log.target)) fs.unlinkSync(log.target);
                    }
                } catch {
                    rollbackClean = false; // Cascade panic — keep the WAL for the next boot
                }
                this.bumpDiskVersion(this.toPosix(log.target));
            }
            // Fully rolled back: drop the WAL so a later boot does not "recover" a
            // finished transaction (e.g. deleting a file the user re-created since).
            if (rollbackClean && walWritten) {
                try { fs.unlinkSync(walPath); } catch { /* best effort */ }
            }

            // VFS ZOMBIE FIX: Purge RAM state that never reached disk.
            // Without this, the next readFile() serves ghost content
            // desynchronized from the real filesystem.
            this.vfs.clear();
            this.vfsClock.clear();
            this.vfsDirectories.clear();
            // CRITICAL FIX: Clear mutatedFiles to prevent the next commitToDisk()
            // from iterating stale entries, reading null from empty VFS,
            // and executing fs.unlinkSync() on real user files.
            this.mutatedFiles.clear();
            this.logicalTime += 1000;

            // Force cold rebuild from disk reality
            this.tsBackend.purgeCache();
            try {
                this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
                this.tsBackend.captureBaseline(undefined, this.mode);
            } catch {
                // If rebuild also fails, mark kernel for full reconstruction
                this.tsBackend.purgeCache(true);
            }

            // gopls/pyright still hold the APPROVED-but-uncommitted content as
            // open-document overlays: without this they would keep validating
            // later edits against code that never reached disk (I-01).
            await this.resyncSidecarsFromDisk(filesToCommit);

            // A conflict is not an OS failure: surface it as-is so handlers can
            // tell the agent to re-read instead of reporting a kernel crash.
            if (error instanceof NrekiConflictError) throw error;
            throw new Error(`[NREKI] Physical ACID commit failed. Repository and VFS restored. Reason: ${error}`);
        }
        });
    }

    /** Emergency rollback - purge all staged changes (P3). */
    public async rollbackAll(): Promise<void> {
        return this.mutex.withLock(async () => {
            const touched = [...this.mutatedFiles];
            this.vfs.clear();
            this.vfsClock.clear();
            this.vfsDirectories.clear();
            // CRITICAL FIX: Prevent stale mutatedFiles from deleting real files
            // in the next commitToDisk() call.
            this.tsBackend.releaseMutatedDocuments(new Set(this.mutatedFiles));
            this.mutatedFiles.clear();
            this.diskExpectations.clear();
            this.initConfig(); // Re-sync rootNames from disk
            // BUG 1: In hologram mode, re-filter rootNames
            if (this.mode === "hologram") {
                if (this.jitMode) {
                    // SURGICAL JIT CACHE INVALIDATION:
                    // jitClassifyFile() reads from DISK, not VFS. Classifications
                    // remain valid after rollback because disk content is unchanged.
                    // Only invalidate files that were being edited in this transaction.
                    // This preserves the ~1.94s of accumulated JIT work.
                    for (const target of this.currentEditTargets) {
                        this.jitClassifiedCache.delete(target);
                        this.prunedFiles.delete(target);
                        this.shadowContent.delete(target);
                    }
                    this.buildShadowLookups();
                    this.currentEditTargets.clear();
                    this.rootNames = new Set(
                        [...this.rootNames].filter(f => /\.d\.[mc]?ts$/i.test(f)),
                    );
                    this.tsBackend.rootNames = this.rootNames;
                } else if (this.ambientFiles.length > 0) {
                    // Eager mode: re-filter to ambient-only
                    const ambientSet = new Set(
                        this.ambientFiles.map(f => this.toPosix(path.resolve(this.projectRoot, f))),
                    );
                    this.rootNames = new Set(
                        [...this.rootNames].filter(f => ambientSet.has(f)),
                    );
                    this.tsBackend.rootNames = this.rootNames;
                    this.buildShadowLookups();
                }
            }
            // WARM-PATH: Advance clock to invalidate cached files.
            // Only destroy builderProgram if it doesn't exist yet.
            this.logicalTime += 1000;
            this.tsBackend.updateProgram();
                // DR/LS synced via tsBackend
            // Release stale AST versions from DocumentRegistry
            this.tsBackend.releaseMutatedDocuments(this.mutatedFiles);
            // LSP overlays of the discarded transaction go back to disk content (I-01).
            await this.resyncSidecarsFromDisk(touched);
            logger.warn("Hard rollback executed. VFS purged.");
        });
    }

    // ─── Utilities ─────────────────────────────────────────────────

    /**
     * Restore the hologram veil for temporarily unveiled files.
     * Re-adds files to the pruned/shadow lookups, removes them from rootNames,
     * and invalidates JIT classification cache. Clears currentEditTargets.
     */
    private restoreHologramVeil(temporarilyUnveiled: Set<string>): void {
        if (this.mode === "hologram" && temporarilyUnveiled.size > 0) {
            for (const file of temporarilyUnveiled) {
                this.prunedTsLookup.add(file);
                this.shadowDtsLookup.add(file.replace(/\.([mc]?)tsx?$/, ".d.$1ts"));
                this.rootNames.delete(file);
                this.vfsClock.set(file, new Date(this.logicalTime + 1));
                this.jitClassifiedCache.delete(file);
            }
        }
        this.currentEditTargets.clear();
    }

    /**
     * Show which files depend on a symbol before the agent edits it.
     * Uses LanguageService.findReferences(). Cost: ~20ms per call.
     */
    public predictBlastRadius(targetFile: string, symbolName: string): { safe: boolean; report: string } {
        if (this.mode === "hologram") {
            throw new Error(
                "[NREKI] Cannot use predictBlastRadius in hologram mode. " +
                "Use Layer 1 AST navigator for reference queries.",
            );
        }
        if (!this.booted || !this.tsBackend.tsLanguageService || !this.tsBackend.tsBuilder) {
            throw new Error("[NREKI] Kernel or Language Service not booted.");
        }

        const posixPath = this.toPosix(path.resolve(this.projectRoot, targetFile));
        const program = this.tsBackend.tsLanguageService.getProgram();
        if (!program) throw new Error("[NREKI] Could not get program from LanguageService");
        const sourceFile = program.getSourceFile(posixPath);
        if (!sourceFile) throw new Error(`[NREKI] File not tracked: ${targetFile}`);

        // 1. Find the declaration's byte offset
        let targetPos = -1;
        const findNode = (node: ts.Node) => {
            if (ts.isIdentifier(node) && node.text === symbolName) {
                const parent = node.parent;
                if (parent && (
                    ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
                    ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent) ||
                    ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) ||
                    ts.isPropertySignature(parent) || ts.isMethodSignature(parent)
                ) && (parent as ts.NamedDeclaration).name === node) {
                    targetPos = node.getStart(sourceFile);
                    return;
                }
            }
            if (targetPos === -1) ts.forEachChild(node, findNode);
        };
        findNode(sourceFile);

        if (targetPos === -1) {
            throw new Error(`[NREKI] Declaration for '${symbolName}' not found in ${targetFile}`);
        }

        // 2. Fire the LanguageService reference scanner
        const references = this.tsBackend.tsLanguageService.findReferences(posixPath, targetPos);
        if (!references || references.length === 0) {
            return {
                safe: true,
                report: `No external dependents found for ${symbolName}. Safe to change.`,
            };
        }

        const dependents = new Map<string, Array<{ line: number; context: string; reason: string }>>();
        let totalUsages = 0;

        for (const ref of references) {
            for (const curr of ref.references) {
                if (curr.isDefinition) continue;

                const refFile = this.toPosix(path.resolve(this.projectRoot, curr.fileName));
                if (refFile === posixPath) continue;

                const refSourceFile = program.getSourceFile(refFile);
                if (!refSourceFile) continue;

                const { line } = ts.getLineAndCharacterOfPosition(refSourceFile, curr.textSpan.start);
                let lineMap = this.lineMapCache.get(refSourceFile);
                if (!lineMap) {
                    lineMap = new LineMap(refSourceFile.text);
                    this.lineMapCache.set(refSourceFile, lineMap);
                }
                const lineText = lineMap.getLine(line, refSourceFile.text).trim();

                // Extract WHY this usage matters (Demand Inference)
                let reason = "Structural usage";
                let usageNode: ts.Node | undefined;
                const findUsage = (n: ts.Node) => {
                    if (curr.textSpan.start >= n.getStart(refSourceFile) && curr.textSpan.start < n.getEnd()) {
                        usageNode = n;
                        ts.forEachChild(n, findUsage);
                    }
                };
                findUsage(refSourceFile);

                if (usageNode && usageNode.parent) {
                    const p = usageNode.parent;
                    if (ts.isCallExpression(p)) reason = "Function call (expects specific arguments/return type)";
                    else if (ts.isPropertyAccessExpression(p)) reason = "Property access";
                    else if (ts.isBinaryExpression(p)) reason = "Binary operation / Assignment";
                    else if (ts.isVariableDeclaration(p)) reason = "Assigned to explicitly typed variable";
                    else if (ts.isTypeReferenceNode(p)) reason = "Type contract (Type Reference)";
                    else if (ts.isImportSpecifier(p) || ts.isImportClause(p)) reason = "Module import";
                    else if (ts.isExportSpecifier(p) || ts.isExportAssignment(p)) reason = "Module export";
                    else if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) reason = "JSX Component instantiation";
                }

                const relPath = path.relative(this.projectRoot, curr.fileName).replace(/\\/g, "/");
                const arr = dependents.get(relPath) || [];
                arr.push({ line: line + 1, context: lineText, reason });
                dependents.set(relPath, arr);
                totalUsages++;
            }
        }

        if (dependents.size === 0) {
            return {
                safe: true,
                report: `${symbolName} is only used internally in ${path.relative(this.projectRoot, posixPath)}. Safe to change.`,
            };
        }

        // 3. Format tactical report for the LLM
        const lines: string[] = [
            `${totalUsages} references across ${dependents.size} files will break if you change this signature.`,
            `Dependent files:\n`,
        ];

        for (const [file, usages] of dependents.entries()) {
            lines.push(`${file} (${usages.length} usages)`);
            for (const u of usages) {
                lines.push(`  L${u.line}: ${u.context} (${u.reason})`);
            }
        }

        lines.push(
            `\nUse nreki_code action:"batch_edit" to update all dependent files in the same transaction.`,
        );

        return { safe: false, report: lines.join("\n") };
    }

    /** Resolve a file path to the kernel's internal POSIX format. */
    public resolvePosixPath(filePath: string): string {
        return this.toPosix(path.resolve(this.projectRoot, filePath));
    }

    /**
     * Which semantic checker (if any) covers a file. Used to build an honest
     * validation banner (NREKI-GAR-01): JS only counts as type-checked when
     * allowJs AND checkJs are on — with allowJs alone TS reports no semantic
     * diagnostics for .js files.
     */
    public getSemanticCoverage(filePath: string): { backend: "typescript" | "lsp" | null; languageId?: string; outsideProgram?: boolean } {
        const posixPath = this.resolvePosixPath(filePath);
        // Not selected by the tsconfig (excluded, or a solution-style root config
        // with "files": [] + references): the file was checked, its importers were
        // not, so the banner must not claim a project-wide check (G-01).
        const outsideProgram = () => !this.tsBackend.isInConfiguredProgram(posixPath);
        if (/\.(d\.ts|d\.mts|d\.cts|tsx?|mts|cts)$/i.test(posixPath)) return { backend: "typescript", outsideProgram: outsideProgram() };
        if (/\.(jsx?|mjs|cjs)$/i.test(posixPath)) {
            return this.compilerOptions?.allowJs && this.compilerOptions?.checkJs
                ? { backend: "typescript", outsideProgram: outsideProgram() }
                : { backend: null };
        }
        const sidecar = this.lspSidecars.get(path.extname(posixPath).toLowerCase());
        if (sidecar) return { backend: "lsp", languageId: sidecar.languageId };
        return { backend: null };
    }

    /**
     * A file changed on disk outside interceptAtomicBatch/commitToDisk (e.g.
     * nreki_code action:"undo"). Re-synchronize every cache that would
     * otherwise keep validating against the old content (NREKI-INT-05):
     * VFS entries, LanguageService version, hologram shadows, the project-mode
     * baseline and the LSP sidecars' open-document overlays.
     */
    public async notifyExternalChange(filePaths: string[]): Promise<void> {
        if (!this.booted || filePaths.length === 0) return;
        return this.mutex.withLock(async () => {
            const changed = filePaths.map(p => this.resolvePosixPath(p));
            for (const p of changed) {
                this.vfs.delete(p);
                this.vfsClock.delete(p);
                this.mutatedFiles.delete(p);
                this.diskExpectations.delete(p);
                this.bumpDiskVersion(p);
                if (this.mode === "hologram") {
                    this.jitClassifiedCache.delete(p);
                    this.shadowContent.delete(p);
                    this.prunedFiles.delete(p);
                }
            }
            if (this.mode === "hologram") this.buildShadowLookups();
            this.tsBackend.releaseMutatedDocuments(new Set(changed));
            this.logicalTime += 1000;
            this.tsBackend.updateProgram();
            if (this.mode === "project") this.tsBackend.captureBaseline(undefined, this.mode);

            await this.resyncSidecarsFromDisk(changed);
        });
    }

    /**
     * Push the DISK content of `paths` into every LSP sidecar that has them open.
     * Caller must hold the mutex. A sidecar that cannot be resynced is marked
     * dead (validation then reports "LSP offline") rather than left validating
     * against content that never reached disk.
     */
    private async resyncSidecarsFromDisk(paths: Iterable<string>): Promise<void> {
        for (const p of paths) {
            const sidecar = this.lspSidecars.get(path.extname(p).toLowerCase());
            if (!sidecar || !sidecar.isHealthy() || !sidecar.hasOpenDocument(p)) continue;
            try { await sidecar.validateEdits([{ filePath: p, content: this.diskContentOrNull(p) }]); }
            catch { sidecar.isDead = true; }
        }
    }

    /** BOM-stripped disk content (LSP offsets stay aligned), or null when the file is absent. */
    private diskContentOrNull(p: string): string | null {
        try { return readSource(path.normalize(p)); } catch { return null; }
    }

    public getTypeShape(targetFile: string, symbolName: string): string | null {
        if (!this.booted) throw new Error("Kernel not booted.");
        const posixPath = this.resolvePosixPath(targetFile);
        return this.tsBackend.getTypeShape(posixPath, symbolName);
    }

    public getStagingSize(): number { return this.vfs.size; }
    public getTrackedFiles(): number { return this.rootNames.size; }
    /**
     * @internal
     * For test assertions only. Checks if a file is currently tracked in rootNames.
     */
    public hasRootName(filePath: string): boolean {
        return this.rootNames.has(this.resolvePosixPath(filePath));
    }
    public getBaselineErrorCount(): number {
        return this.tsBackend.getBaselineErrorCount();
    }

    /**
     * Error count captured once at boot time. Immutable after boot.
     * Used by the file fragility tracker for session health delta calculation.
     */
    public getInitialErrorCount(): number {
        return Math.max(0, this.bootErrorCount);
    }

    /**
     * Current project error count via baseline cache.
     *
     * Between tool calls the VFS is empty (each intercept ends in
     * commit → captureBaseline() or rollback → VFS clean).
     * Therefore baselineFrequencies reflects the current disk state.
     *
     * Cost: O(1) - no compiler invocation needed.
     */
    public getCurrentErrorCount(): number {
        return this.getBaselineErrorCount();
    }

    // ─── Hologram mode API ─────────────────────────────────

    /** Receive shadow scan results BEFORE boot(). */
    public setShadows(
        prunable: Map<string, string>,
        _unprunable: Set<string>,
        ambientFiles: string[],
    ): void {
        this.prunedFiles = new Set(prunable.keys());
        this.shadowContent = new Map(prunable);
        this.ambientFiles = ambientFiles;
        this.buildShadowLookups();
    }

    /** Check if shadows have been loaded. */
    public hasShadows(): boolean {
        return this.prunedFiles.size > 0;
    }

    /** Set JIT parser for on-demand shadow generation. Call BEFORE boot(). */
    public setJitParser(parser: Parser, tsLanguage: Parser.Language): void {
        this.jitParser = parser;
        this.jitTsLanguage = tsLanguage;
    }

    /** Set JIT classifier function (classifyAndGenerateShadow). */
    public setJitClassifier(fn: (filePath: string, content: string, parser: Parser, lang: Parser.Language) => { prunable: boolean; shadow: string | null }): void {
        this.jitClassifyFn = fn;
    }

    /** Check if JIT hologram mode is initialized. */
    public hasJitHologram(): boolean {
        return !!this.jitParser && !!this.jitClassifyFn;
    }

    /** Get number of files classified on-demand by JIT. */
    public getJitCacheSize(): number {
        return this.jitClassifiedCache.size;
    }

    /** Get the monotonic logical clock (for harvester epoch detection). */
    public getLogicalTime(): number {
        return this.logicalTime;
    }

    /** Get the current TypeScript Program (for harvester .d.ts emission). */
    public getProgram(): ts.Program | undefined {
        return this.tsBackend.tsProgram;
    }

    /**
     * JIT classify a single .ts/.tsx file and populate shadow data structures.
     * Returns true if file was prunable (shadow generated), false otherwise.
     * Synchronous: reads file from disk, classifies with pre-loaded tree-sitter parser.
     */
    private jitClassifyFile(tsPath: string): boolean {
        if (this.jitClassifiedCache.has(tsPath)) return this.prunedTsLookup.has(tsPath);
        if (!this.jitParser || !this.jitTsLanguage || !this.jitClassifyFn) return false;

        this.jitClassifiedCache.add(tsPath);

        // SIZE GUARD: Skip large auto-generated files (GraphQL codegen,
        // Prisma client, protobuf output) that would block the event loop.
        try {
            const stat = fs.statSync(path.normalize(tsPath));
            if (stat.size > NrekiKernel.JIT_MAX_FILE_SIZE) return false;
        } catch { return false; }

        let content: string;
        try { content = readSource(path.normalize(tsPath)); }
        catch { return false; }

        const result = this.jitClassifyFn(tsPath, content, this.jitParser, this.jitTsLanguage);
        if (result.prunable && result.shadow) {
            this.prunedFiles.add(tsPath);
            this.shadowContent.set(tsPath, result.shadow);
            const dtsPath = tsPath.replace(/\.([mc]?)tsx?$/, ".d.$1ts");
            this.shadowDtsLookup.add(dtsPath);
            this.prunedTsLookup.add(tsPath);
            return true;
        }
        return false;
    }

    private buildShadowLookups(): void {
        this.shadowDtsLookup.clear();
        this.prunedTsLookup.clear();
        for (const tsPath of this.prunedFiles) {
            const dtsPath = tsPath.replace(/\.([mc]?)tsx?$/, ".d.$1ts");
            this.shadowDtsLookup.add(dtsPath);
            this.prunedTsLookup.add(tsPath);
        }
    }

    // ─── LSP Sidecar Management ─────────────────────────────────────

    /**
     * Compensatory Rollback — heal sidecar VFS on ACID abort.
     *
     * When `interceptAtomicBatch` rejects a transaction, the TypeScript VFS
     * is rolled back via the `rollbackState` map. But LSP sidecars (gopls,
     * pyright) have their OWN VFS in RAM. If we don't re-inject the original
     * content, the sidecar's next `validateEdits` call will run against the
     * phantom (rejected) code, causing a brain-split.
     *
     * Awaits all rollbacks via Promise.all to ensure sidecar VFS consistency
     * before returning. If a rollback fails, marks the sidecar dead for respawn.
     */
    private async rollbackSidecars(
        sidecarEdits: Map<LspSidecarBase, Array<{filePath: string; content: string | null}>>,
        rollbackState: Map<string, {content: string | null | undefined; time: Date | undefined; wasInRoot: boolean}>,
    ): Promise<void> {
        if (sidecarEdits.size === 0) return;

        const promises: Promise<void | NrekiStructuredError[]>[] = [];
        for (const [sidecar, scEdits] of sidecarEdits) {
            if (sidecar.isDead) continue;
            const rollbacks: Array<{filePath: string; content: string | null}> = [];

            for (const edit of scEdits) {
                const posixPath = this.toPosix(path.resolve(this.projectRoot, edit.filePath));
                const state = rollbackState.get(posixPath);

                // Not staged before the transaction: the disk content (null when absent).
                const originalContent = state && state.content !== undefined
                    ? state.content
                    : this.diskContentOrNull(edit.filePath);

                rollbacks.push({ filePath: edit.filePath, content: originalContent });
            }

            if (rollbacks.length > 0) {
                promises.push(
                    sidecar.validateEdits(rollbacks).catch(() => {
                        sidecar.isDead = true;
                    })
                );
            }
        }
        await Promise.all(promises);
    }

    /**
     * Register an LSP sidecar for a file extension.
     * Called during initialization (index.ts) when project markers are detected.
     * Example: kernel.registerSidecar(".go", new GoLspSidecar(root));
     */
    public registerSidecar(ext: string, sidecar: LspSidecarBase): void {
        this.lspSidecars.set(ext, sidecar);
    }

    /**
     * Shutdown all LSP sidecars (kill child processes).
     * Called on MCP server close to prevent orphan processes.
     */
    public async shutdownSidecars(): Promise<void> {
        const unique = new Set(this.lspSidecars.values());
        for (const sidecar of unique) {
            try { await sidecar.shutdown(); } catch { /* best effort */ }
        }
        this.lspSidecars.clear();
    }
}
