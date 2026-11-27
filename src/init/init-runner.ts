/**
 * init/init-runner.ts — orchestrates `nreki init` for the detected (or
 * explicitly chosen) AI coding agents.
 *
 * v12.3.0: installs for every detected agent (project signals, else the agents
 * found in the home folder) and registers NREKI as each agent's MCP server with
 * the project folder pinned (see mcp-register.ts), so one command is enough.
 *
 * v11.3.0 replaces the pre-v11.3.0 "spray every template" behavior with
 * targeted per-agent installs. Templates and the Claude Code enforcer
 * hook are shipped under templates/ inside the package and read at
 * runtime — no string-literal escape juggling, no rebuild required to
 * tweak template wording.
 *
 * Backward compat: when run without --agent and no agent signal is on
 * disk, falls back to writing AGENTS.md (the cross-agent convention)
 * and surfaces an honest disclosure. Existing Claude Code projects
 * keep getting the same files because the legacy install left .claude/
 * + CLAUDE.md behind, which the detector now picks up.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { DetectedAgent } from "./agent-detect.js";
import { detectAgent, isKnownAgent, KNOWN_AGENTS } from "./agent-detect.js";
import {
    CLAUDE_HOOK_TOOLS,
    defaultGlobalAgents,
    isGlobalAgent,
    registerGlobalAgent,
    sameText,
    sentinelBlockOf,
} from "./global-register.js";
import { hookVersion } from "./hook-upgrade.js";
import { isMcpHost, launchCommand, registerMcp, removeEmptyDirs, unregisterMcp, type McpAction } from "./mcp-register.js";
import { isNonProjectLaunchDir, sameDir } from "../project-root.js";
import { unsafeWriteTarget } from "../utils/path-jail.js";
import { availableVoyageKey } from "../utils/voyage-key.js";
import { trackedAmong } from "../utils/state-hygiene.js";

type WriteMode = "write" | "append" | "skip-if-marked";

interface FileAction {
    /** Project-relative target path. */
    targetRel: string;
    /** Bytes to write. */
    content: string;
    /** Substring used to recognize a prior NREKI install (skip on append). */
    marker: string;
    /**
     * "write" = NREKI-owned file (rewritten with --force).
     * "append" = user-owned file: NREKI only adds/replaces its own
     * sentinel-delimited block; --force never touches the user's content.
     */
    mode: WriteMode;
    /** Make executable on POSIX (mode 0o755). */
    executable?: boolean;
}

export interface InitOptions {
    /** Project root the init writes into. Defaults to process.cwd(). */
    cwd?: string;
    /** Explicit agent override. Bypasses disk detection. */
    agent?: DetectedAgent;
    /** Explicit agent list (`--agent codex,antigravity`). Bypasses disk detection. */
    agents?: DetectedAgent[];
    /** Home folder consulted for installed agents. Defaults to os.homedir(). */
    home?: string;
    /** Overwrite existing NREKI block instead of skipping when marker present. */
    force?: boolean;
    /** Print plan and skip filesystem mutations. */
    dryRun?: boolean;
    /** Register NREKI as an MCP server for each agent (default true; `--no-mcp` turns it off). */
    mcp?: boolean;
    /** `--voyage` sets NREKI_SEMANTIC=voyage in the registrations, `--no-voyage` removes it. */
    voyage?: boolean;
    /** Version pinned in the registrations. Defaults to this package's version. */
    version?: string;
    /** CLI only: `--no-prompt` never shows the Voyage key box; `--prompt` forces it. */
    prompt?: boolean;
    /**
     * Install globally at user scope (`~/.claude.json`, `~/.gemini/config/plugins/nreki/`,
     * `~/.cursor/mcp.json`, `~/.codex/config.toml`, VS Code `Code/User/mcp.json`) so every
     * project works automatically without per-repo `.mcp.json` approval prompts.
     */
    global?: boolean;
}

export interface InitResult {
    /** First agent of `agents` (kept for callers that handle a single agent). */
    agent: DetectedAgent;
    /** Every agent installed for. */
    agents: DetectedAgent[];
    /** Why these agents were chosen (detection reason or "--agent override"). */
    reason: string;
    /** Per-file outcome. `op` describes what we did (or would do in dry-run). */
    actions: Array<{ path: string; op: "created" | "appended" | "rewritten" | "skipped" | "merged" | "removed"; note?: string }>;
    /** What the user still has to do in each agent. */
    notes: string[];
}

/** Version of the installed package (dist/init → ../../package.json). */
export function packageVersion(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf-8")) as { version: string }).version;
}

/** Resolve templates/ shipped inside the installed package. */
function templatesDir(): string {
    // dist/init/init-runner.js → ../../templates
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..", "..", "templates");
}

function readTemplate(rel: string): string {
    return fs.readFileSync(path.join(templatesDir(), rel), "utf-8");
}

/**
 * Build the cursor `.mdc` body. Cursor's modern rule format wants a YAML
 * frontmatter block followed by the rule body. We use `alwaysApply: true`
 * so the rule pins to every prompt; users can lower this manually.
 */
function buildCursorRule(): string {
    const body = readTemplate("CLAUDE.md");
    return `---
description: NREKI MCP — surgical AST-validated editing, semantic search, token-savings (auto-installed by \`nreki init\`)
alwaysApply: true
---

${body}`;
}

/** Plan the file writes for a given agent. */
function planForAgent(agent: DetectedAgent): FileAction[] {
    switch (agent) {
        case "claude":
            return [
                {
                    targetRel: "CLAUDE.md",
                    content: readTemplate("CLAUDE.md"),
                    marker: "# NREKI ACTIVE",
                    mode: "append",
                },
                {
                    // Claude Code discovers project skills under .claude/skills/<name>/SKILL.md;
                    // the pre-v12.1.0 repo-root SKILL.md was never loaded (NREKI-INS-01).
                    targetRel: path.join(".claude", "skills", "nreki-optimizer", "SKILL.md"),
                    content: readTemplate("SKILL.md"),
                    marker: "name: nreki-optimizer",
                    mode: "write",
                },
                {
                    targetRel: path.join(".claude", "hooks", "nreki-enforcer.mjs"),
                    content: readTemplate(path.join("hooks", "nreki-enforcer.mjs")),
                    // v12.1.0: marker bumped to the v3 enforcer (token-aware: only large
                    // reads are steered, offset/limit honored, edits allowed, symlink-aware,
                    // fail-open when NREKI is not running). v4: its state file is never
                    // written through a link. Older enforcers on disk are upgraded; a
                    // current one is left alone. v5 previews native edits over local IPC.
                    // v6 measures shell file dumps and defers to the user-level copy.
                    marker: "nreki-enforcer:v6",
                    mode: "write",
                    executable: true,
                },
            ];
        case "cursor":
            return [
                {
                    targetRel: path.join(".cursor", "rules", "nreki.mdc"),
                    content: buildCursorRule(),
                    marker: "# NREKI ACTIVE",
                    mode: "write",
                },
            ];
        case "cline":
            return [
                {
                    targetRel: path.join(".clinerules", "nreki.md"),
                    content: readTemplate("CLAUDE.md"),
                    marker: "# NREKI ACTIVE",
                    mode: "write",
                },
            ];
        case "copilot":
            return [
                {
                    targetRel: path.join(".github", "copilot-instructions.md"),
                    content: readTemplate("AGENTS.md"),
                    marker: "NREKI MCP instructions",
                    mode: "append",
                },
            ];
        // Codex and Antigravity both read AGENTS.md at the project root (Antigravity
        // loads it as an always-on rule, without frontmatter).
        case "codex":
        case "antigravity":
        case "generic":
            return [
                {
                    targetRel: "AGENTS.md",
                    content: readTemplate("AGENTS.md"),
                    marker: "NREKI MCP instructions",
                    mode: "append",
                },
            ];
    }
}

// NREKI-owned region inside user-owned files (CLAUDE.md, AGENTS.md,
// copilot-instructions.md). Invisible when rendered.
const BLOCK_BEGIN = "<!-- nreki:begin -->";
const BLOCK_END = "<!-- nreki:end -->";

function wrapBlock(content: string): string {
    return `${BLOCK_BEGIN}\n${content.replace(/\s+$/, "")}\n${BLOCK_END}\n`;
}

/**
 * Replace ONLY the NREKI block of a user-owned file. Sentinel-delimited
 * blocks are replaced exactly; legacy (pre-sentinel) installs span from the
 * marker line to the first heading that is not a numbered NREKI section
 * ("## 3. …"), or EOF. Returns null when no block can be located.
 */
function replaceNrekiBlock(current: string, marker: string, block: string): string | null {
    const begin = current.indexOf(BLOCK_BEGIN);
    const endTag = begin === -1 ? -1 : current.indexOf(BLOCK_END, begin);
    if (begin !== -1 && endTag !== -1) {
        let end = endTag + BLOCK_END.length;
        if (current[end] === "\r") end++;
        if (current[end] === "\n") end++;
        return current.slice(0, begin) + block + current.slice(end);
    }

    const at = current.indexOf(marker);
    if (at === -1) return null;
    const start = current.lastIndexOf("\n", at) + 1;
    let end = current.indexOf("\n", at);
    end = end === -1 ? current.length : end + 1;
    while (end < current.length) {
        let next = current.indexOf("\n", end);
        next = next === -1 ? current.length : next + 1;
        const line = current.slice(end, next).replace(/\r?\n$/, "");
        if (/^#{1,6}\s/.test(line) && !/^##\s+\d+\./.test(line)) break; // foreign heading
        end = next;
    }
    return current.slice(0, start) + block + current.slice(end);
}

/** User-owned files where `init` adds a block: `deinit` removes only that block. */
const USER_OWNED_TARGETS: Array<{ rel: string; markers: string[] }> = [
    { rel: "CLAUDE.md", markers: ["# NREKI ACTIVE"] },
    // The second marker is the header of the pre-v12.1 AGENTS.md template.
    { rel: "AGENTS.md", markers: ["NREKI MCP instructions", "# Instructions for AI coding agents consuming NREKI via MCP"] },
    { rel: path.join(".github", "copilot-instructions.md"), markers: ["NREKI MCP instructions"] },
];

/** Files `init` owns outright: `deinit` deletes them when they still carry NREKI's marker. */
const NREKI_OWNED_TARGETS: Array<{ rel: string; marker: string }> = [
    { rel: path.join(".claude", "skills", "nreki-optimizer", "SKILL.md"), marker: "name: nreki-optimizer" },
    { rel: path.join(".cursor", "rules", "nreki.mdc"), marker: "# NREKI ACTIVE" },
    { rel: path.join(".clinerules", "nreki.md"), marker: "# NREKI ACTIVE" },
];

/**
 * Undo the instruction files `init` wrote. Before v12.3.0 `deinit` cut
 * CLAUDE.md from "# NREKI ACTIVE" to the end of the file (dropping the user's
 * text after the block and leaving the begin sentinel), never matched the
 * current AGENTS.md header, and left the Claude skill behind.
 */
export function removeInstructions(cwd: string, dryRun = false, only?: (rel: string) => boolean): InitResult["actions"] {
    const actions: InitResult["actions"] = [];
    for (const target of USER_OWNED_TARGETS) {
        if (only && !only(target.rel)) continue;
        const abs = path.join(cwd, target.rel);
        if (!fs.existsSync(abs)) continue;
        const unsafe = unsafeWriteTarget(cwd, target.rel);
        if (unsafe) { actions.push({ path: target.rel, op: "skipped", note: `${unsafe}: not touched` }); continue; }
        const current = fs.readFileSync(abs, "utf-8").replace(/^﻿/, "");
        let stripped: string | null = null;
        for (const marker of target.markers) {
            stripped = replaceNrekiBlock(current, marker, "");
            if (stripped !== null) break;
        }
        if (stripped === null) continue;
        const rest = stripped.replace(/\s+$/, "");
        if (!dryRun) {
            if (rest === "") fs.unlinkSync(abs);
            else fs.writeFileSync(abs, rest + (current.includes("\r\n") ? "\r\n" : "\n"), "utf-8");
        }
        actions.push({ path: target.rel, op: "removed", note: rest === "" ? "file deleted (it only held NREKI's block)" : "NREKI block removed; your content kept" });
    }
    for (const target of NREKI_OWNED_TARGETS) {
        if (only && !only(target.rel)) continue;
        const abs = path.join(cwd, target.rel);
        if (!fs.existsSync(abs)) continue;
        const unsafe = unsafeWriteTarget(cwd, target.rel);
        if (unsafe) { actions.push({ path: target.rel, op: "skipped", note: `${unsafe}: not touched` }); continue; }
        if (!fs.readFileSync(abs, "utf-8").includes(target.marker)) continue;
        if (!dryRun) {
            fs.unlinkSync(abs);
            removeEmptyDirs(cwd, path.dirname(abs));
        }
        actions.push({ path: target.rel, op: "removed", note: "file deleted" });
    }
    return actions;
}

function applyFileAction(
    cwd: string,
    action: FileAction,
    force: boolean,
    dryRun: boolean,
): InitResult["actions"][number] {
    const abs = path.join(cwd, action.targetRel);
    // A cloned repository can ship AGENTS.md -> ~/.bashrc: never write through a link.
    const unsafe = unsafeWriteTarget(cwd, action.targetRel);
    if (unsafe) return { path: action.targetRel, op: "skipped", note: `${unsafe}: not touched` };
    const exists = fs.existsSync(abs);
    // Append-mode targets belong to the USER: NREKI only ever owns its block.
    const userOwned = action.mode === "append";
    const payload = userOwned ? wrapBlock(action.content) : action.content;

    if (exists) {
        const current = fs.readFileSync(abs, "utf-8");
        const hasMarker = current.includes(action.marker);
        // A hook written by a newer NREKI is never downgraded by an older `init` (the server's upgrade does the same).
        const mine = hookVersion(current);
        const theirs = hookVersion(payload);
        if (!userOwned && !force && mine !== null && theirs !== null && mine > theirs) {
            return { path: action.targetRel, op: "skipped", note: `a newer NREKI hook (v${mine}) is installed` };
        }

        if (hasMarker && !force) {
            // NREKI's own text (its sentinel block, or a file it owns) is brought up
            // to date; without --force an upgrade used to keep the old instructions.
            if (userOwned) {
                const existing = sentinelBlockOf(current);
                const replaced = existing !== null && !sameText(existing, payload)
                    ? replaceNrekiBlock(current, action.marker, payload) : null;
                if (replaced !== null) {
                    if (!dryRun) fs.writeFileSync(abs, replaced, "utf-8");
                    return { path: action.targetRel, op: "rewritten", note: "NREKI block updated to this version; your content kept" };
                }
            } else if (!sameText(current, payload)) {
                if (!dryRun) {
                    fs.writeFileSync(abs, payload, "utf-8");
                    if (action.executable) chmodExec(abs);
                }
                return { path: action.targetRel, op: "rewritten", note: "updated to this version" };
            }
            return { path: action.targetRel, op: "skipped", note: "NREKI block already present (use --force to rewrite)" };
        }

        if (userOwned) {
            if (hasMarker) {
                // --force: rewrite the NREKI block in place. Pre-v12.1.0 this
                // overwrote the WHOLE file, destroying the user's own content.
                const replaced = replaceNrekiBlock(current, action.marker, payload);
                if (replaced !== null) {
                    if (!dryRun) fs.writeFileSync(abs, replaced, "utf-8");
                    return { path: action.targetRel, op: "rewritten", note: "NREKI block replaced; your content kept" };
                }
            }
            // append mode, no marker yet (with or without --force)
            if (!dryRun) {
                const sep = current.length === 0 || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
                fs.appendFileSync(abs, sep + payload, "utf-8");
            }
            return { path: action.targetRel, op: "appended" };
        }

        // NREKI-owned file (hook, skill, .mdc, .clinerules): rewrite.
        if (!dryRun) {
            ensureDir(path.dirname(abs));
            fs.writeFileSync(abs, payload, "utf-8");
            if (action.executable) chmodExec(abs);
        }
        return { path: action.targetRel, op: "rewritten" };
    }

    if (!dryRun) {
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, payload, "utf-8");
        if (action.executable) chmodExec(abs);
    }
    return { path: action.targetRel, op: "created" };
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function chmodExec(file: string): void {
    if (process.platform === "win32") return; // no-op on Windows
    try { fs.chmodSync(file, 0o755); } catch { /* best-effort */ }
}

/**
 * For agent=claude only: merge NREKI's PreToolUse enforcer hook into
 * `.claude/settings.json`. Idempotent — keeps any hooks the user added
 * for other tools and only touches the matchers we own.
 */
function mergeClaudeSettings(cwd: string, dryRun: boolean): InitResult["actions"][number] {
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const targetRel = path.relative(cwd, settingsPath);
    const unsafe = unsafeWriteTarget(cwd, targetRel);
    if (unsafe) return { path: targetRel, op: "skipped", note: `${unsafe}: not touched` };

    interface ClaudeSettings {
        hooks?: {
            PreToolUse?: Array<{
                matcher: string;
                hooks: Array<{ type: string; command: string }>;
            }>;
        };
        [key: string]: unknown;
    }

    let settings: ClaudeSettings = {};
    if (fs.existsSync(settingsPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as unknown;
            if (parsed && typeof parsed === "object") settings = parsed as ClaudeSettings;
        } catch {
            // Malformed JSON — fall through with empty defaults. The user's
            // existing settings.json would be overwritten, which is destructive,
            // so refuse instead and ask them to fix it.
            return { path: targetRel, op: "skipped", note: "settings.json is not valid JSON; refusing to overwrite" };
        }
    }

    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    // Bash/PowerShell: the hook measures only plain whole-file dumps (`cat big.ts`) and lets the rest pass.
    const toolsToBlock = [...CLAUDE_HOOK_TOOLS];
    const command = "node .claude/hooks/nreki-enforcer.mjs";
    let added = 0;
    for (const tool of toolsToBlock) {
        const entry = settings.hooks.PreToolUse.find(h => h.matcher === tool);
        if (!entry) {
            settings.hooks.PreToolUse.push({ matcher: tool, hooks: [{ type: "command", command }] });
            added++;
        } else if (Array.isArray(entry.hooks) && !entry.hooks.some(isNrekiHookCommand)) {
            // The user's own hook for this tool (a Bash guard, say) keeps running beside NREKI's.
            entry.hooks.push({ type: "command", command });
            added++;
        }
    }

    if (added === 0) {
        return { path: targetRel, op: "skipped", note: "PreToolUse hooks already wired" };
    }

    if (!dryRun) {
        ensureDir(path.dirname(settingsPath));
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    }
    return { path: targetRel, op: "merged", note: `added ${added} PreToolUse matcher(s)` };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNrekiHookCommand = (h: unknown): boolean =>
    isPlainObject(h) && typeof h.command === "string" && h.command.includes("nreki-enforcer.mjs");

/** True when `settingsAbs` runs NREKI's hook for each of `tools`. */
function settingsRunNrekiHook(settingsAbs: string, tools: readonly string[]): boolean {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(settingsAbs, "utf-8").replace(/^﻿/, "")); } catch { return false; }
    const pre = isPlainObject(parsed) && isPlainObject(parsed.hooks) ? parsed.hooks.PreToolUse : undefined;
    if (!Array.isArray(pre)) return false;
    return tools.every(tool => pre.some(e => isPlainObject(e) && e.matcher === tool && Array.isArray(e.hooks) && e.hooks.some(isNrekiHookCommand)));
}

/**
 * Remove NREKI's hook commands from a Claude settings file (`rel`), keeping
 * every other hook, also one that shares NREKI's matcher entry; a file left
 * empty is deleted. `references`: the file still runs nreki-enforcer.mjs (also
 * true when it cannot be parsed: then nothing may delete the hook file).
 */
export function stripNrekiHookCommands(cwd: string, rel: string, dryRun: boolean, why: string):
    { action: InitResult["actions"][number] | null; references: boolean } {
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) return { action: null, references: false };
    const unsafe = unsafeWriteTarget(cwd, rel);
    if (unsafe) return { action: { path: rel, op: "skipped", note: `${unsafe}: not touched` }, references: true };
    const raw = fs.readFileSync(abs, "utf-8");
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw.replace(/^﻿/, "")); } catch { parsed = null; }
    if (!isPlainObject(parsed)) {
        return { action: { path: rel, op: "skipped", note: "not a JSON object: not touched" }, references: raw.includes("nreki-enforcer.mjs") };
    }
    const hooks = isPlainObject(parsed.hooks) ? parsed.hooks : null;
    const pre = hooks && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : null;
    let removed = 0;
    if (hooks && pre) {
        const kept: unknown[] = [];
        for (const entry of pre) {
            if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) { kept.push(entry); continue; }
            const others = entry.hooks.filter(h => !isNrekiHookCommand(h));
            removed += entry.hooks.length - others.length;
            if (others.length > 0) kept.push({ ...entry, hooks: others });
        }
        if (removed > 0) {
            if (kept.length > 0) hooks.PreToolUse = kept;
            else delete hooks.PreToolUse;
            if (Object.keys(hooks).length === 0) delete parsed.hooks;
        }
    }
    const references = JSON.stringify(parsed).includes("nreki-enforcer.mjs");
    if (removed === 0) return { action: null, references };
    const empty = Object.keys(parsed).length === 0;
    if (!dryRun) {
        if (empty) fs.unlinkSync(abs);
        else {
            const eol = raw.includes("\r\n") ? "\r\n" : "\n";
            fs.writeFileSync(abs, JSON.stringify(parsed, null, 2).replace(/\n/g, eol) + eol, "utf-8");
        }
    }
    return {
        action: { path: rel, op: "removed", note: `${removed} NREKI hook command(s) ${why}${empty ? "; file deleted (it only held them)" : "; your hooks kept"}` },
        references,
    };
}

/**
 * The user-scope install replaces this project's Claude Code install. Kept
 * side by side, the project's registration ran NREKI's hook a second time on
 * every Read/Edit (a project `init`, then the user-scope one: measured on a real
 * project, 2026-11-27), and its CLAUDE.md block and skill put the same
 * instructions in every prompt twice. Only what NREKI wrote goes (its hook
 * command, a stock hook file, its CLAUDE.md block, its skill), and only once the
 * user-scope copy of each is in place; the user's own hooks and text stay.
 */
function migrateProjectClaudeInstall(cwd: string, home: string, dryRun: boolean, globalActions: McpAction[]): InitResult["actions"] {
    const actions: InitResult["actions"] = [];
    const moved = "now in the user-scope install (~/.claude): the project copy ran twice";
    const globalOk = (label: string): boolean => {
        const a = globalActions.find(x => x.path.replace(/\\/g, "/") === label);
        if (!a) return false;
        if (dryRun) return a.op !== "skipped" || /up to date|already/.test(a.note ?? "");
        return true;
    };

    // Claude Code started with CLAUDE_CONFIG_DIR reads another folder than the
    // ~/.claude this install wrote: there the project's copy is the only one.
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (configDir && !sameDir(configDir, path.join(home, ".claude"))) {
        return [{ path: ".claude", op: "skipped", note: "CLAUDE_CONFIG_DIR points Claude Code at another folder than ~/.claude: this project's install is kept" }];
    }

    // 1. NREKI's hook commands in .claude/settings.json and settings.local.json (the user's hooks stay).
    const userHookAbs = path.join(home, ".claude", "hooks", "nreki-enforcer.mjs");
    const userHooksReady = dryRun
        ? globalOk("~/.claude/settings.json") && globalOk("~/.claude/hooks/nreki-enforcer.mjs")
        : fs.existsSync(userHookAbs) && settingsRunNrekiHook(path.join(home, ".claude", "settings.json"), CLAUDE_HOOK_TOOLS);
    let projectHookUnreferenced = userHooksReady;
    if (userHooksReady) {
        for (const rel of [path.join(".claude", "settings.json"), path.join(".claude", "settings.local.json")]) {
            const { action, references } = stripNrekiHookCommands(cwd, rel, dryRun, moved);
            if (action) actions.push(action);
            if (references) projectHookUnreferenced = false;
        }
    }

    // 2. The project's stock hook file, once nothing in the project runs it.
    const hookRel = path.join(".claude", "hooks", "nreki-enforcer.mjs");
    const hookAbs = path.join(cwd, hookRel);
    if (projectHookUnreferenced && fs.existsSync(hookAbs) && !unsafeWriteTarget(cwd, hookRel)) {
        const text = fs.readFileSync(hookAbs, "utf-8");
        if (hookVersion(text) !== null || text.includes("/^(Write|Edit|Replace)(File)?$/i")) {
            if (!dryRun) {
                fs.unlinkSync(hookAbs);
                removeEmptyDirs(cwd, path.dirname(hookAbs));
            }
            actions.push({ path: hookRel, op: "removed", note: `stock NREKI hook ${moved}` });
        }
    }

    // 3. CLAUDE.md block and skill, once the user-scope copies exist.
    const claudeMdReady = dryRun ? globalOk("~/.claude/CLAUDE.md")
        : (() => { try { return fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf-8").includes("# NREKI ACTIVE"); } catch { return false; } })();
    const skillReady = dryRun ? globalOk("~/.claude/skills/nreki-optimizer/SKILL.md")
        : fs.existsSync(path.join(home, ".claude", "skills", "nreki-optimizer", "SKILL.md"));
    const only = (rel: string): boolean => (rel === "CLAUDE.md" && claudeMdReady)
        || (rel === path.join(".claude", "skills", "nreki-optimizer", "SKILL.md") && skillReady);
    for (const action of removeInstructions(cwd, dryRun, only)) {
        actions.push(action.op === "removed" ? { ...action, note: `${action.note}; ${moved}` } : action);
    }
    return actions;
}

/**
 * Run `nreki init`. Pure function over the filesystem so tests can
 * mkdtemp + assert on the returned plan.
 */
export function runInit(opts: InitOptions = {}): InitResult {
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const home = path.resolve(opts.home ?? os.homedir());
    const force = opts.force === true;
    const dryRun = opts.dryRun === true;
    const version = opts.version ?? packageVersion();

    // ─── User-scoped (Global) installation ────────────────────────────────
    if (opts.global === true) {
        const explicit = [...(opts.agents ?? []), ...(opts.agent ? [opts.agent] : [])];
        const agents: DetectedAgent[] = explicit.length > 0
            ? KNOWN_AGENTS.filter((a) => explicit.includes(a))
            : defaultGlobalAgents(home);
        const reason = explicit.length > 0
            ? "global install (--agent override)"
            : `global user-scope install for ${agents.join(", ")} (active across all projects, zero per-repo approval needed)`;

        const actions: InitResult["actions"] = [];
        const notes: string[] = [];

        if (opts.mcp !== false) {
            for (const agent of agents) {
                if (isGlobalAgent(agent)) {
                    const globalActions = registerGlobalAgent(agent, {
                        home,
                        version,
                        voyage: opts.voyage,
                        force,
                        dryRun,
                    });
                    actions.push(...globalActions);
                    // This folder's own Claude install would keep running beside the user-scope one.
                    if (agent === "claude" && !isNonProjectLaunchDir(cwd, home)) {
                        actions.push(...migrateProjectClaudeInstall(cwd, home, dryRun, globalActions));
                    }
                }
            }
            // If `cwd` had an older unapproved repo `.mcp.json` entry written by
            // NREKI, clean it up so Claude Code uses user-scoped `~/.claude.json`
            // without showing an unapproved `.mcp.json` banner.
            if (agents.includes("claude") && !isNonProjectLaunchDir(cwd, home)) {
                const cleaned = unregisterMcp("claude", cwd, dryRun);
                if (cleaned && cleaned.op === "removed") {
                    actions.push({
                        path: cleaned.path,
                        op: "removed",
                        note: "migrated to ~/.claude.json (user scope — no per-project approval needed)",
                    });
                }
            }
            // A team may share the project install through git: say so before the removal is committed.
            if (!isNonProjectLaunchDir(cwd, home)) {
                const removed = actions.filter(a => a.op === "removed" && !a.path.startsWith("~"))
                    .map(a => a.path.replace(/\\/g, "/"));
                const tracked = trackedAmong(cwd, removed);
                if (tracked.length > 0) {
                    notes.push(
                        `${tracked.join(", ")} ${tracked.length === 1 ? "is" : "are"} tracked by git: committing ` +
                        "the removal also removes NREKI from this repository for teammates without the user-scope install " +
                        "(git checkout -- <file> restores one).",
                    );
                }
            }
        }

        // Non-global agents explicitly requested (e.g. cline / generic) still
        // get their project instruction files when run inside a project folder.
        const projectOnly = agents.filter((a) => !isGlobalAgent(a));
        if (!isNonProjectLaunchDir(cwd, home)) {
            const planned = new Set<string>();
            for (const agent of projectOnly) {
                for (const action of planForAgent(agent)) {
                    if (planned.has(action.targetRel)) continue;
                    planned.add(action.targetRel);
                    actions.push(applyFileAction(cwd, action, force, dryRun));
                }
            }
        }

        const configuredGlobal = agents.filter(isGlobalAgent);
        if (configuredGlobal.length > 0 && opts.mcp !== false) {
            notes.push(
                `Global MCP ready for ${configuredGlobal.join(", ")}: reload or restart open editor windows once; ` +
                "every project now loads nreki_navigate, nreki_code, and nreki_guard automatically without per-project approval.",
            );
        }
        if (opts.voyage === undefined && availableVoyageKey() !== null) {
            notes.push("A Voyage key is saved: run `npx nreki init --voyage` to enable semantic search globally.");
        }
        return { agent: agents[0] ?? "generic", agents, reason, actions, notes };
    }

    // ─── Project-scoped installation ──────────────────────────────────────
    let agents: DetectedAgent[];
    let reason: string;
    const explicit = [...(opts.agents ?? []), ...(opts.agent ? [opts.agent] : [])];
    if (explicit.length > 0) {
        agents = KNOWN_AGENTS.filter((a) => explicit.includes(a));
        reason = "--agent override";
    } else {
        const detection = detectAgent(cwd, home);
        agents = detection.agents;
        reason = detection.reason;
    }

    const actions: InitResult["actions"] = [];
    // Codex, Antigravity and generic share AGENTS.md: write each target once.
    const planned = new Set<string>();
    for (const agent of agents) {
        for (const action of planForAgent(agent)) {
            if (planned.has(action.targetRel)) continue;
            planned.add(action.targetRel);
            actions.push(applyFileAction(cwd, action, force, dryRun));
        }
        if (agent === "claude") actions.push(mergeClaudeSettings(cwd, dryRun));
    }

    const notes: string[] = [];
    if (opts.mcp !== false) {
        for (const agent of agents) {
            if (!isMcpHost(agent)) continue;
            const result: McpAction = registerMcp(agent, { cwd, version, voyage: opts.voyage, force, dryRun });
            actions.push(result);
            if (result.op !== "skipped" || /already registered/.test(result.note ?? "")) notes.push(NEXT_STEP[agent]);
        }
        const manual = agents.filter((a) => !isMcpHost(a));
        if (manual.length > 0) {
            const { command, args } = launchCommand(version);
            notes.push(
                `${manual.join(", ")}: register the MCP server by hand — command "${command}", args ${JSON.stringify(args)}, ` +
                `started in this folder (or set NREKI_PROJECT_ROOT=${cwd}).`,
            );
        }
        const machineSpecific = [
            ...(agents.includes("codex") ? [".codex/config.toml"] : []),
            ...(agents.includes("cursor") ? [".cursor/mcp.json"] : []),
        ];
        if (machineSpecific.length > 0) {
            notes.push(`${machineSpecific.join(" and ")} hold${machineSpecific.length === 1 ? "s" : ""} this computer's path to the project: keep ${machineSpecific.length === 1 ? "it" : "them"} out of git.`);
        }
        if (opts.voyage === undefined && availableVoyageKey() !== null) {
            notes.push("A Voyage key is set: add --voyage to turn on semantic search for this project (its code is sent to Voyage once to be indexed).");
        }
    }

    return { agent: agents[0], agents, reason, actions, notes };
}

/** What the user still has to do after the registration, per host. */
const NEXT_STEP: Record<"claude" | "codex" | "antigravity" | "cursor" | "copilot", string> = {
    claude: "Claude Code: start it in this folder and approve the project server \"nreki\" when asked (.mcp.json), or run `npx nreki init --global` to skip per-project approval.",
    codex: "Codex: restart Codex and open this folder as a trusted project; Codex ignores .codex/config.toml in untrusted projects.",
    antigravity: "Antigravity: open \"Manage MCP servers\" and press Refresh (the server is in .agents/mcp_config.json).",
    cursor: "Cursor: restart Cursor and enable \"nreki\" in its MCP settings if it is off (.cursor/mcp.json).",
    copilot: "VS Code: open .vscode/mcp.json and start the \"nreki\" server for Copilot agent mode.",
};

/**
 * Parse argv-style flags accepted by `nreki init`. Returns a usable
 * InitOptions plus an error string for invalid input so the CLI can
 * print a helpful message and exit non-zero.
 */
export function parseInitArgs(argv: string[]): { opts: InitOptions; error?: string } {
    const opts: InitOptions = {};
    const addAgents = (value: string | undefined): string | undefined => {
        if (!value) return "--agent requires a value";
        for (const name of value.split(",").map((s) => s.trim()).filter(Boolean)) {
            if (!isKnownAgent(name)) return `unknown agent "${name}"; valid: ${KNOWN_AGENTS.join(", ")}`;
            opts.agents = [...(opts.agents ?? []), name];
        }
        if (!opts.agents || opts.agents.length === 0) return "--agent requires a value";
        opts.agent = opts.agents[0];
        return undefined;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") { opts.force = true; continue; }
        if (a === "--dry-run") { opts.dryRun = true; continue; }
        if (a === "--no-mcp") { opts.mcp = false; continue; }
        if (a === "--voyage") { opts.voyage = true; continue; }
        if (a === "--no-voyage") { opts.voyage = false; continue; }
        if (a === "--no-prompt") { opts.prompt = false; continue; }
        if (a === "--prompt") { opts.prompt = true; continue; }
        if (a === "--global" || a === "-g") { opts.global = true; continue; }
        if (a === "--project" || a === "--local") { opts.global = false; continue; }
        if (a === "--agent") {
            const error = addAgents(argv[++i]);
            if (error) return { opts, error };
            continue;
        }
        if (a.startsWith("--agent=")) {
            const error = addAgents(a.slice("--agent=".length));
            if (error) return { opts, error };
            continue;
        }
        return { opts, error: `unknown flag: ${a}` };
    }
    return { opts };
}

/** One-line summary of an init action suitable for console output. */
export function formatAction(a: InitResult["actions"][number]): string {
    const tag = ({
        created: "[create]",
        appended: "[append]",
        rewritten: "[write] ",
        merged: "[merge] ",
        skipped: "[skip]  ",
        removed: "[remove]",
    } as const)[a.op];
    return `${tag} ${a.path}${a.note ? ` — ${a.note}` : ""}`;
}
