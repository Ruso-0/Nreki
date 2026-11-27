#!/usr/bin/env node
// nreki-enforcer:v6 — Claude Code PreToolUse hook installed by `nreki init`.
// v5: native edits are previewed in the running kernel over authenticated local IPC.
// v6: a whole-file dump of a large code file through Bash/PowerShell (`cat`,
//     `head -n`, `sed -n 'a,bp'`, `Get-Content`, `type`) gets the same one-time
//     block as a large Read; and when both the project's copy and the user's
//     copy (~/.claude) are registered, exactly one decides each call (see
//     anotherCopyDecides), and twin runs of one call share the block state.
// Keeps state-file protection: never write through a link.
//
// Workflow nudge, NOT a sandbox (other shell commands pass). v3 follows token
// economics: a PreToolUse hook runs AFTER the model generated the tool call,
// so blocking a Write/Edit never saves tokens (the content is already paid
// for and the retry costs another turn), while blocking a large Read does:
// the file has not entered the context yet.
//   - Read: blocked only when the requested range is large (default ~6k
//     tokens ≈ 500 lines of code; NREKI_READ_MAX_TOKENS). offset/limit are
//     honored. The block message carries the file's symbol outline, so the
//     retry is ONE targeted Read, and repeating the same Read is allowed.
//   - Bash / PowerShell: only a single plain command that prints one code file
//     (no pipes except `| Select-Object -First N`, no chaining, redirection or
//     substitution) is measured; everything else passes untouched.
//   - Edit / MultiEdit / Write: silent IPC preview when supported. Without IPC,
//     NREKI_ENFORCE_EDITS=1 redirects large edits to validated edit tools.
//   - Only code files NREKI can outline are steered (not .md, .json, images).
//   - Paths outside the project are left to Claude Code's own permissions
//     (memory, plans, scratch files). A project path whose real location is
//     outside the project (symlink escape) is blocked (NREKI-SEC-04).
//   - Missing/unreachable IPC fails open for compatibility. Once connected,
//     failed validation or an invalid response blocks the native edit.
import fs from "fs";
import path from "path";
import net from "net";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";

const HOOK_VERSION = 6;

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
const SHELL_TOOLS = /^(Bash|PowerShell)$/;
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

/**
 * Installed dependencies under `node_modules/` often live outside `projectDir`
 * via pnpm's content-addressable store, workspace links, or shared junctions.
 * Reading a package file is safe when the package directory itself carries a
 * real `package.json` and the resolved file stays inside that package root
 * (blocking internal symlink escapes and writes).
 */
function isLinkedPackageRead(projectRoot, absPath, realTargetPosix) {
    const rel = path.relative(projectRoot, absPath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const m = /^((?:.+\/)?node_modules\/(?:@[^/]+\/[^/]+|[^/@][^/]*))\/(.+)$/i.exec(rel);
    if (!m) return false;
    if (/(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|pfx|p12|kdbx)$/i.test(m[2])) return false;
    try {
        const realPkgDir = fs.realpathSync(path.join(projectRoot, m[1]));
        if (!fs.statSync(path.join(realPkgDir, "package.json")).isFile()) return false;
        return isInside(realTargetPosix, norm(realPkgDir));
    } catch {
        return false;
    }
}

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

// ─── One install, one run: the project copy defers to the user-level copy ───

/** Does a PreToolUse `matcher` select `tool`? (exact name, regex, "*" or empty = all) */
function matcherCovers(matcher, tool) {
    if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
    if (typeof matcher !== "string") return false;
    try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return matcher === tool; }
}

/** Does one of `settingsFiles` run NREKI's hook for `tool`? */
function registersNrekiHook(settingsFiles, tool) {
    for (const file of settingsFiles) {
        let settings;
        try { settings = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { continue; }
        if (!settings || settings.disableAllHooks === true) continue;
        const entries = settings.hooks && settings.hooks.PreToolUse;
        if (!Array.isArray(entries)) continue;
        if (entries.some(e => e && matcherCovers(e.matcher, tool) && Array.isArray(e.hooks)
            && e.hooks.some(h => h && typeof h.command === "string" && h.command.includes("nreki-enforcer.mjs")))) return true;
    }
    return false;
}

/** The `nreki-enforcer:vN` tag of a hook file; 0 when unreadable or untagged. */
function hookTag(file) {
    try {
        const fd = fs.openSync(file, "r");
        try {
            const buf = Buffer.alloc(256);
            const head = buf.subarray(0, fs.readSync(fd, buf, 0, 256, 0)).toString("utf8");
            return Number((/nreki-enforcer:v(\d+)/.exec(head) || [])[1] || 0);
        } finally { fs.closeSync(fd); }
    } catch { return 0; }
}

/** v4 and v5 apply the same Read budget and edit preview, but never step aside. */
const LEGACY_MIN = 4;

/**
 * True when the OTHER install of this hook (the project's .claude/hooks copy
 * vs the user's ~/.claude copy) decides this call, so this copy steps aside.
 * After a project `init` and then the user-scope one, both copies ran on
 * every call. Worse, running together they consumed each other's one-time
 * block: one blocked a big Read while the other took the same call for the
 * repeat and cleared it, so the Read stayed blocked forever (audit of 12.5.2).
 * Exactly one decides: a v4/v5 copy cannot step aside, so a newer copy yields
 * to it for the tools that copy is registered for; between v6+ copies the newer
 * one decides, the user's on a tie. Paths are compared resolved (Node loads
 * this file by its real path: /private/var on macOS, a junction's target).
 */
function anotherCopyDecides(tool) {
    let self;
    try { self = norm(realish(fileURLToPath(import.meta.url))); } catch { return false; }
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const userHook = path.join(configDir, "hooks", "nreki-enforcer.mjs");
    const projectHook = path.join(projectDir, ".claude", "hooks", "nreki-enforcer.mjs");
    const userKey = norm(realish(path.resolve(userHook)));
    const projectKey = norm(realish(path.resolve(projectHook)));
    if (userKey === projectKey) return false; // the project is the home folder: one copy
    let other, otherSettings, iAmProject;
    if (self === projectKey) {
        iAmProject = true;
        other = userHook;
        otherSettings = [path.join(configDir, "settings.json")];
    } else if (self === userKey) {
        iAmProject = false;
        other = projectHook;
        otherSettings = [path.join(projectDir, ".claude", "settings.json"), path.join(projectDir, ".claude", "settings.local.json")];
    } else {
        return false; // a copy somewhere else decides alone
    }
    if (!registersNrekiHook(otherSettings, tool)) return false;
    const theirs = hookTag(other);
    if (theirs === 0) return false;
    if (theirs < 6) return theirs >= LEGACY_MIN;
    return theirs > HOOK_VERSION || (theirs === HOOK_VERSION && iAmProject);
}

// ─── Shell file dumps: `cat big.ts` costs the same tokens as a whole-file Read ───

/** Words of ONE simple command (quotes grouped); null when it chains, pipes, redirects or substitutes. */
function shellWords(text, allowPipe) {
    const s = String(text || "").trim();
    if (!s || s.length > 2000 || /\r|\n/.test(s)) return null;
    const words = [];
    let cur = "";
    let quote = null;
    let started = false;
    for (const ch of s) {
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
            continue;
        }
        if (ch === "\"" || ch === "'") { quote = ch; started = true; continue; }
        if (ch === " " || ch === "\t") {
            if (started) { words.push(cur); cur = ""; started = false; }
            continue;
        }
        if (ch === "|" && allowPipe) {
            if (started) { words.push(cur); cur = ""; started = false; }
            words.push("|");
            continue;
        }
        if (";&|<>`$(){}".includes(ch)) return null;
        cur += ch;
        started = true;
    }
    if (quote) return null;
    if (started) words.push(cur);
    return words;
}

const positiveNum = (w) => (/^\d+$/.test(w || "") && Number(w) > 0 ? Number(w) : undefined);

/**
 * The file and line range a plain dump command prints, or null. Bash: `cat [-n] F`,
 * `nl F`, `head [-n N | -N] F`, `sed -n 'A,Bp' F`. PowerShell: `Get-Content`/`gc`/
 * `cat`/`type` F [-TotalCount|-Head|-First N] [| Select-Object [-Skip M] -First N].
 * A tail (`tail`, `-Tail`, `-Last`) or anything else is not measured.
 */
function shellDump(tool, command) {
    const dump = shellDumpOf(tool, command);
    // Git Bash on Windows names D:\x as /d/x.
    if (dump && tool === "Bash" && process.platform === "win32") dump.file = dump.file.replace(/^\/([a-zA-Z])(?=\/)/, "$1:");
    return dump;
}

function shellDumpOf(tool, command) {
    const words = shellWords(command, tool === "PowerShell");
    if (!words || words.length < 2) return null;
    const verb = words[0].toLowerCase();
    if (tool === "Bash") {
        if (verb === "cat" || verb === "nl") {
            const files = words.slice(1).filter(w => !w.startsWith("-"));
            if (files.length !== 1) return null;
            return { file: files[0], start: 1, end: Infinity, numbered: verb === "nl" || words.includes("-n") };
        }
        if (verb === "head") {
            let count = 10;
            const rest = [];
            for (let i = 1; i < words.length; i++) {
                const w = words[i];
                if (w === "-n" && positiveNum(words[i + 1])) { count = positiveNum(words[++i]); continue; }
                if (/^-n\d+$/.test(w)) { count = Number(w.slice(2)); continue; }
                if (/^-\d+$/.test(w)) { count = Number(w.slice(1)); continue; }
                if (w.startsWith("-")) return null; // -c bytes, --lines=… : not measured
                rest.push(w);
            }
            return rest.length === 1 && count > 0 ? { file: rest[0], start: 1, end: count, numbered: false } : null;
        }
        if (verb === "sed" && words[1] === "-n" && words.length === 4) {
            const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(words[2]);
            if (!m) return null;
            const start = Math.max(1, Number(m[1]));
            const end = m[2] === undefined ? start : m[2] === "$" ? Infinity : Number(m[2]);
            return end >= start ? { file: words[3], start, end, numbered: false } : null;
        }
        return null;
    }
    // PowerShell
    if (!["get-content", "gc", "cat", "type"].includes(verb)) return null;
    const bar = words.indexOf("|");
    const left = bar < 0 ? words.slice(1) : words.slice(1, bar);
    let file = null;
    let end = Infinity;
    let raw = false;
    for (let i = 0; i < left.length; i++) {
        const w = left[i];
        const flag = w.toLowerCase();
        if (flag === "-path" || flag === "-literalpath") { if (file !== null) return null; file = left[++i]; continue; }
        if (flag === "-totalcount" || flag === "-head" || flag === "-first") {
            const n = positiveNum(left[++i]);
            if (!n) return null;
            end = n;
            continue;
        }
        if (flag === "-raw") { raw = true; continue; }
        if (flag === "-encoding") { i++; continue; }
        if (flag.startsWith("-")) return null; // -Tail, -Last, -Wait, -Delimiter, …
        if (file !== null) return null;
        file = w;
    }
    if (!file) return null;
    let start = 1;
    if (bar >= 0) {
        const right = words.slice(bar + 1);
        if (right.includes("|") || !["select-object", "select"].includes((right[0] || "").toLowerCase())) return null;
        let first;
        let skip = 0;
        for (let i = 1; i < right.length; i++) {
            const flag = right[i].toLowerCase();
            const n = positiveNum(right[i + 1]);
            if (flag === "-first" && n) { first = n; i++; continue; }
            if (flag === "-skip" && right[i + 1] === "0") { i++; continue; }
            if (flag === "-skip" && n) { skip = n; i++; continue; }
            return null; // -Last, -Index, properties…
        }
        if (first === undefined) return null;
        // -Raw emits ONE string: Select-Object -First N passes the whole file (and -Skip drops it).
        if (raw && skip > 0) return null;
        if (!raw) {
            start = skip + 1;
            end = Math.min(end, skip + first);
        }
    }
    return { file, start, end, numbered: false };
}

function ipcEndpoint(pid) {
    const canonical = norm(fs.realpathSync(projectDir));
    const id = crypto.createHash("sha256").update(`${canonical}\0${pid}`).digest("hex").slice(0, 32);
    return process.platform === "win32" ? `\\\\.\\pipe\\nreki-edit-${id}`
        : path.join(os.tmpdir(), `nreki-edit-${id}.sock`);
}

/** Old servers have empty session markers: those keep the legacy behavior. */
async function previewNativeEdit(tool, input) {
    const dir = path.join(projectDir, ".nreki", "sessions");
    let entries;
    try {
        if (!fs.lstatSync(path.dirname(dir)).isDirectory() || !fs.lstatSync(dir).isDirectory()) return null;
        entries = fs.readdirSync(dir);
    } catch { return null; }
    const candidates = [];
    for (const name of entries) {
        if (!/^[1-9]\d*$/.test(name)) continue;
        const marker = path.join(dir, name);
        try {
            const stat = fs.lstatSync(marker);
            if (!stat.isFile() || stat.size > 4096) continue;
            const parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
            const token = parsed?.token;
            if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) continue;
            const pid = Number(name);
            process.kill(pid, 0);
            const startedMs = typeof parsed?.startedAt === "string" ? (Date.parse(parsed.startedAt) || 0) : 0;
            candidates.push({ pid, token, startedMs });
        } catch { continue; }
    }
    candidates.sort((a, b) => (b.startedMs - a.startedMs) || (b.pid - a.pid));
    let skipped = null;
    for (const { pid, token } of candidates) {
        const request = JSON.stringify({ token, tool_name: tool, tool_input: input }) + "\n";
        if (Buffer.byteLength(request) > 4 * 1024 * 1024) {
            return { status: "deny", error: "NREKI: native edit exceeds the 4 MiB IPC limit. Use batch_edit." };
        }
        const response = await new Promise(resolve => {
            let connected = false;
            let settled = false;
            let data = "";
            const socket = net.createConnection(ipcEndpoint(pid));
            socket.setEncoding("utf8");
            const finish = result => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                resolve(result);
            };
            const failed = () => finish(connected
                ? { status: "deny", error: "NREKI: native-edit IPC validation did not complete. Use batch_edit to retry safely." }
                : null);
            const timer = setTimeout(failed, 30_000);
            socket.once("connect", () => { connected = true; socket.write(request); });
            socket.on("error", failed);
            socket.once("close", () => { if (!settled) failed(); });
            socket.on("data", chunk => {
                data += chunk;
                if (Buffer.byteLength(data) > 1024 * 1024) { failed(); return; }
                const end = data.indexOf("\n");
                if (end < 0) return;
                try {
                    const result = JSON.parse(data.slice(0, end));
                    if (!result || !["allow", "deny", "skip"].includes(result.status)
                        || (result.error !== undefined && typeof result.error !== "string")) { failed(); return; }
                    finish(result);
                } catch { failed(); }
            });
        });
        if (response?.status === "skip") { skipped = response; continue; }
        if (response) return response;
    }
    return skipped;
}

// ─── Repeat-Read escape hatch: one block per file, then the agent decides ───

const STATE_FILE = path.join(projectDir, ".nreki", "hook-state.json");

// Claude Code runs matching hooks in parallel, so two copies of this hook can
// see the same call. Run side by side they used to consume each other's block
// (one blocked, the other took that same call for the repeat and cleared it):
// the Read stayed blocked forever. When the host names the call (tool_use_id),
// the first verdict for it is recorded and every copy that sees the same call
// returns it; without an id the cycle is as before (block, one free repeat).
const CALL_MEMORY_MS = 60 * 1000;

function readState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (s && typeof s === "object" && s.blockedReads && typeof s.blockedReads === "object") {
            if (!s.calls || typeof s.calls !== "object") s.calls = {};
            return s;
        }
    } catch { /* missing or corrupt: start fresh */ }
    return { blockedReads: {}, calls: {} };
}

function writeState(state) {
    const now = Date.now();
    for (const [key, at] of Object.entries(state.blockedReads)) {
        if (!(typeof at === "number" && now - at < REPEAT_WINDOW_MS)) delete state.blockedReads[key];
    }
    for (const [id, call] of Object.entries(state.calls || {})) {
        if (!(call && typeof call.at === "number" && now - call.at < CALL_MEMORY_MS)) delete state.calls[id];
    }
    // Never through a link: a repository can ship `.nreki` as one (lstat: a link
    // is not a directory), or plant one at a predictable temporary name (`wx`).
    if (!fs.lstatSync(path.dirname(STATE_FILE)).isDirectory()) throw new Error(".nreki is not a plain folder");
    const tmp = `${STATE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { flag: "wx" });
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

function shellBlockMessage(tool, verb, rel, est, start, end, total, outline) {
    const range = tool === "PowerShell"
        ? "Get-Content <file> | Select-Object -Skip <start-1> -First <n>"
        : "sed -n '<start>,<end>p' <file>";
    const out = [
        `NREKI: \`${verb}\` of ${rel} blocked to save context — lines ${start}-${end} of ${total} ≈ ${fmtTokens(est)} tokens, limit ${fmtTokens(READ_MAX_TOKENS)}.`,
        `Print only what you need: Read with offset/limit, or ${range}.`,
    ];
    if (outline.length > 0) {
        out.push("Symbols:");
        for (const o of outline.slice(0, OUTLINE_MAX)) out.push(`  L${o.start}-${o.end} ${o.depth ? "  " : ""}${o.label}`);
        if (outline.length > OUTLINE_MAX) out.push(`  … +${outline.length - OUTLINE_MAX} more (nreki_navigate action:"outline" lists all)`);
    }
    out.push(`Several symbols in one call: nreki_code action:"compress" path:"${rel}" focus:"name1, name2".`);
    out.push("Need the whole file anyway? Run the same command again: it will be allowed.");
    return out.join("\n");
}

// ─── Main ───

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", async () => {
    try {
        const payload = JSON.parse(stdin);
        const tool = String(payload.tool_name || payload.name || "");
        const input = payload.tool_input || payload.input || {};
        let targetPath = input.file_path || input.path || input.file || input.target_file || input.absolute_path;
        let kind = WRITE_TOOLS.test(tool) ? "write"
            : (READ_TOOLS.test(tool) || tool === "read_file") ? "read"
            : null;
        let dump = null; // shell: the file and line range the command prints
        if (!kind && SHELL_TOOLS.test(tool)) {
            dump = shellDump(tool, input.command);
            if (!dump) allow(); // not a plain file dump: never measured
            kind = "shell";
            targetPath = dump.file;
        }
        if (!kind) allow();
        if (typeof targetPath !== "string" || targetPath === "") allow();

        // No NREKI server → nothing to redirect to: allow the native tool.
        if (!nrekiIsRunning()) allow();
        // The other install of this hook decides this call: do not run twice.
        if (anotherCopyDecides(tool)) allow();

        const resolvedProject = path.resolve(projectDir);
        // A shell path is relative to the shell's folder; tool paths to the project.
        const base = kind === "shell" && typeof payload.cwd === "string" && payload.cwd ? path.resolve(payload.cwd) : resolvedProject;
        const absPath = path.resolve(base, targetPath);
        const cwdPosix = norm(resolvedProject);
        const realTargetPosix = norm(realish(absPath));
        const lexInside = isInside(norm(absPath), cwdPosix);
        const realInside = isInside(realTargetPosix, norm(realish(resolvedProject)));
        if (!lexInside && !realInside) allow(); // not a project file: Claude Code's permissions apply
        if (lexInside && !realInside && !(kind === "read" && isLinkedPackageRead(resolvedProject, absPath, realTargetPosix))) {
            if (kind === "shell") allow(); // the shell is under Claude Code's own permissions
            deny(`NREKI: blocked — ${targetPath} is inside the project but resolves outside it (symlink).`);
        }

        const ext = path.extname(absPath).toLowerCase();
        if (!CODE_EXTS.has(ext)) allow();

        if (kind === "write") {
            const result = await previewNativeEdit(tool, input);
            if (result?.status === "allow") allow();
            if (result?.status === "deny") deny(result.error || "NREKI: native edit rejected by validation.");
        }

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
        const start = kind === "shell" ? dump.start : (positiveInt(input.offset) ?? 1);
        const end = kind === "shell" ? Math.min(lines.length, dump.end)
            : Math.min(lines.length, start + (positiveInt(input.limit) ?? READ_DEFAULT_LINES) - 1);
        let chars = 0;
        for (let i = start - 1; i < end; i++) {
            // Read cuts long lines and numbers each one; a shell prints them whole.
            chars += kind === "shell" ? lines[i].length + 1 + (dump.numbered ? 7 : 0) : Math.min(lines[i].length, READ_LINE_CHARS) + 1;
        }
        const est = Math.ceil(chars / CHARS_PER_TOKEN);
        if (est < READ_MAX_TOKENS) allow();

        const outline = outlineOf(lines, ext);
        const message = kind === "shell"
            ? shellBlockMessage(tool, String(input.command).trim().split(/\s+/)[0], rel, est, start, end, lines.length, outline)
            : readBlockMessage(rel, est, start, end, lines.length, outline);

        // Second identical request within the window: the agent needs it, let it through.
        const key = norm(realish(absPath));
        const state = readState();
        const now = Date.now();
        const callId = typeof payload.tool_use_id === "string" && payload.tool_use_id.length <= 200 ? payload.tool_use_id : "";
        const seen = callId ? state.calls[callId] : undefined;
        if (seen && seen.verdict === "allow") allow(); // another copy already let this very call through
        if (seen && seen.verdict === "deny") deny(message); // another copy already blocked this very call
        const last = state.blockedReads[key];
        if (typeof last === "number" && now - last < REPEAT_WINDOW_MS) {
            delete state.blockedReads[key];
            if (callId) state.calls[callId] = { verdict: "allow", at: now };
            try { writeState(state); } catch { /* best effort */ }
            allow();
        }
        state.blockedReads[key] = now;
        if (callId) state.calls[callId] = { verdict: "deny", at: now };
        try { writeState(state); } catch { allow(); } // cannot remember the block → never a dead end
        deny(message);
    } catch {
        allow();
    }
});
