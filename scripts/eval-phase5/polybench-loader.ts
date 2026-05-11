/**
 * scripts/eval-phase5/polybench-loader.ts
 *
 * Phase 5 SWE-Bench-TS-Lite C.2.B: Loader for SWE-PolyBench Verified
 * test.csv → PolyBenchTask[] (Furia round 18 sovereign schema).
 *
 * Source: AmazonScience/SWE-PolyBench_Verified (arXiv:2504.08703, MIT).
 *
 * Notes on CSV quirks discovered during implementation:
 *   - modified_nodes column is JSON-formatted (double quotes).
 *   - F2P / P2P columns are Python repr() output: mixed single/double
 *     quotes (Python optimizes per-string), zero backslash escapes.
 *     NOT valid JSON. Parsed via a small Python-list-literal parser.
 *   - Dockerfile column is capitalized "Dockerfile"; PolyBenchTask
 *     normalizes to lowercase `dockerfile`.
 *   - pull_number arrives as e.g. "106767.0" (pandas float coercion);
 *     parseInt handles the trailing ".0" correctly.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse } from "csv-parse/sync";
import type { PolyBenchTask, ModifiedNode } from "./types.js";

export const DEFAULT_CSV_PATH = path.join(
    "scripts",
    "eval-phase5",
    "data",
    "polybench-verified.csv",
);

const REQUIRED_COLUMNS: readonly string[] = [
    "repo",
    "pull_number",
    "instance_id",
    "base_commit",
    "patch",
    "test_patch",
    "problem_statement",
    "modified_nodes",
    "task_category",
    "F2P",
    "P2P",
    "Dockerfile",
    "test_command",
    "language",
];

const VALID_TASK_CATEGORIES = new Set<PolyBenchTask["task_category"]>([
    "Bug Fix",
    "Feature",
    "Refactoring",
]);

/**
 * Parse a single PolyBench modified_node string into a typed ModifiedNode.
 *
 * Raw format:
 *   "file.ts->program->class_declaration:X->method_definition:Y"
 *
 * Strategy: fail-fast at load with a noisy stderr warning + fallback
 * to terminal_kind="unknown" / terminal_name="" for malformed segments,
 * rather than throw — keeps the loader resilient on imperfect rows.
 */
function parseOne(raw: string): ModifiedNode {
    const segments = raw.split("->");
    if (segments.length < 2 || segments[0] === "") {
        process.stderr.write(
            `[polybench-loader] WARN: malformed modified_node path: ${JSON.stringify(raw)}\n`,
        );
        return {
            raw_path: raw,
            file_path: raw,
            ast_path: [],
            terminal_kind: "unknown",
            terminal_name: "",
        };
    }

    const file_path = segments[0];
    const terminal = segments[segments.length - 1];
    const ast_path = segments.slice(1, -1);

    const colonIdx = terminal.indexOf(":");
    let terminal_kind: string;
    let terminal_name: string;
    if (colonIdx === -1) {
        terminal_kind = terminal;
        terminal_name = "";
    } else {
        terminal_kind = terminal.slice(0, colonIdx);
        terminal_name = terminal.slice(colonIdx + 1);
    }

    return {
        raw_path: raw,
        file_path,
        ast_path,
        terminal_kind,
        terminal_name,
    };
}

export function parseModifiedNodes(raw: string[]): ModifiedNode[] {
    return raw.map(parseOne);
}

/**
 * Parse a Python repr()-style list literal: ['a', "b's", ...].
 * Handles both single- and double-quoted strings within the same list.
 * Tolerates backslash-escaped quotes inside strings (defensive — the
 * Verified CSV has none, but the parser remains robust).
 */
function parsePythonListLiteral(s: string): string[] {
    const trimmed = s.trim();
    if (trimmed === "" || trimmed === "[]") return [];
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
        throw new Error(
            `Expected list literal, got: ${trimmed.slice(0, 80)}${trimmed.length > 80 ? "..." : ""}`,
        );
    }

    const inner = trimmed.slice(1, -1);
    const result: string[] = [];
    let i = 0;
    while (i < inner.length) {
        while (i < inner.length && /[\s,]/.test(inner[i])) i++;
        if (i >= inner.length) break;

        const quote = inner[i];
        if (quote !== "'" && quote !== '"') {
            throw new Error(
                `Expected quote at position ${i}, got "${inner[i]}"`,
            );
        }
        i++; // skip opening quote

        let str = "";
        while (i < inner.length) {
            const ch = inner[i];
            if (ch === "\\" && i + 1 < inner.length) {
                str += inner[i + 1];
                i += 2;
                continue;
            }
            if (ch === quote) break;
            str += ch;
            i++;
        }
        if (i >= inner.length) {
            throw new Error("Unterminated string in list literal");
        }
        i++; // skip closing quote
        result.push(str);
    }
    return result;
}

/**
 * Parse a stringified list. Prefers JSON; falls back to Python repr.
 * PolyBench `modified_nodes` is JSON; `F2P`/`P2P` are Python repr.
 */
function parseStringList(s: string, field: string, instanceId: string): string[] {
    try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed) && parsed.every(x => typeof x === "string")) {
            return parsed;
        }
    } catch {
        // fall through to Python literal
    }
    try {
        return parsePythonListLiteral(s);
    } catch (e) {
        throw new Error(
            `${field} parse failed for ${instanceId}: ${(e as Error).message}`,
        );
    }
}

/**
 * Load SWE-PolyBench Verified test.csv, filter language === "TypeScript",
 * return typed PolyBenchTask[] with all stringified fields normalized.
 *
 * Skips rows with invalid task_category or unparseable list fields
 * (logged to stderr with the instance_id for audit trail).
 */
export async function loadPolyBenchVerified(csvPath: string): Promise<PolyBenchTask[]> {
    const content = await fs.readFile(csvPath, "utf-8");

    // Two-pass parse: first extract header alone so missing-column
    // detection works even when the CSV has zero data rows.
    const allRows: string[][] = parse(content, {
        columns: false,
        skip_empty_lines: true,
        relax_quotes: false,
        relax_column_count: false,
    });
    if (allRows.length === 0) {
        throw new Error(`Empty CSV at ${csvPath}`);
    }
    const headerKeys = allRows[0];
    const missing = REQUIRED_COLUMNS.filter(c => !headerKeys.includes(c));
    if (missing.length > 0) {
        throw new Error(
            `CSV missing required columns: ${missing.join(", ")} (got: ${headerKeys.join(", ")})`,
        );
    }

    // Re-parse with columns: true now that header is validated.
    const records: Record<string, string>[] = parse(content, {
        columns: true,
        skip_empty_lines: true,
        relax_quotes: false,
        relax_column_count: false,
    });

    const tsRows = records.filter(r => r.language === "TypeScript");
    const tasks: PolyBenchTask[] = [];
    let skipped = 0;

    for (const r of tsRows) {
        if (!VALID_TASK_CATEGORIES.has(r.task_category as PolyBenchTask["task_category"])) {
            process.stderr.write(
                `[polybench-loader] WARN: skipping ${r.instance_id}: invalid task_category "${r.task_category}"\n`,
            );
            skipped++;
            continue;
        }

        let F2P: string[];
        let P2P: string[];
        let modifiedNodesRaw: string[];
        try {
            F2P = parseStringList(r.F2P, "F2P", r.instance_id);
            P2P = parseStringList(r.P2P, "P2P", r.instance_id);
            modifiedNodesRaw = parseStringList(r.modified_nodes, "modified_nodes", r.instance_id);
        } catch (e) {
            process.stderr.write(
                `[polybench-loader] WARN: skipping ${r.instance_id}: ${(e as Error).message}\n`,
            );
            skipped++;
            continue;
        }

        tasks.push({
            repo: r.repo,
            pr_number: parseInt(r.pull_number, 10),
            instance_id: r.instance_id,
            base_commit: r.base_commit,
            patch: r.patch,
            test_patch: r.test_patch,
            problem_statement: r.problem_statement,
            modified_nodes: parseModifiedNodes(modifiedNodesRaw),
            task_category: r.task_category as PolyBenchTask["task_category"],
            F2P,
            P2P,
            dockerfile: r.Dockerfile,
            test_command: r.test_command,
            language: "TypeScript",
        });
    }

    process.stdout.write(
        `[polybench-loader] Loaded ${tasks.length} TS tasks${skipped > 0 ? ` (${skipped} skipped)` : ""} from ${csvPath}\n`,
    );

    return tasks;
}
