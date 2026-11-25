/**
 * hooks/cognitive-enforcer.ts — Capa 2 del Escudo Cognitivo.
 * State machine en RAM. Falla en 1ms. Cero I/O pesado.
 * Sincroniza pasaportes a disco para resiliencia en reinicios MCP.
 */

import fs from "fs";
import path from "path";
import { quarantineFile, signState, verifyState } from "../utils/trust.js";
import { memberName, splitQualifiedName } from "../utils/qualified-name.js";
import { writeStateFile } from "../utils/path-jail.js";

/**
 * Patch 7 (v10.6.1): superset of params the enforcer inspects across
 * tools/actions. All fields optional because different tools populate
 * different subsets; the enforcer reads permissively and shortcircuits
 * on anything it doesn't recognize. The per-edit shape is wider than
 * semantic-edit's BatchEditOp (mode is plain string, not EditMode) so
 * the enforcer can consume raw router-layer input without casts.
 */
interface EnforcerInput {
    path?: string;
    symbol?: string;
    mode?: string;
    focus?: string;
    edits?: Array<{
        path?: string;
        symbol?: string;
        mode?: string;
        search_text?: string;
        replace_text?: string;
        new_code?: string;
    }>;
    _nreki_bypass?: string;
}

interface FilePassport {
    outlined: boolean;
    rawRead: boolean;
    focusedSymbols: Set<string>;
}

/**
 * Was `symbol` read? Read `redeem`, edit `RecoveryCodes.redeem`: yes, the bare
 * read showed it. Read `RecoveryCodes.redeem`, edit `redeem`: yes (the edit
 * refuses a bare name that two classes define). Read `RecoveryCodes.redeem`,
 * edit `InviteCodes.redeem`: no — a read used to register the bare member too,
 * which unlocked every class's `redeem`.
 */
function sawSymbol(pass: FilePassport, symbol: string): boolean {
    if (pass.focusedSymbols.has(symbol)) return true;
    const q = splitQualifiedName(symbol);
    if (q) {
        return pass.focusedSymbols.has(q.member)
            || pass.focusedSymbols.has(q.container)
            || pass.focusedSymbols.has(`${q.container}.${q.member}`);
    }
    for (const seen of pass.focusedSymbols) if (memberName(seen) === symbol) return true;
    return false;
}

interface EnforcerState {
    files: Record<string, { outlined: boolean; rawRead: boolean; focusedSymbols: string[] }>;
}

export class CognitiveEnforcer {
    private passports = new Map<string, FilePassport>();
    private projectRoot: string;
    private stateFile: string;

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
        this.stateFile = path.join(projectRoot, ".nreki", "enforcer-state.json");
        this.loadState();
    }

    private loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"), (k, v) => {
                    if (k === "__proto__" || k === "constructor" || k === "prototype") return undefined;
                    return v;
                }) as EnforcerState & { tag?: unknown };
                const { tag, ...data } = parsed;
                // A passport file shipped with a repo would pre-grant "already read"
                // for any file and switch off the blind-edit rule (S-04): only a
                // state signed on this machine is loaded (utils/trust.ts).
                if (!verifyState("enforcer", JSON.stringify(data), tag)) {
                    quarantineFile(this.stateFile);
                    return;
                }
                if (data.files) {
                    for (const [filePath, p] of Object.entries(data.files)) {
                        this.passports.set(filePath, {
                            outlined: !!p.outlined,
                            rawRead: !!p.rawRead,
                            focusedSymbols: new Set(p.focusedSymbols || [])
                        });
                    }
                }
            }
        } catch {}
    }

    private saveState() {
        try {
            const data: EnforcerState = { files: {} };
            for (const [filePath, p] of this.passports.entries()) {
                if (p.outlined || p.rawRead || p.focusedSymbols.size > 0) {
                    data.files[filePath] = {
                        outlined: p.outlined,
                        rawRead: p.rawRead,
                        focusedSymbols: Array.from(p.focusedSymbols)
                    };
                }
            }
            // A fixed temporary name could be planted as a link; never through a
            // `.nreki` link shipped with the repository either (writeStateFile).
            writeStateFile(this.projectRoot, this.stateFile,
                JSON.stringify({ ...data, tag: signState("enforcer", JSON.stringify(data)) }));
        } catch {}
    }

    private getPassport(filePath: string): FilePassport {
        if (!this.passports.has(filePath)) {
            this.passports.set(filePath, { outlined: false, rawRead: false, focusedSymbols: new Set() });
        }
        return this.passports.get(filePath)!;
    }

    private countLines(filePath: string): number {
        try {
            const buf = fs.readFileSync(filePath);
            let lines = 1;
            for (let i = 0; i < buf.length; i++) {
                if (buf[i] === 10) lines++;
                if (lines >= 100) return lines;
            }
            return lines;
        } catch { return 0; }
    }

    /**
     * LEY 0: a file under 1 KB, or under 100 lines and 50 KB, fits in one read,
     * so the blind-edit rule does not apply. Shared by edit and batch_edit:
     * batch_edit had no such bypass and demanded a compress focus on a 7-line
     * file (one extra turn on the path AGENTS.md tells agents to use), while
     * edit let through a 200 KB file as long as it had few lines (minified or
     * generated code). 50 KB is the bound the blind-insert rule already uses.
     */
    private isSmallFile(absPath: string, size: number): boolean {
        if (size < 1024) return true;
        if (size >= 50000) return false; // also keeps countLines from reading huge files
        return this.countLines(absPath) < 100;
    }

    // Patch 7 (v10.6.1): edit shape pulled from EnforcerInput so the enforcer
    // stays internally self-consistent without importing semantic-edit types.
    private validateSingleBatchEdit(edit: NonNullable<EnforcerInput["edits"]>[number]): { blocked: boolean; errorText?: string } {
        // Patch mode has its own anti-ambiguity (occurrences === 1). Safe to pass through.
        if (edit.mode === "patch") return { blocked: false };

        if (edit.mode === "insert_before" || edit.mode === "insert_after") {
            if (!edit.path) return { blocked: false };
            try {
                const insertSize = fs.statSync(path.resolve(this.projectRoot, edit.path)).size;
                if (insertSize < 50000) return { blocked: false };
            } catch { return { blocked: false }; }
            const ip = path.resolve(this.projectRoot, edit.path).replace(/\\/g, "/");
            const ipass = this.getPassport(ip);
            if (!ipass.outlined && !ipass.rawRead) {
                return {
                    blocked: true,
                    errorText: `Blocked: Blind insert on large file (${edit.path}). Run outline or compress focus:"..." first.`,
                };
            }
            return { blocked: false };
        }

        if (edit.symbol && edit.path) {
            try {
                const p = path.resolve(this.projectRoot, edit.path).replace(/\\/g, "/");
                // Same small-file bypass as a single edit. A missing file throws
                // here and stays permissive (the edit itself reports it).
                if (this.isSmallFile(p, fs.statSync(p).size)) return { blocked: false };
                const pass = this.getPassport(p);
                if (!sawSymbol(pass, edit.symbol) && !pass.rawRead) {
                    return {
                        blocked: true,
                        errorText: `Blocked: Blind batch_edit on "${edit.symbol}" in ${edit.path}. Run compress focus:"${edit.symbol}" first.`,
                    };
                }
            } catch { /* stat/path errors fall through as permissive */ }
        }
        return { blocked: false };
    }

    public evaluate(tool: string, action: string, params: EnforcerInput): { blocked: boolean; errorText?: string; penalty?: number } {
        if (tool !== "nreki_code") return { blocked: false };
        if (!["read", "compress", "edit", "batch_edit"].includes(action)) return { blocked: false };

        // LEY 3.5: Anti-Contrabando. Valida TODO edit del batch, no solo length===1.
        // Fix round-5: antes, un batch de 2+ eludía el cortafuegos (1 real blind + 1 dummy).
        if (action === "batch_edit" && params.edits) {
            for (const edit of params.edits) {
                const result = this.validateSingleBatchEdit(edit);
                if (result.blocked) return result;
            }
            return { blocked: false };
        }

        if (!params.path) return { blocked: false };

        let absPath: string;
        let size = 0;
        try {
            absPath = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
            size = fs.statSync(absPath).size;
        } catch { return { blocked: false }; }

        // LEY 0: Fast bypass
        if (this.isSmallFile(absPath, size)) return { blocked: false };

        const passport = this.getPassport(absPath);

        // Escape hatch: SOLO para read/compress. Cobra peaje. Nunca para edit.
        const isEscapeHatch = params._nreki_bypass === "chronos_recovery" && (action === "read" || action === "compress");
        if (isEscapeHatch) {
            return { blocked: false, penalty: 0.3 };
        }

        // LEYES 1 y 2 (read / compress sin focus) retiradas en v12.1.0: bloqueaban
        // TODO read y todo compress sin focus en archivos de código de 100+ líneas,
        // así que el contrato de read (verbatim por defecto; AUTO-SHIELD comprimido
        // por encima de 12k tokens, en handleRead) era inalcanzable por MCP, y cada
        // bloqueo costaba 1–2 turnos (outline → compress) para leer lo mismo.
        // El tamaño lo controla handleRead; aquí solo queda la regla de seguridad.
        if (action === "read" || action === "compress") return { blocked: false };

        // LEY 3: Edit a ciegas BLOQUEADO. Visa Dorada (rawRead) da inmunidad.
        if (action === "edit" && params.symbol) {
            if (params.mode === "patch") {
                return { blocked: false };
            }
            if (params.mode === "insert_before" || params.mode === "insert_after") {
                if (size < 50000) return { blocked: false };
                if (!passport.outlined && !passport.rawRead) {
                    return { blocked: true, errorText: `Blocked: Blind insert on large file. Run outline or compress focus:"${params.symbol}" first.` };
                }
                return { blocked: false };
            }
            if (!sawSymbol(passport, params.symbol) && !passport.rawRead) {
                return { blocked: true, errorText: `Blocked: Blind edit. Run compress focus:"${params.symbol}" first.` };
            }
        }

        return { blocked: false };
    }

    /** The agent received the whole file verbatim (handleRead): its symbols are not blind. */
    public registerRawRead(absPath: string): void {
        const p = path.resolve(this.projectRoot, absPath).replace(/\\/g, "/");
        this.getPassport(p).rawRead = true;
        this.getPassport(p).outlined = true;
        this.saveState();
    }

    /** Symbols whose full body was shown (e.g. outline auto-expansion) count as focused. */
    public registerFocusedSymbols(absPath: string, symbols: ReadonlyArray<string>): void {
        if (symbols.length === 0) return;
        const pass = this.getPassport(path.resolve(this.projectRoot, absPath).replace(/\\/g, "/"));
        for (const s of symbols) pass.focusedSymbols.add(s);
        this.saveState();
    }

    // LEY 5: Amnesia Quirúrgica
    public registerSuccess(tool: string, action: string, params: EnforcerInput) {
        let changed = false;
        try {
            if (tool === "nreki_navigate" && action === "outline" && params.path) {
                const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                this.getPassport(p).outlined = true;
                changed = true;
            } else if (tool === "nreki_code") {
                if ((action === "read" || action === "compress") && params._nreki_bypass === "chronos_recovery" && params.path) {
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    this.getPassport(p).rawRead = true;
                    changed = true;
                } else if ((action === "compress" || action === "read") && params.focus && params.path) {
                    // read + focus is served as compress focus (handlers/code/read.ts).
                    const p = path.resolve(this.projectRoot, params.path).replace(/\\/g, "/");
                    // v10.13.1: parse CSV — "A, B, C" registra los tres símbolos separados.
                    for (const raw of params.focus.split(",")) {
                        const clean = raw.trim();
                        if (clean) this.getPassport(p).focusedSymbols.add(clean);
                    }
                    this.getPassport(p).outlined = true;
                    changed = true;
                } else if (action === "edit" && params.symbol && params.path) {
                    // v10.13.1: passport persiste post-edit. El LLM tiene el símbolo fresco
                    // en su ventana de contexto tras haberlo escrito. Forzar recompress
                    // generaba deadlocks en refactors multi-paso. Capas AST + TS-RAM +
                    // Cache Tickets cubren correctitud e invalidación por edits externos.
                } else if (action === "batch_edit" && params.edits) {
                    // v10.13.1: idem — ver F2 arriba.
                }
            }
        } catch {}
        if (changed) this.saveState();
    }
}
