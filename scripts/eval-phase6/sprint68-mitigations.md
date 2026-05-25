# Sprint 6.8 — Furia post-hoc mitigations

**EXPLICITLY POST-HOC.** These do not redefine the pre-registered Q_a/Q_b/Q_c verdict.

## Q3 — Apples-to-apples TPCH on voyage's 16-task subset

NREKI restricted to the SAME N=16 tasks where voyage ran successfully.

| Retriever | n | hits@5 | R@5 | tokens mean | TPCH @N=0 | TPCH @N=1 | TPCH @N=2 |
|---|---|---|---|---|---|---|---|
| nreki-mbf-on | 16 | 6 | 37.50% | 2190 | 5839 | 9705 | 13571 |
| hybrid-rrf | 16 | 9 | 56.25% | 30186 | 53665 | 81081 | 108498 |
| bm25 | 16 | 5 | 31.25% | 50410 | 161312 | 295117 | 428922 |
| ripgrep | 16 | 5 | 31.25% | 231011 | 739236 | 1350630 | 1962024 |
| voyage-3 | 16 | 12 | 75.00% | 3900 | 5201 | 6493 | 7786 |
| aider | 7 | 1 | 14.29% | 2449 | 17142 | 31195 | 45248 |

## Q2 — Break-even R@5 NREKI vs voyage

NREKI tokens mean (full 100): 3194. voyage TPCH on its 16: N=0 5201, N=1 6493, N=2 7786.

| N_retry | NREKI R@5 needed to match voyage TPCH | NREKI's actual R@5 | gap (pp) |
|---|---|---|---|
| 0 | 0.614 | 0.370 | +24.4 |
| 1 | 0.659 | 0.370 | +28.9 |
| 2 | 0.676 | 0.370 | +30.6 |

## Q4 — Foveal ablation: NREKI-foveal vs NREKI-raw-files (same top-K, same retrieval)

- n_tasks: 100
- with foveal (recorded): 319,439 tokens
- without foveal (raw top-5 file content): 1,410,083 tokens
- global compression ratio: 0.2265
- global savings: 77.3%

This is the foveal's contribution **with denominator pinned**: same retriever, same files, only thing changed is foveal-on vs foveal-off.
