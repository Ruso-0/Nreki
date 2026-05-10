/**
 * scripts/eval-phase5/reviewer-harness.ts
 *
 * Phase 5 SWE-Bench-TS-Lite C.1: Blind reviewer interactive CLI.
 *
 * Furia round 13 #1 (BLIND CONSTRAINT MANDATORY):
 *   Reviewer reads ONLY:
 *     - PR title
 *     - Issue text (body)
 *     - Repo + PR number metadata
 *
 *   Reviewer NEVER sees:
 *     - PR diff (the fix itself)
 *     - modified_files list (might leak structure)
 *     - merge_commit content
 *
 * Approval criterion: "Is the issue text sufficient for an agent
 * with NO codebase knowledge to attempt locating the bug?"
 *
 * Anti-confirmation-bias: NO automation here. CLI-interactive
 * forces presence of human judgment. Mocking this defeats the
 * methodological purpose.
 */

import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import type { BugCandidate } from "./types.js";

export interface ReviewerIO {
    /** Prompt user, return their response trimmed. */
    ask: (question: string) => Promise<string>;
    /** Print line(s) to reviewer terminal. */
    write: (text: string) => void;
    /** Close any underlying handles. */
    close: () => void;
}

/**
 * Default ReviewerIO using readline + console. Real interactive use.
 */
export function makeStdioReviewerIO(): ReviewerIO {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return {
        ask: (q) =>
            new Promise(resolve => rl.question(q, ans => resolve(ans.trim()))),
        write: (text) => process.stdout.write(text + "\n"),
        close: () => rl.close(),
    };
}

const SEPARATOR_HEAVY = "=".repeat(70);
const SEPARATOR_LIGHT = "-".repeat(70);

/**
 * Run blind review over candidates. Persists incremental progress to
 * outputPath after each decision (resilient to mid-session abort).
 *
 * Decisions:
 *   y → approve (blind_approved=true, append to result)
 *   n → reject (blind_approved=false, append to result with notes)
 *   s → skip (NOT appended; candidate left unreviewed)
 *
 * @param candidates  Raw candidates from dataset-fetcher.
 * @param outputPath  Incremental save target (audit trail).
 * @param io          Optional injected ReviewerIO (default = stdio).
 */
export async function reviewBlindly(
    candidates: BugCandidate[],
    outputPath: string,
    io?: ReviewerIO,
): Promise<BugCandidate[]> {
    const reviewerIO = io ?? makeStdioReviewerIO();
    const reviewed: BugCandidate[] = [];

    try {
        for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];

            reviewerIO.write("");
            reviewerIO.write(SEPARATOR_HEAVY);
            reviewerIO.write(
                `[${i + 1}/${candidates.length}] ${c.repo} PR #${c.pr_number}`,
            );
            reviewerIO.write(SEPARATOR_HEAVY);
            reviewerIO.write("");
            reviewerIO.write(`TITLE: ${c.pr_title}`);
            reviewerIO.write("");
            reviewerIO.write("ISSUE TEXT:");
            reviewerIO.write(c.issue_text || "(no issue text)");
            reviewerIO.write("");
            reviewerIO.write(SEPARATOR_LIGHT);

            const decision = (await reviewerIO.ask(
                "Approve? (y=approve, n=reject, s=skip): ",
            )).toLowerCase();

            if (decision === "s") {
                continue;
            }

            const notes = await reviewerIO.ask("Reviewer notes (optional): ");
            c.reviewer_notes = notes || undefined;
            c.blind_approved = decision === "y";
            reviewed.push(c);

            // Incremental persistence (resume-safe).
            await fs.writeFile(
                outputPath,
                JSON.stringify(reviewed, null, 2),
                "utf-8",
            );
        }
    } finally {
        reviewerIO.close();
    }

    return reviewed;
}
