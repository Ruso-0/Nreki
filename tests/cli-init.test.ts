/**
 * cli-init.test.ts — v11.3.0 `nreki init` agent-aware install.
 *
 * Tests are filesystem-based: each test mkdtemps a workspace, optionally
 * stubs an agent-config marker, runs runInit, and asserts the on-disk
 * outcome. Templates are read from the live templates/ dir (no mocking)
 * so the test exercises the same code path consumers do.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { detectAgent } from "../src/init/agent-detect.js";
import { parseInitArgs, runInit } from "../src/init/init-runner.js";

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nreki-init-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectAgent", () => {
    it("returns generic when no agent config is present", () => {
        const result = detectAgent(tmpDir);
        expect(result.agent).toBe("generic");
        expect(result.detected).toEqual([]);
    });

    it("detects claude from .claude/ directory", () => {
        fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
        const result = detectAgent(tmpDir);
        expect(result.agent).toBe("claude");
        expect(result.detected).toContain("claude");
    });

    it("detects claude from CLAUDE.md alone", () => {
        fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "user content\n");
        expect(detectAgent(tmpDir).agent).toBe("claude");
    });

    it("detects cursor from .cursor/ directory", () => {
        fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });
        expect(detectAgent(tmpDir).agent).toBe("cursor");
    });

    it("detects cursor from legacy .cursorrules", () => {
        fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "x");
        expect(detectAgent(tmpDir).agent).toBe("cursor");
    });

    it("detects cline from .clinerules", () => {
        fs.writeFileSync(path.join(tmpDir, ".clinerules"), "x");
        expect(detectAgent(tmpDir).agent).toBe("cline");
    });

    it("detects copilot from .github/copilot-instructions.md", () => {
        fs.mkdirSync(path.join(tmpDir, ".github"), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, ".github", "copilot-instructions.md"), "x");
        expect(detectAgent(tmpDir).agent).toBe("copilot");
    });

    it("prioritizes claude over cursor when both are present", () => {
        fs.mkdirSync(path.join(tmpDir, ".claude"));
        fs.mkdirSync(path.join(tmpDir, ".cursor"));
        const result = detectAgent(tmpDir);
        expect(result.agent).toBe("claude");
        expect(result.detected).toEqual(["claude", "cursor"]);
        expect(result.reason).toContain("--agent to override");
    });
});

describe("parseInitArgs", () => {
    it("parses --agent <value>", () => {
        const r = parseInitArgs(["--agent", "cursor"]);
        expect(r.error).toBeUndefined();
        expect(r.opts.agent).toBe("cursor");
    });

    it("parses --agent=<value>", () => {
        const r = parseInitArgs(["--agent=cline"]);
        expect(r.opts.agent).toBe("cline");
    });

    it("rejects unknown agent names", () => {
        const r = parseInitArgs(["--agent", "bibi"]);
        expect(r.error).toMatch(/unknown agent/);
    });

    it("rejects --agent with no value", () => {
        const r = parseInitArgs(["--agent"]);
        expect(r.error).toMatch(/requires a value/);
    });

    it("parses --force and --dry-run together", () => {
        const r = parseInitArgs(["--force", "--dry-run"]);
        expect(r.opts.force).toBe(true);
        expect(r.opts.dryRun).toBe(true);
    });

    it("rejects unknown flags", () => {
        const r = parseInitArgs(["--nope"]);
        expect(r.error).toMatch(/unknown flag/);
    });
});

describe("runInit — generic", () => {
    it("creates AGENTS.md when no agent is detected", () => {
        const result = runInit({ cwd: tmpDir });
        expect(result.agent).toBe("generic");
        expect(result.reason).toMatch(/no agent-specific/);
        const agents = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
        expect(agents).toContain("NREKI MCP instructions");
        expect(result.actions.some(a => a.path === "AGENTS.md" && a.op === "created")).toBe(true);
    });

    it("skips when AGENTS.md already contains NREKI marker", () => {
        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "NREKI MCP instructions — already here\n");
        const result = runInit({ cwd: tmpDir, agent: "generic" });
        expect(result.actions[0].op).toBe("skipped");
    });

    it("appends to AGENTS.md when present without marker", () => {
        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "# user rules\n- be helpful\n");
        const result = runInit({ cwd: tmpDir, agent: "generic" });
        expect(result.actions[0].op).toBe("appended");
        const final = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
        expect(final).toContain("# user rules");
        expect(final).toContain("NREKI MCP instructions");
    });

    it("--force rewrites even when marker is present", () => {
        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "NREKI MCP instructions — STALE\n");
        const result = runInit({ cwd: tmpDir, agent: "generic", force: true });
        expect(result.actions[0].op).toBe("rewritten");
        const final = fs.readFileSync(path.join(tmpDir, "AGENTS.md"), "utf-8");
        expect(final).not.toContain("STALE");
    });

    it("--dry-run does not write to disk", () => {
        const result = runInit({ cwd: tmpDir, agent: "generic", dryRun: true });
        expect(result.actions[0].op).toBe("created");
        expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(false);
    });
});

describe("runInit — claude", () => {
    it("installs CLAUDE.md + SKILL.md + enforcer hook + settings", () => {
        const result = runInit({ cwd: tmpDir, agent: "claude" });
        expect(result.agent).toBe("claude");
        expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, "SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".claude", "hooks", "nreki-enforcer.mjs"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".claude", "settings.json"))).toBe(true);
        const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf-8"));
        expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
        expect(settings.hooks.PreToolUse.some((h: { matcher: string }) => h.matcher === "Read")).toBe(true);
    });

    it("does not duplicate matchers in an existing settings.json", () => {
        const settingsPath = path.join(tmpDir, ".claude", "settings.json");
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const original = {
            hooks: {
                PreToolUse: [
                    { matcher: "Read", hooks: [{ type: "command", command: "node .claude/hooks/nreki-enforcer.mjs" }] },
                ],
            },
        };
        fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2), "utf-8");

        const result = runInit({ cwd: tmpDir, agent: "claude" });
        const settingsAction = result.actions.find(a => a.path.endsWith("settings.json"));
        // 8 of 9 matchers still need to be added; "Read" already exists.
        expect(settingsAction?.op).toBe("merged");
        const final = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const readEntries = final.hooks.PreToolUse.filter((h: { matcher: string }) => h.matcher === "Read");
        expect(readEntries).toHaveLength(1);
    });

    it("upgrades legacy enforcer hook (no cwdPosix marker)", () => {
        const hookPath = path.join(tmpDir, ".claude", "hooks", "nreki-enforcer.mjs");
        fs.mkdirSync(path.dirname(hookPath), { recursive: true });
        fs.writeFileSync(hookPath, "// legacy hook without security hardening\n");

        const result = runInit({ cwd: tmpDir, agent: "claude" });
        const hookAction = result.actions.find(a => a.path.endsWith("nreki-enforcer.mjs"));
        expect(hookAction?.op).toBe("rewritten");
        const final = fs.readFileSync(hookPath, "utf-8");
        expect(final).toContain("cwdPosix");
    });
});

describe("runInit — cursor", () => {
    it("creates .cursor/rules/nreki.mdc with frontmatter", () => {
        const result = runInit({ cwd: tmpDir, agent: "cursor" });
        const mdcPath = path.join(tmpDir, ".cursor", "rules", "nreki.mdc");
        expect(fs.existsSync(mdcPath)).toBe(true);
        const content = fs.readFileSync(mdcPath, "utf-8");
        expect(content.startsWith("---")).toBe(true);
        expect(content).toContain("alwaysApply: true");
        expect(content).toContain("# NREKI ACTIVE");
    });
});

describe("runInit — cline", () => {
    it("creates .clinerules/nreki.md", () => {
        const result = runInit({ cwd: tmpDir, agent: "cline" });
        const mdPath = path.join(tmpDir, ".clinerules", "nreki.md");
        expect(fs.existsSync(mdPath)).toBe(true);
        expect(fs.readFileSync(mdPath, "utf-8")).toContain("# NREKI ACTIVE");
    });
});

describe("runInit — copilot", () => {
    it("creates .github/copilot-instructions.md", () => {
        const result = runInit({ cwd: tmpDir, agent: "copilot" });
        const p = path.join(tmpDir, ".github", "copilot-instructions.md");
        expect(fs.existsSync(p)).toBe(true);
        expect(fs.readFileSync(p, "utf-8")).toContain("NREKI MCP instructions");
    });

    it("appends to existing .github/copilot-instructions.md without marker", () => {
        const p = path.join(tmpDir, ".github", "copilot-instructions.md");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "# user copilot rules\n- be terse\n");
        const result = runInit({ cwd: tmpDir, agent: "copilot" });
        expect(result.actions[0].op).toBe("appended");
        const final = fs.readFileSync(p, "utf-8");
        expect(final).toContain("# user copilot rules");
        expect(final).toContain("NREKI MCP instructions");
    });
});

describe("runInit — agent auto-detection end-to-end", () => {
    it("picks claude when .claude exists and writes claude files only", () => {
        fs.mkdirSync(path.join(tmpDir, ".claude"));
        const result = runInit({ cwd: tmpDir });
        expect(result.agent).toBe("claude");
        expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, ".cursor"))).toBe(false);
    });

    it("picks cursor when .cursorrules exists and skips claude files", () => {
        fs.writeFileSync(path.join(tmpDir, ".cursorrules"), "user rules\n");
        const result = runInit({ cwd: tmpDir });
        expect(result.agent).toBe("cursor");
        expect(fs.existsSync(path.join(tmpDir, ".cursor", "rules", "nreki.mdc"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(false);
    });
});
