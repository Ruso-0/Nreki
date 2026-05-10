# Phase 5 SWE-Bench-TS-Lite — Evaluation Module

NREKI Phase 5 dataset curation + eval pipeline infrastructure.

**Spec firmada:** UNION rounds 10+11+13 — see [TECH_DEBT.md "Phase 5"](../../TECH_DEBT.md#phase-5-swe-bench-ts-lite--spec-firmada-union-rounds-101113).

**Sub-fase actual:** C.1 dataset curation infrastructure (this commit).

## Module structure

```
scripts/eval-phase5/
├── README.md             — this file
├── types.ts              — shared interfaces (BugCandidate, GroundTruth, etc.)
├── dataset-fetcher.ts    — GitHub API filter (closed PRs + bug labels)
├── repo-cloner.ts        — Per-task clone @ base_commit (Time-Travel guard)
├── ground-truth.ts       — 3-niveles + anti-tests filter mortal
├── reviewer-harness.ts   — Blind review CLI (anti-confirmation-bias)
├── curate.ts             — Orchestrator (NOT executed in C.1 commit)
└── data/                 — Output JSONs (gitignored, generated locally)
    ├── candidates-raw.json       (post-fetch, pre-review)
    ├── candidates-approved.json  (post-review, incremental save)
    └── dataset-final.json        (post-ground-truth, final dataset)
```

Tests at [tests/eval-phase5/](../../tests/eval-phase5/).

## Architectural decisions enforced

- **Time-Travel Guard** (Furia round 13 #3): per-task `git checkout base_commit`
  ANTES de indexar. Pureza del entorno NO se negocia.
- **Anti-tests filter MORTAL** (Furia round 13 #8): `*.test.ts`, `*.spec.ts`,
  `test/` folders excluded from Recall ground truth. Tests del FUTURO =
  trampa temporal.
- **Blind reviewer constraint** (Furia round 13 #1): reviewer reads ONLY
  PR title + Issue text + repo metadata. NEVER PR diff or modified_files.
- **3-level ground truth** (Furia round 10 #4): strict_src (HEADLINE),
  permissive (anexo), maximal (anexo). Strict_src = src/ ONLY post-anti-tests.
- **Stratified target repos** (Furia round 11): small (date-fns), medium
  (trpc), large (microsoft/TypeScript). All cutoff `2026-01-31`.

## Usage (manual curation step, post-C.1 commit)

### 1. Set GitHub token

```bash
export GITHUB_TOKEN="ghp_..."   # read scope sufficient
```

The token is needed for GitHub Search API rate limits (60 req/hr unauth →
5000 req/hr auth). NEVER commit `.env` to git (already in `.gitignore`).

### 2. Run curation orchestrator

```bash
npx tsx scripts/eval-phase5/curate.ts
```

Pipeline:
1. Fetch raw candidates from each target repo (saved to `data/candidates-raw.json`)
2. Interactive blind review — for each candidate:
   - Reviewer sees: PR title, Issue text, repo+PR# metadata
   - Reviewer DOES NOT see: PR diff, modified_files, merge_commit
   - Decision: `y` approve / `n` reject / `s` skip
   - Incremental save to `data/candidates-approved.json` after each decision
3. Ground truth computation for approved candidates
4. Final dataset saved to `data/dataset-final.json`

Estimated reviewer time: ~15-30 sec per candidate × 100-150 candidates =
**25-75 min** focused review session.

### 3. Output validation

```bash
# Count approved tasks per tier
cat scripts/eval-phase5/data/dataset-final.json | jq 'group_by(.tier) | map({tier: .[0].tier, count: length})'

# Verify anti-tests filter applied to all
cat scripts/eval-phase5/data/dataset-final.json | jq '[.[] | select(.ground_truth.anti_tests_filter_applied == false)] | length'
# Expected: 0 (all tasks must have filter applied)
```

## Tests

```bash
npm test -- tests/eval-phase5/
```

Tests use mocked Octokit + mocked CommandRunner + mocked ReviewerIO.
**NO real GitHub API calls. NO real git operations.** Run-to-run deterministic.

## Next sub-fases

- **C.2** Eval pipeline core: indexer adapter, query extractor,
  TokenCost@K instrumentation, result aggregator
- **C.3** Baselines implementations: ripgrep, BM25, dense retrieval,
  Aider repo-map
- **C.4** Execution + analysis: Pre/Post Phase 4 ablation, paper-grade
  markdown report
