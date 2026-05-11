/**
 * Phase 5 C.2.B polybench-loader tests.
 *
 * parseModifiedNodes: pure unit coverage including malformed-segment
 * fallback behavior (stderr spied to assert noisy warning).
 *
 * loadPolyBenchVerified: integration via small inline CSV fixtures
 * written to tmpdir. NO dependency on the real polybench-verified.csv
 * (would make tests brittle to dataset version drift).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
    parseModifiedNodes,
    loadPolyBenchVerified,
} from "../../scripts/eval-phase5/polybench-loader.js";

const HEADER =
    "repo,pull_number,instance_id,base_commit,patch,test_patch,problem_statement,modified_nodes,task_category,F2P,P2P,Dockerfile,test_command,language";

/** Wrap a CSV cell in double quotes, escaping internal double quotes. */
function csvCell(v: string): string {
    return `"${v.replace(/"/g, '""')}"`;
}

interface MockRow {
    repo?: string;
    pull_number?: string;
    instance_id?: string;
    base_commit?: string;
    patch?: string;
    test_patch?: string;
    problem_statement?: string;
    modified_nodes?: string;
    task_category?: string;
    F2P?: string;
    P2P?: string;
    Dockerfile?: string;
    test_command?: string;
    language?: string;
}

function csvRow(row: MockRow): string {
    const d: Required<MockRow> = {
        repo: "owner/repo",
        pull_number: "1",
        instance_id: "owner__repo-1",
        base_commit: "abc",
        patch: "",
        test_patch: "",
        problem_statement: "x",
        modified_nodes: "[]",
        task_category: "Bug Fix",
        F2P: "[]",
        P2P: "[]",
        Dockerfile: "",
        test_command: "",
        language: "TypeScript",
        ...row,
    };
    return [
        d.repo,
        d.pull_number,
        d.instance_id,
        d.base_commit,
        csvCell(d.patch),
        csvCell(d.test_patch),
        csvCell(d.problem_statement),
        csvCell(d.modified_nodes),
        d.task_category,
        csvCell(d.F2P),
        csvCell(d.P2P),
        csvCell(d.Dockerfile),
        csvCell(d.test_command),
        d.language,
    ].join(",");
}

async function writeTmpCsv(rows: MockRow[]): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polybench-loader-"));
    const file = path.join(dir, "test.csv");
    const content = [HEADER, ...rows.map(csvRow)].join("\n") + "\n";
    await fs.writeFile(file, content, "utf-8");
    return file;
}

describe("Phase 5 C.2.B: parseModifiedNodes", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it("parses path with function terminal", () => {
        const [m] = parseModifiedNodes([
            "src/foo.ts->program->function_declaration:bar",
        ]);
        expect(m.file_path).toBe("src/foo.ts");
        expect(m.terminal_kind).toBe("function_declaration");
        expect(m.terminal_name).toBe("bar");
        expect(m.ast_path).toEqual(["program"]);
        expect(m.raw_path).toBe("src/foo.ts->program->function_declaration:bar");
    });

    it("parses path with class + nested method", () => {
        const [m] = parseModifiedNodes([
            "src/a.ts->program->class_declaration:A->method_definition:m",
        ]);
        expect(m.file_path).toBe("src/a.ts");
        expect(m.ast_path).toEqual(["program", "class_declaration:A"]);
        expect(m.terminal_kind).toBe("method_definition");
        expect(m.terminal_name).toBe("m");
    });

    it("handles terminal without ':' (kind only)", () => {
        const [m] = parseModifiedNodes([
            "src/x.ts->program->expression_statement",
        ]);
        expect(m.terminal_kind).toBe("expression_statement");
        expect(m.terminal_name).toBe("");
    });

    it("falls back to 'unknown' for single-segment path + warns", () => {
        const [m] = parseModifiedNodes(["src/y.ts"]);
        expect(m.terminal_kind).toBe("unknown");
        expect(m.terminal_name).toBe("");
        expect(m.ast_path).toEqual([]);
        expect(m.raw_path).toBe("src/y.ts");
        expect(stderrSpy).toHaveBeenCalled();
    });

    it("falls back to 'unknown' for empty string + warns", () => {
        const [m] = parseModifiedNodes([""]);
        expect(m.terminal_kind).toBe("unknown");
        expect(m.raw_path).toBe("");
        expect(stderrSpy).toHaveBeenCalled();
    });

    it("preserves ':' inside terminal_name (split on first colon only)", () => {
        const [m] = parseModifiedNodes(["a.ts->program->method:foo:bar"]);
        expect(m.terminal_kind).toBe("method");
        expect(m.terminal_name).toBe("foo:bar");
    });

    it("raw_path always preserved verbatim", () => {
        const inputs = [
            "src/foo.ts->program->fn:x",
            "src/y.ts",
            "",
            "a->b->c:d:e",
        ];
        const out = parseModifiedNodes(inputs);
        out.forEach((m, i) => {
            expect(m.raw_path).toBe(inputs[i]);
        });
    });
});

describe("Phase 5 C.2.B: loadPolyBenchVerified", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let stdoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
    });

    it("filters language === 'TypeScript' (3 TS + 2 JS → 3 returned)", async () => {
        const csv = await writeTmpCsv([
            { instance_id: "a__r-1", language: "TypeScript" },
            { instance_id: "a__r-2", language: "JavaScript" },
            { instance_id: "a__r-3", language: "TypeScript" },
            { instance_id: "a__r-4", language: "JavaScript" },
            { instance_id: "a__r-5", language: "TypeScript" },
        ]);
        const tasks = await loadPolyBenchVerified(csv);
        expect(tasks).toHaveLength(3);
        expect(tasks.every(t => t.language === "TypeScript")).toBe(true);
    });

    it("parses F2P/P2P Python-list-literal correctly (single-quote)", async () => {
        const csv = await writeTmpCsv([
            {
                F2P: "['test a', 'test b']",
                P2P: "['p1', 'p2', 'p3']",
            },
        ]);
        const [t] = await loadPolyBenchVerified(csv);
        expect(t.F2P).toEqual(["test a", "test b"]);
        expect(t.P2P).toEqual(["p1", "p2", "p3"]);
    });

    it("handles mixed-quote Python list (apostrophe in test name)", async () => {
        const csv = await writeTmpCsv([
            {
                P2P: `['simple', "doesn't break", 'plain']`,
            },
        ]);
        const [t] = await loadPolyBenchVerified(csv);
        expect(t.P2P).toEqual(["simple", "doesn't break", "plain"]);
    });

    it("parses modified_nodes JSON correctly", async () => {
        const nodes = JSON.stringify([
            "src/foo.ts->program->fn:bar",
            "src/baz.ts->program->class:Q->method:run",
        ]);
        const csv = await writeTmpCsv([{ modified_nodes: nodes }]);
        const [t] = await loadPolyBenchVerified(csv);
        expect(t.modified_nodes).toHaveLength(2);
        expect(t.modified_nodes[0].file_path).toBe("src/foo.ts");
        expect(t.modified_nodes[1].terminal_name).toBe("run");
    });

    it("skips row with invalid task_category + warns", async () => {
        const csv = await writeTmpCsv([
            { instance_id: "good", task_category: "Bug Fix" },
            { instance_id: "bad", task_category: "Mystery" },
            { instance_id: "good2", task_category: "Feature" },
        ]);
        const tasks = await loadPolyBenchVerified(csv);
        expect(tasks).toHaveLength(2);
        expect(tasks.map(t => t.instance_id).sort()).toEqual(["good", "good2"]);
        expect(stderrSpy).toHaveBeenCalled();
        // Warning mentions the bad instance_id
        const warns = stderrSpy.mock.calls.flat().join("");
        expect(warns).toContain("bad");
    });

    it("throws when CSV missing a required column", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "polybench-loader-"));
        const file = path.join(dir, "broken.csv");
        // Header missing 'F2P'
        await fs.writeFile(
            file,
            "repo,pull_number,instance_id,base_commit,patch,test_patch,problem_statement,modified_nodes,task_category,P2P,Dockerfile,test_command,language\n",
            "utf-8",
        );
        await expect(loadPolyBenchVerified(file)).rejects.toThrow(
            /missing required columns.*F2P/,
        );
    });

    it("returns [] when CSV has no TS rows", async () => {
        const csv = await writeTmpCsv([
            { language: "JavaScript" },
            { language: "Python" },
        ]);
        const tasks = await loadPolyBenchVerified(csv);
        expect(tasks).toEqual([]);
    });

});
