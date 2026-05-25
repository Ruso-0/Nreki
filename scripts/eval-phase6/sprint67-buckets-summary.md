# Sprint 6.7 — Phase 1 bucket classification

Jaccard threshold (pre-registered): 0.15
Total tasks classified: 100

## Bucket counts

- Bucket A (type-dependent-cross-file, low lexical overlap): **1**
- Bucket B (cross-file, lexical or non-type): 31
- Bucket C (single-file / no cross-file): 68

## Per-repo bucket distribution

| Repo | A | B | C | Total |
|---|---|---|---|---|
| mui/material-ui | 0 | 26 | 44 | 70 |
| microsoft/vscode | 0 | 3 | 20 | 23 |
| tailwindlabs/tailwindcss | 0 | 1 | 2 | 3 |
| coder/code-server | 1 | 1 | 1 | 3 |
| angular/angular | 0 | 0 | 1 | 1 |

## Stopping rule
**|A| = 1 < 15.** Per pre-registration, this is **insufficient sample**. Phase 2 will still compute metrics for transparency, but the H0/H1 verdict will be reported as 'insufficient sample — cannot reject H0 with available power'.
