/**
 * ts-compiler-wrapper.ts - TypeScript Compiler Wrapper
 *
 * Private wrapper encapsulating TypeScript compiler infrastructure.
 * Uses the "Strada" pattern: Build -> LanguageService -> CompilerHost.
 *
 * The wrapper is a pure computation slave: it computes diagnostics
 * but has no authority over the VFS or disk. The NrekiKernel
 * orchestrates all state transitions.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 *
 * Compiler Architecture:
 *   CompilerHost → BuilderProgram → LanguageService
 *   One DocumentRegistry shared across all instances.
 */

import * as ts from "typescript";
import * as path from "path";
import * as crypto from "crypto";
// ─── Inlined Types (formerly in language-backend.ts) ────────────────

export interface BackendCapabilities {
    supportsAutoHealing: boolean;
    supportsTTRD: boolean;
}

export interface BackendFix {
    description: string;
    changes: Array<{
        filePath: string;
        textChanges: Array<{ start: number; length: number; newText: string }>;
    }>;
}

export interface VfsAdapter {
    readFile(fileName: string): string | undefined;
    fileExists(fileName: string): boolean;
    getModifiedTime(fileName: string): Date;
    directoryExists(dirName: string): boolean;
    getScriptVersion(fileName: string): string;
    getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined;
}

/** What files that never import some edited files can still see of them. */
export interface DeclarationSurface {
    /** The .d.ts TypeScript emits for each file; null when one could not be emitted cleanly (a .d.ts, a file outside the program, an emit diagnostic). */
    declarations: string | null;
    /** Every file of the program: a new import can bring global declarations in. */
    programFiles: string;
    /** One of the files is a script (its top-level names are global), or has `declare global` / `declare module "x"`. */
    globalScope: boolean;
}

/** A script's top-level declarations are global; `declare global` and `declare module "x"` reach files that never import this one. */
function declaresGlobals(sf: ts.SourceFile): boolean {
    if (!ts.isExternalModule(sf)) return true;
    return sf.statements.some(s => ts.isModuleDeclaration(s)
        && ((s.flags & ts.NodeFlags.GlobalAugmentation) !== 0 || ts.isStringLiteral(s.name)));
}
import type { NrekiStructuredError, PreEditContract, TypeRegression } from "../nreki-kernel.js";
import { escapeRegExp } from "../../utils/imports.js";
import { toPosix as toPosixUtil } from "../../utils/to-posix.js";
import { logger } from "../../utils/logger.js";

// ─── Environment file classifier (copied from kernel) ─────────────
const ENV_FILE_BASENAMES = new Set([
    "tsconfig.json", "jsconfig.json", "package.json",
    "jest.config.ts", "jest.config.js", "jest.config.mjs",
    "vitest.config.ts", "vitest.config.js", "vitest.config.mts",
    "webpack.config.js", "webpack.config.ts",
    "vite.config.ts", "vite.config.js", "vite.config.mts",
    "rollup.config.js", "rollup.config.ts", "rollup.config.mjs",
    "eslint.config.js", "eslint.config.mjs",
    ".eslintrc.json", ".eslintrc.js",
    "prettier.config.js", ".prettierrc.json",
    "babel.config.js", "babel.config.json",
    "next.config.js", "next.config.mjs", "next.config.ts",
    "tailwind.config.js", "tailwind.config.ts",
]);

const isEnvironmentFile = (filePath: string): boolean => {
    const base = path.basename(filePath).toLowerCase();
    return base.endsWith(".d.ts") || base.startsWith(".") || ENV_FILE_BASENAMES.has(base);
};

/**
 * Diagnostics inside third-party code (root-level or nested node_modules)
 * are never the agent's fault and must not abort its transaction. Filtering
 * HERE — before the kernel decides safe/unsafe and rolls back — is what makes
 * "ignore node_modules errors" actually commit the edit (NREKI-INT-01: the
 * old post-hoc filter in processKernelResult ran after the rollback, so it
 * "committed" an empty VFS and answered [OK] with zero bytes written).
 */
const NODE_MODULES_PATH = /(?:^|[\\/])node_modules[\\/]/i;
const isThirdPartyDiagnostic = (diag: ts.Diagnostic): boolean =>
    !!diag.file && NODE_MODULES_PATH.test(diag.file.fileName);

interface CachedSourceFile {
    file: ts.SourceFile;
    languageVersion: ts.ScriptTarget;
    impliedNodeFormat: ts.ResolutionMode;
    /** Program build that last asked for this file. */
    lastUsed: number;
}

/**
 * A parsed file is forgotten once this many program builds have not asked for
 * it. More than one, so a file that leaves and re-enters the program (hologram
 * unveiling, a rejected edit followed by a retry) is not parsed again.
 */
const SOURCE_FILE_GRACE_BUILDS = 8;

/** Module specifier of an auto-import fix ("node:fs" and "fs" are the same module). */
const importFixModule = (description: string): string => {
    const m = /from ["']([^"']+)["']/.exec(description);
    return (m ? m[1] : description).replace(/^node:/, "");
};

export class TsCompilerWrapper {
    readonly name = "TypeScript-Strada";

    readonly capabilities: BackendCapabilities = {
        supportsAutoHealing: true,
        supportsTTRD: true,
    };

    // ─── Compiler State (owned by backend, referenced by kernel) ───
    public compilerOptions!: ts.CompilerOptions;
    public rootNames!: Set<string>;
    public tsBuildInfoPath!: string;
    /** Files the tsconfig itself selects (include/files minus exclude), for honest coverage claims. */
    private configuredFileNames = new Set<string>();
    private configFile: string | undefined;
    private configBase: string | undefined;

    // ─── Compiler Infrastructure (owned by backend, referenced by kernel) ───
    public host!: ts.CompilerHost;
    public originalReadFile!: (fileName: string) => string | undefined;
    public originalFileExists!: (fileName: string) => boolean;
    public documentRegistry!: ts.DocumentRegistry;
    public languageService!: ts.LanguageService;

    // ─── Stored from createCompilerInfra for recovery paths ───
    private projectRoot!: string;
    private vfsAdapter?: VfsAdapter;

    // ─── Compiler Lifecycle (moved from kernel) ───
    private builderProgram?: ts.EmitAndSemanticDiagnosticsBuilderProgram;
    private editCount = 0;
    private gcThreshold = 100;
    private isStateCorrupted = false;

    // ─── Parsed files kept across program builds (see installSourceFileCache) ───
    private sourceFiles = new Map<string, CachedSourceFile>();
    /** Options object / value the cached files were parsed and bound under. */
    private sourceFilesOptionsRef?: ts.CompilerOptions;
    private sourceFilesOptionsDigest = "";
    private programGeneration = 0;

    // ─── Diagnostic State (moved from kernel) ───
    private baselineFrequencies = new Map<string, number>();
    private lastRawDiagnostics: ts.Diagnostic[] = [];

    // POSIX normalization — delegates to shared utility
    private toPosix(p: string): string { return toPosixUtil(p); }

    // Pre-compiled regexes for getFingerprint (avoids 3 RegExp per diagnostic)
    private rootRegex?: RegExp;
    private nativeRootRegex?: RegExp;
    private nativePosixRegex?: RegExp;

    /**
     * Read tsconfig.json and initialize compilerOptions + rootNames.
     * Extracted from NrekiKernel.initConfig().
     *
     * Called by kernel.boot() and kernel.rollbackAll().
     * The kernel copies references after this call.
     */
    public initConfig(projectRoot: string): void {
        const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json") ||
                           ts.findConfigFile(projectRoot, ts.sys.fileExists, "jsconfig.json");

        const nrekiDir = path.join(projectRoot, ".nreki");
        this.tsBuildInfoPath = this.toPosix(path.join(nrekiDir, "cache.tsbuildinfo"));

        if (!configPath) {
            // Polyglot fallback: Python/Go-only projects have no tsconfig.
            // Initialize minimal compilerOptions so the VFS + LSP sidecars
            // can boot without TS Compiler crashing. The TS backend stays
            // idle; language-specific validation flows through sidecars.
            this.compilerOptions = {
                noEmit: true,
                allowJs: true,
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                skipLibCheck: true,
                // No automatic @types: with no root files TypeScript still loaded
                // every @types package visible from the cwd on alternate builds
                // (121 files here: 489 ms per Go/Python edit, 6 ms without them).
                types: [],
                tsBuildInfoFile: this.tsBuildInfoPath,
                incremental: true,
            };
            this.rootNames = new Set<string>();
            return;
        }

        const parsed = ts.parseJsonConfigFileContent(
            ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, projectRoot
        );
        this.compilerOptions = parsed.options;
        this.rootNames = new Set(
            parsed.fileNames.map((f) => this.toPosix(path.resolve(projectRoot, f)))
        );
        this.configFile = configPath;
        this.configBase = projectRoot; // same base parseJsonConfigFileContent used above
        this.configuredFileNames = new Set(this.rootNames);
        this.compilerOptions.tsBuildInfoFile = this.tsBuildInfoPath;
        this.compilerOptions.incremental = true;
    }

    /**
     * Does the tsconfig select this file? False for excluded files and for a
     * solution-style root config (`"files": []` + `references`), where the
     * importers of the file are NOT in the program, so a "project-wide" check
     * did not happen. Files created after boot are re-evaluated once.
     */
    public isInConfiguredProgram(posixPath: string): boolean {
        if (this.configuredFileNames.has(posixPath)) return true;
        if (!this.configFile || !this.configBase || !ts.sys.fileExists(posixPath)) return false;
        try {
            const parsed = ts.parseJsonConfigFileContent(
                ts.readConfigFile(this.configFile, ts.sys.readFile).config, ts.sys, this.configBase,
            );
            this.configuredFileNames = new Set(
                parsed.fileNames.map((f) => this.toPosix(path.resolve(this.configBase!, f))),
            );
        } catch { return false; }
        return this.configuredFileNames.has(posixPath);
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
        this.projectRoot = projectRoot;
        this.vfsAdapter = vfsAdapter;

        // Create base host from TS
        this.host = ts.createIncrementalCompilerHost(this.compilerOptions, ts.sys);

        // Disk fallbacks for the kernel's VFS closures. Straight from ts.sys, NOT
        // from the host: createIncrementalCompilerHost is built for ONE
        // compilation and caches every fileExists() answer and the text of every
        // .json file for its whole life. In this long-lived server a module
        // created after a failed import stayed "missing" (TS2307 until restart)
        // and a JSON module stayed at its first content after being edited.
        this.originalReadFile = (fileName: string) => ts.sys.readFile(fileName);
        this.originalFileExists = (fileName: string) => ts.sys.fileExists(fileName);

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

        // Patch 7 (v10.6.1): ts.CompilerHost doesn't declare getModifiedTime
        // (it's on ts.ModuleResolutionHost). Type-explicit cast via local alias
        // replaces `as any`.
        type CompilerHostWithMtime = ts.CompilerHost & {
            getModifiedTime?: (fileName: string) => Date;
        };
        (this.host as CompilerHostWithMtime).getModifiedTime = (fileName: string): Date => {
            return vfsAdapter.getModifiedTime(fileName);
        };

        this.host.directoryExists = (dirName: string): boolean => {
            return vfsAdapter.directoryExists(dirName);
        };

        this.installSourceFileCache();

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

    /**
     * Keep parsed files across program builds.
     *
     * The stock host re-reads AND re-parses every file for each new program,
     * and updateProgram() runs at least twice per accepted edit: editing one
     * file of a 48-file program cost 96 parses (~200 ms), growing with the
     * project. Handing back the SAME SourceFile while its text is unchanged
     * also lets TypeScript reuse the old program's structure.
     *
     * Exact by construction: an entry is served only if the text the host
     * reads right now (VFS first, then disk) equals the text it was parsed
     * from, under the same parse options. No mtime, no version counter.
     */
    private installSourceFileCache(): void {
        const parse = this.host.getSourceFile.bind(this.host);
        this.host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
            this.dropSourceFilesIfOptionsChanged();
            const options: ts.CreateSourceFileOptions = typeof languageVersionOrOptions === "object"
                ? languageVersionOrOptions
                : { languageVersion: languageVersionOrOptions };
            const key = this.host.getCanonicalFileName(this.toPosix(path.resolve(fileName)));
            const cached = this.sourceFiles.get(key);
            if (
                cached && !shouldCreateNewSourceFile &&
                cached.languageVersion === options.languageVersion &&
                cached.impliedNodeFormat === options.impliedNodeFormat
            ) {
                let current: string | undefined;
                // A read error is left to the stock implementation below.
                try { current = this.host.readFile(fileName); } catch { current = undefined; }
                if (current !== undefined && current === cached.file.text) {
                    cached.lastUsed = this.programGeneration;
                    return cached.file;
                }
            }
            const file = parse(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
            if (file) {
                this.sourceFiles.set(key, {
                    file,
                    languageVersion: options.languageVersion,
                    impliedNodeFormat: options.impliedNodeFormat,
                    lastUsed: this.programGeneration,
                });
            } else {
                this.sourceFiles.delete(key);
            }
            return file;
        };
    }

    /**
     * Options decide how a file is parsed and bound. initConfig() builds a new
     * options object on every rollback, so only a change of VALUE empties the
     * cache; TypeScript's own shouldCreateNewSourceFile covers the case where
     * an old program exists, this covers a build from scratch after a purge.
     */
    private dropSourceFilesIfOptionsChanged(): void {
        if (this.sourceFilesOptionsRef === this.compilerOptions) return;
        let digest: string;
        try { digest = JSON.stringify(this.compilerOptions); } catch { digest = `unserializable:${this.programGeneration}`; }
        if (digest !== this.sourceFilesOptionsDigest) this.sourceFiles.clear();
        this.sourceFilesOptionsRef = this.compilerOptions;
        this.sourceFilesOptionsDigest = digest;
    }

    /** Forget parsed files no program build has asked for in a while. */
    private releaseUnusedSourceFiles(): void {
        this.programGeneration++;
        for (const [key, entry] of this.sourceFiles) {
            if (this.programGeneration - entry.lastUsed > SOURCE_FILE_GRACE_BUILDS) this.sourceFiles.delete(key);
        }
    }

    /**
     * Create a LanguageServiceHost using the stored VfsAdapter.
     * Used by updateProgram() during recovery (recreate after corruption).
     * Extracted from NrekiKernel.createLSHost().
     */
    public createLSHost(): ts.LanguageServiceHost {
        if (!this.vfsAdapter) {
            throw new Error("[NREKI] Cannot create LSHost: VfsAdapter not initialized. Call createCompilerInfra first.");
        }
        return {
            getCompilationSettings: () => this.compilerOptions,
            getScriptFileNames: () => Array.from(this.rootNames),
            getScriptVersion: (fileName: string) => this.vfsAdapter!.getScriptVersion(fileName),
            getScriptSnapshot: (fileName: string) => this.vfsAdapter!.getScriptSnapshot(fileName),
            getCurrentDirectory: () => this.projectRoot,
            getDefaultLibFileName: (options: ts.CompilerOptions) => ts.getDefaultLibFilePath(options),
            fileExists: this.host.fileExists,
            readFile: this.host.readFile,
            directoryExists: this.host.directoryExists,
            readDirectory: ts.sys.readDirectory,
        };
    }

    /**
     * Rebuild the incremental TypeScript program.
     * Handles corruption recovery (recreate DocumentRegistry + LanguageService)
     * and periodic GC (kill builder every N edits).
     *
     * Extracted from NrekiKernel.updateProgram().
     */
    public updateProgram(): void {
        if (this.isStateCorrupted) {
            logger.warn("Purging builder and LanguageService after early exit. Warm rebuild ~2-5s.");
            this.builderProgram = undefined;

            this.documentRegistry = ts.createDocumentRegistry(
                ts.sys.useCaseSensitiveFileNames,
                this.projectRoot
            );
            this.languageService = ts.createLanguageService(this.createLSHost(), this.documentRegistry);
            // A full rebuild trusts nothing parsed before the corruption.
            this.sourceFiles.clear();

            this.isStateCorrupted = false;
        } else if (++this.editCount >= this.gcThreshold) {
            this.builderProgram = undefined;
            this.editCount = 0;
        }
        this.builderProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
            Array.from(this.rootNames), this.compilerOptions, this.host,
            this.builderProgram // undefined after purge = fresh rebuild with cached files
        );
        this.releaseUnusedSourceFiles();
    }

    /**
     * Release cached AST data for files that have been mutated.
     * mutatedFiles is owned by the kernel — passed as parameter.
     *
     * Extracted from NrekiKernel.releaseMutatedDocuments().
     */
    public releaseMutatedDocuments(mutatedFiles: Set<string>): void {
        if (!this.documentRegistry || mutatedFiles.size === 0) return;

        const registryKey = this.documentRegistry.getKeyForCompilationSettings(
            this.compilerOptions
        );

        for (const file of mutatedFiles) {
            try {
                const scriptKind =
                    file.endsWith(".tsx") ? ts.ScriptKind.TSX :
                    file.endsWith(".jsx") ? ts.ScriptKind.JSX :
                    file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs") ? ts.ScriptKind.JS :
                    ts.ScriptKind.TS;
                this.documentRegistry.releaseDocumentWithKey(
                    file as ts.Path,
                    registryKey,
                    scriptKind,
                    undefined,
                );
            } catch { /* Best effort: version may already be released */ }
        }
        mutatedFiles.clear();
    }

    /**
     * Kill the compiler cache. Called by the Orchestrator when a transaction
     * fails or times out.
     *
     * markCorrupted=false: warm rebuild (just kill incremental cache)
     * markCorrupted=true: full rebuild (recreate DR + LS on next updateProgram)
     */
    public purgeCache(markCorrupted: boolean = false): void {
        this.builderProgram = undefined;
        this.isStateCorrupted = markCorrupted;
    }

    // ─── Diagnostic Methods (moved from kernel) ───

    private getFingerprint(diag: ts.Diagnostic): string {
        const file = diag.file
            ? this.toPosix(path.resolve(this.projectRoot, diag.file.fileName))
            : "GLOBAL";
        let msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        // FIX: Use pre-compiled regexes instead of creating 3 new RegExp per diagnostic.
        if (!this.rootRegex) {
            const nativeRoot = path.resolve(this.projectRoot);
            const nativePosix = nativeRoot.replace(/\\/g, "/");
            this.rootRegex = new RegExp(escapeRegExp(this.projectRoot), "ig");
            this.nativeRootRegex = new RegExp(escapeRegExp(nativeRoot), "ig");
            this.nativePosixRegex = new RegExp(escapeRegExp(nativePosix), "ig");
        }
        msg = msg.replace(this.rootRegex, "<ROOT>");
        msg = msg.replace(this.nativeRootRegex!, "<ROOT>");
        msg = msg.replace(this.nativePosixRegex!, "<ROOT>");
        return crypto.createHash("sha256").update(`${file}|TS${diag.code}|${msg}`).digest("hex");
    }

    private toStructured(diag: ts.Diagnostic): NrekiStructuredError {
        const pos = diag.file && diag.start != null
            ? ts.getLineAndCharacterOfPosition(diag.file, diag.start)
            : { line: 0, character: 0 };
        return {
            file: diag.file
                ? this.toPosix(path.relative(this.projectRoot, diag.file.fileName))
                : "global",
            line: pos.line + 1,
            column: pos.character + 1,
            code: `TS${diag.code}`,
            message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        };
    }

    public captureBaseline(targetFiles: Set<string> | undefined, mode: string): void {
        this.baselineFrequencies.clear();
        if (!this.builderProgram) return;
        const program = this.builderProgram.getProgram();
        const processDiag = (diag: ts.Diagnostic) => {
            const hash = this.getFingerprint(diag);
            this.baselineFrequencies.set(hash, (this.baselineFrequencies.get(hash) || 0) + 1);
        };

        if (mode === "project") {
            for (const file of program.getSourceFiles()) {
                for (const diag of program.getSyntacticDiagnostics(file)) processDiag(diag);
                // Use program.getSemanticDiagnostics(file) per file instead of
                // builderProgram.getSemanticDiagnostics() to avoid consuming the
                // builder's stateful affected-file iterator.
                for (const diag of program.getSemanticDiagnostics(file)) processDiag(diag);
            }
            for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
            return;
        }

        const filesToScan = targetFiles
            ? Array.from(targetFiles)
                .map(p => program.getSourceFile(p))
                .filter((sf): sf is ts.SourceFile => sf !== undefined)
            : Array.from(program.getSourceFiles());

        for (const sf of filesToScan) {
            for (const diag of program.getSyntacticDiagnostics(sf)) processDiag(diag);
            for (const diag of program.getSemanticDiagnostics(sf)) processDiag(diag);
        }
        for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
    }

    public getBaselineErrorCount(): number {
        let total = 0;
        for (const count of this.baselineFrequencies.values()) total += count;
        return total;
    }

    // ─── TTRD Methods (moved from kernel) ───

    private getToxicityScoreFromType(
        type: ts.Type,
        checker: ts.TypeChecker,
        depth: number = 0,
        visited: Set<ts.Type> = new Set()
    ): number {
        if (depth > 3) return 0;
        if (type.flags & ts.TypeFlags.Object) {
            if (visited.has(type)) return 0;
            visited.add(type);
        }

        let score = 0;

        if (type.flags & ts.TypeFlags.Any) score += 10;
        else if (type.flags & ts.TypeFlags.Unknown) score += 2;

        if (type.symbol && type.symbol.name === "Function") score += 5;

        for (const sig of type.getCallSignatures()) {
            for (const param of sig.parameters) {
                const paramDecl = param.valueDeclaration || param.declarations?.[0];
                const paramType = paramDecl
                    ? checker.getTypeOfSymbolAtLocation(param, paramDecl)
                    : checker.getDeclaredTypeOfSymbol(param);
                score += this.getToxicityScoreFromType(paramType, checker, depth + 1, visited);
            }
            score += this.getToxicityScoreFromType(sig.getReturnType(), checker, depth + 1, visited);
        }

        if (type.flags & ts.TypeFlags.Object) {
            for (const prop of type.getProperties()) {
                const propDecl = prop.valueDeclaration || prop.declarations?.[0];
                const propType = propDecl
                    ? checker.getTypeOfSymbolAtLocation(prop, propDecl)
                    : checker.getDeclaredTypeOfSymbol(prop);
                score += this.getToxicityScoreFromType(propType, checker, depth + 1, visited);
            }
        }

        const typeRef = type as ts.TypeReference;
        if (typeRef.typeArguments) {
            for (const arg of typeRef.typeArguments) {
                score += this.getToxicityScoreFromType(arg, checker, depth + 1, visited);
            }
        }

        if (type.isUnionOrIntersection()) {
            for (const sub of type.types) {
                score += this.getToxicityScoreFromType(sub, checker, depth + 1, visited);
            }
        }

        return score;
    }

    async extractCanonicalTypes(files: Set<string>): Promise<Map<string, Map<string, PreEditContract>>> {
        const contracts = new Map<string, Map<string, PreEditContract>>();
        if (!this.builderProgram) return contracts;

        const program = this.builderProgram.getProgram();
        const checker = program.getTypeChecker();

        for (const posixPath of files) {
            const sf = program.getSourceFile(posixPath);
            if (!sf) continue;

            const fileSymbol = checker.getSymbolAtLocation(sf);
            if (!fileSymbol || !fileSymbol.exports) continue;

            const fileContracts = new Map<string, PreEditContract>();
            const exports = checker.getExportsOfModule(fileSymbol);

            for (const exp of exports) {
                const decl = exp.valueDeclaration || exp.declarations?.[0];
                if (!decl || decl.getSourceFile().fileName !== posixPath) continue;

                let type: ts.Type;
                if (exp.flags & ts.SymbolFlags.TypeAlias || exp.flags & ts.SymbolFlags.Interface) {
                    type = checker.getDeclaredTypeOfSymbol(exp);
                } else {
                    type = checker.getTypeOfSymbolAtLocation(exp, decl);
                }

                const toxicity = this.getToxicityScoreFromType(type, checker);
                const isUntyped = (type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Unknown) !== 0;

                let typeStr = checker.typeToString(type, undefined, ts.TypeFormatFlags.UseFullyQualifiedType);
                const cleanType = typeStr.replace(/\s+/g, " ");
                const safeType = cleanType.length > 150 ? cleanType.substring(0, 147) + "..." : cleanType;

                fileContracts.set(exp.getName(), { typeStr: safeType, toxicity, isUntyped });
            }
            if (fileContracts.size > 0) contracts.set(posixPath, fileContracts);
        }
        return contracts;
    }

    public computeTypeRegressions(
        preContracts: Map<string, Map<string, PreEditContract>>,
        postContracts: Map<string, Map<string, PreEditContract>>
    ): TypeRegression[] {
        const regressions: TypeRegression[] = [];

        for (const [filePath, preSymbols] of preContracts.entries()) {
            const postSymbols = postContracts.get(filePath);
            if (!postSymbols) continue;

            for (const [symbol, oldData] of preSymbols.entries()) {
                const newData = postSymbols.get(symbol);
                if (!newData) continue;

                if (newData.toxicity > oldData.toxicity || (newData.isUntyped && !oldData.isUntyped)) {
                    regressions.push({
                        filePath, symbol,
                        oldType: oldData.typeStr,
                        newType: newData.typeStr,
                    });
                }
            }

            // DETECT NEW TOXIC EXPORTS injected by AI to bypass TTRD
            for (const [symbol, newData] of postSymbols.entries()) {
                if (preSymbols.has(symbol)) continue;
                if (newData.toxicity > 0 || newData.isUntyped) {
                    regressions.push({
                        filePath, symbol,
                        oldType: "(new export)",
                        newType: newData.typeStr,
                    });
                }
            }
        }

        // Detect toxic exports in entirely NEW files
        for (const [filePath, postSymbols] of postContracts.entries()) {
            if (preContracts.has(filePath)) continue;
            for (const [symbol, newData] of postSymbols.entries()) {
                if (newData.toxicity > 0 || newData.isUntyped) {
                    regressions.push({
                        filePath, symbol,
                        oldType: "(new file)",
                        newType: newData.typeStr,
                    });
                }
            }
        }

        return regressions;
    }

    /**
     * File mode checks the edited files and their direct importers. Taken before
     * and after an edit: the same declarations and program files mean no other
     * file can type-check differently. extractCanonicalTypes is not enough for
     * that: it prints `() => Totals` whatever a local `Totals` holds.
     * `withDeclarations: false` only looks for globals (declarations stay null).
     * null: no program yet.
     */
    public declarationSurface(files: ReadonlySet<string>, withDeclarations = true): DeclarationSurface | null {
        if (!this.builderProgram) return null;
        const program = this.builderProgram.getProgram();
        // Program.emit's 6th parameter, forceDtsEmit (public as LanguageService.getEmitOutput's
        // 3rd): emits the .d.ts in memory even under noEmit or without `declaration`.
        const emit = program.emit.bind(program) as (
            targetSourceFile: ts.SourceFile,
            writeFile: ts.WriteFileCallback,
            cancellationToken: ts.CancellationToken | undefined,
            emitOnlyDtsFiles: boolean,
            customTransformers: ts.CustomTransformers | undefined,
            forceDtsEmit: boolean,
        ) => ts.EmitResult;

        let declarations: string | null = withDeclarations ? "" : null;
        let globalScope = false;
        for (const file of [...files].sort()) {
            const sf = program.getSourceFile(file);
            if (!sf) { declarations = null; continue; }
            if (declaresGlobals(sf)) globalScope = true;
            if (declarations === null || sf.isDeclarationFile) { declarations = null; continue; }
            let dts: string | undefined;
            try {
                const result = emit(sf, (name, text) => { if (/\.d\.[cm]?ts$/i.test(name)) dts = text; }, undefined, true, undefined, true);
                if (result.diagnostics.length > 0) dts = undefined;
            } catch {
                dts = undefined;
            }
            declarations = dts === undefined ? null : `${declarations}// ${file}\n${dts}\n`;
        }
        return {
            declarations,
            programFiles: withDeclarations ? program.getSourceFiles().map(sf => sf.fileName).sort().join("\n") : "",
            globalScope,
        };
    }

    /** @internal Strangler Fig bridge: inject pre-loaded builderProgram from cache */
    public _injectBuilderProgram(program: ts.EmitAndSemanticDiagnosticsBuilderProgram): void {
        this.builderProgram = program;
    }

    // ─── Temporary Bridge Getters (Strangler Fig) ───
    // These exist ONLY so the kernel can access compiler state
    // for methods not yet migrated (captureBaseline, getFatalErrors,
    // extractCanonicalTypes, attemptAutoHealing, predictBlastRadius).
    // They will be DELETED when those methods move to the backend.

    get tsBuilder(): ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined {
        return this.builderProgram;
    }

    get tsProgram(): ts.Program | undefined {
        return this.builderProgram?.getProgram();
    }

    get tsLanguageService(): ts.LanguageService {
        return this.languageService;
    }

    get isCorrupted(): boolean {
        return this.isStateCorrupted;
    }

    // ─── Bridge for attemptAutoHealing (deleted in Act 5) ───
    get tsLastDiagnostics(): ts.Diagnostic[] {
        return this.lastRawDiagnostics;
    }

    get baselineCount(): number {
        return this.baselineFrequencies.size;
    }



    async getDiagnostics(
        filesToEvaluate: Set<string>,
        explicitlyEditedFiles?: Set<string>,
        mode?: string,
    ): Promise<NrekiStructuredError[]> {
        if (!this.builderProgram) return [];

        const editedFiles = explicitlyEditedFiles || filesToEvaluate;
        const currentMode = mode || "project";

        const currentFrequencies = new Map<string, number>();
        const fatalErrors: ts.Diagnostic[] = [];
        const program = this.builderProgram.getProgram();

        const errorThreshold = Math.min(500, 50 + (editedFiles.size * 20));
        const touchedEnvironment = Array.from(editedFiles).some(isEnvironmentFile);

        const processDiag = (diag: ts.Diagnostic) => {
            if (!diag.file && !touchedEnvironment) return;
            if (isThirdPartyDiagnostic(diag)) return;
            const hash = this.getFingerprint(diag);
            const count = (currentFrequencies.get(hash) || 0) + 1;
            currentFrequencies.set(hash, count);
            if (count > (this.baselineFrequencies.get(hash) || 0)) {
                fatalErrors.push(diag);
            }
        };

        // Shield 1: Global diagnostics
        if (touchedEnvironment) {
            for (const diag of program.getGlobalDiagnostics()) processDiag(diag);
            for (const diag of program.getOptionsDiagnostics()) processDiag(diag);
        }

        // Shield 2: Syntactic + Semantic
        for (const posixPath of filesToEvaluate) {
            const sf = program.getSourceFile(posixPath);
            if (sf) {
                if (editedFiles.has(posixPath)) {
                    for (const diag of program.getSyntacticDiagnostics(sf)) processDiag(diag);
                }
                if (currentMode === "file" || currentMode === "hologram") {
                    for (const diag of program.getSemanticDiagnostics(sf)) processDiag(diag);
                }
            }
        }

        // Shield 3: PROJECT mode cascade
        if (currentMode === "project") {
            let cascadeCount = 0;
            let nextAffected: ts.AffectedFileResult<readonly ts.Diagnostic[]>;

            while ((nextAffected = this.builderProgram!.getSemanticDiagnosticsOfNextAffectedFile())) {
                for (const diag of nextAffected.result as ts.Diagnostic[]) {
                    if (isThirdPartyDiagnostic(diag)) continue;
                    processDiag(diag);
                    if (diag.file && !editedFiles.has(this.toPosix(diag.file.fileName))) {
                        cascadeCount++;
                    }
                }
                if (cascadeCount > errorThreshold) {
                    this.isStateCorrupted = true;
                    // Include first 5 cascade errors so the LLM can diagnose the root cause
                    const cascadeSample = fatalErrors
                        .filter(d => d.file && !editedFiles.has(this.toPosix(d.file.fileName)))
                        .slice(0, 5)
                        .map(d => this.toStructured(d));
                    const sampleText = cascadeSample.length > 0
                        ? `\nSample: ${cascadeSample.map(e => `${e.file}:${e.line} ${e.code} ${e.message.slice(0, 80)}`).join(" | ")}`
                        : "";
                    fatalErrors.push({
                        file: undefined,
                        start: undefined,
                        length: undefined,
                        category: ts.DiagnosticCategory.Error,
                        code: 9999,
                        messageText:
                            `Cascade exceeded threshold (${errorThreshold}). ` +
                            `${cascadeCount} errors in non-edited files. Edit rejected.${sampleText}`,
                    });
                    break;
                }
            }
        }

        // Store raw diagnostics for attemptAutoHealing bridge (until Act 5)
        this.lastRawDiagnostics = fatalErrors;

        return fatalErrors.map(d => this.toStructured(d));
    }

    // Safe fix whitelist: only 100% structural fixes that don't mutate business logic.
    // REMOVED: fixClassDoesntImplementInheritedAbstractMember — inserts throw stubs
    // REMOVED: fixAddMissingMember — inserts throw stubs
    // Both generate `throw new Error("Method not implemented.")` which compiles
    // but crashes unconditionally at runtime. Better to return the error to the LLM.
    // REMOVED (NREKI-GAR-04): fixMissingProperties — fabricates values for missing
    // required fields (0, "", false, and `throw new Error("Function not implemented.")`
    // for methods): it compiles and silently changes business data.
    // KEPT: fixPromiseResolve only adds a `<void>` type argument; fixAddOverrideModifier
    // only adds the `override` keyword. Neither changes runtime behavior.
    private static readonly SAFE_FIXES = new Set([
        "import",
        "fixMissingImport",
        "fixPromiseResolve",
        "fixAddOverrideModifier",
    ]);

    async getAutoFixes(filePath: string, error: NrekiStructuredError): Promise<BackendFix[]> {
        if (!this.languageService) return [];

        // Find the matching raw diagnostic (need byte offsets for TS API)
        const errorCode = Number(error.code.replace("TS", ""));
        // FIX: Match by line+column too. Without this, duplicate error codes
        // (e.g., two TS2304 in the same file) always return the first diagnostic,
        // causing the healer to apply the wrong fix in an infinite micro-rollback loop.
        const rawDiag = this.lastRawDiagnostics.find(d => {
            if (!d.file || d.code !== errorCode || d.start === undefined || d.length === undefined) return false;
            const matchPath = this.toPosix(d.file.fileName) === filePath || this.toPosix(d.file.fileName).endsWith("/" + filePath);
            if (!matchPath) return false;
            const pos = ts.getLineAndCharacterOfPosition(d.file, d.start);
            return (pos.line + 1) === error.line && (pos.character + 1) === error.column;
        });

        if (!rawDiag || rawDiag.start === undefined || rawDiag.length === undefined || !rawDiag.file) {
            return [];
        }

        const posixPath = this.toPosix(rawDiag.file.fileName);
        const formatOptions = ts.getDefaultFormatCodeSettings();
        const preferences: ts.UserPreferences = {};

        const tsFixes = this.languageService.getCodeFixesAtPosition(
            posixPath, rawDiag.start, rawDiag.start + rawDiag.length,
            [errorCode], formatOptions, preferences
        );

        // NREKI-GAR-04: when several modules export the missing name (e.g. two
        // `parseConfig` in ./a and ./b), TS offers one import per module and
        // fixes[0] would pick one blindly — compiling fine while wiring the wrong
        // implementation. Only auto-import when the candidate module is unique.
        const importModules = new Set(
            tsFixes.filter(f => f.fixName === "import").map(f => importFixModule(f.description)),
        );
        const ambiguousImport = importModules.size > 1;

        const results: BackendFix[] = [];
        for (const fix of tsFixes) {
            if (!TsCompilerWrapper.SAFE_FIXES.has(fix.fixName)) continue;
            if (ambiguousImport && fix.fixName === "import") continue;

            results.push({
                description: fix.description,
                changes: fix.changes.map(change => ({
                    filePath: this.toPosix(change.fileName),
                    textChanges: change.textChanges.map(tc => ({
                        start: tc.span.start,
                        length: tc.span.length,
                        newText: tc.newText,
                    })),
                })),
            });
        }

        return results;
    }

    /**
     * The declaration of `symbolName` as the checker resolves it, ready to print:
     * `function f(a: number): string`, `const x: 5`, `interface I { … }`,
     * `type T = …`, `class C { … }`, `enum E { … }`.
     *
     * A symbol has a declared type only when it NAMES a type. Asking for the
     * declared type of a function or a const (as this did for every symbol)
     * answers the error type, printed as `any`: a false contract. Values are
     * resolved with getTypeOfSymbolAtLocation instead.
     */
    public getTypeShape(posixPath: string, symbolName: string): string | null {
        if (!this.builderProgram) return null;
        const program = this.builderProgram.getProgram();
        const checker = program.getTypeChecker();
        const sourceFile = program.getSourceFile(posixPath);
        if (!sourceFile) return null;

        const unalias = (s: ts.Symbol): ts.Symbol =>
            s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;

        // Try exports first
        const fileSymbol = checker.getSymbolAtLocation(sourceFile);
        const exported = fileSymbol?.exports?.get(ts.escapeLeadingUnderscores(symbolName));
        if (exported) return this.describeSymbol(checker, unalias(exported), symbolName);

        // Fallback: top-level declarations that are not exported
        for (const node of sourceFile.statements) {
            const names: ts.Node[] = [];
            if (ts.isVariableStatement(node)) {
                for (const d of node.declarationList.declarations) names.push(d.name);
            } else if (
                (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
                 ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) ||
                 ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) && node.name
            ) {
                names.push(node.name);
            }
            for (const nameNode of names) {
                if (nameNode.getText(sourceFile) !== symbolName) continue;
                const sym = checker.getSymbolAtLocation(nameNode);
                if (sym) return this.describeSymbol(checker, unalias(sym), symbolName);
            }
        }

        return null;
    }

    /** Members shown for one class/interface before the list is cut (token bound). */
    private static readonly SHAPE_MEMBER_CAP = 60;

    private describeSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, name: string): string | null {
        const F = ts.SymbolFlags;
        const full = ts.TypeFormatFlags.NoTruncation;
        const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (!decl) return null;
        const typeParams = (d: ts.Declaration | undefined): string => {
            const tps = (d as ts.DeclarationWithTypeParameterChildren | undefined)?.typeParameters;
            return tps && tps.length > 0 ? `<${tps.map(p => p.getText()).join(", ")}>` : "";
        };
        const typeDecl = (kind: ts.SyntaxKind): ts.Declaration | undefined =>
            symbol.declarations?.find(d => d.kind === kind);
        const parts: string[] = [];

        if (symbol.flags & F.Class) {
            const classDecl = typeDecl(ts.SyntaxKind.ClassDeclaration) ?? decl;
            const members = this.describeMembers(checker, checker.getDeclaredTypeOfSymbol(symbol), classDecl);
            const ctorType = checker.getTypeOfSymbolAtLocation(symbol, classDecl);
            for (const sig of ctorType.getConstructSignatures()) {
                members.push(`new ${checker.signatureToString(sig, classDecl, full, ts.SignatureKind.Construct)}`);
            }
            for (const prop of ctorType.getProperties()) {
                if (prop.getName() === "prototype" || this.isHiddenMember(prop)) continue;
                members.push(`static ${this.describeMember(checker, prop, classDecl)}`);
            }
            parts.push(`class ${name}${typeParams(classDecl)} ${this.braces(members)}`);
        } else if (symbol.flags & F.Interface) {
            const ifaceDecl = typeDecl(ts.SyntaxKind.InterfaceDeclaration) ?? decl;
            const members = this.describeMembers(checker, checker.getDeclaredTypeOfSymbol(symbol), ifaceDecl);
            parts.push(`interface ${name}${typeParams(ifaceDecl)} ${this.braces(members)}`);
        }
        if (symbol.flags & F.TypeAlias) {
            const aliasDecl = typeDecl(ts.SyntaxKind.TypeAliasDeclaration);
            const shape = checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol), undefined,
                full | ts.TypeFormatFlags.InTypeAlias);
            parts.push(`type ${name}${typeParams(aliasDecl)} = ${shape}`);
        }
        if (symbol.flags & F.Enum) {
            const members: string[] = [];
            symbol.exports?.forEach((member) => {
                const d = member.valueDeclaration;
                const value = d && ts.isEnumMember(d) ? checker.getConstantValue(d) : undefined;
                members.push(value === undefined ? member.getName() : `${member.getName()} = ${JSON.stringify(value)}`);
            });
            const keyword = symbol.flags & F.ConstEnum ? "const enum" : "enum";
            parts.push(`${keyword} ${name} { ${members.join(", ")} }`);
        }
        if (symbol.flags & F.Function) {
            const signatures = checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures();
            for (const sig of signatures) {
                parts.push(`function ${name}${checker.signatureToString(sig, decl, full, ts.SignatureKind.Call)}`);
            }
        }
        if (symbol.flags & F.Variable) {
            const varDecl = typeDecl(ts.SyntaxKind.VariableDeclaration) ?? decl;
            const list = varDecl.parent;
            const keyword = ts.isVariableDeclarationList(list)
                ? (list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Let ? "let" : "var")
                : "const";
            const type = checker.getTypeOfSymbolAtLocation(symbol, varDecl);
            parts.push(`${keyword} ${name}: ${checker.typeToString(type, varDecl, full)}`);
        }
        if (parts.length === 0 && symbol.flags & (F.ValueModule | F.NamespaceModule)) {
            const names = checker.getExportsOfModule(symbol).map(e => e.getName());
            parts.push(`namespace ${name} ${this.braces(names)}`);
        }
        return parts.length > 0 ? parts.join("\n") : null;
    }

    private braces(members: string[]): string {
        const cap = TsCompilerWrapper.SHAPE_MEMBER_CAP;
        const shown = members.length > cap
            ? [...members.slice(0, cap), `/* +${members.length - cap} more */`]
            : members;
        return shown.length > 0 ? `{ ${shown.join("; ")}; }` : "{}";
    }

    /** Private/protected members are not part of the shape a consumer can use. */
    private isHiddenMember(member: ts.Symbol): boolean {
        const d = member.valueDeclaration ?? member.declarations?.[0];
        if (!d) return false;
        if (ts.isPrivateIdentifier((d as ts.NamedDeclaration).name ?? d)) return true;
        return (ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0;
    }

    private describeMember(checker: ts.TypeChecker, member: ts.Symbol, location: ts.Node): string {
        const full = ts.TypeFormatFlags.NoTruncation;
        const d = member.valueDeclaration ?? member.declarations?.[0];
        const type = checker.getTypeOfSymbolAtLocation(member, d ?? location);
        const optional = member.flags & ts.SymbolFlags.Optional ? "?" : "";
        if (member.flags & ts.SymbolFlags.Method) {
            const sigs = type.getCallSignatures();
            if (sigs.length > 0) {
                return sigs
                    .map(sig => `${member.getName()}${optional}${checker.signatureToString(sig, location, full, ts.SignatureKind.Call)}`)
                    .join("; ");
            }
        }
        const readonly = d && (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly) ? "readonly " : "";
        return `${readonly}${member.getName()}${optional}: ${checker.typeToString(type, location, full)}`;
    }

    /** Properties, methods, call/construct and index signatures of an object type. */
    private describeMembers(checker: ts.TypeChecker, type: ts.Type, location: ts.Node): string[] {
        const full = ts.TypeFormatFlags.NoTruncation;
        const out: string[] = [];
        for (const prop of checker.getPropertiesOfType(type)) {
            if (!this.isHiddenMember(prop)) out.push(this.describeMember(checker, prop, location));
        }
        for (const sig of type.getCallSignatures()) {
            out.push(checker.signatureToString(sig, location, full, ts.SignatureKind.Call));
        }
        for (const sig of type.getConstructSignatures()) {
            out.push(`new ${checker.signatureToString(sig, location, full, ts.SignatureKind.Construct)}`);
        }
        for (const info of checker.getIndexInfosOfType(type)) {
            const key = checker.typeToString(info.keyType, location, full);
            out.push(`${info.isReadonly ? "readonly " : ""}[key: ${key}]: ${checker.typeToString(info.type, location, full)}`);
        }
        return out;
    }
}
