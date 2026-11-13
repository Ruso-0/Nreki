/**
 * lsp-sidecar-base.ts — LSP Child Process Sidecar (Base Class)
 *
 * Shared infrastructure for spawning and communicating with LSP servers
 * (gopls, pyright) as child processes. Implements JSON-RPC 2.0 framing,
 * LSP lifecycle (initialize/initialized/shutdown/exit), and virtual file
 * overlay via didOpen/didChange.
 *
 * The sidecar is a "mercenary" — it receives files, returns diagnostics,
 * and dies when told to. It has no opinion about the VFS, ACID, or rollback.
 * The Orchestrator (NrekiKernel) holds all authority.
 *
 * @author Jherson Eddie Tintaya Holguin (Ruso-0)
 */

import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import type { NrekiStructuredError } from "../nreki-kernel.js";
import { toPosix as toPosixUtil } from "../../utils/to-posix.js";
import { contentDigest } from "../../utils/file-traits.js";
import { readSource } from "../../utils/read-source.js";
import { logger } from "../../utils/logger.js";
import { resolveExecutable, buildSafeChildEnv, spawnResolved, killProcessTree } from "../../utils/safe-exec.js";

/**
 * ENV WHITELIST: never propagate secrets (API keys, DB passwords, tokens) to
 * third-party LSP binaries operating on untrusted code. Windows system
 * variables (SystemRoot, LOCALAPPDATA, ...) are added by buildSafeChildEnv —
 * without them Winsock fails to initialize and `go` cannot locate its build
 * cache, silently disabling Layer 2 on Windows (NREKI-ROB-01).
 */
const SAFE_ENV_KEYS = [
    "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
    "TMPDIR", "TEMP", "TMP", "TERM",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    // Go toolchain
    "GOPATH", "GOROOT", "GOMODCACHE", "GOCACHE", "GOENV", "GOFLAGS", "GOPROXY",
    "GONOSUMCHECK", "GONOSUMDB", "GOSUMDB", "GOPRIVATE", "GONOPROXY", "GOINSECURE",
    "GOWORK", "GOTOOLCHAIN", "GOTMPDIR", "GOBIN",
    // Python toolchain
    "PYTHONPATH", "VIRTUAL_ENV", "CONDA_DEFAULT_ENV", "CONDA_PREFIX",
    // Node (pyright-langserver runs on Node)
    "NODE_PATH", "NODE_OPTIONS",
];

// ─── JSON-RPC 2.0 Types (strict, zero any) ─────────────────────────

// Patch 5 (v10.5.9): public output shape imports.
import type { LspCodeAction, LspTextEdit } from "../types.js";

// ─── LSP JSON-RPC Protocol Shapes (internal) ──────────────────
// What the wire carries. Explicit instead of `any` so the cast on the
// JSON-RPC response is a single documented assertion about the LSP
// protocol contract, not a scattered permissive type.
// Patch 7 (v10.6.1): typed JSON-RPC responses for initialize & pull diagnostics.
interface LspProtocolInitializeResult {
    capabilities?: {
        diagnosticProvider?: boolean | {
            interFileDependencies?: boolean;
            workspaceDiagnostics?: boolean;
        };
    };
    serverInfo?: {
        name?: string;
        version?: string;
    };
}

interface LspProtocolDiagnosticResult {
    items?: LspDiagnostic[];
}

interface LspProtocolRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface LspProtocolTextEdit {
    range: LspProtocolRange;
    newText: string;
}

interface LspProtocolTextDocumentEdit {
    textDocument?: { uri: string };
    edits?: LspProtocolTextEdit[];
}

interface LspProtocolWorkspaceEdit {
    changes?: { [uri: string]: LspProtocolTextEdit[] };
    documentChanges?: LspProtocolTextDocumentEdit[];
}

interface LspProtocolCodeAction {
    title?: string;
    kind?: string;
    edit?: LspProtocolWorkspaceEdit;
}

interface RpcRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: unknown;
}

interface RpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}

interface RpcResponseError {
    code: number;
    message: string;
}

/** Our answer to a request the SERVER sent us. */
interface RpcResponse {
    jsonrpc: "2.0";
    id: number | string;
    result?: unknown;
    error?: RpcResponseError;
}

/** What can arrive from the server: a response, a request (method + id) or a notification. */
interface RpcIncoming {
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: RpcResponseError;
}

const METHOD_NOT_FOUND = -32601;

/** An error the server answered a request with; keeps the JSON-RPC code. */
class LspRequestError extends Error {
    constructor(message: string, public readonly code: number | undefined) {
        super(message);
    }
}

/** Server requests that only need an acknowledgement. */
const ACKNOWLEDGED_SERVER_REQUESTS = new Set([
    "client/registerCapability",
    "client/unregisterCapability",
    "workspace/diagnostic/refresh",
    "window/workDoneProgress/create",
]);

// ─── LSP Diagnostic Types ───────────────────────────────────────────

export interface LspPosition {
    line: number;
    character: number;
}

export interface LspRange {
    start: LspPosition;
    end: LspPosition;
}

interface LspDiagnostic {
    range: LspRange;
    severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
    code?: number | string;
    source?: string;
    message: string;
}

// ─── Pending Request Tracker ────────────────────────────────────────

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

// ─── Base Class ─────────────────────────────────────────────────────

export abstract class LspSidecarBase {
    /** LSP command to spawn (e.g., ["gopls", "serve"]) */
    public readonly command: readonly string[];
    /** LSP language identifier (e.g., "go", "python") */
    public readonly languageId: string;

    private proc?: ChildProcess;
    private buffer: Buffer = Buffer.alloc(0);
    private requestId = 0;
    private pendingRequests = new Map<number, PendingRequest>();
    // All three maps are keyed by a CANONICAL path key (see pathKey/uriKey), not
    // by raw URI: servers echo URIs back percent-encoded and normalized
    // (`My%20Project`, `d%3A`), which never string-matched NREKI's own URIs
    // and silently dropped every diagnostic (NREKI-INT-04).
    private diagnostics = new Map<string, LspDiagnostic[]>();
    private openedFiles = new Map<string, { uri: string; filePath: string }>();
    private docVersions = new Map<string, number>();
    /** Digest of the text last sent for each open document (see isInSync). */
    private sentDigest = new Map<string, string>();
    /** A pull round failed part-way: `diagnostics` may describe older content. */
    private diagnosticsStale = false;
    /** `mtimeMs:size` of the disk file when an open document was last known to equal it. */
    private diskStamp = new Map<string, string>();
    /** Recency of each open document (see evictIdleDocuments). */
    private lastUse = new Map<string, number>();
    private useClock = 0;

    /**
     * Documents kept open at most. Every edited file and every dependent opened
     * to be checked stays open (its diagnostics are pulled on each edit), so
     * without a bound a long session pulled an ever-growing set.
     */
    public static readonly MAX_OPEN_DOCUMENTS = 96;

    protected readonly spawnEnv?: Record<string, string>;
    protected realProjectRoot: string;
    protected workspaceUri: string;

    /** True if the process has exited or failed to boot. */
    public isDead = false;

    /**
     * True once the server advertised textDocument/diagnostic (pull model) or
     * answered one. Until then the first round tries a pull anyway: gopls and
     * pyright both answer it without advertising it in `initialize`.
     */
    protected supportsPullDiagnostics = false;
    /** The server answered a pull with "method not found": it only pushes. */
    private pullRejected = false;

    // ─── Settle Debounce ────────────────────────────────────────────
    private settleResolvers: Array<() => void> = [];
    private settleTimer?: ReturnType<typeof setTimeout>;
    private settleMs = 150;

    // ─── Anti-Zombie Guard ──────────────────────────────────────────
    private readonly killFn: () => void;

    constructor(
        projectRoot: string,
        command: string[],
        languageId: string,
        spawnEnv?: Record<string, string>,
    ) {
        this.realProjectRoot = projectRoot;
        this.command = command;
        this.languageId = languageId;
        this.spawnEnv = spawnEnv;
        // The workspace IS the real project. No tmp dirs. No fake go.mod.
        this.workspaceUri = this.toUri(projectRoot);

        // Anti-Zombie Guard: kill child process if Node exits unexpectedly.
        // Listeners are attached in ensureReady() (when proc exists) and removed
        // in shutdown() and proc "exit" to prevent MaxListenersExceededWarning.
        this.killFn = () => { this.forceKill(); };
    }

    // ─── Path Utilities ─────────────────────────────────────────────

    // POSIX normalization — delegates to shared utility
    protected toPosix(p: string): string { return toPosixUtil(p); }

    /** RFC 8089 file URI with proper percent-encoding (spaces, #, non-ASCII). */
    private toUri(p: string): string {
        return pathToFileURL(path.resolve(p)).href;
    }

    /** Canonical key for a filesystem path (case-insensitive on Windows). */
    private pathKey(p: string): string {
        const n = this.toPosix(path.resolve(p));
        return process.platform === "win32" ? n.toLowerCase() : n;
    }

    /** Canonical key for a URI received from the server. */
    private uriKey(uri: string): string {
        const p = this.uriToPath(uri);
        return p === null ? uri : this.pathKey(p);
    }

    /** Decode a file URI (handles %20, %3A drive colons, UTF-8). Null for non-file URIs. */
    private uriToPath(uri: string): string | null {
        try {
            return this.toPosix(fileURLToPath(uri));
        } catch {
            return null;
        }
    }

    /** True if NREKI has an in-memory overlay open for this file. */
    public hasOpenDocument(filePath: string): boolean {
        return this.openedFiles.has(this.pathKey(filePath));
    }

    /** Number of documents currently open in the server. */
    public openDocumentCount(): number {
        return this.openedFiles.size;
    }

    /**
     * Files compiled together with `filePath` although they do not import it
     * (Go: the other files of its package). The kernel opens them with the edit;
     * importers come from the dependency graph. None by default.
     */
    public companionFiles(_filePath: string): string[] {
        return [];
    }

    // ─── Lifecycle ──────────────────────────────────────────────────

    /**
     * Spawn the LSP server and perform the initialize handshake.
     * Throws if the binary is not found or initialize times out.
     */
    async boot(): Promise<void> {
        if (this.proc) return;
        this.isDead = false;

        return new Promise<void>((resolve, reject) => {
            try {
                // NREKI-SEC-03: resolve the binary to an absolute path from trusted
                // PATH entries ONLY. A bare name handed to spawn()/cmd.exe with
                // cwd = the repository would run a planted gopls.exe /
                // basedpyright-langserver.cmd from the repo root on Windows.
                const executable = resolveExecutable(this.command[0], { projectRoot: this.realProjectRoot });
                if (!executable) {
                    const msg = `[NREKI] ${this.command[0]} spawn failed: not found in a trusted PATH entry ` +
                        `(the working directory and in-project node_modules bins are never searched)`;
                    logger.error(msg);
                    this.cleanupState(msg);
                    reject(new Error(msg));
                    return;
                }
                const finalEnv = buildSafeChildEnv(SAFE_ENV_KEYS, this.spawnEnv);

                this.proc = spawnResolved(executable, this.command.slice(1), {
                    cwd: this.realProjectRoot,
                    env: finalEnv,
                    stdio: ["pipe", "pipe", "pipe"],
                    detached: process.platform !== "win32",
                    windowsHide: true,
                });

                // Attach anti-zombie listeners now that proc exists
                process.on("exit", this.killFn);
                process.on("SIGINT", this.killFn);
                process.on("SIGTERM", this.killFn);

                // ENOENT handler: binary not found in PATH
                this.proc.on("error", (err: NodeJS.ErrnoException) => {
                    const isNotFound = err.code === "ENOENT";
                    const msg = `[NREKI] ${this.command[0]} spawn failed: ${isNotFound ? "not found in PATH" : err.message}`;
                    logger.error(msg);
                    this.cleanupState(msg);
                });

                // Capture stderr for debugging
                if (this.proc.stderr) {
                    this.proc.stderr.on("data", (chunk: Buffer) => {
                        const msg = chunk.toString("utf-8").trim();
                        if (msg) logger.debug(`[${this.languageId}] ${msg}`);
                    });
                }

                // JSON-RPC frame parser
                if (this.proc.stdout) {
                    this.proc.stdout.on("data", (chunk: Buffer) => this.handleData(chunk));
                }

                // Clean exit: no redundant kill, prevent Windows ESRCH crash
                this.proc.on("exit", () => {
                    this.cleanupState(`[NREKI] ${this.command[0]} process exited unexpectedly`);
                });

                // LSP initialize handshake (10s timeout)
                const initializationOptions = this.initializationOptions();
                this.request("initialize", {
                    processId: process.pid,
                    rootUri: this.workspaceUri,
                    capabilities: {
                        textDocument: {
                            publishDiagnostics: { relatedInformation: true },
                            // dynamicRegistration: pyright only serves pull diagnostics
                            // to clients that accept client/registerCapability.
                            diagnostic: { dynamicRegistration: true },
                        },
                    },
                    workspaceFolders: [
                        { uri: this.workspaceUri, name: path.basename(this.realProjectRoot) },
                    ],
                    ...(initializationOptions ? { initializationOptions } : {}),
                }, 10_000)
                    .then((initResult) => {
                        // Detect pull diagnostics support from server capabilities
                        const serverCaps = initResult as LspProtocolInitializeResult;
                        if (serverCaps?.capabilities?.diagnosticProvider) {
                            this.supportsPullDiagnostics = true;
                            logger.info(`${this.command[0]} supports pull diagnostics (deterministic mode).`);
                        }
                        this.notifyLsp("initialized", {});
                        logger.info(`${this.command[0]} sidecar booted successfully.`);
                        resolve();
                    })
                    .catch((e) => {
                        this.forceKill();
                        reject(e);
                    });
            } catch (e) {
                const errMsg = e instanceof Error ? e.message : String(e);
                this.cleanupState(`[NREKI] Synchronous boot failure for ${this.command[0]}: ${errMsg}`);
                reject(e);
            }
        });
    }

    /** Server-specific settings sent with `initialize` (none by default). */
    protected initializationOptions(): Record<string, unknown> | undefined {
        return undefined;
    }

    /** Check if the child process is alive and responding. */
    isHealthy(): boolean {
        return !!this.proc && this.proc.exitCode === null && !this.isDead;
    }

    /**
     * SSOT (Single Source of Truth) para el ciclo de vida final.
     * Idempotente: previene ejecución redundante si exit y forceKill colisionan.
     * Simétrico: limpia TODO sin importar por qué murió el proceso.
     */
    private cleanupState(reasonMsg: string): void {
        if (this.isDead) return;
        this.isDead = true;
        this.openedFiles.clear();
        this.docVersions.clear();
        this.diagnostics.clear();
        this.sentDigest.clear();
        this.diskStamp.clear();
        this.lastUse.clear();
        this.diagnosticsStale = false;
        // A respawned server is asked again how it delivers diagnostics.
        this.supportsPullDiagnostics = false;
        this.pullRejected = false;

        // 1. Settle Timers
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
            this.settleTimer = undefined;
        }
        const queue = this.settleResolvers;
        this.settleResolvers = [];
        for (const r of queue) r();

        // 2. Pending Request Timers (limpieza explícita, sin closures)
        const err = new Error(reasonMsg);
        for (const { reject, timer } of this.pendingRequests.values()) {
            clearTimeout(timer);
            reject(err);
        }
        this.pendingRequests.clear();

        // 3. Process listeners
        process.removeListener("exit", this.killFn);
        process.removeListener("SIGINT", this.killFn);
        process.removeListener("SIGTERM", this.killFn);

        this.proc = undefined;
    }

    public forceKill(): void {
        if (this.proc) {
            try {
                if (this.proc.stdin && !this.proc.stdin.destroyed) {
                    this.proc.stdin.end();
                    this.proc.stdin.destroy();
                }
                // Kill the whole tree: process group (-pid) on POSIX, taskkill /T on
                // Windows — killing only the cmd.exe wrapper of a .cmd shim left
                // node/pyright running as an orphan holding file locks.
                killProcessTree(this.proc);
            } catch { /* already dead */ }
        }
        this.cleanupState(`[NREKI] ${this.command[0]} process tree terminated forcefully`);
    }

    /**
     * Graceful shutdown: send LSP shutdown → exit.
     * If unresponsive after 3s, SIGKILL.
     */
    async shutdown(): Promise<void> {
        if (!this.proc) return;
        try {
            await this.request("shutdown", null, 3_000);
            this.notifyLsp("exit", null);
        } catch {
            // Unresponsive — force kill
        }
        this.forceKill();
    }

    // ─── Validation ─────────────────────────────────────────────────

    /**
     * Send virtual edits to the LSP server and collect diagnostics.
     * Uses didOpen (first time) or didChange (subsequent) to overlay
     * file content in the LSP server's memory.
     *
     * Waits for diagnostics to settle (150ms quiet period, 5s max).
     * Returns only severity=1 (Error) diagnostics as NrekiStructuredError[],
     * for EVERY open document — including errors that were there before the
     * edit. The kernel subtracts baselineErrors() to keep only the new ones.
     */
    async validateEdits(
        edits: Array<{ filePath: string; content: string | null }>,
    ): Promise<NrekiStructuredError[]> {
        if (!this.proc || this.isDead) return [];
        this.touch(edits.map(e => this.pathKey(e.filePath)));
        if (this.applyEdits(edits) || this.diagnosticsStale) await this.refreshDiagnostics();
        return this.collectErrors();
    }

    /**
     * Errors of every open document with `docs` at their PRE-EDIT content: the
     * baseline a later validateEdits() is compared against, so an error that
     * was already there does not reject the edit. Documents not open yet (or
     * open at another content) are synced first. When all are in sync the
     * cached diagnostics are returned without any request to the server.
     *
     * `alsoOpen` names the files that depend on the edited ones (same package,
     * importers): the server only reports open documents, so a dependent that
     * was never opened could be broken without a trace. They are opened from
     * disk, and every open document outside `docs` is brought back to its disk
     * content before the baseline is read.
     */
    async baselineErrors(
        docs: Array<{ filePath: string; content: string | null }>,
        alsoOpen: readonly string[] = [],
    ): Promise<NrekiStructuredError[]> {
        if (!this.proc || this.isDead) return [];
        const inTransaction = new Set(docs.map(d => this.pathKey(d.filePath)));
        const needed = new Set(inTransaction);
        for (const p of alsoOpen) needed.add(this.pathKey(p));
        this.touch(needed);
        const outOfSync = docs.filter(d => !this.isInSync(d.filePath, d.content));
        let changed = this.applyEdits(outOfSync);
        if (this.openFromDisk(alsoOpen)) changed = true;
        if (this.followDisk(inTransaction)) changed = true;
        this.evictIdleDocuments(needed);
        if (changed || this.diagnosticsStale) await this.refreshDiagnostics();
        return this.collectErrors();
    }

    /** Open, with their disk content, the files of `paths` that are not open yet. */
    private openFromDisk(paths: readonly string[]): boolean {
        const toOpen: Array<{ filePath: string; content: string }> = [];
        const stamps = new Map<string, string>();
        for (const filePath of paths) {
            const key = this.pathKey(filePath);
            if (this.openedFiles.has(key) || stamps.has(key)) continue;
            try {
                const st = fs.statSync(filePath);
                if (!st.isFile()) continue;
                toOpen.push({ filePath, content: readSource(filePath) });
                stamps.set(key, `${st.mtimeMs}:${st.size}`);
            } catch { /* listed by a stale graph, or unreadable: nothing to open */ }
        }
        if (toOpen.length === 0) return false;
        const changed = this.applyEdits(toOpen);
        for (const [key, stamp] of stamps) this.diskStamp.set(key, stamp);
        return changed;
    }

    private touch(keys: Iterable<string>): void {
        for (const key of keys) this.lastUse.set(key, ++this.useClock);
    }

    /**
     * An open document outside the transaction must mirror the disk. Its
     * overlay otherwise keeps the text it was opened with for the whole
     * session, and a file changed since (IDE save, git checkout, formatter)
     * was type-checked at its old content. Stat first: no read when unchanged.
     */
    private followDisk(inTransaction: ReadonlySet<string>): boolean {
        const stale: Array<{ filePath: string; content: string | null }> = [];
        const rewritten = new Map<string, string>(); // key → stamp of the content sent
        for (const [key, opened] of this.openedFiles) {
            if (inTransaction.has(key)) continue;
            let stamp: string;
            try {
                const st = fs.statSync(opened.filePath);
                stamp = `${st.mtimeMs}:${st.size}`;
            } catch {
                stale.push({ filePath: opened.filePath, content: null }); // gone: applyEdits closes it
                continue;
            }
            if (this.diskStamp.get(key) === stamp) continue;
            let content: string;
            try { content = readSource(opened.filePath); } catch { continue; }
            if (this.sentDigest.get(key) === contentDigest(content)) {
                this.diskStamp.set(key, stamp);
                continue;
            }
            stale.push({ filePath: opened.filePath, content });
            rewritten.set(key, stamp);
        }
        if (stale.length === 0) return false;
        const changed = this.applyEdits(stale);
        // applyEdits drops the stamp of every document it rewrites; these equal the disk again.
        for (const [key, stamp] of rewritten) this.diskStamp.set(key, stamp);
        return changed;
    }

    /**
     * Close the least recently used documents beyond MAX_OPEN_DOCUMENTS. Only
     * documents outside the transaction, which followDisk just made equal to
     * the disk: closing one changes nothing for the server.
     */
    private evictIdleDocuments(inTransaction: ReadonlySet<string>): void {
        const excess = this.openedFiles.size - LspSidecarBase.MAX_OPEN_DOCUMENTS;
        if (excess <= 0) return;
        const idle = [...this.openedFiles.keys()]
            .filter(key => !inTransaction.has(key))
            .sort((a, b) => (this.lastUse.get(a) ?? 0) - (this.lastUse.get(b) ?? 0))
            .slice(0, excess);
        for (const key of idle) {
            const opened = this.openedFiles.get(key)!;
            this.notifyLsp("textDocument/didClose", { textDocument: { uri: opened.uri } });
            this.forgetDocument(key);
        }
    }

    private forgetDocument(key: string): void {
        this.openedFiles.delete(key);
        this.docVersions.delete(key);
        this.diagnostics.delete(key);
        this.sentDigest.delete(key);
        this.diskStamp.delete(key);
        this.lastUse.delete(key);
    }

    /** True if the overlay already holds exactly this content (null = not open). */
    private isInSync(filePath: string, content: string | null): boolean {
        const key = this.pathKey(filePath);
        if (content === null) return !this.openedFiles.has(key);
        return this.sentDigest.get(key) === contentDigest(content);
    }

    /** Overlay each edit in the server (didOpen / didChange / didClose). True if anything was sent. */
    private applyEdits(edits: Array<{ filePath: string; content: string | null }>): boolean {
        let changed = false;
        for (const edit of edits) {
            const key = this.pathKey(edit.filePath);
            const opened = this.openedFiles.get(key);
            const uri = opened?.uri ?? this.toUri(edit.filePath);

            if (edit.content === null) {
                if (opened && !fs.existsSync(path.normalize(edit.filePath))) {
                    // Absent on disk (a rollback or resync of a file that never reached
                    // it, or one deleted outside NREKI): close the overlay. An empty
                    // open buffer is a syntax error in gopls ("expected ';', found 'EOF'")
                    // and errors of EVERY open file are collected, so it failed each
                    // later Go validation. (pyright 1.1.414 does not resolve imports
                    // to a buffer that is absent on disk, so there it was harmless.)
                    this.notifyLsp("textDocument/didClose", { textDocument: { uri } });
                    this.forgetDocument(key);
                    changed = true;
                } else if (opened) {
                    // Tombstone for a pending deletion: the file is still on disk, so
                    // DO NOT use didClose (the LSP would re-read the old file). Empty
                    // content forces import errors in dependents (correct behavior).
                    const nextVer = (this.docVersions.get(key) || 1) + 1;
                    this.docVersions.set(key, nextVer);
                    this.notifyLsp("textDocument/didChange", {
                        textDocument: { uri, version: nextVer },
                        contentChanges: [{ text: "" }],
                    });
                    this.diagnostics.delete(key);
                    this.sentDigest.delete(key);
                    this.diskStamp.delete(key);
                    changed = true;
                }
            } else if (!opened) {
                // First time: didOpen
                this.notifyLsp("textDocument/didOpen", {
                    textDocument: { uri, languageId: this.languageId, version: 1, text: edit.content },
                });
                this.openedFiles.set(key, { uri, filePath: this.toPosix(path.resolve(edit.filePath)) });
                this.docVersions.set(key, 1);
                this.sentDigest.set(key, contentDigest(edit.content));
                this.diskStamp.delete(key);
                changed = true;
            } else {
                // Subsequent: didChange (full content replacement)
                // FIX: Date.now() overflows int32 in gopls. Use monotonic counter.
                const nextVer = (this.docVersions.get(key) || 1) + 1;
                this.docVersions.set(key, nextVer);
                this.notifyLsp("textDocument/didChange", {
                    textDocument: { uri, version: nextVer },
                    contentChanges: [{ text: edit.content }],
                });
                this.sentDigest.set(key, contentDigest(edit.content));
                this.diskStamp.delete(key);
                changed = true;
            }
        }
        return changed;
    }

    /** Collect diagnostics: pull (deterministic) or push (settle timer). */
    private async refreshDiagnostics(): Promise<void> {
        // Errors are only collected from open documents.
        if (this.openedFiles.size === 0) return;

        if (!this.pullRejected) {
            // PULL MODE: Request diagnostics for ALL open files, not just edited ones.
            // This catches cross-file breakage (editing api.py breaks consumer.py).
            // The cache is flagged until a round completes, so it is never served
            // as a baseline.
            this.diagnosticsStale = true;
            try {
                await Promise.all(
                    [...this.openedFiles].map(([key, f]) => this.pullDiagnostics(key, f.uri)),
                );
                this.diagnosticsStale = false;
                this.supportsPullDiagnostics = true;
                return;
            } catch (err) {
                // A failed pull REJECTS: the kernel then reports "validation failed"
                // instead of silently returning zero errors (fail-open). The one
                // exception is a server that never offered pull diagnostics and
                // answers "method not found": it delivers them by push.
                const notOffered = !this.supportsPullDiagnostics &&
                    err instanceof LspRequestError && err.code === METHOD_NOT_FOUND;
                if (!notOffered) throw err;
                this.pullRejected = true;
                this.diagnosticsStale = false;
                logger.info(`${this.command[0]} has no pull diagnostics; waiting for published ones.`);
            }
        }
        // PUSH MODE (fallback): wait for the server to publish diagnostics. A
        // publish that arrived while the pull was being refused still resolves
        // this wait: the settle timer reads the waiters when it fires.
        await this.waitForSettle(5_000, 150);
    }

    /**
     * Errors of ALL open documents (severity 1 only), as last reported.
     * Cross-file: if editing file A breaks file B, we catch it here.
     */
    private collectErrors(): NrekiStructuredError[] {
        const errors: NrekiStructuredError[] = [];
        for (const [key, opened] of this.openedFiles) {
            const diags = this.diagnostics.get(key) || [];

            for (const d of diags) {
                if (d.severity === 1) {
                    errors.push({
                        file: opened.filePath,
                        line: d.range.start.line + 1,
                        column: d.range.start.character + 1,
                        code: d.source ? `${this.languageId}-${d.source}` : this.languageId,
                        message: d.message,
                    });
                }
            }
        }
        return errors;
    }

    /**
     * Pull diagnostics for a specific file (LSP 3.17+).
     * Deterministic: waits for the server's actual response.
     * No timers. No race conditions.
     */
    private async pullDiagnostics(key: string, uri: string): Promise<void> {
        // Errors propagate on purpose: push notifications are ignored in pull
        // mode (see handleData), so there is no fallback to "fall through" to.
        const result = await this.request("textDocument/diagnostic", {
            textDocument: { uri },
        }, 10_000) as LspProtocolDiagnosticResult;

        // Pull response contains items directly (not via notification)
        this.diagnostics.set(key, result?.items && Array.isArray(result.items) ? result.items : []);
    }

    /**
     * Request code actions (quickfixes) for a diagnostic.
     * Returns TextEdit[] that the kernel can apply to VFS.
     * The kernel decides if the fix is safe (whitelist).
     */
    async requestCodeActions(
        filePath: string,
        diagnostic: { range: LspRange; message: string; code?: number | string; source?: string }
    ): Promise<LspCodeAction[]> {
        if (!this.proc || this.isDead) return [];

        const uri = this.openedFiles.get(this.pathKey(filePath))?.uri ?? this.toUri(filePath);

        try {
            // AUDIT FIX (Patch 5 / v10.5.9): JSON-RPC response is unknown at
            // the type layer; cast to explicit LspProtocolCodeAction[] shape.
            const result = await this.request("textDocument/codeAction", {
                textDocument: { uri },
                range: diagnostic.range,
                context: {
                    diagnostics: [{
                        range: diagnostic.range,
                        message: diagnostic.message,
                        code: diagnostic.code,
                        source: diagnostic.source,
                    }],
                    only: ["quickfix"],
                },
            }, 5_000) as LspProtocolCodeAction[] | null;

            if (!result || !Array.isArray(result)) return [];

            const actions: LspCodeAction[] = [];

            for (const action of result) {
                if (!action.edit?.documentChanges && !action.edit?.changes) continue;
                const edits: LspTextEdit[] = [];
                // Decode every target URI to a real absolute path (handles %20,
                // %3A drive colons, UTF-8). An undecodable URI poisons the whole
                // action — a partially applied CodeAction is worse than none.
                let undecodable = false;

                const changes = action.edit?.changes || {};
                for (const [changeUri, textEdits] of Object.entries(changes)) {
                    const filePathFromUri = this.uriToPath(changeUri);
                    if (filePathFromUri === null) { undecodable = true; break; }
                    for (const te of textEdits) {
                        edits.push({ filePath: filePathFromUri, range: te.range, newText: te.newText });
                    }
                }

                for (const dc of action.edit?.documentChanges || []) {
                    if (undecodable) break;
                    if (!dc.edits) continue;
                    const filePathFromUri = this.uriToPath(dc.textDocument?.uri || "");
                    if (filePathFromUri === null) { undecodable = true; break; }
                    for (const te of dc.edits) {
                        edits.push({ filePath: filePathFromUri, range: te.range, newText: te.newText });
                    }
                }

                if (!undecodable && edits.length > 0) {
                    actions.push({ title: action.title || "LSP Auto-Fix", edits });
                }
            }

            return actions;
        } catch {
            return [];
        }
    }

    // ─── JSON-RPC Engine ────────────────────────────────────────────

    /** Parse incoming JSON-RPC frames from stdout. Uses Buffer (not string) for emoji safety. */
    /** Max buffer size (10MB) — prevents unbounded growth from malformed LSP responses. */
    private static MAX_BUFFER = 10 * 1024 * 1024;

    private handleData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        if (this.buffer.length > LspSidecarBase.MAX_BUFFER) {
            logger.error(`[${this.languageId}] LSP buffer exceeded 10MB — stream corrupted, restarting sidecar`);
            // Kill and restart: truncating the buffer desynchronizes the JSON-RPC
            // stream permanently (remaining fragments lack Content-Length headers).
            this.forceKill();
            return;
        }

        while (true) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) break;

            const headerStr = this.buffer.toString("utf-8", 0, headerEnd);
            const match = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                // Malformed header — skip it
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }

            const bodyLen = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (this.buffer.length < bodyStart + bodyLen) break; // Wait for more TCP data

            const bodyBuf = this.buffer.subarray(bodyStart, bodyStart + bodyLen);
            this.buffer = this.buffer.subarray(bodyStart + bodyLen);

            try {
                const msg = JSON.parse(bodyBuf.toString("utf-8")) as RpcIncoming;

                if (typeof msg.method === "string") {
                    // A message WITH a method is never a response. With an id it is a
                    // request from the server: both sides number their requests from
                    // small integers, so treating "id we are waiting on" as "our
                    // response" resolved a pending pull with `undefined` — zero
                    // diagnostics, a silent pass (pyright sends ids 0, 1, 2…).
                    if (msg.id !== undefined && msg.id !== null) {
                        this.answerServerRequest(msg.id, msg.method, msg.params);
                    } else if (msg.method === "textDocument/publishDiagnostics") {
                        // RACE CONDITION GUARD: In pull mode, ignore async push notifications.
                        // The LSP may send stale pushes after we've already received the
                        // authoritative pull response, overwriting fresh data with old data.
                        if (!this.supportsPullDiagnostics) {
                            const params = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
                            this.diagnostics.set(this.uriKey(params.uri), params.diagnostics);
                            this.triggerSettle();
                        }
                    }
                    // Other notifications (window/logMessage, etc.) — ignore
                } else if (typeof msg.id === "number" && this.pendingRequests.has(msg.id)) {
                    // Response to a request we sent
                    const pending = this.pendingRequests.get(msg.id)!;
                    this.pendingRequests.delete(msg.id);

                    clearTimeout(pending.timer);

                    if (msg.error) {
                        pending.reject(new LspRequestError(msg.error.message, msg.error.code));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
            } catch {
                // Malformed JSON — skip isolated frame
            }
        }
    }

    /** Send a JSON-RPC request and wait for response. Rejects on timeout. */
    protected request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
        if (!this.proc || this.isDead) {
            return Promise.reject(new Error(`[NREKI] ${this.command[0]} is not running`));
        }
        const id = ++this.requestId;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`[NREKI] LSP request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timer });

            const msg: RpcRequest = { jsonrpc: "2.0", id, method, params };
            this.sendRaw(msg);
        });
    }

    /** Send a JSON-RPC notification (no response expected). */
    private notifyLsp(method: string, params: unknown): void {
        const msg: RpcNotification = { jsonrpc: "2.0", method, params };
        this.sendRaw(msg);
    }

    /**
     * Answer a request the server sent. An unanswered request can stall the
     * server (pyright awaits client/registerCapability before it serves pulls).
     */
    private answerServerRequest(id: number | string, method: string, params: unknown): void {
        if (method === "workspace/configuration") {
            // One entry per requested section; null = "use your default".
            const items = (params as { items?: unknown[] } | undefined)?.items;
            this.sendRaw({ jsonrpc: "2.0", id, result: Array.isArray(items) ? items.map(() => null) : [] });
        } else if (ACKNOWLEDGED_SERVER_REQUESTS.has(method)) {
            this.sendRaw({ jsonrpc: "2.0", id, result: null });
        } else {
            this.sendRaw({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } });
        }
    }

    /** Write a JSON-RPC message to the child process stdin. */
    private sendRaw(msg: RpcRequest | RpcNotification | RpcResponse): void {
        if (!this.proc?.stdin || this.isDead) return;
        const body = JSON.stringify(msg);
        try {
            this.proc.stdin.write(
                `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`,
            );
        } catch {
            // Broken pipe — process is dying
        }
    }

    // ─── Settle Debounce ────────────────────────────────────────────

    /** Signal that new diagnostics arrived — reset the settle timer. */
    private triggerSettle(): void {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            const queue = this.settleResolvers;
            this.settleResolvers = [];
            for (const r of queue) r();
        }, this.settleMs);
    }

    /** Wait until diagnostics stop arriving, with a hard timeout. */
    private waitForSettle(maxMs: number, settleMs: number): Promise<void> {
        this.settleMs = settleMs;
        return new Promise<void>((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            const timeout = setTimeout(() => {
                const idx = this.settleResolvers.indexOf(settleCallback);
                if (idx !== -1) this.settleResolvers.splice(idx, 1);
                done();
            }, maxMs);

            const settleCallback = () => {
                clearTimeout(timeout);
                done();
            };
            this.settleResolvers.push(settleCallback);
        });
    }
}
