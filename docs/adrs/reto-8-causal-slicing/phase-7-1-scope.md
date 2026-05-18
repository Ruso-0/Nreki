# Phase 7.1 Scope Definition — Reto 8.1 TypeScript Causal Slicing

Status: **Phase 0 — Sprint Initial output**
Date: 2026-05-16
Derived from: ADR-001..005, `000-literature-review.md`

---

## In Scope (Phase 7.1)

| Capability                                        | Status |
|---------------------------------------------------|--------|
| TypeScript SDG construction (intra + inter-proc)  | YES    |
| `allowJs` JavaScript support via TS Compiler API  | YES    |
| Backward + forward + evidence-chain slicing       | YES    |
| Statement-level slice output, expression-level PDG| YES    |
| Conservative over-approximation at dynamic dispatch sites | YES |
| Provenance / cause-set annotation per output statement | YES |
| Opaque-sink emission at cross-language boundaries | YES    |
| MCP tool entry point (standalone)                 | YES    |
| Vitest test suite for slicer                      | YES    |
| Micro-benchmark known-answer tests (Weiser-canonical) | YES |

## Out of Scope (Phase 7.1)

| Capability                                        | Deferred to |
|---------------------------------------------------|-------------|
| Dynamic-trace instrumentation                     | 7.2 (hybrid) |
| Learning-based slice prediction (NS-Slicer style) | 8.x        |
| JVM family slicing (Kotlin, Java)                 | 7.2 (after Reto 9.1) |
| C++ slicing                                       | 7.3 (after Reto 9.2) |
| Causal weight feedback into RRF score             | 7.2        |
| Integrated parafovea expander                     | 7.1.5      |
| Empirical comparison against NS-Slicer            | 8.x        |
| Slicer-driven autonomous edit proposal            | NEVER (Section 9.3 paper constraint) |

## Pre-Implementation Blockers (added by Furia review, see `furia-adversarial-review.md` Q6)

The following design items emerged from Furia adversarial review
and MUST be resolved before Phase 7.1 implementation starts
(i.e., before Milestone 0 PoC ships into mainline):

| Item                                                  | Owner ADR    | Sprint    |
|-------------------------------------------------------|--------------|-----------|
| **Criterion extraction** — how does a natural-language NREKI query become a `<file, line, variable>` slicing criterion? (Furia Gap 6.B) | ADR-006 *(to be written at Phase 7.1 kickoff)* | Sprint 7.1.0 |
| **Slice budget compression** — what happens when a slice exceeds the foveal-compressor token budget? (Furia Gap 6.C) | Extension of ADR-002, adds `SliceCompressor` to module structure | Sprint 7.1.0 |
| **Task-completion benchmark, not just FHR** — measure end-to-end LLM task pass rate, not only file-level retrieval, on the 40-task subset (Furia Gap 6.A) | Phase 7.1.5 measurement protocol | Sprint 7.1.5 |

## Phase 7.1 Empirical Success Criteria

The Phase 7.1 work is empirically validated when *all* of the
following hold, each empírico verifiable from artefacts checked
into the repo:

1. **Soundness micro-benchmark.** Backward and forward slicer
   reproduce Weiser-canonical expected slices on a hand-curated
   suite of at least 12 micro-benchmark TypeScript files covering:
   straight-line code, intra-procedural branches, intra-procedural
   loops, function calls, recursive calls, callback parameters,
   simple decorator, simple DI constructor injection, async
   `await`, Promise `.then`, event-emitter `.on`, React-style
   `useEffect`. Pass rate ≥ 95 %.
2. **No regression on the existing test suite.** All 1313+
   pre-Phase 7.1 tests continue to pass empírico verifiable in CI.
3. **SDG construction performance.** On a 10 000-LoC representative
   TypeScript project, SDG construction completes in under 60 s on
   a developer-class machine empírico verifiable.
4. **Slice extraction performance.** Backward slice from a
   criterion on the same 10 000-LoC project returns in under 5 s
   empírico verifiable.
5. **MCP tool usable.** The MCP tool can be invoked via Claude
   Code / Cursor / Copilot integration and returns structured slice
   output empírico verifiable, with at least one screen-recorded
   smoke run committed to `docs/adrs/reto-8-causal-slicing/`.
6. **Honest scope disclosures.** README / module JSDoc states (a)
   conservative over-approximation at dynamic-dispatch sites,
   (b) TS-only scope, (c) Phase 7.1.5 expander is opt-in, (d)
   Reto 8.2/8.3 gating on Reto 9. Empírico verifiable by `grep`.

## Phase 7.1 *Empirical Stretch* Goal (not exit criterion)

Inject the slicer into the foveal compressor under the Phase 7.1.5
feature flag and measure FHR change on the "ambos fail" 40-task
subset of PolyBench-Verified TypeScript N=99. *No statistical
significance claim is required* for Phase 7.1 exit; this is an
exploratory measurement to inform Phase 7.2 design. The empirical
result will be reported honestly whether positive, neutral, or
negative.

## Module Architecture (recap from ADR-005)

```text
src/causal-slicer/
  index.ts
  types.ts
  sdg/
    builder.ts
    pdg.ts
    inter-procedural.ts
    dynamic-dispatch.ts
    cross-language.ts
  slicer/
    backward.ts
    forward.ts
    evidence-chain.ts
  output/
    projection.ts
    renderer.ts
    provenance.ts
  mcp/
    tool.ts
tests/causal-slicer/
  micro-benchmarks/             # the 12+ known-answer files
  poc-callback-chain.test.ts    # Milestone 0
  poc-dependency-injection.test.ts
  poc-react-useeffect.test.ts
  sdg-builder.test.ts
  backward-slicer.test.ts
  forward-slicer.test.ts
  evidence-chain.test.ts
  dynamic-dispatch-overapprox.test.ts
  cross-language-opaque-sink.test.ts
  mcp-tool.test.ts
  perf-10kloc.test.ts           # SDG + slice perf gates
```

## Tooling Identification

### TypeScript (Phase 7.1)
- **TS Compiler API** — already present (peerDep `typescript >=5.5 <6.0`).
  Provides `createProgram`, `getTypeChecker`, `getSymbolAtLocation`,
  `getSignatureFromDeclaration`, `findReferences` (via
  `LanguageService`).
- **Decision: prefer Compiler API over headless `tsserver`.**
  Tsserver adds protocol surface (LSP/RPC, request lifecycle) we do
  not need for offline SDG construction. Reto 7 will own the
  headless-tsserver path; Reto 8 stays on the Compiler API.
- **`oxc-ast`** — already discussed for Nova; *not* needed for
  Phase 7.1 because the TS Compiler API gives us semantic types,
  which `oxc-ast` does not (today empírico verifiable). Reconsider
  for Phase 7.x if oxc gains TS semantic resolution.

### JVM (Phase 7.2, deferred)
- **Eclipse JDT Core** — canonical Java semantic frontend.
  Embeddable Java library; requires JVM boundary from Node.
- **Kotlin compiler embeddable** — official Kotlin compiler
  invocation API.
- **Alternative — SourceGraph SCIP** — language-agnostic semantic
  indexer. Lower fidelity but uniform across languages.
- **Decision deferred pending Reto 9.1 outcome.**

### C++ (Phase 7.3, deferred)
- **clangd** — LSP-based, mature, batteries-included.
- **LLVM/Clang API + DG (Chalupa)** — research-grade, lower-level.
- **Decision deferred pending Reto 9.2 outcome.**

## Wall-Clock Estimate (Honest)

Phase 7.1 (TypeScript slicer, standalone module + MCP tool, 12+
micro-benchmark tests passing, performance gates met):

- **Optimistic:** 8 weeks of focused work, single contributor.
- **Realistic:** 16 weeks (4 months) accounting for SDG-edge
  edge cases (TS conditional types, template literal types,
  declaration merging, ambient modules, namespace re-exports).
- **Pessimistic:** 24 weeks (6 months) if dynamic-dispatch
  over-approximation produces unusably large slices and we have to
  iterate on heuristics.

Phase 7.1.5 (expander integration + 40-task measurement):

- **Realistic:** 2-3 weeks once Phase 7.1 is shipped.

Phase 7.2 (JVM slicer, after Reto 9.1):

- **Realistic:** 6 months *after* Reto 9.1 lands.

Phase 7.3 (C++ slicer, after Reto 9.2):

- **Realistic:** 6-9 months *after* Reto 9.2 lands.

**Total honest wall-clock for full Reto 8 (Phases 7.1 + 7.1.5 +
7.2 + 7.3):** 18-24 months under sustained single-contributor
effort, dependent on Reto 9 timeline. Paper articulated 6-12 months;
this estimate revises upward and discloses why (cross-language
gating + dispatch heuristic iteration).

## Risks (Phase 7.1 specific)

| Risk                                                           | Mitigation                                                              |
|----------------------------------------------------------------|-------------------------------------------------------------------------|
| Conservative slices too large to consume                        | Phase 7.1.5 measurement empírico; abort expander if median slice > 5 % of project LoC |
| TS Compiler API performance on large projects                   | Perf gate at 10 kLoC in 60 s SDG; abort scope if 100 kLoC > 30 min       |
| Decorator / DI dispatch heuristics produce no useful precision  | Document over-approximation honestly; defer precision to Phase 7.2 hybrid |
| 1313+ test suite regresses due to incidental dep changes        | Standalone module; CI gate on full suite green                          |
| MCP tool surface conflicts with existing NREKI MCP tools        | Audit MCP registration at design start; namespace under `slice/*`       |
| Empirical 40-task measurement is null result                    | Disclose honestly; pivot Phase 7.2 design accordingly                   |
