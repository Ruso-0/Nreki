/**
 * context-pack.ts — `nreki_navigate action:"context"`: the code a task names, in one call.
 *
 * Where an agent's tokens go: every turn re-sends the whole conversation
 * (~20k tokens per request in the 2026-11-13 Codex A/B), and exploration
 * (map → grep → read → read…) is several turns. A turn saved is worth more
 * than any trimming of a tool's output. Given the task text, this returns,
 * within a token budget:
 *   1. every symbol the task names, verbatim, with path and line range;
 *   2. where the identifiers that are not symbols (fields, properties) occur,
 *      and, when the task names no symbol, the code that holds them;
 *   3. for every issue of the task that names no code, the best `search` hits
 *      (BM25, fused with the Voyage index when it is enabled), one search per
 *      issue, and a small file found that way shown whole; an issue with no
 *      hit is listed as such;
 *   4. per file, who imports it (what an API change can break);
 *   5. the short definitions (≤ 6 lines) of what the shown code imports.
 * `path` narrows all of it to a folder or file of the project.
 *
 * 3 and 5 come from the pre-registered A/B of 2026-11-13 (tasks that name no
 * code): after `context` the agents still spent 2 turns reading — the third
 * issue of the task had no hit (4 hits went to the first two), and they read
 * whole the 20–40-line files of the hits and the helpers those import
 * (money.ts, clock.ts) before editing.
 */

import fs from "fs";
import path from "path";
import type { McpToolResponse, NavigateParams, RouterDependencies } from "../router.js";
import type { ChunkRecord } from "../database.js";
import type { SearchResult } from "../engine-types.js";
import type { NrekiEngine } from "../engine.js";
import { estimateTokens } from "../utils/token-estimator.js";
import { isSecondaryPath } from "../utils/file-filter.js";
import { readSource } from "../utils/read-source.js";
import { isSensitivePath, safePath } from "../utils/path-jail.js";
import { escapeRegExp, extractDependencies, isSensitiveSignature } from "../utils/imports.js";
import { goPackageHolds, jsDeclarationSite, jsImportBindings, pythonModuleHolds } from "../utils/import-origin.js";

/** Default size of the package (estimated tokens). */
export const CONTEXT_DEFAULT_BUDGET = 2000;
const CONTEXT_MAX_BUDGET = 8000;
/** A symbol longer than this is shown as its first line + a pointer. */
const VERBATIM_MAX_LINES = 80;
/** Definitions kept per name (a name defined in more places is ambiguous). */
const DEFINITIONS_PER_NAME = 3;
/** Occurrences listed per identifier that is not a symbol. */
const OCCURRENCES_PER_NAME = 8;
/** Index lookups per call: a pasted log or long spec must not cost one query per word. */
const STRONG_LOOKUPS = 120;
const WEAK_LOOKUPS = 200;
/** A file search led to is shown whole up to this size: agents read it whole anyway. */
const WHOLE_FILE_LINES = 80;
const WHOLE_FILE_TOKENS = 900;
/** Imported definitions shown under the code: short ones only, and few. */
const HELPER_MAX_LINES = 6;
const HELPERS_MAX = 12;
/** Parts of a task searched one by one, and the hits kept per part. */
const ISSUES_MAX = 6;
const HITS_PER_ISSUE = 3;
export const CONTEXT_EDIT_HINT =
    "To edit: one batch_edit with every change; in code mode, run your tests/checker right after it, in the same cell (a rejected batch writes nothing).";

/** Words that say what to do with code, not which code: no search signal in them. */
const TASK_WORDS = new Set([
    "fix", "fixes", "fixed", "issue", "issues", "bug", "bugs", "problem", "problems", "task", "tasks", "src",
    "only", "inspect", "checker", "check", "should", "must", "need", "needs", "also", "please", "code", "change",
    "keep", "rest", "workspace", "follow", "verify", "don", "not", "does", "two", "three", "four", "five",
    "resuelve", "resolver", "incidencia", "incidencias", "corrige", "corregir", "arregla", "arreglar", "modifica",
    "modificar", "solo", "debe", "deben", "dos", "tres", "cuatro", "cinco", "código", "archivo", "archivos",
    "cambia", "cambies", "conserva", "resto", "sigue", "ejecuta", "verifica", "prueba", "pruebas", "leas",
    "preserve", "preserving", "conservar", "conservando", "mantener", "manteniendo",
]);

/**
 * "Do not read the checker", "No leas el checker", "Nunca toques…": an
 * instruction, not an issue. Spanish verbs are listed: "no" + any word ending
 * in -as/-es also dropped issues such as "No todas las facturas…".
 */
const NEGATIVE_IMPERATIVE = new RegExp(
    "^(?:do\\s+not|don['’]t|never|nunca|jam[aá]s|no\\s+(?:" +
    "leas?|lean|modifiques?|modifiquen|toques?|toquen|cambies?|cambien|uses?|usen|ejecutes?|ejecuten|" +
    "abras?|abran|inspecciones?|inspeccionen|busques?|busquen|edites?|editen|borres?|borren|elimines?|eliminen|" +
    "delegues?|deleguen|instales?|instalen|accedas?|accedan|consultes?|consulten|mires?|miren))(?=[\\s,.;:]|$)",
    "iu",
);

/** Words that are symbol names in many codebases and plain words in a task. */
const GENERIC_WORDS = new Set([
    "the", "and", "for", "with", "from", "that", "this", "into", "when", "then", "else", "true", "false", "null",
    "value", "values", "data", "item", "items", "list", "name", "names", "type", "types", "index", "key", "keys",
    "result", "results", "error", "errors", "file", "files", "path", "test", "tests", "main", "run", "get", "set",
    "init", "start", "stop", "new", "add", "update", "delete", "remove", "create", "read", "write", "load", "save",
    "user", "users", "config", "options", "state", "string", "number", "boolean", "object", "array", "function",
    "class", "default", "export", "import", "return", "async", "await", "const", "let", "var", "use", "make",
    "para", "que", "los", "las", "con", "por", "una", "uno", "del", "como", "sus", "sin", "cuando", "tests",
]);

interface Picked {
    chunk: ChunkRecord;
    /** Why it is in the package (the identifier it matched, or "search"). */
    via: string;
    /** Higher = more relevant: identifiers the task wrote like code beat plain words. */
    rank: number;
}

/**
 * Identifiers in the task: code-shaped ones are strong, plain words are weak.
 * `capitalized` lists the strong ones that are only a capitalized word
 * ("Station", "Fix", "Percentiles"): a type name, or the first word of a
 * sentence. They are looked up, but never stand for the code of an issue. In
 * the third Codex holdout "Station settings …" matched the `Station` type and
 * no issue was searched: 0 of 3 files, then 5 and 7 reads.
 */
export function extractTaskIdentifiers(rawTask: string): { strong: string[]; weak: string[]; pathHints: string[]; capitalized: string[] } {
    // "Configuración" was cut at the accent into "Configuraci" + "n".
    const task = rawTask.normalize("NFD").replace(/\p{M}/gu, "");
    const strong = new Set<string>();
    const weak = new Set<string>();
    const capitalized = new Set<string>();
    // `inBackticks`, call-like `name(` and `Class.method` are written as code.
    for (const m of task.matchAll(/`([^`\n]{1,80})`/g)) {
        for (const w of m[1].match(/[A-Za-z_$][\w$]*/g) ?? []) if (w.length >= 3) strong.add(w);
    }
    for (const m of task.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (m[1].length >= 3) strong.add(m[1]);
    for (const m of task.matchAll(/\b[A-Z][\w$]*(?:\.|::|#|->)[A-Za-z_$][\w$]*/g)) {
        for (const w of m[0].split(/\.|::|#|->/)) if (w.length >= 3) strong.add(w);
    }
    for (const w of task.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (w.length < 3 || strong.has(w)) continue;
        // camelCase, PascalCase with an inner capital, snake_case, digits, $: written as code.
        if (/[a-z][A-Z]/.test(w) || /^[A-Z][a-z0-9]+[A-Z]/.test(w) || /_/.test(w) || /\d/.test(w) || w.includes("$")) {
            strong.add(w);
        } else if (/^[A-Z][a-z0-9]+$/.test(w)) {
            strong.add(w);
            capitalized.add(w);
        } else if (!GENERIC_WORDS.has(w.toLowerCase())) {
            weak.add(w);
        }
    }
    const pathHints = [...new Set((task.match(/[\w.-]*[/\\-][\w./\\-]*/g) ?? [])
        .map(h => h.replace(/\\/g, "/").replace(/^[./]+|[./]+$/g, "").toLowerCase())
        .filter(h => h.length >= 3))];
    return { strong: [...strong], weak: [...weak], pathHints, capitalized: [...capitalized] };
}

/**
 * The issues of a task that lists several, each with at least 3 words that can
 * point at code. The coarsest split that gives two or more wins: list items
 * (`1.`, `-`), else lines, else sentences, else `;` — so an item is not cut at
 * its own `;`, nor a sentence (a paragraph with one issue per sentence and a
 * `;` inside one was cut in two). Instructions are not issues: parts with no
 * words that point at code, and negative imperatives ("Do not read …"). One part: [].
 */
export function splitTaskIssues(task: string): string[] {
    const contentWords = (part: string): number => (part.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) ?? [])
        .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w.toLowerCase()) && !TASK_WORDS.has(w.toLowerCase())).length;
    const keep = (parts: string[]): string[] => parts
        .map(p => p.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
        .filter(p => contentWords(p) >= 3 && !NEGATIVE_IMPERATIVE.test(p));
    const lines = task.split(/\r?\n/);
    const items = lines.filter(l => /^\s*(?:\d+[.)]|[-*•])\s+/.test(l));
    for (const parts of [items, lines, task.split(/(?<=[.!?])\s+/), task.split(";")]) {
        const issues = keep(parts);
        if (issues.length >= 2) return issues.slice(0, ISSUES_MAX);
    }
    return [];
}

/**
 * Search hits for the task, best first; for a task with several issues, the
 * top hit of every issue before the second hit of any (one search for the
 * whole task gave all its hits to the first two issues). After each issue's
 * hits, the file where they meet (see meetingFile).
 */
async function searchTask(
    engine: NrekiEngine, root: string, issues: string[], scope: Scope,
): Promise<{ hits: ChunkRecord[]; files: Set<string>; empty: string[] }> {
    // A scope drops hits: ask for more, keep the first k inside it.
    const find = async (query: string, k: number): Promise<SearchResult[]> => {
        const found = await engine.search(query, scope ? k * 3 : k);
        return (scope ? found.filter(r => scope(r.path)) : found).slice(0, k);
    };
    if (issues.length === 1) {
        const all = await find(issues[0], 6);
        const hits = all.slice(0, 4).map(fromSearch);
        const meeting = await meetingFile(engine, root, all.slice(0, 4), scope);
        if (meeting) hits.push(meeting);
        return { hits, files: new Set(all.map(r => r.path)), empty: all.length === 0 ? issues : [] };
    }
    const lists: SearchResult[][] = [];
    for (const issue of issues) lists.push(await find(issue, 4)); // sequential: Voyage rate limits
    // 3 per issue: the code to edit was 3rd in 2 of the 6 A/B issues (BM25 and
    // Voyage alike). A small file more is ~250 tokens; a missed one, a read turn.
    const hits: ChunkRecord[] = [];
    for (let rank = 0; rank < HITS_PER_ISSUE; rank++) {
        for (const list of lists) if (list[rank]) hits.push(fromSearch(list[rank]));
    }
    for (const list of lists) {
        const meeting = await meetingFile(engine, root, list, scope);
        if (meeting) hits.push(meeting);
    }
    return { hits, files: new Set(lists.flat().map(r => r.path)), empty: issues.filter((_, i) => lists[i].length === 0) };
}

/** `path` passed to context: only code under it is shown (agents pass path:"src"). Takes absolute paths. */
type Scope = ((file: string) => boolean) | null;

function resolveScope(root: string, requested: string | undefined): { scope: Scope; note: string } {
    const p = requested?.trim();
    if (!p || p === ".") return { scope: null, note: "" };
    let prefix: string;
    try {
        const abs = safePath(root, p);
        if (!fs.existsSync(abs)) return { scope: null, note: `path "${p}" not found: the whole project was used` };
        prefix = relOf(root, abs);
    } catch {
        return { scope: null, note: `path "${p}" is not inside the project: the whole project was used` };
    }
    if (prefix === "") return { scope: null, note: "" };
    return { scope: (file: string) => { const rel = relOf(root, file); return rel === prefix || rel.startsWith(prefix + "/"); }, note: "" };
}

/**
 * The small file that imports at least two of the files search found: where
 * the concepts of the issue meet, which is where behaviour that spans them
 * lives. "VAT on shipping" found tax-rates.ts, zones.ts and shipping/rates.ts —
 * leaves; the bug was in invoice-builder.ts, which imports two of them.
 * Tests and barrels (files that only import/re-export) are not candidates.
 */
async function meetingFile(engine: NrekiEngine, root: string, list: SearchResult[], scope: Scope): Promise<ChunkRecord | null> {
    const hitRels = [...new Set(list.map(r => relOf(root, r.path)))];
    if (hitRels.length < 2) return null;
    const count = new Map<string, number>();
    for (const rel of hitRels) {
        let importers: string[];
        try { importers = await engine.findDependents(rel); } catch { return null; }
        for (const imp of new Set(importers.map(i => i.replace(/\\/g, "/")))) count.set(imp, (count.get(imp) ?? 0) + 1);
    }
    const ranked = [...count].filter(([rel, n]) => n >= 2 && !isSecondaryPath(rel) && (!scope || scope(path.resolve(root, rel))))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [rel] of ranked) {
        const text = readFileText(root, rel);
        if (text === null) continue;
        const body = text.trimEnd();
        const lines = body.split("\n");
        if (lines.length > WHOLE_FILE_LINES || estimateTokens(body) > WHOLE_FILE_TOKENS) continue;
        const logic = lines.filter(l => l.trim() && !/^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|\/\/|\/\*|\*|#)/.test(l));
        if (logic.length === 0) continue;
        const hit = list.find(r => relOf(root, r.path) === rel);
        if (hit) return fromSearch(hit);
        return {
            id: 0, path: path.resolve(root, rel), shorthand: "", raw_code: body, node_type: "file",
            start_line: 1, end_line: lines.length, start_index: 0, end_index: 0, symbol_name: "",
        };
    }
    return null;
}

const fromSearch = (r: SearchResult): ChunkRecord => ({
    id: 0, path: r.path, shorthand: r.shorthand, raw_code: r.rawCode, node_type: r.nodeType,
    start_line: r.startLine, end_line: r.endLine, start_index: 0, end_index: 0, symbol_name: r.symbolName ?? "",
});

/** The file's text, LF, when it is inside the project, not a secrets path, and readable. */
function readFileText(root: string, file: string): string | null {
    try {
        const abs = safePath(root, file);
        if (isSensitivePath(abs)) return null;
        return readSource(abs).replace(/\r\n/g, "\n");
    } catch {
        return null;
    }
}

const JS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** One import the shown code uses, and how to tell the file that declares it. */
interface UsedImport {
    localName: string;
    /** The name looked up in the index (the declared one for TS/JS). */
    symbol: string;
    /** Is `defRel` (project-relative POSIX) the declaring file? */
    holds: (defRel: string) => boolean;
}

/** The imports of `fileText` that `code` uses; TS/JS ones resolved to their declaration (unresolved ones dropped). */
function usedImports(root: string, file: string, fileText: string, code: string): UsedImport[] {
    const uses = (name: string): boolean => new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`).test(code);
    const ext = path.extname(file).toLowerCase();
    const same = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (JS_EXTS.has(ext)) {
        const out: UsedImport[] = [];
        for (const b of jsImportBindings(path.join(root, file), fileText)) {
            if (!uses(b.local)) continue;
            const site = jsDeclarationSite(root, path.join(root, file), b.source, b.imported);
            if (!site) continue; // a package, an unresolved alias: never a homonym from elsewhere
            const siteRel = relOf(root, site.file);
            out.push({ localName: b.local, symbol: site.name, holds: rel => same(rel, siteRel) });
        }
        return out;
    }
    return extractDependencies(fileText, ext).filter(d => d.source !== undefined && uses(d.localName)).map(d => ({
        localName: d.localName,
        symbol: d.symbol,
        holds: ext === ".go"
            ? (rel: string) => goPackageHolds(root, d.source!, rel)
            : (rel: string) => pythonModuleHolds(d.source!, file, rel),
    }));
}

/**
 * Short definitions (≤ HELPER_MAX_LINES) of what `code` uses from the imports
 * of `fileText` — the helpers an agent opened next in the A/B. Only from the
 * file that declares the import (see utils/import-origin.ts); none that looks
 * like a credential; none from a file already shown whole.
 */
async function importedHelpers(
    engine: NrekiEngine, root: string, file: string, fileText: string, code: string,
    skipFiles: Set<string>, seen: Set<string>,
): Promise<string[]> {
    const out: string[] = [];
    const used = usedImports(root, file, fileText, code);
    // Functions the code calls first, in the order it calls them; types and
    // constants after. Import order put the 3-line function holding a bug last.
    const firstUse = (name: string): number => {
        const call = new RegExp(`(^|[^\\w$.])${escapeRegExp(name)}\\s*\\(`).exec(code);
        if (call) return call.index;
        const any = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`).exec(code);
        return code.length + (any?.index ?? code.length);
    };
    used.sort((a, b) => firstUse(a.localName) - firstUse(b.localName));
    for (const dep of used) {
        const symbol = dep.symbol.replace(/^type\s+/, "");
        if (seen.has(symbol)) continue;
        const defs = (await engine.getChunksBySymbolExact(symbol, true)).filter(c =>
            c.symbol_name === symbol && !skipFiles.has(relOf(root, c.path)) && dep.holds(relOf(root, c.path)));
        if (defs.length !== 1) continue;
        const def = defs[0];
        if (def.end_line - def.start_line + 1 > HELPER_MAX_LINES) continue;
        if (isSensitivePath(def.path) || isSensitiveSignature(def.raw_code)) continue;
        seen.add(symbol);
        const alias = dep.localName !== symbol && !dep.localName.endsWith(`.${symbol}`) ? ` (imported as ${dep.localName})` : "";
        out.push(`// ${relOf(root, def.path)}:L${def.start_line}-L${def.end_line}${alias}\n${def.raw_code.replace(/\r\n/g, "\n")}`);
    }
    return out;
}

function relOf(root: string, p: string): string {
    return path.relative(root, p).replace(/\\/g, "/");
}

/** Prefer production code and files whose path the task mentions. */
function definitionOrder(root: string, pathHints: string[]) {
    const score = (c: ChunkRecord): number => {
        const rel = relOf(root, c.path).toLowerCase();
        let s = 0;
        for (const h of pathHints) if (rel.includes(h)) s += 10;
        if (isSecondaryPath(rel)) s -= 5;
        return s;
    };
    return (a: ChunkRecord, b: ChunkRecord) => score(b) - score(a) || a.path.localeCompare(b.path) || a.start_line - b.start_line;
}

export async function handleContext(params: NavigateParams, deps: RouterDependencies): Promise<McpToolResponse> {
    const { engine } = deps;
    const task = (params.query ?? "").trim();
    if (task.length < 3) {
        return { content: [{ type: "text" as const, text: `Error: context needs query:"<the task or question>".` }], isError: true };
    }
    const root = engine.getProjectRoot();
    const { strong, weak, pathHints, capitalized } = extractTaskIdentifiers(task);
    const order = definitionOrder(root, pathHints);
    const { scope, note: scopeNote } = resolveScope(root, params.path);
    const inScope = (file: string): boolean => !scope || scope(file);

    const picked: Picked[] = [];
    const seen = new Set<string>();
    const keyOf = (c: ChunkRecord) => `${c.path}\u0000${c.start_line}\u0000${c.end_line}`;
    const take = (c: ChunkRecord, via: string, rank: number): void => {
        const k = keyOf(c);
        if (seen.has(k)) return;
        seen.add(k);
        picked.push({ chunk: c, via, rank });
    };

    // 1. Symbols the task names. A code-shaped name, or a plain word defined
    // under a path the task gives, names the code of its issue (rank 2). A
    // capitalized word or another plain word may only be a word (rank 1).
    const notSymbols: string[] = [];
    const naming = new Set<string>();
    const isCapitalized = new Set(capitalized);
    for (const [words, strength] of [[strong.slice(0, STRONG_LOOKUPS), 2], [weak.slice(0, WEAK_LOOKUPS), 1]] as const) {
        for (const word of words) {
            const defs = (await engine.getChunksBySymbolExact(word, true)).filter(c => c.symbol_name === word && inScope(c.path));
            if (defs.length === 0) {
                if (strength === 2) notSymbols.push(word);
                continue;
            }
            defs.sort(order);
            // A plain word defined in many places is a word, not a reference.
            const hinted = defs.filter(c => pathHints.some(h => relOf(root, c.path).toLowerCase().includes(h)));
            if (strength === 1 && defs.length > 2 && hinted.length === 0) continue;
            const kept = (hinted.length > 0 ? hinted : defs).slice(0, DEFINITIONS_PER_NAME);
            const explicit = strength === 2 ? !isCapitalized.has(word) : hinted.length > 0;
            // A named interface or type is shown, but the behaviour to fix lives in
            // the code that uses it: "OrderItem discounts round each line" must
            // still be searched, or context returns the 4-line interface only.
            const typeOnly = kept.every(c => c.node_type === "interface" || c.node_type === "type");
            if (explicit && !typeOnly) naming.add(word);
            for (const c of kept) take(c, word, explicit ? 2 : 1);
        }
    }

    // 1b. Every issue that names no code is searched (top 3 each). A plain word
    // that is also a method name ("size", "missing", "server") used to win over
    // search (5 of 20 conceptual questions on NREKI's own code), and one named
    // type used to stand for a whole three-issue task (third Codex holdout). A
    // rank-1 match stays only when search lands in its file.
    const taskIssues = splitTaskIssues(task);
    const issueTexts = taskIssues.length > 0 ? taskIssues : [task];
    const issueCount = issueTexts.length;
    const mentions = (text: string, word: string): boolean =>
        new RegExp(`(^|[^\\w$])${escapeRegExp(word)}(?![\\w$])`).test(text);
    const unnamed = issueTexts.filter(t => ![...naming].some(w => mentions(t, w)));
    let conceptual = false;
    let searched: string[] = [];
    let unfound: string[] = [];
    if (picked.length > 0 && unnamed.length > 0) {
        conceptual = true;
        searched = unnamed;
        const { hits, files, empty } = await searchTask(engine, root, unnamed, scope);
        unfound = empty;
        const kept = picked.filter(p => p.rank === 2 || files.has(p.chunk.path));
        picked.length = 0;
        seen.clear();
        for (const p of kept) take(p.chunk, p.via, p.rank);
        for (const r of hits) take(r, "search", 0);
    }

    // 2. Identifiers that are not symbols (fields, properties): where they occur.
    const occurrences: string[] = [];
    const enclosing: ChunkRecord[] = []; // named chunks holding those occurrences
    for (const word of notSymbols) {
        // Property-shaped only (camelCase / snake_case): a PascalCase word that is
        // no symbol here is usually a product or library name found in comments.
        if (!/^[a-z][a-z0-9]*[A-Z_]/.test(word) && !/_/.test(word)) continue;
        const hits = await engine.fastGrep(word, 60);
        const whole = new RegExp(`(^|[^\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`);
        const at: string[] = [];
        const lines = new Set<string>();
        for (const h of hits) {
            if (!inScope(h.path)) continue;
            const rel = relOf(root, h.path);
            const rows = h.raw_code.split("\n");
            let inChunk = false;
            for (let i = 0; i < rows.length && at.length < OCCURRENCES_PER_NAME; i++) {
                if (!whole.test(rows[i])) continue;
                inChunk = true;
                const loc = `${rel}:L${h.start_line + i}`;
                if (lines.has(loc)) continue;
                lines.add(loc);
                at.push(loc);
            }
            if (inChunk && h.symbol_name) {
                enclosing.push({
                    id: 0, path: h.path, shorthand: "", raw_code: h.raw_code, node_type: "",
                    start_line: h.start_line, end_line: h.start_line + rows.length - 1,
                    start_index: 0, end_index: 0, symbol_name: h.symbol_name,
                });
            }
        }
        if (at.length > 0) occurrences.push(`${word} at: ${at.join(", ")}${lines.size >= OCCURRENCES_PER_NAME ? ", …" : ""}`);
    }

    // 3. No symbol named, but fields/properties are: the code that holds them.
    let viaOccurrence = false;
    if (picked.length === 0 && enclosing.length > 0) {
        viaOccurrence = true;
        // Innermost first (a method before its class), production before tests.
        enclosing.sort((a, b) => order(a, b) || (a.end_line - a.start_line) - (b.end_line - b.start_line));
        for (const c of enclosing.slice(0, 4)) take(c, "occurrence", 1);
    }

    // 4. Nothing named at all: concept search (BM25 + Voyage when enabled).
    let viaSearch = false;
    if (picked.length === 0) {
        viaSearch = true;
        searched = issueTexts;
        const { hits, empty } = await searchTask(engine, root, issueTexts, scope);
        unfound = empty;
        for (const r of hits) take(r, "search", 0);
    }

    // A method inside a class that is also in the package is shown once, in the class.
    const contains = (outer: ChunkRecord, inner: ChunkRecord) =>
        outer !== inner && outer.path === inner.path && outer.start_line <= inner.start_line && outer.end_line >= inner.end_line;
    const kept = picked.filter(p => !picked.some(o => contains(o.chunk, p.chunk) &&
        o.chunk.end_line - o.chunk.start_line + 1 <= VERBATIM_MAX_LINES));

    // 5. Render: most relevant first, then by file. Over budget → one-line pointers.
    // The default grows with the issues of the task (up to 3): one issue's worth each.
    const budget = Math.min(CONTEXT_MAX_BUDGET, Math.max(300, Math.floor(
        params.token_budget ?? CONTEXT_DEFAULT_BUDGET * Math.min(3, searched.length > 0 ? issueCount : 1))));
    kept.sort((a, b) => b.rank - a.rank || order(a.chunk, b.chunk));
    const byFile = new Map<string, Picked[]>();
    for (const p of kept) {
        const arr = byFile.get(relOf(root, p.chunk.path)) ?? [];
        arr.push(p);
        byFile.set(relOf(root, p.chunk.path), arr);
    }

    // Search chose the code, so the agent cannot trust a lone chunk of it: a
    // small file is shown whole (in the A/B they read each such file next).
    const searchLed = viaSearch || conceptual || viaOccurrence;
    const blocks: string[] = [];
    const pointers: string[] = [];
    let used = 0;
    const shownByFile = new Map<string, string[]>();
    const wholeShown = new Set<string>();
    const shownCode: Array<{ file: string; text: string; code: string }> = [];
    for (const [file, items] of byFile) { // file: project-relative, POSIX
        items.sort((a, b) => a.chunk.start_line - b.chunk.start_line);
        const rel = file;
        let importers = "";
        try {
            const deps2 = await engine.findDependents(rel);
            if (deps2.length > 0) {
                importers = ` — imported by ${deps2.length > 4 ? `${deps2.length} files: ${deps2.slice(0, 4).join(", ")}, …` : deps2.join(", ")}`;
            }
        } catch { /* graph unavailable: no importer line */ }
        const fileText = readFileText(root, file);
        if (searchLed && fileText !== null) {
            const body = fileText.trimEnd();
            const lines = body.split("\n").length;
            const header = `// ${rel} (whole file, ${lines}L)${importers}`;
            const cost = estimateTokens(header) + estimateTokens(body) + 2;
            if (lines <= WHOLE_FILE_LINES && estimateTokens(body) <= WHOLE_FILE_TOKENS && (used + cost <= budget || blocks.length === 0)) {
                used += cost;
                blocks.push(`${header}\n${body}`);
                wholeShown.add(file);
                shownByFile.set(file, items.map(p => p.chunk.symbol_name).filter(Boolean));
                shownCode.push({ file, text: fileText, code: body });
                continue;
            }
        }
        for (const p of items) {
            const c = p.chunk;
            const lineCount = c.end_line - c.start_line + 1;
            const name = c.symbol_name || "(top level)";
            const header = `// ${rel}:L${c.start_line}-L${c.end_line}${importers}`;
            importers = ""; // once per file
            const body = lineCount <= VERBATIM_MAX_LINES
                ? c.raw_code
                : `${c.raw_code.split("\n")[0]}\n// … ${lineCount} lines: compress focus:"${name}"`;
            const cost = estimateTokens(header) + estimateTokens(body) + 2;
            if (used + cost > budget && blocks.length > 0) {
                pointers.push(`${name} ${rel}:L${c.start_line}-L${c.end_line}`);
                continue;
            }
            used += cost;
            blocks.push(`${header}\n${body}`);
            const names = shownByFile.get(file) ?? [];
            // A symbol cut to its first line was not read: it must not unlock a blind replace.
            if (c.symbol_name && lineCount <= VERBATIM_MAX_LINES) names.push(c.symbol_name);
            shownByFile.set(file, names);
            if (fileText !== null && lineCount <= VERBATIM_MAX_LINES) shownCode.push({ file, text: fileText, code: c.raw_code });
        }
    }

    // What the shown code imports, when it is short: in the A/B the agents
    // opened money.ts and clock.ts for a 3-line percentOf and a constant.
    // Shared among the symbols shown, one round at a time: given file by file,
    // the first two symbols' types took the whole cap, and the 3-line function
    // holding the third bug was never shown (measured pair of 2026-11-14).
    const helperSeen = new Set(kept.map(p => p.chunk.symbol_name).filter(Boolean));
    const perSymbol: string[][] = [];
    for (const { file, text, code } of shownCode) {
        const uses = code.split("\n").filter(l => !/^\s*(?:import|from)\s/.test(l)).join("\n");
        perSymbol.push(await importedHelpers(engine, root, file, text, uses, wholeShown, helperSeen));
    }
    const helpers: string[] = [];
    for (let round = 0; helpers.length < HELPERS_MAX && perSymbol.some(list => list.length > round); round++) {
        for (const list of perSymbol) {
            const h = list[round];
            if (!h || helpers.length >= HELPERS_MAX) continue;
            const cost = estimateTokens(h) + 1;
            if (used + cost > budget) continue;
            used += cost;
            helpers.push(h);
        }
    }

    if (blocks.length === 0 && occurrences.length === 0) {
        return {
            content: [{
                type: "text" as const,
                text: `context: nothing in the index matches this task. Try fast_grep with an exact string, or search with other words.` +
                    (scopeNote ? ` (${scopeNote})` : ""),
            }],
        };
    }

    // What was shown in full counts as read for the blind-edit rule.
    for (const [file, names] of shownByFile) deps.enforcer?.registerFocusedSymbols(file, names);

    const parts: string[] = [];
    const nSymbols = blocks.length;
    // Say what the agent holds: in the A/B, agents re-read the four bodies
    // they had just received (one more turn, ~20k tokens re-sent).
    const complete = pointers.length === 0 && !blocks.some(b => b.includes(" lines: compress focus:"));
    const holding = complete
        ? "current and complete code; edit it with batch_edit by these symbol names, no further read is needed"
        : "current code; the ones marked with a line count or listed below were not shown whole";
    const wholeNote = wholeShown.size > 0 ? ` — a "whole file" block is the complete current file: no further read of it is needed` : "";
    parts.push(conceptual && naming.size > 0
        ? `context (the symbols the task names, plus best search hits for the ${searched.length} of its ${issueCount} issues that name no code): ${nSymbols} block(s)${wholeNote}`
        : viaSearch || conceptual
            ? `context (no symbol named in the task; best search hits${issueCount > 1 ? `, each of its ${issueCount} issues searched` : ""}): ${nSymbols} block(s)${wholeNote}`
            : viaOccurrence
                ? `context (no symbol named in the task; code holding the names it mentions): ${nSymbols} block(s) — ${holding}`
                : `context: ${nSymbols} symbol(s) the task names — ${holding}`);
    if (blocks.length > 0) parts.push("```\n" + blocks.join("\n\n") + "\n```");
    if (helpers.length > 0) parts.push("what that code imports (short definitions):\n```\n" + helpers.join("\n") + "\n```");
    if (occurrences.length > 0) parts.push(occurrences.join("\n"));
    if (pointers.length > 0) parts.push(`over budget, not shown: ${pointers.join("; ")}`);
    // Say which issues have no evidence, instead of a package that reads as complete.
    if (unfound.length > 0) {
        parts.push(`no code found for: ${unfound.map(i => `"${i.length > 70 ? `${i.slice(0, 70)}…` : i}"`).join("; ")}`);
    }
    if (scopeNote) parts.push(scopeNote);
    // In the Codex A/Bs agents sent batch_edit alone and ran the checker on the
    // next turn (~20k tokens re-sent); with apply_patch they did both in one cell.
    // Tool descriptions are not sent in code mode, so this result is where it can be said.
    parts.push(CONTEXT_EDIT_HINT);
    const text = parts.join("\n");
    const tokens = estimateTokens(text);
    engine.logUsage("nreki_context", tokens, tokens, 0);
    return { content: [{ type: "text" as const, text }] };
}
