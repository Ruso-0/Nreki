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
import { expandSpanishContextQuery } from "../utils/spanish-query.js";
import { resolveVoyageConfig } from "../search/voyage.js";

export { expandSpanishContextQuery } from "../utils/spanish-query.js";

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
/**
 * Primary search files (an issue's #1 hit, its meeting file, or a module #1
 * imports) are shown whole up to 135 lines: in the 2026-11-25 v3 A/B/C, folding
 * a 117-line #1 service still triggered `compress` in 6/6 sessions (+1 turn).
 */
const PRIMARY_WHOLE_FILE_LINES = 135;
const PRIMARY_WHOLE_FILE_TOKENS = 1950;
/** Imported definitions shown under the code: short ones whole, longer called ones as a 1-line signature. */
const HELPER_MAX_LINES = 18;
const HELPERS_MAX = 15;
/** Focused interior window shown when search/occurrence lands inside a >80-line symbol. */
const LARGE_WINDOW_LINES = 28;
/** Parts of a task searched one by one, and the hits kept per part. */
const ISSUES_MAX = 6;
const HITS_PER_ISSUE = 3;
/**
 * A file that only a weaker search hit led to (not the top hit of its issue,
 * not where the hits meet, not imported by the top hit) is shown whole only up
 * to this size; above it, only the matched symbol.
 */
const SECONDARY_WHOLE_FILE_LINES = 24;
/** Minimum file size for a #1 hit to prune single-parent downstream wrapper hits. */
const CONCRETE_PRIMARY_MIN_LINES = 20;
/** A helper whose file this many project files import is boilerplate (fault, logger, assert): not inlined. */
const UBIQUITOUS_HELPER_IMPORTERS = 10;
/** Largest search/occurrence symbol whose guard runs are folded to fit VERBATIM_MAX_LINES. */
const FOLD_MAX_SOURCE_LINES = 240;

export const CONTEXT_EDIT_HINT =
    "When using batch_edit, send one call; in code mode, run your tests/checker right after it, in the same cell (a rejected batch writes nothing).";

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
    /** Insertion index so search hits preserve relevance order instead of sorting alphabetically. */
    orderIdx: number;
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
): Promise<{ hits: ChunkRecord[]; files: Set<string>; empty: string[]; primary: Set<string>; epicenters: Set<string> }> {
    // A scope drops hits: ask for more, keep the first k inside it.
    const find = async (query: string, k: number): Promise<SearchResult[]> => {
        // Dense embeddings already understand Spanish; keep their input unchanged.
        const searchQuery = resolveVoyageConfig() ? query : expandSpanishContextQuery(query);
        const found = await engine.search(searchQuery, scope ? k * 3 : k);
        return (scope ? found.filter(r => scope(r.path)) : found).slice(0, k);
    };
    const primary = new Set<string>();
    const epicenters = new Set<string>();
    if (issues.length === 1) {
        const all = await find(issues[0], 6);
        const refined = await refineIssueHits(engine, root, all.slice(0, 5), scope);
        for (const p of refined.primaryRels) primary.add(p);
        for (const e of refined.epicenterRels) epicenters.add(e);
        const hits = refined.kept.slice(0, 4).map(fromSearch);
        if (refined.meeting) {
            hits.push(refined.meeting);
            primary.add(relOf(root, refined.meeting.path));
            epicenters.add(relOf(root, refined.meeting.path));
        }
        return { hits, files: new Set(all.map(r => r.path)), empty: all.length === 0 ? issues : [], primary, epicenters };
    }
    const lists: SearchResult[][] = [];
    for (const issue of issues) lists.push(await find(issue, 4)); // sequential: Voyage rate limits
    const refinedLists: Array<Awaited<ReturnType<typeof refineIssueHits>>> = [];
    for (const list of lists) {
        const ref = await refineIssueHits(engine, root, list, scope);
        for (const p of ref.primaryRels) primary.add(p);
        for (const e of ref.epicenterRels) epicenters.add(e);
        refinedLists.push(ref);
    }
    const hits: ChunkRecord[] = [];
    for (let rank = 0; rank < HITS_PER_ISSUE; rank++) {
        for (const ref of refinedLists) if (ref.kept[rank]) hits.push(fromSearch(ref.kept[rank]));
    }
    for (const ref of refinedLists) {
        if (ref.meeting) {
            hits.push(ref.meeting);
            primary.add(relOf(root, ref.meeting.path));
            epicenters.add(relOf(root, ref.meeting.path));
        }
    }
    return { hits, files: new Set(lists.flat().map(r => r.path)), empty: issues.filter((_, i) => lists[i].length === 0), primary, epicenters };
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

/** Files explicitly forbidden by a negative imperative in the prompt ("Do not read verify.mjs", "No leas verify.mjs"). */
function extractForbiddenFiles(task: string): Set<string> {
    const out = new Set<string>();
    for (const clause of task.split(/(?<=[.!?;\n])\s+/)) {
        const trimmed = clause.trim().replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "");
        if (!NEGATIVE_IMPERATIVE.test(trimmed)) continue;
        for (const m of trimmed.matchAll(/`?([\w./\\-]+\.(?:[cm]?[jt]sx?|py|go|json))`?/gi)) {
            const norm = m[1].replace(/\\/g, "/").replace(/^[./]+/, "").toLowerCase();
            if (norm) {
                out.add(norm);
                out.add(path.posix.basename(norm));
            }
        }
    }
    return out;
}

/** Extract a compact interior window around query-matching lines inside a >80-line symbol. */
function focusedLargeSymbolWindow(
    rawCode: string,
    startLine: number,
    name: string,
    queryTerms: ReadonlySet<string>,
): { body: string; matchedSlice: string | null } {
    const lines = rawCode.replace(/\r\n/g, "\n").split("\n");
    const fallback = `${lines[0]}\n// … ${lines.length} lines: compress focus:"${name}"`;
    if (lines.length <= 2 || queryTerms.size === 0) return { body: fallback, matchedSlice: null };

    const terms = [...queryTerms];
    const lineScores = new Int32Array(lines.length);
    let anyMatch = false;
    for (let i = 1; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        let score = 0;
        for (const t of terms) {
            if (lower.includes(t)) score++;
        }
        lineScores[i] = score;
        if (score > 0) anyMatch = true;
    }
    if (!anyMatch) return { body: fallback, matchedSlice: null };

    const winLen = Math.min(LARGE_WINDOW_LINES, lines.length - 1);
    let clusterStart = 1;
    let bestSum = -1;
    let running = 0;
    for (let i = 1; i < lines.length; i++) {
        running += lineScores[i];
        if (i - winLen >= 1) running -= lineScores[i - winLen];
        const candidateStart = Math.max(1, i - winLen + 1);
        if (running > bestSum) {
            bestSum = running;
            clusterStart = candidateStart;
        }
    }
    const clusterEnd = Math.min(lines.length - 1, clusterStart + winLen - 1);
    let mFirst = clusterStart;
    let mLast = clusterStart;
    let seenMatch = false;
    for (let i = clusterStart; i <= clusterEnd; i++) {
        if (lineScores[i] > 0) {
            if (!seenMatch) { mFirst = i; seenMatch = true; }
            mLast = i;
        }
    }
    const matchSpan = Math.min(winLen, mLast - mFirst + 1);
    const lead = Math.floor((winLen - matchSpan) * 0.35);
    const bestStart = Math.max(1, Math.min(lines.length - winLen, mFirst - lead));
    const winEnd = Math.min(lines.length - 1, bestStart + winLen - 1);
    const slice = lines.slice(bestStart, winEnd + 1).join("\n");
    const fileStart = startLine + bestStart;
    const fileEnd = startLine + winEnd;
    return {
        body: `${lines[0]}\n// … L${fileStart}-L${fileEnd} (matched window of ${lines.length}L; full body: compress focus:"${name}")\n${slice}`,
        matchedSlice: slice,
    };
}

/** A call that only validates: requireX(…), assertX(…), invariant(…), ensureX(…), checkX(…). */
const GUARD_CALL = /^(?:(?:require|assert|invariant|ensure|check)[A-Z_]\w*|assert|invariant)\s*\(/;

/**
 * Index of the last line of the statement starting at `from` (brackets
 * balanced, strings and line comments skipped), or -1 past `maxLines`.
 */
function statementEnd(lines: string[], from: number, maxLines = 40): number {
    let depth = 0;
    let quote = "";
    for (let i = from; i < lines.length && i < from + maxLines; i++) {
        const line = lines[i];
        let code = "";
        for (let k = 0; k < line.length; k++) {
            const ch = line[k];
            if (quote) {
                if (ch === "\\") { k++; continue; }
                if (ch === quote) quote = "";
                continue;
            }
            if (ch === "/" && line[k + 1] === "/") break;
            if (ch === "'" || ch === "\"" || ch === "`") { quote = ch; code += ch; continue; }
            if (ch === "(" || ch === "[" || ch === "{") depth++;
            else if (ch === ")" || ch === "]" || ch === "}") depth--;
            code += ch;
        }
        if (quote === "'" || quote === "\"") quote = ""; // an unterminated plain string does not span lines
        if (depth <= 0 && !quote && /[;)}]\s*$/.test(code.trimEnd())) return i;
    }
    return -1;
}

/** Last line of the guard statement starting at `from` (a validating call, or an `if` whose body only throws/validates), or -1. */
function guardStatementEnd(lines: string[], from: number): number {
    const t = lines[from].trim();
    if (GUARD_CALL.test(t)) return statementEnd(lines, from);
    if (!/^if\s*\(/.test(t)) return -1;
    const end = statementEnd(lines, from);
    if (end < 0 || /^else\b/.test(lines[end + 1]?.trim() ?? "")) return -1;
    if (end === from) {
        // `if (cond) throw …;` / `if (cond) requireX(…);` on one line.
        return /\)\s*(?:throw\b|(?:require|assert|invariant|ensure|check)[A-Z_]?\w*\s*\()/.test(t) && !/\{/.test(t) ? end : -1;
    }
    if (!/\{\s*$/.test(t) || lines[end].trim() !== "}") return -1;
    let j = from + 1;
    let statements = 0;
    while (j < end) {
        const body = lines[j].trim();
        if (body === "") { j++; continue; }
        const e = body.startsWith("throw ") || body.startsWith("throw(") ? statementEnd(lines, j) : GUARD_CALL.test(body) ? statementEnd(lines, j) : -1;
        if (e < 0 || e >= end) return -1;
        statements++;
        j = e + 1;
    }
    return statements > 0 ? end : -1;
}

/**
 * A >80-line symbol with its runs of guard statements (≥ 3 statements or ≥ 4
 * lines of requireX/assertX/`if (…) throw`) folded into one marked line each,
 * when that brings it to VERBATIM_MAX_LINES; else null. In the 2026-11-25
 * Codex A/B/C every NREKI session ran a `compress` on a 105-line function
 * whose lines 19–67 were preconditions and whose bug sat at line 85.
 */
export function foldGuardStatements(rawCode: string, startLine: number, name: string): string | null {
    const lines = rawCode.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let folded = false;
    let i = 0;
    while (i < lines.length) {
        let end = i > 0 ? guardStatementEnd(lines, i) : -1;
        if (end < 0) { out.push(lines[i]); i++; continue; }
        const runStart = i;
        let count = 0;
        let lastEnd = end;
        let j = i;
        while (j < lines.length) {
            if (lines[j].trim() === "") {
                let k = j;
                while (k < lines.length && lines[k].trim() === "") k++;
                if (k >= lines.length || guardStatementEnd(lines, k) < 0) break;
                j = k;
                continue;
            }
            end = guardStatementEnd(lines, j);
            if (end < 0) break;
            count++;
            lastEnd = end;
            j = end + 1;
        }
        const span = lastEnd - runStart + 1;
        if (count >= 3 || span >= 4) {
            const indent = /^\s*/.exec(lines[runStart])?.[0] ?? "";
            out.push(`${indent}// L${startLine + runStart}-L${startLine + lastEnd}: ${span} validation/guard lines omitted (full body: compress focus:"${name}")`);
            folded = true;
        } else {
            out.push(...lines.slice(runStart, lastEnd + 1));
        }
        i = lastEnd + 1;
    }
    return folded && out.length <= VERBATIM_MAX_LINES ? out.join("\n") : null;
}

/**
 * Topology pass over an issue's search hits:
 *  1. Modules imported by the #1 hit (`coveredByTop`) are promoted to `primary`
 *     so core domain helpers (e.g. local-calendar.ts) are shown whole instead
 *     of being truncated as weak rank-2/3 noise.
 *  2. When #1 is a concrete implementation (≥20L, non-type), lower-ranked hits
 *     that merely import #1 without bridging any hit outside `coveredByTop` are
 *     pruned (their paths already appear in `#1`'s `imported by` header).
 *  3. Finds a `meetingFile` when an issue's hits are disjoint leaves (e.g.
 *     rates.ts + days.ts -> late-fee.ts), ignoring adapters whose imported hits
 *     are already united by #1.
 */
async function refineIssueHits(
    engine: NrekiEngine,
    root: string,
    list: SearchResult[],
    scope: Scope,
): Promise<{ kept: SearchResult[]; primaryRels: string[]; epicenterRels: string[]; meeting: ChunkRecord | null }> {
    if (list.length === 0) return { kept: [], primaryRels: [], epicenterRels: [], meeting: null };
    const top = list[0];
    const topRel = relOf(root, top.path);
    const hitRels = [...new Set(list.map(r => relOf(root, r.path)))];
    const importersByHit = new Map<string, Set<string>>();
    const importedHitsOf = new Map<string, string[]>();
    for (const rel of hitRels) {
        let deps: string[] = [];
        try { deps = await engine.findDependents(rel); } catch { deps = []; }
        const normSet = new Set(deps.map(d => d.replace(/\\/g, "/")));
        importersByHit.set(rel, normSet);
        for (const imp of normSet) {
            const arr = importedHitsOf.get(imp) ?? [];
            arr.push(rel);
            importedHitsOf.set(imp, arr);
        }
    }

    const fileLines = (rel: string): number => readFileText(root, rel)?.trimEnd().split("\n").length ?? 0;
    const isConcrete = (r: SearchResult, rel: string): boolean =>
        r.nodeType !== "interface" && r.nodeType !== "type" && fileLines(rel) >= CONCRETE_PRIMARY_MIN_LINES;

    // When #1 is a small leaf helper (e.g. 12L unit-share.ts) and #2 in `list` is
    // the concrete service importing it (e.g. 117L reconcile-return.ts), treat that
    // service as the issue's concrete anchor as well.
    let anchorRel = topRel;
    let anchorConcrete = isConcrete(top, topRel);
    if (!anchorConcrete) {
        const topDeps = importersByHit.get(topRel);
        const caller = list.slice(1).find(r => {
            const rel = relOf(root, r.path);
            return topDeps?.has(rel) && isConcrete(r, rel);
        });
        if (caller) {
            anchorRel = relOf(root, caller.path);
            anchorConcrete = true;
        }
    }

    const epicenterRels = new Set<string>([topRel, anchorRel]);
    const coveredByAnchor = new Set<string>([topRel, anchorRel]);
    for (const rel of hitRels) {
        if (importersByHit.get(rel)?.has(anchorRel)) coveredByAnchor.add(rel);
    }
    const primaryRels = [...coveredByAnchor];

    const anchorImporters = importersByHit.get(anchorRel) ?? new Set<string>();
    const kept = list.filter((r, idx) => {
        if (idx === 0) return true;
        const rRel = relOf(root, r.path);
        if (rRel === topRel || rRel === anchorRel) return true;
        if (anchorConcrete && anchorImporters.has(rRel)) {
            const imports = importedHitsOf.get(rRel) ?? [];
            if (imports.every(h => coveredByAnchor.has(h))) return false;
        }
        return true;
    });

    let meeting: ChunkRecord | null = null;
    if (hitRels.length >= 2) {
        const ranked = [...importedHitsOf.entries()]
            .filter(([rel, hits]) =>
                hits.length >= 2
                && !hits.every(h => coveredByAnchor.has(h))
                && !isSecondaryPath(rel)
                && (!scope || scope(path.resolve(root, rel))),
            )
            .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
        for (const [rel] of ranked) {
            const text = readFileText(root, rel);
            if (text === null) continue;
            const body = text.trimEnd();
            const lines = body.split("\n");
            if (lines.length > WHOLE_FILE_LINES || estimateTokens(body) > WHOLE_FILE_TOKENS) continue;
            const logic = lines.filter(l => l.trim() && !/^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|\/\/|\/\*|\*|#)/.test(l));
            if (logic.length === 0) continue;
            const hit = kept.find(r => relOf(root, r.path) === rel) ?? list.find(r => relOf(root, r.path) === rel);
            meeting = hit ? fromSearch(hit) : {
                id: 0, path: path.resolve(root, rel), shorthand: "", raw_code: body, node_type: "file",
                start_line: 1, end_line: lines.length, start_index: 0, end_index: 0, symbol_name: "",
            };
            break;
        }
    }
    return { kept, primaryRels, epicenterRels: [...epicenterRels], meeting };
}

const fromSearch = (r: SearchResult): ChunkRecord => ({
    id: 0, path: r.path, shorthand: r.shorthand, raw_code: r.rawCode, node_type: r.nodeType,
    start_line: r.startLine, end_line: r.endLine, start_index: 0, end_index: 0,
    symbol_name: r.symbolName ?? "", qualified_name: r.qualifiedName ?? "",
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
    allowDef: (def: ChunkRecord) => Promise<boolean>,
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
        if (isSensitivePath(def.path) || isSensitiveSignature(def.raw_code)) continue;
        if (!(await allowDef(def))) continue;
        const defLines = def.end_line - def.start_line + 1;
        const alias = dep.localName !== symbol && !dep.localName.endsWith(`.${symbol}`) ? ` (imported as ${dep.localName})` : "";
        if (defLines > HELPER_MAX_LINES) {
            const isCalled = new RegExp(`(^|[^\\w$.])${escapeRegExp(dep.localName)}\\s*\\(`).test(code);
            if (!isCalled && def.node_type !== "interface" && def.node_type !== "type") continue;
            const sigLine = def.raw_code.replace(/\r\n/g, "\n").split("\n")[0]?.replace(/\s*\{\s*$/, "").trim();
            if (!sigLine) continue;
            seen.add(symbol);
            out.push(`// ${relOf(root, def.path)}:L${def.start_line}-L${def.end_line}${alias} (${defLines}L; signature)\n${sigLine}`);
            continue;
        }
        seen.add(symbol);
        out.push(`// ${relOf(root, def.path)}:L${def.start_line}-L${def.end_line}${alias}\n${def.raw_code.replace(/\r\n/g, "\n")}`);
    }
    return out;
}

function relOf(root: string, p: string): string {
    return path.relative(root, p).replace(/\\/g, "/");
}

/** Lines listed per literal term, and literal terms per task. */
const LITERAL_LINES_MAX = 40;
const LITERAL_TERMS_MAX = 3;
const RENAME_VERB = new RegExp(
    "(?:^|[^\\p{L}])(?:rename|replace|change|cambiar|cambia|cambie|cambiá|reemplazar|reemplaza|reemplace|" +
    "renombrar|renombra|renombre|sustituir|sustituye|sustituya)\\s+" +
    "(?:(?:all|every|the|of|word|text|label|occurrences|mentions|instances|todas?|todos?|el|la|los|las|de|del|" +
    "palabra|texto|t[eé]rmino|nombre|apariciones|ocurrencias|menciones)\\s+){0,4}" +
    "[\"“«']?([\\p{L}\\p{N}_$][\\p{L}\\p{N}_$-]{2,39})",
    "giu",
);

/**
 * Text the task asks to change wherever it appears: a quoted string
 * ("…", “…”, «…», '…'), or the capitalized object of rename/replace/cambiar/
 * reemplazar/renombrar ("cambiar Limpieza en toda la página" → "Limpieza").
 * A lower-case object ("change the label") is a plain word, not a literal.
 */
export function extractLiteralTerms(task: string): string[] {
    const terms: string[] = [];
    const add = (t: string) => {
        const term = t.trim();
        if (term.length < 3 || term.length > 60) return;
        if (GENERIC_WORDS.has(term.toLowerCase()) || TASK_WORDS.has(term.toLowerCase())) return;
        if (!terms.some(x => x.toLowerCase() === term.toLowerCase())) terms.push(term);
    };
    // A quoted value in a bug report ('"status" is "pending" instead of "paid"')
    // names data, not text to change: quotes count when the task asks for a
    // text change, or when the text is distinctive (a capital, a digit, a
    // space, a non-ASCII letter: "Servicios Generales", "LIMPIEZA").
    RENAME_VERB.lastIndex = 0;
    const asksForTextChange = RENAME_VERB.test(task) || TEXT_CHANGE.test(task);
    RENAME_VERB.lastIndex = 0;
    const distinctive = (t: string) => /[\p{Lu}\d\s]|[^\x20-\x7e]/u.test(t);
    const quoted = (t: string) => { if (asksForTextChange || distinctive(t)) add(t); };
    for (const m of task.matchAll(/["“«]([^"”»\n]{3,60})["”»]/g)) quoted(m[1]);
    for (const m of task.matchAll(/(?<![\p{L}\p{N}])'([^'\n]{3,60})'(?![\p{L}\p{N}])/gu)) quoted(m[1]);
    for (const m of task.matchAll(RENAME_VERB)) if (/\p{Lu}|\d/u.test(m[1])) add(m[1]);
    return terms.slice(0, LITERAL_TERMS_MAX);
}

/** "should say …", "debería decir …": a text change without a rename verb. */
const TEXT_CHANGE = /\b(?:should (?:say|read|show)|must (?:say|read|show))\b|deber[ií]a (?:decir|mostrar)|debe (?:decir|mostrar)/iu;

/**
 * Every line of the project holding `term`, any case, grouped by file:
 * `"Limpieza" (any case): 23 lines in 9 files — src/a.tsx:L3,L40; …`. A task
 * such as "cambiar Limpieza en toda la página" got one search symbol from
 * context, and the agent needed fast_grep to find the 20+ lines (2026-11-27).
 */
async function literalMentions(
    engine: NrekiEngine, root: string, term: string, inScope: (file: string) => boolean,
): Promise<{ full: string; short: string } | null> {
    const hits = await engine.fastGrep(term, 400, { ignoreCase: true });
    const anyCase = new RegExp(escapeRegExp(term), "i");
    const byFile = new Map<string, Set<number>>();
    for (const h of hits) {
        if (!inScope(h.path)) continue;
        const rel = relOf(root, h.path);
        const rows = h.raw_code.split("\n");
        for (let i = 0; i < rows.length; i++) {
            if (!anyCase.test(rows[i])) continue;
            const lines = byFile.get(rel) ?? new Set<number>();
            lines.add(h.start_line + i);
            byFile.set(rel, lines);
        }
    }
    if (byFile.size === 0) return null;
    const files = [...byFile.entries()].sort((a, b) =>
        Number(isSecondaryPath(a[0])) - Number(isSecondaryPath(b[0])) || a[0].localeCompare(b[0]));
    const total = files.reduce((n, [, lines]) => n + lines.size, 0);
    const shown: string[] = [];
    let listed = 0;
    for (const [rel, lines] of files) {
        if (listed >= LITERAL_LINES_MAX) break;
        const sorted = [...lines].sort((a, b) => a - b).slice(0, LITERAL_LINES_MAX - listed);
        listed += sorted.length;
        shown.push(`${rel}:${sorted.map(l => `L${l}`).join(",")}${sorted.length < lines.size ? ",…" : ""}`);
    }
    const more = listed < total
        ? ` … (${total - listed} more: fast_grep query:"${term}" ignore_case:true lists every line)`
        : "";
    const head = `"${term}" (any case): ${total} line(s) in ${files.length} file(s)`;
    return {
        full: `${head} — ${shown.join("; ")}${more}`,
        short: `${head}: fast_grep query:"${term}" ignore_case:true lists them`,
    };
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
    const forbiddenFiles = extractForbiddenFiles(task);
    const isForbidden = (file: string): boolean => {
        if (forbiddenFiles.size === 0) return false;
        const rel = relOf(root, file).toLowerCase();
        return forbiddenFiles.has(rel) || forbiddenFiles.has(path.posix.basename(rel));
    };
    const inScope = (file: string): boolean => !isForbidden(file) && (!scope || scope(file));
    const effectiveScope: Scope = scope || forbiddenFiles.size > 0 ? inScope : null;

    const picked: Picked[] = [];
    const seen = new Set<string>();
    const keyOf = (c: ChunkRecord) => `${c.path}\u0000${c.start_line}\u0000${c.end_line}`;
    const take = (c: ChunkRecord, via: string, rank: number): void => {
        const k = keyOf(c);
        if (seen.has(k)) return;
        seen.add(k);
        picked.push({ chunk: c, via, rank, orderIdx: picked.length });
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
    const primarySearch = new Set<string>(); // project-relative POSIX paths
    const epicenterSearch = new Set<string>();
    if (picked.length > 0 && unnamed.length > 0) {
        conceptual = true;
        searched = unnamed;
        const { hits, files, empty, primary, epicenters } = await searchTask(engine, root, unnamed, effectiveScope);
        for (const f of primary) primarySearch.add(f);
        for (const e of epicenters) epicenterSearch.add(e);
        unfound = empty;
        const kept = picked.filter(p => p.rank === 2 || files.has(p.chunk.path));
        picked.length = 0;
        seen.clear();
        for (const p of kept) take(p.chunk, p.via, p.rank);
        for (const r of hits) take(r, "search", primarySearch.has(relOf(root, r.path)) ? 0.5 : 0);
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
        const { hits, empty, primary, epicenters } = await searchTask(engine, root, issueTexts, effectiveScope);
        for (const f of primary) primarySearch.add(f);
        for (const e of epicenters) epicenterSearch.add(e);
        unfound = empty;
        for (const r of hits) take(r, "search", primarySearch.has(relOf(root, r.path)) ? 0.5 : 0);
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
    kept.sort((a, b) => b.rank - a.rank || (a.via === "search" && b.via === "search" ? a.orderIdx - b.orderIdx : order(a.chunk, b.chunk)));
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
    const windowQueryTerms = new Set(
        (expandSpanishContextQuery(task).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z_$][a-z0-9_$]*/g) ?? [])
            .filter(w => w.length >= 3 && !GENERIC_WORDS.has(w) && !TASK_WORDS.has(w)),
    );
    for (const [file, items] of byFile) { // file: project-relative, POSIX
        items.sort((a, b) => a.chunk.start_line - b.chunk.start_line);
        const rel = file;
        let importers = "";
        try {
            // A file the task forbids is not named either (its path is evidence too).
            const deps2 = (await engine.findDependents(rel)).map(d => d.replace(/\\/g, "/"))
                .filter(d => !isForbidden(path.resolve(root, d)));
            if (deps2.length > 0) {
                importers = deps2.length <= 4
                    ? ` — imported by ${deps2.join(", ")}`
                    : ` — imported by ${deps2.length} files: ${deps2.slice(0, 4).join(", ")}, …`;
            }
        } catch { /* graph unavailable: no importer line */ }
        const fileText = readFileText(root, file);
        // Epicenters up to 135L whole; upstream helpers up to 80L whole; secondary tail up to 24L whole.
        const isEpicenter = epicenterSearch.has(rel);
        const secondaryOnly = items.every(p => p.via === "search" && !primarySearch.has(rel));
        if (searchLed && fileText !== null) {
            const body = fileText.trimEnd();
            const lines = body.split("\n").length;
            const header = `// ${rel} (whole file, ${lines}L)${importers}`;
            const cost = estimateTokens(header) + estimateTokens(body) + 2;
            const maxItemLines = items.reduce((max, p) => Math.max(max, p.chunk.end_line - p.chunk.start_line + 1), 0);
            const dominantEpicenter = isEpicenter && maxItemLines >= lines * 0.85;
            const wholeLimit = dominantEpicenter ? PRIMARY_WHOLE_FILE_LINES : secondaryOnly ? SECONDARY_WHOLE_FILE_LINES : WHOLE_FILE_LINES;
            const wholeTokLimit = dominantEpicenter ? PRIMARY_WHOLE_FILE_TOKENS : WHOLE_FILE_TOKENS;
            if (lines <= wholeLimit && estimateTokens(body) <= wholeTokLimit && (used + cost <= budget || blocks.length === 0)) {
                used += cost;
                blocks.push(`${header}\n${body}`);
                wholeShown.add(file);
                const absWhole = path.resolve(root, file);
                deps.enforcer?.registerRawRead(absWhole);
                deps.chronos?.markReadUncompressed(absWhole);
                shownByFile.set(file, items.map(p => p.chunk.qualified_name || p.chunk.symbol_name).filter(Boolean));
                if (!secondaryOnly) shownCode.push({ file, text: fileText, code: body });
                continue;
            }
        }
        for (const p of items) {
            const c = p.chunk;
            const lineCount = c.end_line - c.start_line + 1;
            const name = c.symbol_name || "(top level)";
            const header = `// ${rel}:L${c.start_line}-L${c.end_line}${importers}`;
            importers = ""; // once per file
            const fallbackPointer = `${c.raw_code.split("\n")[0]}\n// … ${lineCount} lines: compress focus:"${name}"`;
            let body: string;
            let codeForImports: string | null = null;
            if (lineCount <= VERBATIM_MAX_LINES) {
                body = c.raw_code;
                codeForImports = c.raw_code;
            } else if (p.via === "search" || p.via === "occurrence") {
                // Preconditions folded first: the whole algorithm, top to bottom, in one call.
                const foldedBody = lineCount <= FOLD_MAX_SOURCE_LINES ? foldGuardStatements(c.raw_code, c.start_line, name) : null;
                const foldCost = foldedBody !== null ? estimateTokens(header) + estimateTokens(foldedBody) + 2 : Infinity;
                const win = foldedBody === null ? focusedLargeSymbolWindow(c.raw_code, c.start_line, name, windowQueryTerms) : null;
                const winCost = win ? estimateTokens(header) + estimateTokens(win.body) + 2 : Infinity;
                if (foldedBody !== null && (used + foldCost <= budget || blocks.length === 0)) {
                    body = foldedBody;
                    codeForImports = foldedBody;
                } else if (win && win.matchedSlice !== null && (used + winCost <= budget || blocks.length === 0)) {
                    body = win.body;
                    codeForImports = win.body;
                } else {
                    body = fallbackPointer;
                }
            } else {
                body = fallbackPointer;
            }
            const cost = estimateTokens(header) + estimateTokens(body) + 2;
            if (used + cost > budget && blocks.length > 0) {
                pointers.push(`${name} ${rel}:L${c.start_line}-L${c.end_line}`);
                continue;
            }
            used += cost;
            blocks.push(`${header}\n${body}`);
            const names = shownByFile.get(file) ?? [];
            // A symbol cut to its first line or a partial window was not read whole: it must not unlock a blind replace.
            const symKey = c.qualified_name || c.symbol_name;
            if (symKey && lineCount <= VERBATIM_MAX_LINES) names.push(symKey);
            shownByFile.set(file, names);
            if (!secondaryOnly && fileText !== null && codeForImports !== null) {
                shownCode.push({ file, text: fileText, code: codeForImports });
            }
        }
    }

    // What the shown code imports, when it is short: in the A/B the agents
    // opened money.ts and clock.ts for a 3-line percentOf and a constant.
    // Shared among the symbols shown, one round at a time: given file by file,
    // the first two symbols' types took the whole cap, and the 3-line function
    // holding the third bug was never shown (measured pair of 2026-11-14).
    const helperSeen = new Set(kept.map(p => p.chunk.symbol_name).filter(Boolean));
    // Never from a forbidden file; never a function from a module most of the
    // project imports (fault.ts, logger.ts): it crowded out the domain helpers.
    const dependentsOf = new Map<string, number>();
    const allowDef = async (def: ChunkRecord): Promise<boolean> => {
        if (isForbidden(def.path)) return false;
        if (def.node_type === "interface" || def.node_type === "type") return true;
        const defRel = relOf(root, def.path);
        let n = dependentsOf.get(defRel);
        if (n === undefined) {
            try { n = (await engine.findDependents(defRel)).length; } catch { n = 0; }
            dependentsOf.set(defRel, n);
        }
        return n < UBIQUITOUS_HELPER_IMPORTERS;
    };
    const stripImports = (src: string): string =>
        src.replace(/^\s*import\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, "")
            .split("\n").filter(l => !/^\s*(?:import|from)\s/.test(l)).join("\n");
    const perSymbol: string[][] = [];
    for (const { file, text, code } of shownCode) {
        perSymbol.push(await importedHelpers(engine, root, file, text, stripImports(code), wholeShown, helperSeen, allowDef));
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

    // Text the task asks to change wherever it appears: every line holding it, any
    // case, within token_budget (over it, one line saying where to get the list).
    const literals: string[] = [];
    for (const term of extractLiteralTerms(task)) {
        const mention = await literalMentions(engine, root, term, inScope);
        if (!mention) continue;
        const fullCost = estimateTokens(mention.full) + 1;
        const line = used + fullCost <= budget || (blocks.length === 0 && literals.length === 0) ? mention.full : mention.short;
        used += estimateTokens(line) + 1;
        literals.push(line);
    }

    if (blocks.length === 0 && occurrences.length === 0 && literals.length === 0) {
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
    const complete = pointers.length === 0
        && !blocks.some(b => b.includes(" lines: compress focus:") || b.includes("full body: compress focus:"));
    const holding = complete
        ? "current and complete code; no further read is needed"
        : "current code; the ones marked with a line count or listed below were not shown whole";
    const wholeNote = wholeShown.size > 0 ? ` — a "whole file" block is the complete current file: no further read of it is needed` : "";
    parts.push(nSymbols === 0
        ? "context: no code block to show; where the text the task names appears:"
        : conceptual && naming.size > 0
        ? `context (the symbols the task names, plus best search hits for the ${searched.length} of its ${issueCount} issues that name no code): ${nSymbols} block(s)${wholeNote}`
        : viaSearch || conceptual
            ? `context (no symbol named in the task; best search hits${issueCount > 1 ? `, each of its ${issueCount} issues searched` : ""}): ${nSymbols} block(s)${wholeNote}`
            : viaOccurrence
                ? `context (no symbol named in the task; code holding the names it mentions): ${nSymbols} block(s) — ${holding}`
                : `context: ${nSymbols} symbol(s) the task names — ${holding}`);
    if (blocks.length > 0) parts.push("```\n" + blocks.join("\n\n") + "\n```");
    if (helpers.length > 0) parts.push("what that code imports (short definitions):\n```\n" + helpers.join("\n") + "\n```");
    if (occurrences.length > 0) parts.push(occurrences.join("\n"));
    if (literals.length > 0) parts.push(literals.join("\n"));
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
