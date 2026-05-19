/**
 * init/agent-detect.ts — detect which AI coding agent a project uses
 * so `nreki init` can drop instructions in the format that agent reads.
 *
 * Detection is conservative: a positive signal (config dir or rules file
 * already present on disk) wins. When no signal is present we fall back
 * to "generic" (AGENTS.md) and the caller surfaces an honest disclosure
 * so the user can re-run with --agent <name> if the guess is wrong.
 */

import fs from "fs";
import path from "path";

export type DetectedAgent =
    | "claude"   // Anthropic Claude Code (.claude/, CLAUDE.md, hooks)
    | "cursor"   // Cursor (.cursor/rules/*.mdc, legacy .cursorrules)
    | "cline"    // Cline VS Code extension (.clinerules, .clinerules/)
    | "copilot"  // GitHub Copilot (.github/copilot-instructions.md)
    | "generic"; // Fallback: AGENTS.md cross-agent convention

export interface AgentDetectionResult {
    agent: DetectedAgent;
    reason: string;
    detected: DetectedAgent[];
}

const exists = (p: string): boolean => {
    try { return fs.existsSync(p); } catch { return false; }
};

/**
 * Detect which agent(s) a project is configured for by inspecting disk.
 * Returns the FIRST match in priority order and the full list of signals
 * found so the caller can report ambiguity to the user.
 */
export function detectAgent(cwd: string = process.cwd()): AgentDetectionResult {
    const detected: DetectedAgent[] = [];

    if (exists(path.join(cwd, ".claude")) || exists(path.join(cwd, "CLAUDE.md"))) {
        detected.push("claude");
    }
    if (exists(path.join(cwd, ".cursor")) || exists(path.join(cwd, ".cursorrules"))) {
        detected.push("cursor");
    }
    if (exists(path.join(cwd, ".clinerules"))) {
        detected.push("cline");
    }
    if (exists(path.join(cwd, ".github", "copilot-instructions.md"))) {
        detected.push("copilot");
    }

    if (detected.length === 0) {
        return {
            agent: "generic",
            reason: "no agent-specific config found; writing AGENTS.md (cross-agent convention)",
            detected: [],
        };
    }

    // Priority order matches the listing above: claude > cursor > cline > copilot.
    const agent = detected[0];
    const reason = detected.length === 1
        ? `detected ${agent}`
        : `detected ${detected.join(", ")}; using ${agent} (pass --agent to override)`;

    return { agent, reason, detected };
}

/** True if `name` is one of the known agent ids. */
export function isKnownAgent(name: string): name is DetectedAgent {
    return name === "claude" || name === "cursor" || name === "cline" || name === "copilot" || name === "generic";
}
