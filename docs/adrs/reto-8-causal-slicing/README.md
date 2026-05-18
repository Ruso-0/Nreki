# Reto 8 — Causal Program Slicing (NREKI Phase 7 OMEGA)

**Phase 0 — Sprint Initial — Handoff Index**
Date: 2026-05-16
NREKI version at sprint start: v11.0.0 (tag pushed, npm publish pending)
Branch: master
Status: Phase 0 design complete; Phase 7.1 implementation NOT started

---

## What This Sprint Delivered (artefacts in this directory)

| Artefact                                    | Purpose                                                  |
|---------------------------------------------|----------------------------------------------------------|
| [`000-literature-review.md`](000-literature-review.md) | 16 papers / tools surveyed; TS slicing research gap confirmed |
| [`001-slicing-approach.md`](001-slicing-approach.md)   | ADR-001 — static SDG, with reserved hybrid + learning hooks |
| [`002-granularity.md`](002-granularity.md)             | ADR-002 — statement-level output, expression-level internal PDG |
| [`003-direction.md`](003-direction.md)                 | ADR-003 — backward + forward + evidence-chain composition |
| [`004-cross-language-scope.md`](004-cross-language-scope.md) | ADR-004 — TS-only Phase 7.1; 7.2/7.3 gated on Reto 9 |
| [`005-nreki-integration.md`](005-nreki-integration.md) | ADR-005 — standalone module; Phase 7.1.5 expander; module skeleton |
| [`phase-7-1-scope.md`](phase-7-1-scope.md)             | In-scope / out-of-scope / exit criteria / wall-clock estimate |
| [`milestone-0-poc.md`](milestone-0-poc.md)             | PoC design — one callback-chain test file, throwaway prototype |
| [`furia-adversarial-review.md`](furia-adversarial-review.md) | Q1-Q10 adversarial pass + Path A decision + 3 genuine gaps |

## Headline Decisions (Path A accepted)

1. **Static SDG-based slicing on the TypeScript Compiler API**,
   conservative over-approximation at dynamic-dispatch sites
   (callbacks, DI, decorators, lifecycle hooks). Dynamic
   instrumentation and learning-based prediction are reserved
   extension hooks, not Phase 7.1 commitments.
2. **Statement-level slice output backed by expression-level PDG**
   for soundness; round-trips through `ts.printNode`.
3. **Backward, forward, and evidence-chain (backward ∩ forward)
   operators** from a unified marking algorithm.
4. **TypeScript only in Phase 7.1**; cross-language calls emitted
   as `OpaqueSink` provenance nodes. JVM (Phase 7.2) and C++ (Phase
   7.3) gated on Reto 9 progress.
5. **Standalone module first** (`src/causal-slicer/` + MCP tool);
   integrated parafovea expander deferred to Phase 7.1.5 behind a
   feature flag with default-off to preserve Phase 5 empirical
   baseline.

## Headline Empirical Findings From Literature Review

- **No native TypeScript causal slicer exists** in peer-reviewed
  literature or maintained open source as of 2025-09. Reto 8
  Phase 7.1 is a genuine research contribution candidate.
- **WALA has a JavaScript frontend but no JS slicer** — confirmed
  on the WALA wiki. SliceJS (research artifact, ES5-targeted)
  is the closest adjacent prior art.
- **LLM-only slicing sits at ~60 % accuracy** on Java (arxiv
  2409.12369). NS-Slicer reaches 94-96 % F1 with neural networks,
  Java only. Learning-based slicing is rising but not load-bearing.
- **Hybrid static + selective-dynamic is the empirical sweet spot**
  for dynamic-flow languages (SliceJS for JS, Slicer4J for Java).
  Phase 7.1 takes static-only as the *first* step; Phase 7.2
  reserves the hybrid path.

## Honest Disclosures (consolidated)

1. **Wall-clock estimate revised from paper's 6-12 months to
   18-24 months ± 50 %** for full Reto 8 (Phases 7.1 + 7.1.5 +
   7.2 + 7.3). Driven by Reto 9 gating dependency and dispatch
   heuristic iteration cost. Phase 7.1 standalone realistic at
   4 months.
2. **Complementarity of Type Ledger and causal slicing is a
   hypothesis, not a measured fact.** Phase 7.1.5 measurement on
   the "ambos fail" 40-task subset is the empirical test. Null
   result is a publishable outcome; framing committed in advance
   (see `furia-adversarial-review.md` Q9).
3. **Three load-bearing design gaps remain** (Furia Q6):
   - **Gap 6.A** Task-completion benchmark beyond file-level FHR.
   - **Gap 6.B** Criterion extraction — how a natural-language
     query becomes a `<file, line, variable>` triple. Needs
     ADR-006 before implementation.
   - **Gap 6.C** Slice budget compression when slice exceeds token
     budget. Extends ADR-002; adds `SliceCompressor` interface.
4. **Phase 7.1's "novel TS contribution" is the TypeChecker
   integration**, not the slicing algorithm itself. SliceJS pre-
   exists for JS; the type-aware extension is what is new.
5. **Phases 7.2 and 7.3 are aspirational, not scheduled.** They
   depend on Reto 9, which is itself indefinite. Disclosed as PM
   honesty (ADR-004).

## What's Required Before Phase 7.1 Implementation Starts

In strict order:

1. **ADR-006 — Criterion Extraction** (resolves Furia Gap 6.B).
   Decide: agent supplies criterion / heuristic NL extraction /
   slice every retrieved function. Without this ADR, Phase 7.1 has
   no upstream invocation contract.
2. **Extension of ADR-002 to cover `SliceCompressor`** (resolves
   Furia Gap 6.C). Decide budget-overflow truncation strategy.
3. **Phase 7.1.5 measurement protocol document** (resolves Furia
   Gap 6.A). Decide LLM-task-pass-rate methodology that
   complements FHR measurement on the 40-task subset.

Estimated effort for steps 1-3: 3-5 days at Phase 7.1 kickoff.

## What This Sprint Did NOT Deliver (and why)

- **No code.** Phase 0 is design-only. The Milestone 0 PoC is
  designed but not implemented. Implementation starts Phase 7.1.
- **No commits to `master`.** Phase 0 outputs are documents in
  `docs/adrs/reto-8-causal-slicing/`. They commit only after a
  human review pass. No `src/causal-slicer/` directory exists yet
  empírico verifiable.
- **No npm or git push.** v11.0.0 is the live tag; Phase 7 work
  will land in a 12.x line, not in v11.0.x.

## Test Suite Status

- 1313+ tests green at sprint start, empírico verifiable from
  pre-sprint state.
- No tests added, no tests changed during Phase 0.
- Phase 7.1 implementation will add `tests/causal-slicer/*` files
  (see ADR-005 module structure).

## Aligned With Project Constraints

- **Apache 2.0 NREKI freemium** (per memory `project_business_strategy.md`):
  the slicer is part of free NREKI core, not paid STGT.
- **NREKI v10.18.1 global binary + nreki init** (per memory
  `project_mcp_install.md`): the slicer MCP tool will register
  through the existing nreki-init enforcer hook, no new install
  flow.

## Pointers

- Paper Section 7.3 (Phase 7 OMEGA articulation):
  [draft-v0.4-arxiv.md:407-411](../../paper-phase5/draft-v0.4-arxiv.md#L407-L411)
- Type Ledger reference implementation:
  [compressor-foveal-cross-file.ts](../../../src/compressor-foveal-cross-file.ts)
- TS Compiler API existing wiring:
  [kernel/nreki-kernel.ts](../../../src/kernel/nreki-kernel.ts),
  [kernel/spectral-topology.ts](../../../src/kernel/spectral-topology.ts)
