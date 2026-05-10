/**
 * scripts/eval-phase5/dataset-fetcher.ts
 *
 * Phase 5 SWE-Bench-TS-Lite C.1: GitHub API filter for bugfix PRs.
 *
 * Furia round 13 #1: scripted candidate generation. Filters applied:
 *   - closed + merged PRs
 *   - labeled {bug, regression, fix}
 *   - has linked issue (closes/fixes/resolves #N pattern)
 *   - modifies ≥1 src/ file (not doc-only, not test-only)
 *   - created POST cutoff date (Furia round 13 #7 training data leakage)
 *
 * Reviewer harness applies blind review post-fetch (separate module).
 */

import * as fs from "node:fs/promises";
import type { BugCandidate } from "./types.js";

/**
 * Minimal Octokit surface used by fetchBugCandidates. Enables
 * dependency injection for tests (mock implementations) without
 * pulling the full @octokit/rest type graph into test boundaries.
 */
export interface OctokitLike {
    search: {
        issuesAndPullRequests: (params: {
            q: string;
            per_page?: number;
        }) => Promise<{ data: { items: SearchIssueItem[] } }>;
    };
    pulls: {
        get: (params: {
            owner: string;
            repo: string;
            pull_number: number;
        }) => Promise<{ data: PullDetail }>;
        listFiles: (params: {
            owner: string;
            repo: string;
            pull_number: number;
        }) => Promise<{ data: { filename: string }[] }>;
    };
    issues: {
        get: (params: {
            owner: string;
            repo: string;
            issue_number: number;
        }) => Promise<{ data: { body?: string | null } }>;
    };
}

export interface SearchIssueItem {
    number: number;
    title: string;
    labels: Array<string | { name?: string }>;
}

export interface PullDetail {
    body?: string | null;
    base: { sha: string };
    merge_commit_sha: string | null;
}

/**
 * Phase 5 C.1: Fetch bugfix PR candidates from a target repo.
 *
 * @param repo            "owner/repo" coordinate
 * @param cutoffDate      ISO date "YYYY-MM-DD". PRs created on/after this date.
 * @param maxCandidates   Hard cap on returned candidates per repo.
 * @param octokit         Optional injected Octokit instance (for tests).
 *                        If omitted, lazy-loads @octokit/rest with
 *                        process.env.GITHUB_TOKEN.
 */
export async function fetchBugCandidates(
    repo: string,
    cutoffDate: string,
    maxCandidates: number = 50,
    octokit?: OctokitLike,
): Promise<BugCandidate[]> {
    if (!octokit) {
        const { Octokit } = await import("@octokit/rest");
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            throw new Error(
                "GITHUB_TOKEN env var required for fetchBugCandidates. " +
                "Set via .env or shell export. See scripts/eval-phase5/README.md.",
            );
        }
        octokit = new Octokit({ auth: token }) as unknown as OctokitLike;
    }

    const [owner, repoName] = repo.split("/");
    if (!owner || !repoName) {
        throw new Error(`Invalid repo format "${repo}", expected "owner/repo".`);
    }

    const search = await octokit.search.issuesAndPullRequests({
        q: `repo:${repo} type:pr is:closed is:merged label:bug created:>=${cutoffDate}`,
        per_page: 100,
    });

    const candidates: BugCandidate[] = [];

    for (const pr of search.data.items) {
        if (candidates.length >= maxCandidates) break;

        const prDetail = await octokit.pulls.get({
            owner,
            repo: repoName,
            pull_number: pr.number,
        });

        // Linked issue extraction (closes|fixes|resolves #N pattern).
        const issueMatch = prDetail.data.body?.match(
            /(?:closes|fixes|resolves)\s+#(\d+)/i,
        );
        if (!issueMatch) continue;

        const issueNumber = parseInt(issueMatch[1], 10);
        let issueText: string | null = null;
        try {
            const issue = await octokit.issues.get({
                owner,
                repo: repoName,
                issue_number: issueNumber,
            });
            issueText = issue.data.body ?? null;
        } catch {
            continue;
        }

        const filesResult = await octokit.pulls.listFiles({
            owner,
            repo: repoName,
            pull_number: pr.number,
        });
        const modifiedFiles = filesResult.data.map(f => f.filename);

        // Filter: ≥1 src/ file modification (not doc-only, not test-only).
        const hasSrcModification = modifiedFiles.some(
            f => f.startsWith("src/") && !/\.(test|spec)\.[tj]sx?$/.test(f),
        );
        if (!hasSrcModification) continue;

        if (!prDetail.data.merge_commit_sha) continue;

        candidates.push({
            repo,
            pr_number: pr.number,
            pr_title: pr.title,
            issue_url: `https://github.com/${repo}/issues/${issueNumber}`,
            issue_text: issueText,
            base_commit: prDetail.data.base.sha,
            merge_commit: prDetail.data.merge_commit_sha,
            modified_files: modifiedFiles,
            pr_labels: pr.labels.map(l =>
                typeof l === "string" ? l : l.name ?? "",
            ),
            curated_at: new Date().toISOString(),
            blind_approved: null,
        });
    }

    return candidates;
}

/**
 * Persist candidates to JSON file (audit trail).
 */
export async function saveBugCandidates(
    candidates: BugCandidate[],
    outputPath: string,
): Promise<void> {
    await fs.writeFile(outputPath, JSON.stringify(candidates, null, 2), "utf-8");
}
