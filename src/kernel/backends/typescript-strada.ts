/**
 * typescript-strada.ts — TypeScript Backend (Strada API)
 *
 * Wraps the current NrekiKernel's TypeScript Compiler API usage.
 * This is the STUB implementation for Strangler Fig Phase 1.
 *
 * All methods return empty/noop results. The kernel continues using
 * its internal logic directly. This stub exists ONLY to prove that
 * the interface compiles and the 704 tests still pass.
 *
 * In Phase 2+, real logic will be extracted from NrekiKernel into here.
 *
 * Dies with TypeScript 7.0 Strada API. Replaced by TypeScriptLSPBackend.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import * as ts from "typescript";
import * as path from "path";
import type {
    LanguageBackend,
    BackendCapabilities,
    BackendFix,
    VfsAdapter,
} from "../language-backend.js";
import type { NrekiStructuredError, PreEditContract } from "../nreki-kernel.js";

export class TypeScriptStradaBackend implements LanguageBackend {
    readonly name = "TypeScript-Strada";

    readonly capabilities: BackendCapabilities = {
        supportsAutoHealing: true,
        supportsTTRD: true,
    };

    // ─── Compiler State (owned by backend, referenced by kernel) ───
    public compilerOptions!: ts.CompilerOptions;
    public rootNames!: Set<string>;
    public tsBuildInfoPath!: string;

    // ─── Compiler Infrastructure (owned by backend, referenced by kernel) ───
    public host!: ts.CompilerHost;
    public originalReadFile!: (fileName: string) => string | undefined;
    public originalFileExists!: (fileName: string) => boolean;
    public documentRegistry!: ts.DocumentRegistry;
    public languageService!: ts.LanguageService;

    // POSIX normalization (duplicated from kernel — 1 line, no shared dependency needed)
    private toPosix(p: string): string {
        return path.normalize(p).replace(/\\/g, "/");
    }

    /**
     * Read tsconfig.json and initialize compilerOptions + rootNames.
     * Extracted from NrekiKernel.initConfig().
     *
     * Called by kernel.boot() and kernel.rollbackAll().
     * The kernel copies references after this call.
     */
    public initConfig(projectRoot: string): void {
        const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
        if (!configPath) throw new Error("[NREKI] Config error: tsconfig.json not found.");
        const parsed = ts.parseJsonConfigFileContent(
            ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, projectRoot
        );
        this.compilerOptions = parsed.options;
        this.rootNames = new Set(
            parsed.fileNames.map((f) => this.toPosix(path.resolve(projectRoot, f)))
        );

        // Incremental cache: set tsBuildInfoFile so TS knows where to read/write
        const nrekiDir = path.join(projectRoot, ".nreki");
        this.tsBuildInfoPath = this.toPosix(path.join(nrekiDir, "cache.tsbuildinfo"));
        this.compilerOptions.tsBuildInfoFile = this.tsBuildInfoPath;
        this.compilerOptions.incremental = true;
    }

    /**
     * Create the TypeScript CompilerHost with VFS overrides.
     * The VfsAdapter callbacks are owned by the kernel — the backend
     * only READS through them. The kernel's VFS, hologram state,
     * and JIT cache stay in the kernel.
     *
     * Also creates DocumentRegistry and LanguageService.
     *
     * Extracted from NrekiKernel.boot().
     */
    public createCompilerInfra(
        projectRoot: string,
        vfsAdapter: VfsAdapter,
    ): void {
        // Create base host from TS
        this.host = ts.createIncrementalCompilerHost(this.compilerOptions, ts.sys);

        // Save originals for fallback (kernel closures use these via tsBackend)
        this.originalReadFile = this.host.readFile;
        this.originalFileExists = this.host.fileExists;

        // Override with VfsAdapter (kernel's eyes)
        this.host.readFile = (fileName: string): string | undefined => {
            // .tsbuildinfo bypasses VFS — it's infrastructure
            if (fileName.endsWith(".tsbuildinfo")) {
                return this.originalReadFile.call(this.host, fileName);
            }
            return vfsAdapter.readFile(fileName);
        };

        this.host.fileExists = (fileName: string): boolean => {
            return vfsAdapter.fileExists(fileName);
        };

        (this.host as any).getModifiedTime = (fileName: string): Date => {
            return vfsAdapter.getModifiedTime(fileName);
        };

        this.host.directoryExists = (dirName: string): boolean => {
            return vfsAdapter.directoryExists(dirName);
        };

        // DocumentRegistry
        this.documentRegistry = ts.createDocumentRegistry(
            ts.sys.useCaseSensitiveFileNames,
            projectRoot,
        );

        // LanguageService
        this.languageService = ts.createLanguageService({
            getCompilationSettings: () => this.compilerOptions,
            getScriptFileNames: () => Array.from(this.rootNames),
            getScriptVersion: (fileName: string) => vfsAdapter.getScriptVersion(fileName),
            getScriptSnapshot: (fileName: string) => vfsAdapter.getScriptSnapshot(fileName),
            getCurrentDirectory: () => projectRoot,
            getDefaultLibFileName: (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options),
            fileExists: this.host.fileExists,
            readFile: this.host.readFile,
            directoryExists: this.host.directoryExists,
            readDirectory: ts.sys.readDirectory,
        }, this.documentRegistry);
    }

    async boot(_workspacePath: string, _mode: "file" | "project" | "hologram"): Promise<void> {
        // STUB: Boot is still orchestrated by NrekiKernel.boot().
        // initConfig() is called explicitly by the kernel, not from here.
        // Phase 2+ will move the full boot sequence here.
    }

    async applyVirtualEdits(_edits: Array<{ filePath: string; content: string | null }>): Promise<void> {
        // STUB: Real VFS injection lives in NrekiKernel.interceptAtomicBatch() for now.
        // Phase 2+ will extract vfs.set() + vfsClock.set() here.
    }

    async getDiagnostics(_filesToEvaluate: Set<string>): Promise<NrekiStructuredError[]> {
        // STUB: Real diagnostics live in NrekiKernel.getFatalErrors() for now.
        // Phase 2+ will extract updateProgram() + diagnostic collection here.
        return [];
    }

    async getAutoFixes(_filePath: string, _error: NrekiStructuredError): Promise<BackendFix[]> {
        // STUB: Real healing lives in NrekiKernel.attemptAutoHealing() for now.
        // Phase 2+ will extract getCodeFixesAtPosition() here.
        return [];
    }

    async extractCanonicalTypes(_files: Set<string>): Promise<Map<string, Map<string, PreEditContract>>> {
        // STUB: Real TTRD lives in NrekiKernel.extractCanonicalTypes() for now.
        // Phase 2+ will extract TypeChecker type walking here.
        return new Map();
    }

    async shutdown(): Promise<void> {
        // STUB: TypeScript backend is in-process. Nothing to kill.
        // In LSP backends, this would be kill -9 on the child process.
    }

    isHealthy(): boolean {
        // In-process TypeScript compiler can't crash independently.
        return true;
    }
}
