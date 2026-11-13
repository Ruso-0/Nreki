/**
 * init/init-runner.ts — orchestrates `nreki init` for the detected (or
 * explicitly chosen) AI coding agent.
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
import path from "path";
import { fileURLToPath } from "url";
import type { DetectedAgent } from "./agent-detect.js";
import { detectAgent, isKnownAgent } from "./agent-detect.js";

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
    /** Overwrite existing NREKI block instead of skipping when marker present. */
    force?: boolean;
    /** Print plan and skip filesystem mutations. */
    dryRun?: boolean;
}

export interface InitResult {
    agent: DetectedAgent;
    /** Why this agent was chosen (detection reason or "--agent override"). */
    reason: string;
    /** Per-file outcome. `op` describes what we did (or would do in dry-run). */
    actions: Array<{ path: string; op: "created" | "appended" | "rewritten" | "skipped" | "merged"; note?: string }>;
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
                    // fail-open when NREKI is not running). Older enforcers on disk are
                    // upgraded; a current one is left alone.
                    marker: "nreki-enforcer:v3",
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

function applyFileAction(
    cwd: string,
    action: FileAction,
    force: boolean,
    dryRun: boolean,
): InitResult["actions"][number] {
    const abs = path.join(cwd, action.targetRel);
    const exists = fs.existsSync(abs);
    // Append-mode targets belong to the USER: NREKI only ever owns its block.
    const userOwned = action.mode === "append";
    const payload = userOwned ? wrapBlock(action.content) : action.content;

    if (exists) {
        const current = fs.readFileSync(abs, "utf-8");
        const hasMarker = current.includes(action.marker);

        if (hasMarker && !force) {
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

    const toolsToBlock = ["Read", "ReadFile", "View", "ViewFile", "Write", "WriteFile", "Edit", "EditFile", "MultiEdit", "Replace"];
    let added = 0;
    for (const tool of toolsToBlock) {
        const exists = settings.hooks.PreToolUse.some(h => h.matcher === tool);
        if (!exists) {
            settings.hooks.PreToolUse.push({
                matcher: tool,
                hooks: [{ type: "command", command: "node .claude/hooks/nreki-enforcer.mjs" }],
            });
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

/**
 * Run `nreki init`. Pure function over the filesystem so tests can
 * mkdtemp + assert on the returned plan.
 */
export function runInit(opts: InitOptions = {}): InitResult {
    const cwd = opts.cwd ?? process.cwd();

    let agent: DetectedAgent;
    let reason: string;
    if (opts.agent) {
        agent = opts.agent;
        reason = "--agent override";
    } else {
        const detection = detectAgent(cwd);
        agent = detection.agent;
        reason = detection.reason;
    }

    const actions: InitResult["actions"] = [];
    const plan = planForAgent(agent);
    for (const action of plan) {
        actions.push(applyFileAction(cwd, action, opts.force === true, opts.dryRun === true));
    }
    if (agent === "claude") {
        actions.push(mergeClaudeSettings(cwd, opts.dryRun === true));
    }

    return { agent, reason, actions };
}

/**
 * Parse argv-style flags accepted by `nreki init`. Returns a usable
 * InitOptions plus an error string for invalid input so the CLI can
 * print a helpful message and exit non-zero.
 */
export function parseInitArgs(argv: string[]): { opts: InitOptions; error?: string } {
    const opts: InitOptions = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--force") { opts.force = true; continue; }
        if (a === "--dry-run") { opts.dryRun = true; continue; }
        if (a === "--agent") {
            const v = argv[++i];
            if (!v) return { opts, error: "--agent requires a value" };
            if (!isKnownAgent(v)) {
                return { opts, error: `unknown agent "${v}"; valid: claude, cursor, cline, copilot, generic` };
            }
            opts.agent = v;
            continue;
        }
        if (a.startsWith("--agent=")) {
            const v = a.slice("--agent=".length);
            if (!isKnownAgent(v)) {
                return { opts, error: `unknown agent "${v}"; valid: claude, cursor, cline, copilot, generic` };
            }
            opts.agent = v;
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
    } as const)[a.op];
    return `${tag} ${a.path}${a.note ? ` — ${a.note}` : ""}`;
}
