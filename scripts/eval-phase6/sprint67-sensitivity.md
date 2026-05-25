# Sprint 6.7 — POST-HOC sensitivity on Jaccard threshold

**EXPLORATORY ONLY.** The pre-registered H0 uses threshold=0.15;
this table is Furia round 6.7 Q2 mitigation, exposing how |A|
moves with the cutoff. Does NOT redefine the verdict.

| Jaccard threshold | |A| | |B| | |C| | A instance_ids |
|---|---|---|---|---|
| 0.15 | 1 | 31 | 68 | coder__code-server-4923 |
| 0.2 | 5 | 25 | 70 | coder__code-server-4923, microsoft__vscode-106767, mui__material-ui-26807, mui__material-ui-34158, mui__material-ui-34207 |
| 0.25 | 5 | 22 | 73 | coder__code-server-4923, microsoft__vscode-106767, mui__material-ui-26807, mui__material-ui-34158, mui__material-ui-34207 |
| 0.3 | 5 | 20 | 75 | coder__code-server-4923, microsoft__vscode-106767, mui__material-ui-26807, mui__material-ui-34158, mui__material-ui-34207 |

Reading: the niche size |A| is small at every reasonable threshold.
0.15 is not artificially deflating it; the issue is that PolyBench
multi-file patches rarely involve type-coupled file pairs at all.
