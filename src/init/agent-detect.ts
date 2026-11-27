/**
 * init/agent-detect.ts — detect which AI coding agents a project uses
 * so `nreki init` can drop instructions in the format each agent reads
 * and register NREKI as an MCP server for it.
 *
 * Detection is conservative: a positive signal (config dir or rules file
 * already present on disk) wins, and every agent with a signal in the project
 * is installed. Without any project signal, v12.3.0 installs for the agents
 * found in the user's home folder (Claude Code, Codex, Antigravity, Cursor),
 * so a fresh project needs one command. When neither exists we fall back to
 * "generic" (AGENTS.md) and the caller surfaces an honest disclosure so the
 * user can re-run with --agent <name> if the guess is wrong.
 */

import fs from "fs";
import os from "os";
import path from "path";

export type DetectedAgent =
    | "claude"      // Anthropic Claude Code (.claude/, CLAUDE.md, hooks, .mcp.json)
    | "codex"       // OpenAI Codex (.codex/config.toml, AGENTS.md)
    | "antigravity" // Google Antigravity (.agents/, GEMINI.md, AGENTS.md)
    | "cursor"      // Cursor (.cursor/rules/*.mdc, legacy .cursorrules, .cursor/mcp.json)
    | "cline"       // Cline VS Code extension (.clinerules, .clinerules/)
    | "copilot"     // GitHub Copilot (.github/copilot-instructions.md, .vscode/mcp.json)
    | "generic";    // Fallback: AGENTS.md cross-agent convention

/** Every agent id, in detection priority order. */
export const KNOWN_AGENTS: readonly DetectedAgent[] =
    ["claude", "codex", "antigravity", "cursor", "cline", "copilot", "generic"];

export interface AgentDetectionResult {
    /** First agent of `agents` (kept for callers that handle a single agent). */
    agent: DetectedAgent;
    /** Every agent `nreki init` installs for. */
    agents: DetectedAgent[];
    reason: string;
    /** Agents with a signal inside the project. */
    detected: DetectedAgent[];
    /** Agents found in the user's home folder (consulted only without project signals). */
    installed: DetectedAgent[];
}

const exists = (p: string): boolean => {
    try { return fs.existsSync(p); } catch { return false; }
};

/** Agents configured inside the project, in priority order. */
export function detectProjectAgents(cwd: string): DetectedAgent[] {
    const found: DetectedAgent[] = [];
    if (exists(path.join(cwd, ".claude")) || exists(path.join(cwd, "CLAUDE.md"))) found.push("claude");
    if (exists(path.join(cwd, ".codex"))) found.push("codex");
    if (
        exists(path.join(cwd, ".agents", "mcp_config.json")) ||
        exists(path.join(cwd, ".agents", "rules")) ||
        exists(path.join(cwd, ".agent", "rules")) ||
        exists(path.join(cwd, "GEMINI.md"))
    ) found.push("antigravity");
    if (exists(path.join(cwd, ".cursor")) || exists(path.join(cwd, ".cursorrules"))) found.push("cursor");
    if (exists(path.join(cwd, ".clinerules"))) found.push("cline");
    if (exists(path.join(cwd, ".github", "copilot-instructions.md"))) found.push("copilot");
    return found;
}

/**
 * Agents installed for this user, from their home-folder state. Only agents
 * whose MCP registration NREKI can write into the project are listed.
 */
export function detectInstalledAgents(home: string): DetectedAgent[] {
    const found: DetectedAgent[] = [];
    if (exists(path.join(home, ".claude")) || exists(path.join(home, ".claude.json"))) found.push("claude");
    if (exists(path.join(home, ".codex"))) found.push("codex");
    if (
        exists(path.join(home, ".gemini", "antigravity")) ||
        exists(path.join(home, ".gemini", "antigravity-ide")) ||
        exists(path.join(home, ".gemini", "config"))
    ) {
        found.push("antigravity");
    }
    if (exists(path.join(home, ".cursor"))) found.push("cursor");
    return found;
}

/**
 * Detect which agent(s) to install for: project signals first, then the
 * agents installed for this user, then the generic AGENTS.md fallback.
 */
export function detectAgent(cwd: string = process.cwd(), home: string = os.homedir()): AgentDetectionResult {
    const detected = detectProjectAgents(cwd);
    if (detected.length > 0) {
        const reason = detected.length === 1
            ? `detected ${detected[0]}`
            : `detected ${detected.join(", ")}; installing for each (pass --agent to choose)`;
        return { agent: detected[0], agents: detected, reason, detected, installed: [] };
    }

    const installed = detectInstalledAgents(home);
    if (installed.length > 0) {
        return {
            agent: installed[0],
            agents: installed,
            reason: `no agent config in this project; installing for the agents found on this computer: ${installed.join(", ")} (pass --agent to choose)`,
            detected,
            installed,
        };
    }

    return {
        agent: "generic",
        agents: ["generic"],
        reason: "no agent-specific config found; writing AGENTS.md (cross-agent convention)",
        detected,
        installed,
    };
}

/** True if `name` is one of the known agent ids. */
export function isKnownAgent(name: string): name is DetectedAgent {
    return (KNOWN_AGENTS as readonly string[]).includes(name);
}
