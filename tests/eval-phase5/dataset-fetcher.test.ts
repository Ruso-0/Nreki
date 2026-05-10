/**
 * Phase 5 C.1 dataset-fetcher tests — mocked Octokit.
 * NO real GitHub API calls.
 */

import { describe, it, expect } from "vitest";
import { fetchBugCandidates, type OctokitLike, type SearchIssueItem, type PullDetail } from "../../scripts/eval-phase5/dataset-fetcher.js";

function makeMockOctokit(opts: {
    items?: SearchIssueItem[];
    pullDetails?: Map<number, PullDetail>;
    issues?: Map<number, { body?: string | null }>;
    files?: Map<number, { filename: string }[]>;
}): OctokitLike {
    return {
        search: {
            issuesAndPullRequests: async () => ({
                data: { items: opts.items ?? [] },
            }),
        },
        pulls: {
            get: async ({ pull_number }) => {
                const d = opts.pullDetails?.get(pull_number);
                if (!d) throw new Error(`mock missing pull ${pull_number}`);
                return { data: d };
            },
            listFiles: async ({ pull_number }) => ({
                data: opts.files?.get(pull_number) ?? [],
            }),
        },
        issues: {
            get: async ({ issue_number }) => {
                const i = opts.issues?.get(issue_number);
                if (!i) throw new Error(`mock missing issue ${issue_number}`);
                return { data: i };
            },
        },
    };
}

describe("Phase 5 C.1: dataset-fetcher", () => {
    it("filters PRs without linked issue (no closes #N)", async () => {
        const mock = makeMockOctokit({
            items: [{ number: 1, title: "PR no issue link", labels: ["bug"] }],
            pullDetails: new Map([
                [1, { body: "Just a fix without issue ref", base: { sha: "abc" }, merge_commit_sha: "def" }],
            ]),
            files: new Map([[1, [{ filename: "src/foo.ts" }]]]),
        });
        const result = await fetchBugCandidates("owner/repo", "2026-01-01", 10, mock);
        expect(result).toHaveLength(0);
    });

    it("filters PRs without src/ modifications (doc-only)", async () => {
        const mock = makeMockOctokit({
            items: [{ number: 1, title: "Doc fix", labels: ["bug"] }],
            pullDetails: new Map([
                [1, { body: "Fixes #100", base: { sha: "abc" }, merge_commit_sha: "def" }],
            ]),
            issues: new Map([[100, { body: "Doc bug" }]]),
            files: new Map([[1, [{ filename: "README.md" }, { filename: "docs/x.md" }]]]),
        });
        const result = await fetchBugCandidates("owner/repo", "2026-01-01", 10, mock);
        expect(result).toHaveLength(0);
    });

    it("filters PRs that only modify test files in src/", async () => {
        const mock = makeMockOctokit({
            items: [{ number: 1, title: "Test fix", labels: ["bug"] }],
            pullDetails: new Map([
                [1, { body: "Closes #200", base: { sha: "abc" }, merge_commit_sha: "def" }],
            ]),
            issues: new Map([[200, { body: "Test bug" }]]),
            files: new Map([[1, [{ filename: "src/foo.test.ts" }, { filename: "src/bar.spec.ts" }]]]),
        });
        const result = await fetchBugCandidates("owner/repo", "2026-01-01", 10, mock);
        expect(result).toHaveLength(0);
    });

    it("includes PR with linked issue + src/ modification", async () => {
        const mock = makeMockOctokit({
            items: [{ number: 42, title: "Fix bug X", labels: [{ name: "bug" }, { name: "regression" }] }],
            pullDetails: new Map([
                [42, { body: "Closes #99 by adjusting parser", base: { sha: "deadbeef" }, merge_commit_sha: "cafebabe" }],
            ]),
            issues: new Map([[99, { body: "Bug: parser breaks on edge case" }]]),
            files: new Map([[42, [{ filename: "src/parser.ts" }, { filename: "src/parser.test.ts" }]]]),
        });
        const result = await fetchBugCandidates("owner/repo", "2026-01-01", 10, mock);
        expect(result).toHaveLength(1);
        expect(result[0].pr_number).toBe(42);
        expect(result[0].pr_title).toBe("Fix bug X");
        expect(result[0].issue_url).toBe("https://github.com/owner/repo/issues/99");
        expect(result[0].issue_text).toBe("Bug: parser breaks on edge case");
        expect(result[0].base_commit).toBe("deadbeef");
        expect(result[0].merge_commit).toBe("cafebabe");
        expect(result[0].pr_labels).toEqual(["bug", "regression"]);
        expect(result[0].blind_approved).toBeNull();
    });

    it("respects maxCandidates limit", async () => {
        const items: SearchIssueItem[] = [];
        const pullDetails = new Map<number, PullDetail>();
        const issues = new Map<number, { body: string }>();
        const files = new Map<number, { filename: string }[]>();
        for (let i = 1; i <= 10; i++) {
            items.push({ number: i, title: `PR ${i}`, labels: ["bug"] });
            pullDetails.set(i, { body: `Fixes #${i}00`, base: { sha: `sha${i}` }, merge_commit_sha: `merge${i}` });
            issues.set(i * 100, { body: `Issue ${i}` });
            files.set(i, [{ filename: "src/index.ts" }]);
        }
        const mock = makeMockOctokit({ items, pullDetails, issues, files });
        const result = await fetchBugCandidates("owner/repo", "2026-01-01", 3, mock);
        expect(result).toHaveLength(3);
    });

    it("handles missing issue body gracefully (defensive null)", async () => {
        const mock = makeMockOctokit({
            items: [{ number: 1, title: "Fix", labels: ["bug"] }],
            pullDetails: new Map([
                [1, { body: "Closes #50", base: { sha: "abc" }, merge_commit_sha: "def" }],
            ]),
            issues: new Map([[50, { body: null }]]),
            files: new Map([[1, [{ filename: "src/x.ts" }]]]),
        });
        const result = await fetchBugCandidates("owner/repo", "2026-01-01", 10, mock);
        expect(result).toHaveLength(1);
        expect(result[0].issue_text).toBeNull();
    });

    it("rejects invalid repo format", async () => {
        const mock = makeMockOctokit({});
        await expect(
            fetchBugCandidates("invalidformat", "2026-01-01", 10, mock),
        ).rejects.toThrow(/Invalid repo format/);
    });

    it("skips PR with null merge_commit_sha", async () => {
        const mock = makeMockOctokit({
            items: [{ number: 1, title: "Unmerged", labels: ["bug"] }],
            pullDetails: new Map([
                [1, { body: "Fixes #1", base: { sha: "abc" }, merge_commit_sha: null }],
            ]),
            issues: new Map([[1, { body: "x" }]]),
            files: new Map([[1, [{ filename: "src/x.ts" }]]]),
        });
        const result = await fetchBugCandidates("owner/repo", "2026-01-01", 10, mock);
        expect(result).toHaveLength(0);
    });
});
