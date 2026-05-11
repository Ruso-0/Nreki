/**
 * scripts/eval-phase5/runners/ripgrep-runner.ts
 *
 * Phase 5 C.3.B: ripgrep lexical retrieval baseline. Wraps the
 * `rg` binary via child_process.spawn. Compared to fast_grep,
 * ripgrep walks the filesystem cold each call (no AST cache),
 * but its Rust core is extremely fast for one-shot use.
 *
 * Flow per task:
 *   keywords = constructQuery(problem_statement)
 *   for each keyword: spawn `rg --type ts ... --count-matches kw repo`
 *   parse `<file>:<count>` lines, aggregate per-file
 *   anti-tests filter, top-K
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { PolyBenchTask } from "../types.js";
import type { RetrievalResult } from "../types-runners.js";
import { isTestFile } from "../ground-truth.js";
import { constructQuery } from "./query-construction.js";

/**
 * rg --type filters scoping search to JS/TS source. Note: ripgrep's
 * built-in `ts` type already covers *.ts AND *.tsx (likewise `js`
 * covers *.js + *.jsx), so we pass two flags instead of four.
 * Older rg versions (bundled with VS Code 13.0.0) reject `tsx`/`jsx`
 * as unknown types — keeping the union under `ts` + `js` works on
 * both old and new builds.
 */
const RG_TYPES = ["ts", "js"] as const;

/**
 * Default binary name. Resolved from `RG_BINARY` env var when set
 * (useful on Windows dev hosts where `rg.exe` is bundled by VS Code
 * / Antigravity rather than on system PATH). Falls back to "rg".
 */
export function resolveRgBinary(): string {
    return process.env.RG_BINARY && process.env.RG_BINARY.length > 0
        ? process.env.RG_BINARY
        : "rg";
}

/**
 * Pluggable spawn function so tests can intercept the rg invocation
 * without touching the real binary. Returns the captured stdout (or
 * the empty string on `rg` exit code 1 = no matches, which is normal).
 */
export type RgSpawnFn = (args: string[], cwd: string) => Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
}>;

const defaultSpawnFn: RgSpawnFn = (args, cwd) =>
    new Promise(resolve => {
        const child = spawn(resolveRgBinary(), args, { cwd, shell: false });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => (stdout += chunk.toString("utf-8")));
        child.stderr.on("data", chunk => (stderr += chunk.toString("utf-8")));
        child.on("error", err => {
            // ENOENT = rg not on PATH. Surface via stderr so caller
            // can produce a clear RetrievalResult.error.
            resolve({ stdout: "", stderr: `spawn error: ${err.message}`, code: null });
        });
        child.on("close", code => resolve({ stdout, stderr, code }));
    });

/**
 * Parse `--count-matches --no-heading` output:
 *   src/foo.ts:7
 *   src/bar.ts:3
 * Returns map of file -> count. Skips malformed lines silently
 * (defensive against locale-dependent path quirks on Windows).
 */
export function parseRgCountOutput(stdout: string): Map<string, number> {
    const out = new Map<string, number>();
    if (stdout.length === 0) return out;
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
        if (line.length === 0) continue;
        // The last colon separates count from path (paths may contain
        // colons on rare Windows shares; the count is always trailing
        // digits).
        const lastColon = line.lastIndexOf(":");
        if (lastColon === -1) continue;
        const file = line.slice(0, lastColon);
        const countStr = line.slice(lastColon + 1);
        if (!/^\d+$/.test(countStr)) continue;
        const count = parseInt(countStr, 10);
        if (count <= 0) continue;
        const normalized = file.replace(/\\/g, "/");
        out.set(normalized, (out.get(normalized) ?? 0) + count);
    }
    return out;
}

function buildRgArgs(keyword: string): string[] {
    const args: string[] = [];
    for (const t of RG_TYPES) {
        args.push("--type", t);
    }
    args.push(
        "--no-heading",
        "--count-matches",
        "--fixed-strings",
        "--",
        keyword,
        ".", // search current working directory (we set cwd = repoRoot)
    );
    return args;
}

/**
 * Run ripgrep lexical retrieval for a single PolyBenchTask.
 *
 * @param task     PolyBenchTask with problem_statement.
 * @param repoRoot Cloned workspace root.
 * @param topK     Headline cap on returned file count.
 * @param spawnFn  Optional injected spawn function (tests).
 */
export async function runRipgrep(
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
    spawnFn: RgSpawnFn = defaultSpawnFn,
): Promise<RetrievalResult> {
    const startedAt = Date.now();

    try {
        const keywords = constructQuery(task.problem_statement);
        const fileScore = new Map<string, number>();
        let firstSpawnError: string | null = null;

        for (const kw of keywords) {
            const { stdout, stderr, code } = await spawnFn(buildRgArgs(kw), repoRoot);
            if (code === null && stderr.startsWith("spawn error:")) {
                firstSpawnError = stderr;
                break;
            }
            // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
            if (code === 2) {
                // Log via error field but keep going? Spec says clear error
                // for missing binary; for keyword-specific failures, skip.
                continue;
            }
            const perFile = parseRgCountOutput(stdout);
            for (const [file, count] of perFile) {
                if (isTestFile(file)) continue;
                fileScore.set(file, (fileScore.get(file) ?? 0) + count);
            }
        }

        if (firstSpawnError !== null) {
            return {
                instance_id: task.instance_id,
                retriever: "ripgrep",
                retrieved_files: [],
                latency_ms: Date.now() - startedAt,
                error: `ripgrep binary not available: ${firstSpawnError}`,
            };
        }

        const ranked = [...fileScore.entries()].sort((a, b) => b[1] - a[1]);
        const retrieved_files = ranked
            .slice(0, topK)
            .map(([f]) => f.replace(/^\.\//, "").replace(/^\.\\/, ""));

        return {
            instance_id: task.instance_id,
            retriever: "ripgrep",
            retrieved_files,
            latency_ms: Date.now() - startedAt,
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "ripgrep",
            retrieved_files: [],
            latency_ms: Date.now() - startedAt,
            error: (e as Error).message,
        };
    }
}
