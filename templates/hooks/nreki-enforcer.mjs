#!/usr/bin/env node
// nreki-enforcer:v3 — Claude Code PreToolUse hook installed by `nreki init`.
//
// Workflow nudge, NOT a sandbox (it cannot stop Bash). v3 follows token
// economics: a PreToolUse hook runs AFTER the model generated the tool call,
// so blocking a Write/Edit never saves tokens (the content is already paid
// for and the retry costs another turn), while blocking a large Read does:
// the file has not entered the context yet.
//   - Read: blocked only when the requested range is large (default ~6k
//     tokens ≈ 500 lines of code; NREKI_READ_MAX_TOKENS). offset/limit are
//     honored. The block message carries the file's symbol outline, so the
//     retry is ONE targeted Read, and repeating the same Read is allowed.
//   - Edit / MultiEdit / Write: allowed. NREKI_ENFORCE_EDITS=1 redirects
//     native edits of large code files to NREKI's validated edit tools.
//   - Only code files NREKI can outline are steered (not .md, .json, images).
//   - Paths outside the project are left to Claude Code's own permissions
//     (memory, plans, scratch files). A project path whose real location is
//     outside the project (symlink escape) is blocked (NREKI-SEC-04).
//   - Fails OPEN on any error and when no NREKI server runs for this project.
import fs from "fs";
import path from "path";

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const norm = (p) => {
    const posix = p.replace(/\\/g, "/");
    return caseInsensitive ? posix.toLowerCase() : posix;
};
const positiveInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

const READ_MAX_TOKENS = positiveInt(process.env.NREKI_READ_MAX_TOKENS) ?? 6000;
const ENFORCE_EDITS = /^(1|true|yes|on)$/i.test(process.env.NREKI_ENFORCE_EDITS ?? "");
const EDIT_BLOCK_LINES = 100;          // strict mode only
const READ_DEFAULT_LINES = 2000;       // Claude Code's Read default when no limit is given
const READ_LINE_CHARS = 2000;          // Read truncates longer lines
const CHARS_PER_TOKEN = 4;
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const OUTLINE_MAX = 40;

const WRITE_TOOLS = /^(Write|Edit|MultiEdit|Replace)(File)?$/i;
const READ_TOOLS = /^(Read|View)(File)?$/i;
const JS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const CODE_EXTS = new Set([...JS_EXTS, ".py", ".go", ".java", ".kt", ".kts",
    ".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]);

const allow = () => process.exit(0);
const deny = (msg) => {
    // Synchronous write: process.exit() right after an async pipe write can cut the message.
    try { fs.writeSync(2, msg + "\n"); } catch { /* stderr closed */ }
    process.exit(2);
};

/** Real path of `p`, or of its nearest existing ancestor + the missing tail. */
function realish(p) {
    let current = p;
    const tail = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...tail);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return p;
            tail.unshift(path.basename(current));
            current = parent;
        }
    }
}

const isInside = (child, parent) =>
    child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");

/** Is any NREKI MCP server for this project alive? (sessions written by the server) */
function nrekiIsRunning() {
    const dir = path.join(projectDir, ".nreki", "sessions");
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return false; }
    for (const name of entries) {
        const pid = Number.parseInt(name, 10);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try {
            process.kill(pid, 0);
            return true;
        } catch (err) {
            if (err && err.code === "EPERM") return true;
        }
    }
    return false;
}

// ─── Repeat-Read escape hatch: one block per file, then the agent decides ───

const STATE_FILE = path.join(projectDir, ".nreki", "hook-state.json");

function readState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (s && typeof s === "object" && s.blockedReads && typeof s.blockedReads === "object") return s;
    } catch { /* missing or corrupt: start fresh */ }
    return { blockedReads: {} };
}

function writeState(state) {
    const now = Date.now();
    for (const [key, at] of Object.entries(state.blockedReads)) {
        if (!(typeof at === "number" && now - at < REPEAT_WINDOW_MS)) delete state.blockedReads[key];
    }
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, STATE_FILE);
}

// ─── Outline: cheap regex symbol list so the retry can be one targeted Read ───

const JS_TOP = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const JS_VAR = /^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const NOT_MEMBER = new Set(["if", "for", "while", "switch", "catch", "return", "function", "await", "new",
    "super", "this", "else", "do", "try", "with", "yield", "typeof", "delete", "void", "throw", "case"]);
const PY_DEF = /^( {0,4})(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;
const GO_DEF = /^(?:func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/;

/** Class-member indentation of a JS/TS file: one level, whatever the file uses. */
function memberIndentRegex(lines) {
    let two = 0, four = 0, tab = 0;
    for (const line of lines) {
        if (/^\t[^\t ]/.test(line)) tab++;
        else if (/^ {2}[^ *]/.test(line)) two++;
        else if (/^ {4}[^ *]/.test(line)) four++;
    }
    const unit = tab > two + four ? "\\t" : two > four * 0.1 ? " {2}" : " {4}";
    return new RegExp(`^${unit}(?![ \\t])(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*\\*?\\s*([A-Za-z_$#][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\(`);
}

function outlineOf(lines, ext) {
    const items = [];
    const add = (i, depth, label) => items.push({ start: i + 1, depth, label });
    const jsMember = JS_EXTS.has(ext) ? memberIndentRegex(lines) : null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (jsMember) {
            let m = JS_TOP.exec(line);
            if (m) { add(i, 0, `${m[1]} ${m[2]}`); continue; }
            m = JS_VAR.exec(line);
            if (m) {
                if (m[1] || /=>|\bfunction\b|\bclass\b/.test(line)) add(i, 0, `const ${m[2]}`);
                continue;
            }
            m = jsMember.exec(line);
            if (!m || NOT_MEMBER.has(m[1])) continue;
            // A signature ends with "{", "(" or ","; a call with a callback ends with "=> {".
            const code = line.replace(/\/\/.*$/, "").trimEnd();
            if (/[{(,]$/.test(code) && !/=>\s*\{$/.test(code) && !/\bfunction\b/.test(code)) add(i, 1, `.${m[1]}()`);
        } else if (ext === ".py") {
            const m = PY_DEF.exec(line);
            if (m) add(i, m[1].length > 0 ? 1 : 0, `${m[2]} ${m[3]}`);
        } else if (ext === ".go") {
            const m = GO_DEF.exec(line);
            if (m) add(i, 0, m[3] ? `type ${m[3]}` : m[1] ? `func (${m[1]}) ${m[2]}` : `func ${m[2]}`);
        }
    }
    for (let i = 0; i < items.length; i++) {
        let end = lines.length;
        for (let j = i + 1; j < items.length; j++) {
            if (items[j].depth <= items[i].depth) { end = items[j].start - 1; break; }
        }
        items[i].end = end;
    }
    return items;
}

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function readBlockMessage(rel, est, start, end, total, outline) {
    const out = [
        `NREKI: Read blocked to save context — lines ${start}-${end} of ${rel} (${total} lines) ≈ ${fmtTokens(est)} tokens, limit ${fmtTokens(READ_MAX_TOKENS)}.`,
    ];
    if (outline.length > 0) {
        out.push("Read only what you need (offset/limit). Symbols:");
        for (const o of outline.slice(0, OUTLINE_MAX)) out.push(`  L${o.start}-${o.end} ${o.depth ? "  " : ""}${o.label}`);
        if (outline.length > OUTLINE_MAX) out.push(`  … +${outline.length - OUTLINE_MAX} more (nreki_navigate action:"outline" lists all)`);
    } else {
        out.push(`Read only what you need (offset/limit); nreki_navigate action:"outline" lists the symbols.`);
    }
    out.push(`Several symbols in one call: nreki_code action:"compress" path:"${rel}" focus:"name1, name2".`);
    out.push("Need the whole file anyway? Repeat the same Read: it will be allowed.");
    return out.join("\n");
}

// ─── Main ───

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", () => {
    try {
        const payload = JSON.parse(stdin);
        const tool = String(payload.tool_name || payload.name || "");
        const input = payload.tool_input || payload.input || {};
        const targetPath = input.file_path || input.path || input.file || input.target_file || input.absolute_path;
        if (typeof targetPath !== "string" || targetPath === "") allow();

        const kind = WRITE_TOOLS.test(tool) ? "write"
            : (READ_TOOLS.test(tool) || tool === "read_file") ? "read"
            : null;
        if (!kind) allow();

        // No NREKI server → nothing to redirect to: allow the native tool.
        if (!nrekiIsRunning()) allow();

        const absPath = path.resolve(projectDir, targetPath);
        const cwdPosix = norm(path.resolve(projectDir));
        const lexInside = isInside(norm(absPath), cwdPosix);
        const realInside = isInside(norm(realish(absPath)), norm(realish(path.resolve(projectDir))));
        if (!lexInside && !realInside) allow(); // not a project file: Claude Code's permissions apply
        if (lexInside && !realInside) {
            deny(`NREKI: blocked — ${targetPath} is inside the project but resolves outside it (symlink).`);
        }

        const ext = path.extname(absPath).toLowerCase();
        if (!CODE_EXTS.has(ext)) allow();

        let size = -1;
        try { size = fs.statSync(absPath).size; } catch { /* new file */ }
        if (size < 0) allow(); // creating a file is always allowed
        const rel = path.relative(path.resolve(projectDir), absPath).replace(/\\/g, "/") || targetPath;

        if (kind === "write") {
            if (!ENFORCE_EDITS || size < 1024) allow();
            const buf = fs.readFileSync(absPath);
            let lines = 1;
            for (let i = 0; i < buf.length && lines < EDIT_BLOCK_LINES; i++) if (buf[i] === 10) lines++;
            if (lines < EDIT_BLOCK_LINES) allow();
            deny(`NREKI (NREKI_ENFORCE_EDITS=1): native edits of ${EDIT_BLOCK_LINES}+ line code files go through validated edits.\n` +
                `Use nreki_code action:"edit" path:"${rel}" symbol:"<name>" (nreki_navigate action:"outline" lists symbols), ` +
                `or action:"batch_edit" for several edits at once.`);
        }

        // Whole file already under the budget → no range of it can exceed it.
        if (size <= READ_MAX_TOKENS * CHARS_PER_TOKEN) allow();
        const buf = fs.readFileSync(absPath);
        if (buf.subarray(0, 8192).includes(0)) allow(); // binary
        const lines = buf.toString("utf8").split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const start = positiveInt(input.offset) ?? 1;
        const end = Math.min(lines.length, start + (positiveInt(input.limit) ?? READ_DEFAULT_LINES) - 1);
        let chars = 0;
        for (let i = start - 1; i < end; i++) chars += Math.min(lines[i].length, READ_LINE_CHARS) + 1;
        const est = Math.ceil(chars / CHARS_PER_TOKEN);
        if (est < READ_MAX_TOKENS) allow();

        // Second identical request within the window: the agent needs it, let it through.
        const key = norm(realish(absPath));
        const state = readState();
        const last = state.blockedReads[key];
        if (typeof last === "number" && Date.now() - last < REPEAT_WINDOW_MS) {
            delete state.blockedReads[key];
            try { writeState(state); } catch { /* best effort */ }
            allow();
        }
        state.blockedReads[key] = Date.now();
        try { writeState(state); } catch { allow(); } // cannot remember the block → never a dead end

        deny(readBlockMessage(rel, est, start, end, lines.length, outlineOf(lines, ext)));
    } catch {
        allow();
    }
});
