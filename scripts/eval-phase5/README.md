# Phase 5 SWE-Bench-TS-Lite — Evaluation Module

NREKI Phase 5 evaluation infrastructure for the paper **"Topological
Retrieval in Massive-Scale TypeScript Codebases"**.

**Spec firmada:** TECH_DEBT.md — section *"PHASE 5 SEALED — SWE-PolyBench
Verified TS (post Furia round 17)"* (commit 46bfb52).

## Pivot post-Furia round 17

The original C.1 GitHub-API curation pipeline (`dataset-fetcher` +
`reviewer-harness` + `curate`) was retired after empirical Path E/F
inspection (rounds 15–17) confirmed that:

- No public academic TS dataset (Multi-SWE-bench, SWE-PolyBench,
  SWE-bench Multilingual) includes Backend/ORM/Compiler/Linter/Library
  repos — 0 of 7 TS repos total across probed datasets.
- SWE-PolyBench Verified TS (100 instances, 5 repos, MIT license) ships
  with pre-validated F2P/P2P tests, tree-sitter AST `modified_nodes`,
  and per-instance Dockerfiles — eliminating the GitHub-API curation
  surface entirely.

Dataset adopted: **AmazonScience/SWE-PolyBench_Verified**
(arXiv:2504.08703, MIT).

## Surviving modules

```
scripts/eval-phase5/
├── README.md         — this file
├── types.ts          — schema interno (BugCandidate, GroundTruth)
├── ground-truth.ts   — anti-tests filter MORTAL (round 13 #8)
├── repo-cloner.ts    — Time-Travel guard via base_commit
└── data/             — output dir (gitignored)
```

Tests at [tests/eval-phase5/](../../tests/eval-phase5/).

### Roles in upcoming sub-fases

- **types.ts** — schema base; will be extended in C.2 to accommodate
  PolyBench fields (`patch`, `test_patch`, `task_category`,
  `modified_nodes`, `F2P`, `P2P`, `Dockerfile`, `test_command`).
- **ground-truth.ts** — anti-tests filter still applicable post-pivot;
  consumes PolyBench `patch` (gold fix patch) and rejects modifications
  to test files. Architectural invariant preserved.
- **repo-cloner.ts** — Time-Travel guard now targets PolyBench
  `base_commit` (40-char SHA) directly. No GitHub API roundtrip needed.

## Architectural invariants enforced (unchanged)

- **Time-Travel Guard** (Furia round 13 #3): per-task `git checkout
  base_commit` BEFORE indexing.
- **Anti-tests filter MORTAL** (Furia round 13 #8): `*.test.ts`,
  `*.spec.ts`, `test/` folders excluded from Recall ground truth.

## Tests

```bash
npm test -- tests/eval-phase5/
```

Tests use mocked `CommandRunner` for `repo-cloner` and pure unit
coverage for `ground-truth`. **No real git operations.**

## Next sub-fases

- **C.2** PolyBench dataset loader (`polybench-loader.ts`) — reads
  `test.csv`, maps to internal `BugCandidate` + extended schema,
  applies anti-tests filter via `ground-truth.ts`.
- **C.3** Baselines: fast_grep, ripgrep, BM25, Voyage-3 dense
  retrieval, Aider repo-map.
- **C.4** Execution + Pre/Post Phase 4 ablation + paper write-up.

## Citation

```
@misc{rashid2025swepolybench,
  title  = {SWE-PolyBench: A multi-language benchmark for repository
            level evaluation of coding agents},
  author = {Rashid, Muhammad Shihab and others},
  year   = {2025},
  eprint = {2504.08703},
  archivePrefix = {arXiv},
  primaryClass  = {cs.SE}
}
```
