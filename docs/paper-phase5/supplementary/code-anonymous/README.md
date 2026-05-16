# Anonymous Supplementary Code

This archive contains the minimal evaluation and figure-rendering code needed to audit the submission's retrieval claims under double-blind review.

## Contents

- `scripts/eval-phase5/runners/hybrid-runner.ts`: Late-Fusion RRF runner.
- `scripts/eval-phase5/runners/voyage-runner.ts`: voyage-code-3 evaluation runner.
- `scripts/eval-phase5/bootstrap-rk-mrr.ts`: paired bootstrap CI95% and p-value analysis.
- `scripts/eval-phase5/voyage-paired-analysis.ts`: paired voyage-code-3 subset analysis.
- `scripts/figures/render_architecture.py`: Figure 1 renderer.
- `scripts/figures/render_pareto.py`: Figure 2 renderer.

## Reproduction

Run the N=99 local evaluation from the repository root:

```bash
npx tsx scripts/eval-phase5/orchestrate.ts \
  --output-jsonl results-c4b-v3-with-hybrid.jsonl \
  --runners nreki-mbf-on,bm25,hybrid-rrf \
  --no-cleanup --no-resume
```

Then run the bootstrap analysis with fixed `random_seed=42`.

The voyage-code-3 paired analysis requires a `VOYAGE_API_KEY` environment variable and sufficient provider quota. The main local retrievers do not require network access.

## Double-Blind Notes

Author names, package handles, repository URLs, git metadata, and personal identifiers are intentionally omitted for review. Public repository and license details will be disclosed after the review process.
