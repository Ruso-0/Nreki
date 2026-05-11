/**
 * scripts/eval-phase5/runners/aider-runner.ts
 *
 * Phase 5 C.3.D: Aider repo-map retrieval baseline.
 *
 * Aider's `--show-repo-map` prints a tree-sitter-derived summary of
 * the most central files in a repo. We invoke it once per task,
 * parse the file headers in encounter order, and boost files whose
 * section text contains constructQuery() keywords.
 *
 * Quirks pinned down during exploration:
 *   - Requires a real git repo: --no-git makes repo-map empty.
 *     The runner assumes the caller has cloned at base_commit
 *     (true for PolyBench eval); the smoke test git-inits the
 *     mock workspace.
 *   - Python 3.14 incompatible; install lives in a Python 3.12
 *     venv at .venv-aider/Scripts/aider.exe. AIDER_BINARY env
 *     overrides this default for CI / cross-platform.
 *   - Aider boots LiteLLM even for --show-repo-map; OPENAI_API_KEY
 *     must be set but a dummy value (sk-dummy) is accepted because
 *     no network call is made in this code path.
 *   - On Windows, Aider's rich renderer crashes on box-drawing
 *     glyphs (│) unless PYTHONIOENCODING=utf-8 is exported.
 *     We always inject it.
 *   - Output uses backslash file paths on Windows -- normalised
 *     to forward slashes in the parser so downstream comparisons
 *     (anti-tests filter, ground-truth) line up with the other
 *     runners.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { PolyBenchTask } from "../types.js";
import type { ChunkResult, RetrievalResult } from "../types-runners.js";
import { isTestFile } from "../ground-truth.js";
import { constructQuery } from "./query-construction.js";
import { payloadTokens } from "../utils/tokenizer.js";

export const DEFAULT_AIDER_BINARY = path.join(
    ".venv-aider",
    "Scripts",
    "aider.exe",
);

/** Hard cap so a runaway Aider call cannot wedge the eval run. */
export const AIDER_TIMEOUT_MS = 30_000;

/** Source-file extensions the parser will look at when scanning headers. */
const SOURCE_EXTENSIONS = ["ts", "tsx", "js", "jsx"];

export function resolveAiderBinary(): string {
    const raw = process.env.AIDER_BINARY && process.env.AIDER_BINARY.length > 0
        ? process.env.AIDER_BINARY
        : DEFAULT_AIDER_BINARY;
    // The runner spawns the binary with cwd = repoRoot (so Aider sees
    // the right git tree), so a relative binary path would resolve
    // against repoRoot rather than the caller's project root. Make
    // the binary path absolute up-front to keep that decoupled.
    return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

export type AiderSpawnFn = (
    args: string[],
    cwd: string,
    env: Record<string, string>,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const defaultSpawnFn: AiderSpawnFn = (args, cwd, env) =>
    new Promise(resolve => {
        const child = spawn(resolveAiderBinary(), args, {
            cwd,
            shell: false,
            env: { ...process.env, ...env },
        });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                /* already exited */
            }
        }, AIDER_TIMEOUT_MS);

        child.stdout.on("data", chunk => (stdout += chunk.toString("utf-8")));
        child.stderr.on("data", chunk => (stderr += chunk.toString("utf-8")));
        child.on("error", err => {
            clearTimeout(timeout);
            resolve({ stdout: "", stderr: `spawn error: ${err.message}`, code: null });
        });
        child.on("close", code => {
            clearTimeout(timeout);
            resolve({ stdout, stderr, code });
        });
    });

/**
 * Match a file-header line in Aider's repo-map output. A header is
 * "<relative path>:" alone on its own line, where the path ends with
 * one of the recognised source extensions. Backslashes (Windows) and
 * forward slashes both match.
 */
const FILE_HEADER_RE = new RegExp(
    `^([\\w./\\\\-]+\\.(?:${SOURCE_EXTENSIONS.join("|")})):\\s*$`,
);

/**
 * Parse `--show-repo-map` stdout into a file -> score map.
 *
 * Scoring strategy:
 *   - base score by encounter rank: 1.0 for first, 1/2 for second,
 *     1/3 for third, ... (harmonic decay -- not too steep so a
 *     2nd-place file isn't crushed by the leader).
 *   - keyword boost: +0.25 per (case-insensitive) query keyword
 *     found in the file's section body, capped at 1.0 boost total
 *     so the boost cannot dominate Aider's own ranking signal.
 *
 * Returns Map<rel_forward_slash_path, score>.
 */
export interface AiderSection {
    path: string;
    body: string[];
}

/**
 * Split Aider's stdout into sections keyed by file path. Each section's
 * body is the raw lines between its header and the next header (with
 * empty leading/trailing lines preserved -- they cost nothing extra in
 * memory and keep line ranges honest).
 */
export function parseAiderRepoMapSections(stdout: string): AiderSection[] {
    const lines = stdout.split(/\r?\n/);
    const sections: AiderSection[] = [];
    let current: AiderSection | null = null;

    for (const line of lines) {
        const m = line.match(FILE_HEADER_RE);
        if (m) {
            if (current) sections.push(current);
            current = { path: m[1].replace(/\\/g, "/"), body: [] };
            continue;
        }
        if (current) current.body.push(line);
    }
    if (current) sections.push(current);
    return sections;
}

export function parseAiderRepoMap(
    stdout: string,
    queryKeywords: string[],
    _repoRoot: string,
): Map<string, number> {
    const sections = parseAiderRepoMapSections(stdout);
    const lowerKeywords = queryKeywords.map(k => k.toLowerCase());
    const out = new Map<string, number>();
    for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const base = 1 / (i + 1);
        const bodyLower = s.body.join("\n").toLowerCase();
        let boost = 0;
        for (const kw of lowerKeywords) {
            if (kw.length < 3) continue;
            if (bodyLower.includes(kw)) boost += 0.25;
            if (boost >= 1.0) break;
        }
        out.set(s.path, base + Math.min(boost, 1.0));
    }
    return out;
}

/** Env vars injected into the Aider child process. */
function aiderEnv(): Record<string, string> {
    return {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "sk-dummy",
        AIDER_ANALYTICS: "false",
        AIDER_AUTO_COMMITS: "0",
        // Without UTF-8 stdio, Aider crashes on box-drawing glyphs
        // when running under non-cp1252 terminals on Windows.
        PYTHONIOENCODING: "utf-8",
        // Suppress prompt-toolkit init failure on non-TTY parents.
        TERM: "dumb",
    };
}

/**
 * Run Aider repo-map retrieval for a single PolyBenchTask.
 *
 * @param task     Issue + repo coordinates.
 * @param repoRoot Cloned workspace root with a git repo present.
 * @param topK     Headline cap on returned files.
 * @param spawnFn  Injectable for tests; defaults to real child_process.
 */
export async function runAider(
    task: PolyBenchTask,
    repoRoot: string,
    topK: number,
    spawnFn: AiderSpawnFn = defaultSpawnFn,
): Promise<RetrievalResult> {
    const startedAt = Date.now();
    try {
        const keywords = constructQuery(task.problem_statement);
        const args = ["--show-repo-map", "--yes", "--no-auto-commits"];
        const { stdout, stderr, code } = await spawnFn(args, repoRoot, aiderEnv());

        if (code === null && stderr.startsWith("spawn error:")) {
            return {
                instance_id: task.instance_id,
                retriever: "aider",
                retrieved_files: [],
                retrieved_chunks: [],
                latency_ms: Date.now() - startedAt,
                token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                error: `Aider binary not found at ${resolveAiderBinary()}. Check AIDER_BINARY env or .venv-aider/ install. (${stderr})`,
            };
        }
        if (code !== 0 && code !== null) {
            const tail = stderr.split(/\r?\n/).slice(-5).join(" | ").slice(0, 300);
            return {
                instance_id: task.instance_id,
                retriever: "aider",
                retrieved_files: [],
                retrieved_chunks: [],
                latency_ms: Date.now() - startedAt,
                token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                error: `Aider exited ${code}: ${tail}`,
            };
        }

        const sections = parseAiderRepoMapSections(stdout);
        const scores = parseAiderRepoMap(stdout, keywords, repoRoot);
        const sectionByPath = new Map(sections.map(s => [s.path, s]));

        const ranked = [...scores.entries()]
            .filter(([p]) => !isTestFile(p))
            .sort((a, b) => b[1] - a[1]);
        const top = ranked.slice(0, topK);
        const retrieved_files = top.map(([f]) => f);

        // Section-body chunks: Aider doesn't emit precise line numbers
        // for its definition snippets, so start_line stays at 1 and
        // end_line uses the body-line count as an upper-bound estimate
        // for the contiguous range covering the printed definitions.
        // Documented caveat: this is an approximation, not AST-exact.
        const retrieved_chunks: ChunkResult[] = top.map(([f, score]) => {
            const sec = sectionByPath.get(f);
            const lineCount = sec ? Math.max(sec.body.length, 1) : 1;
            return { file_path: f, start_line: 1, end_line: lineCount, score };
        });
        const token_cost = payloadTokens(
            top.map(([f]) => sectionByPath.get(f)?.body.join("\n") ?? ""),
        );

        return {
            instance_id: task.instance_id,
            retriever: "aider",
            retrieved_files,
            retrieved_chunks,
            latency_ms: Date.now() - startedAt,
            token_cost,
        };
    } catch (e) {
        return {
            instance_id: task.instance_id,
            retriever: "aider",
            retrieved_files: [],
            retrieved_chunks: [],
            latency_ms: Date.now() - startedAt,
            token_cost: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            error: (e as Error).message,
        };
    }
}
