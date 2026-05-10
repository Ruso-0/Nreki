/**
 * Phase 5 C.1 reviewer-harness tests — mocked IO.
 * Validates blind constraint: NO PR diff exposed to reviewer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { reviewBlindly, type ReviewerIO } from "../../scripts/eval-phase5/reviewer-harness.js";
import type { BugCandidate } from "../../scripts/eval-phase5/types.js";

function mkCandidate(overrides: Partial<BugCandidate>): BugCandidate {
    return {
        repo: "owner/repo",
        pr_number: 1,
        pr_title: "Default PR title",
        issue_url: null,
        issue_text: "Default issue text",
        base_commit: "a",
        merge_commit: "b",
        modified_files: ["src/secret-fix.ts"],
        pr_labels: ["bug"],
        curated_at: new Date().toISOString(),
        blind_approved: null,
        ...overrides,
    };
}

function makeMockIO(answers: string[]): {
    io: ReviewerIO;
    written: string[];
} {
    const written: string[] = [];
    let idx = 0;
    return {
        io: {
            ask: async () => {
                const a = answers[idx++] ?? "";
                return a.trim();
            },
            write: (text) => { written.push(text); },
            close: () => {},
        },
        written,
    };
}

describe("Phase 5 C.1: reviewer-harness blind constraint", () => {
    let tmpFile: string;

    beforeEach(async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p5-rev-"));
        tmpFile = path.join(dir, "approved.json");
    });

    it("approve (y) sets blind_approved=true and appends to result", async () => {
        const { io } = makeMockIO(["y", ""]);
        const c = mkCandidate({ pr_title: "Fix X", issue_text: "Bug X" });
        const result = await reviewBlindly([c], tmpFile, io);
        expect(result).toHaveLength(1);
        expect(result[0].blind_approved).toBe(true);
    });

    it("reject (n) sets blind_approved=false and appends to result", async () => {
        const { io } = makeMockIO(["n", "insufficient context"]);
        const c = mkCandidate({});
        const result = await reviewBlindly([c], tmpFile, io);
        expect(result).toHaveLength(1);
        expect(result[0].blind_approved).toBe(false);
        expect(result[0].reviewer_notes).toBe("insufficient context");
    });

    it("skip (s) does NOT append to result", async () => {
        const { io } = makeMockIO(["s"]);
        const c = mkCandidate({});
        const result = await reviewBlindly([c], tmpFile, io);
        expect(result).toHaveLength(0);
    });

    it("BLIND CONSTRAINT: reviewer terminal output excludes modified_files", async () => {
        const { io, written } = makeMockIO(["y", ""]);
        const c = mkCandidate({
            pr_title: "Fix",
            issue_text: "Bug",
            modified_files: ["src/secret-leak-here.ts"],
        });
        await reviewBlindly([c], tmpFile, io);

        const allText = written.join("\n");
        expect(allText).not.toContain("secret-leak-here");
        expect(allText).not.toContain("modified_files");
    });

    it("BLIND CONSTRAINT: reviewer terminal output excludes merge_commit SHA", async () => {
        const { io, written } = makeMockIO(["y", ""]);
        const c = mkCandidate({
            merge_commit: "MERGE_SHA_LEAK",
            base_commit: "BASE_SHA_OK_TO_SHOW",
        });
        await reviewBlindly([c], tmpFile, io);

        const allText = written.join("\n");
        expect(allText).not.toContain("MERGE_SHA_LEAK");
    });

    it("BLIND CONSTRAINT: reviewer sees title + issue_text + repo + PR number ONLY", async () => {
        const { io, written } = makeMockIO(["y", ""]);
        const c = mkCandidate({
            repo: "trpc/trpc",
            pr_number: 42,
            pr_title: "Visible Title",
            issue_text: "Visible issue body",
        });
        await reviewBlindly([c], tmpFile, io);

        const allText = written.join("\n");
        expect(allText).toContain("Visible Title");
        expect(allText).toContain("Visible issue body");
        expect(allText).toContain("trpc/trpc");
        expect(allText).toContain("PR #42");
    });

    it("incremental persistence: outputPath written after each decision", async () => {
        const { io } = makeMockIO(["y", "ok", "n", "no", "s"]);
        const candidates = [
            mkCandidate({ pr_number: 1 }),
            mkCandidate({ pr_number: 2 }),
            mkCandidate({ pr_number: 3 }),
        ];
        await reviewBlindly(candidates, tmpFile, io);

        const persisted = JSON.parse(await fs.readFile(tmpFile, "utf-8")) as BugCandidate[];
        expect(persisted).toHaveLength(2);
        expect(persisted.map(p => p.pr_number)).toEqual([1, 2]);
    });

    it("handles missing issue_text (no issue text) gracefully", async () => {
        const { io, written } = makeMockIO(["s"]);
        const c = mkCandidate({ issue_text: null });
        await reviewBlindly([c], tmpFile, io);
        const allText = written.join("\n");
        expect(allText).toContain("(no issue text)");
    });
});
