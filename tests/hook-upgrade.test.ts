/**
 * F-01 (external audit of 12.1.1): the server rewrote .claude/hooks/nreki-enforcer.mjs
 * at start whenever it lacked "cwdPosix" — any file, including a hook the user
 * wrote, and through a symbolic link to a file outside the project. `nreki init`
 * and `deinit` also wrote through links. On Windows without symlink rights, a
 * directory junction (reported as a link by lstat) stands in for the link.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { upgradeEnforcerHook } from "../src/init/hook-upgrade.js";
import { runInit } from "../src/init/init-runner.js";
import { unsafeWriteTarget } from "../src/utils/path-jail.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** `.claude` inside the project is a link to a folder outside it. */
function linkedClaudeDir(): { project: string; outside: string } {
    const project = tmp("nreki-hook-project-");
    const outside = tmp("nreki-hook-outside-");
    fs.mkdirSync(path.join(outside, "hooks"), { recursive: true });
    fs.symlinkSync(outside, path.join(project, ".claude"), process.platform === "win32" ? "junction" : "dir");
    return { project, outside };
}

const STOCK_V1 = "#!/usr/bin/env node\nif (/^(Write|Edit|Replace)(File)?$/i.test(tool)) {}\n";
const UPSTREAM = "// nreki-enforcer:v3 — upgraded\n";

describe("hook upgrade at server start", () => {
    it("upgrades the stock hooks, and only those", () => {
        const project = tmp("nreki-hook-stock-");
        const hook = path.join(project, ".claude", "hooks", "nreki-enforcer.mjs");
        fs.mkdirSync(path.dirname(hook), { recursive: true });

        fs.writeFileSync(hook, STOCK_V1);
        expect(upgradeEnforcerHook(project, () => UPSTREAM)).toBe("upgraded");
        expect(fs.readFileSync(hook, "utf8")).toBe(UPSTREAM);

        fs.writeFileSync(hook, "// nreki-enforcer:v2\n");
        expect(upgradeEnforcerHook(project, () => UPSTREAM)).toBe("upgraded");

        // A hook the user wrote (no stock matcher): left alone. It lacked "cwdPosix"
        // and used to be overwritten.
        const custom = "#!/usr/bin/env node\n// my own PreToolUse hook\nprocess.exit(0);\n";
        fs.writeFileSync(hook, custom);
        expect(upgradeEnforcerHook(project, () => UPSTREAM)).toBe("not-nreki");
        expect(fs.readFileSync(hook, "utf8")).toBe(custom);
    });

    it("never writes through a link that leaves the project", () => {
        const { project, outside } = linkedClaudeDir();
        const target = path.join(outside, "hooks", "nreki-enforcer.mjs");
        fs.writeFileSync(target, STOCK_V1);
        expect(unsafeWriteTarget(project, ".claude/hooks/nreki-enforcer.mjs")).toBe("a symbolic link");
        expect(upgradeEnforcerHook(project, () => UPSTREAM)).toBe("unsafe-path");
        expect(fs.readFileSync(target, "utf8")).toBe(STOCK_V1);
    });
});

describe("nreki init", () => {
    it("skips the files it would write through a linked folder, and writes the others", () => {
        const { project, outside } = linkedClaudeDir();
        const result = runInit({ cwd: project, agent: "claude" });
        const skipped = result.actions.filter(a => a.op === "skipped" && /symbolic link/.test(a.note ?? ""));
        expect(skipped.map(a => a.path.replace(/\\/g, "/")).sort()).toEqual([
            ".claude/hooks/nreki-enforcer.mjs", ".claude/settings.json", ".claude/skills/nreki-optimizer/SKILL.md",
        ]);
        expect(fs.readdirSync(path.join(outside, "hooks"))).toEqual([]);
        expect(fs.existsSync(path.join(outside, "settings.json"))).toBe(false);
        expect(fs.existsSync(path.join(outside, "skills"))).toBe(false);
        expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toContain("# NREKI ACTIVE");
    });
});
