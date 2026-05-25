#!/usr/bin/env tsx
/**
 * Sprint 7.0 — Sanity-gate check.
 *
 * Verifies all pre-registered gates from sprint70-prereg.md §"Pre-execution
 * sanity gates" BEFORE the experiment runs. Refuses to execute if any
 * gate fails. The harness exits with code 0 only when every gate passes.
 *
 * Run: `npx tsx scripts/eval-phase7/sprint70-sanity-gate.ts`
 *
 * Output: a structured pass/fail report on stderr + JSON on stdout.
 * Pipe stdout to scripts/eval-phase7/sprint70-sanity-gate.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

interface GateResult {
    name: string;
    pass: boolean;
    detail: string;
    blocker_level: "HARD" | "SOFT" | "WARNING";
}

const PROJECT_ROOT = path.resolve(process.cwd());
const TASK_WORKSPACES = path.join(
    PROJECT_ROOT, ".eval-phase5-cache", "task-workspaces",
);

function safeExec(cmd: string, args: string[]): { ok: boolean; out: string } {
    try {
        const out = execFileSync(cmd, args, {
            encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
        }).trim();
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e as Error).message };
    }
}

function gate(name: string, fn: () => GateResult): GateResult {
    try {
        return fn();
    } catch (e) {
        return {
            name, pass: false,
            detail: `gate threw: ${(e as Error).message}`,
            blocker_level: "HARD",
        };
    }
}

const gates: GateResult[] = [];

gates.push(gate("aider --version present", () => {
    const aider = process.env.AIDER_BINARY
        ?? path.join(".venv-aider", "Scripts", "aider.exe");
    if (!existsSync(aider)) {
        return {
            name: "aider --version present", pass: false,
            detail: `Aider binary not found at ${aider}`,
            blocker_level: "HARD",
        };
    }
    const r = safeExec(aider, ["--version"]);
    return {
        name: "aider --version present",
        pass: r.ok && /aider/i.test(r.out),
        detail: r.out.slice(0, 200),
        blocker_level: "HARD",
    };
}));

gates.push(gate("node ≥ v18", () => {
    const r = safeExec("node", ["--version"]);
    const ok = r.ok && /^v(\d+)/.test(r.out)
        && parseInt(r.out.match(/^v(\d+)/)![1], 10) >= 18;
    return {
        name: "node ≥ v18", pass: ok, detail: r.out,
        blocker_level: "HARD",
    };
}));

gates.push(gate("docker daemon reachable", () => {
    const r = safeExec("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return {
        name: "docker daemon reachable",
        pass: r.ok && r.out.length > 0,
        detail: r.ok ? `version ${r.out}` : r.out.slice(0, 200),
        // SOFT: an alternative non-Docker path is acceptable for some tasks
        // but blocks the vscode 23-task subset which needs xvfb on Linux.
        blocker_level: "HARD",
    };
}));

gates.push(gate("ANTHROPIC_API_KEY ≥ 30 chars", () => {
    const v = process.env.ANTHROPIC_API_KEY ?? "";
    return {
        name: "ANTHROPIC_API_KEY ≥ 30 chars",
        pass: v.length >= 30,
        detail: `len=${v.length}`,
        blocker_level: "HARD",
    };
}));

gates.push(gate("OPENAI_API_KEY ≥ 30 chars (Aider import requirement)", () => {
    const v = process.env.OPENAI_API_KEY ?? "";
    return {
        name: "OPENAI_API_KEY ≥ 30 chars (Aider import requirement)",
        pass: v.length >= 30,
        detail: `len=${v.length}`,
        blocker_level: "HARD",
    };
}));

gates.push(gate("task workspaces cached", () => {
    if (!existsSync(TASK_WORKSPACES)) {
        return {
            name: "task workspaces cached", pass: false,
            detail: `dir missing: ${TASK_WORKSPACES}`,
            blocker_level: "HARD",
        };
    }
    const dirs = readdirSync(TASK_WORKSPACES, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("task-"));
    return {
        name: "task workspaces cached",
        pass: dirs.length >= 50,
        detail: `${dirs.length} task dirs present (need ≥50)`,
        blocker_level: "HARD",
    };
}));

const results = {
    timestamp_utc: new Date().toISOString(),
    project_root: PROJECT_ROOT,
    gates,
    summary: {
        total: gates.length,
        passed: gates.filter((g) => g.pass).length,
        failed: gates.filter((g) => !g.pass).length,
        hard_blockers: gates.filter((g) => !g.pass && g.blocker_level === "HARD").length,
    },
    proceed_to_phase_2: gates.every((g) => g.pass),
};

process.stderr.write(`\nSprint 7.0 sanity gates:\n`);
for (const g of gates) {
    const mark = g.pass ? "PASS" : `FAIL (${g.blocker_level})`;
    process.stderr.write(`  [${mark}] ${g.name} — ${g.detail.slice(0, 120)}\n`);
}
process.stderr.write(
    `\n${results.summary.passed}/${results.summary.total} gates passed; `
    + `${results.summary.hard_blockers} HARD blockers.\n`,
);
process.stderr.write(
    results.proceed_to_phase_2
        ? "→ Phase 2 may proceed.\n"
        : "→ Phase 2 BLOCKED. Do not invent numbers. Verdict slot = NOT MEASURED.\n",
);

process.stdout.write(JSON.stringify(results, null, 2));
process.exit(results.proceed_to_phase_2 ? 0 : 1);
