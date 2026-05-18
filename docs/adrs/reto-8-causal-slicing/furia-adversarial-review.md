# Pipipi Furia Adversarial Review — Reto 8 Phase 0

Status: **Phase 0 — Sprint Initial output**
Date: 2026-05-16
Reviewer voice: Pipipi Furia (in-house adversarial review)
Subject: ADR-001..005, `phase-7-1-scope.md`, `milestone-0-poc.md`,
`000-literature-review.md`
Methodology: 10-question structured adversarial pass + Path A/B/C
decision

---

## Q1 — Static vs Dynamic vs Hybrid choice justification empírico

**Furia:** You chose pure static. The literature (Finding C in
000-literature-review.md) says hybrid is the empirical sweet spot
for dynamic-flow languages — and Reto 8 *targets* dynamic-flow
failures. You contradict your own literature finding in the first
ADR. Why?

**Response (empírico):** Confirmed contradiction in framing.
Reframed: the empirical sweet spot is hybrid, but the *cost
structure* of running dynamic instrumentation inside NREKI is
prohibitive given (a) NREKI is offline-by-design, (b) the "ambos
fail" 40-task benchmark is not runnable, (c) the engineering
surface of dynamic instrumentation in TS (Node loaders, source
maps, ESM/CJS) is enormous. The decision is *not* "static is
better" — it is "static is cheaper to ship first, with explicit
hooks reserved for the empirically-better hybrid approach later".
ADR-001 now reads correctly: static-first, with hybrid as Phase
7.2 explicit follow-up.

**Status:** Acknowledged contradiction in literature-review tone vs
ADR-001 tone. ADR-001 is correct as written; literature review will
be updated to clarify that "empirical sweet spot" applies *if you
can afford the instrumentation cost*, which NREKI Phase 7.1 cannot.

## Q2 — Slicing granularity scalability empírico

**Furia:** Expression-level PDG construction on a 100 kLoC project
will produce millions of nodes. You set a perf gate of 10 kLoC in
60 s but you have no evidence that this scales linearly. What
happens at 100 kLoC?

**Response (empírico):** Honest disclosure: we have no empirical
data for 100 kLoC and the perf gate is set at 10 kLoC deliberately
because that is the smallest credible "real project" size. Above
that, the PDG construction is bounded by symbol-resolution cost,
which scales as roughly O(N · D) where N is the number of
identifiers and D is the average declaration-resolution depth. The
TS Compiler API caches symbol lookups, but ambient modules and
declaration merging can break the cache. We commit to a 100 kLoC
perf measurement *during* Phase 7.1 with a hard abort if SDG
construction exceeds 30 minutes; if it does, we add lazy
construction (build SDG only for files reachable from the slicing
criterion's connected component).

**Status:** Risk acknowledged, mitigation specified
(`phase-7-1-scope.md` risk table row 2). Not blocking Phase 0.

## Q3 — Cross-language scope Phase 7 vs Phase 8 alignment

**Furia:** ADR-004 gates Phases 7.2 and 7.3 on Reto 9. Reto 9 is
itself indefinite. You are admitting that most of Reto 8 is
unschedulable. Why is this not a project-management red flag?

**Response (empírico):** It is. Disclosed as such. The honest
position: Reto 8 Phase 7.1 *alone* is a publishable contribution
(first native TS causal slicer; see `000-literature-review.md`
Finding A). Phases 7.2 and 7.3 are *aspirational* — they describe
what Reto 8 *would* become if Reto 9 lands. The paper Section 7.3
articulation of Reto 8 does not require multi-language to be
true; it requires causal slicing to be true. Phase 7.1 delivers
the latter. Reto 9 dependency is honestly disclosed in ADR-004
under "Honest Disclosure".

**Status:** Acknowledged as PM honesty. Phase 7.1 is the
publishable unit; 7.2/7.3 are aspirational extensions.

## Q4 — Integration NREKI Type Ledger redundancy o complementary

**Furia:** You claim Type Ledger (file-level topology) and causal
slicing (statement-level causal) are complementary. But what if
they are not? What if every "ambos fail" task that benefits from
slicing *also* benefits from Type Ledger going deeper? Is there
prior art that proves complementarity, or are you assuming it?

**Response (empírico):** No prior art proves complementarity for
this exact combination. Honest disclosure: we are *hypothesising*
complementarity based on the conceptual difference (breadth-at-low-
depth vs depth-at-narrow-breadth). Phase 7.1.5 empirical
measurement on the 40-task subset is the test. ADR-005 explicitly
makes Phase 7.1.5 an *exploratory* measurement, not a guaranteed
ship. If the measurement shows redundancy (slicer adds no FHR
improvement over Type Ledger at deeper walk_depth), Phase 7.1
still ships as a standalone MCP tool but the integrated expander is
abandoned. The slicer remains useful for "why this file matters"
direct queries even if it adds nothing to retrieval.

**Status:** Hypothesis disclosed as hypothesis, not as result.
Phase 7.1.5 is the empirical test. Acceptable risk-bearing.

## Q5 — Empirical benchmark plan (subset "ambos fail" 40 tasks)

**Furia:** Phase 7.1 exit criteria do not include the 40-task
benchmark. You're shipping without measuring against the explicit
target the paper Section 7.3 articulated. Why?

**Response (empírico):** Phase 7.1 ships the *slicer*. Phase 7.1.5
ships the *measurement*. The decoupling is deliberate (ADR-005
rationale): the empirical measurement requires the integrated
expander, which is gated on the standalone slicer working. Shipping
both at once would conflate "slicer correctness" with "slicer
empirical value" and make failure attribution impossible. The
phased approach is honest: Phase 7.1 ≡ "the slicer is correct";
Phase 7.1.5 ≡ "the slicer helps NREKI retrieval". Both must hold
for the paper Section 7.3 claim to land, and they are measured
independently.

**Status:** Decoupling is methodologically sound. Phase 7.1 exit
criteria are *necessary but not sufficient* for the paper claim.
Phase 7.1.5 measurement is the sufficient component, with
honest-disclosure protocol for null results.

## Q6 — Auto-crítica gap fundacional Reto 8 que diada NO ve

**Furia:** Stop defending. What is the gap *you* don't see?
What's the question you haven't asked yourself?

**Response (empírico, auto-crítica):** Three candidates.

**Gap 6.A — Why this matters to the agent.** The paper Section 7.3
frames Reto 8 as "evidence chains from symptom to edit location".
But NREKI's *current consumer* (an LLM via MCP) does not ask for
"evidence chains" — it asks for "context to answer this question".
The slice is one possible context, but it is not the only one, and
it may not be the most useful one for the LLM. We have not asked:
*does an LLM perform better on the "ambos fail" 40-task subset
when given a slice vs when given Type Ledger files vs when given
both?* That is the user-value question. Phase 7.1.5 measures FHR,
which is a retrieval metric, not a task-completion metric. The
real benchmark is end-to-end task pass rate on the 40-task subset
with slicer-augmented context.

**Gap 6.B — Slicing criterion provenance.** A slice needs a
*criterion* — a statement-line-variable triple. Where does the
criterion come from in the NREKI retrieval flow? The user's query
is a natural-language task description, not a `<file, line,
variable>` tuple. The criterion-extraction step is *not designed*
in any of the ADRs. This is a load-bearing component that we
silently elided. Either (a) the agent supplies the criterion
(requires agent to first parse the failure into a structured form),
(b) we extract criteria heuristically from the user's task
description (NLP problem we have not scoped), or (c) we slice from
*every* function in the retrieved files (combinatorial explosion).
All three are unresolved.

**Gap 6.C — Slice as context vs slice as map.** The slice is a set
of statements. NREKI gives the LLM a *budgeted token window*. A
1 000-statement slice does not fit. We have not designed *what we
do when the slice is bigger than the budget*. Truncation strategies
(top-K by node centrality? Most-recent in slice topological order?
Just the criterion's immediate dependency frontier?) are not in any
ADR. This is the *same* problem the foveal compressor solves for
files, but at statement granularity.

**Status:** Three real gaps. Gap 6.B is the most severe — it
threatens the whole design. We add it to the open-questions queue
and design a follow-up ADR (ADR-006: Criterion Extraction)
*before* starting Phase 7.1 implementation. Gap 6.A is a benchmark
methodology refinement for Phase 7.1.5. Gap 6.C is a Phase 7.1
implementation concern — add a `SliceCompressor` interface to
ADR-005 module structure.

## Q7 — Honest comparison vs prior art

**Furia:** Phase 7.1 ships first-ever native TS slicer. But
SliceJS exists for JavaScript. JavaScript ≈ TypeScript at the AST
level if you strip types. Are you sure Phase 7.1 is novel, or are
you just porting SliceJS without saying so?

**Response (empírico):** Sound objection. The TS-specific
contributions are: (i) using the TS *type checker* (not just the
parser) for symbol resolution, which SliceJS does not do because
JS has no type system; (ii) handling decorators with type-aware
binding resolution; (iii) modeling conditional and template-literal
types in the PDG where they influence control flow. If we strip
those three, we are indeed re-implementing SliceJS for TS files.
Honest disclosure: the *novel* contribution is the TypeChecker
integration, not the slicing algorithm. We will cite SliceJS
explicitly in any Phase 7.1 publication and frame the contribution
as "type-aware extension of selective-instrumentation slicing".

**Status:** Honest novelty framing added to literature review
honest-disclosures section. Acceptable.

## Q8 — Wall-clock estimate honesty

**Furia:** Paper articulated Reto 8 at 6-12 months. You revised to
18-24 months for full Reto 8. That's a 2-3x slip *at design time*.
What confidence interval do you have on the 18-24 estimate?

**Response (empírico):** Low confidence (±50 %). The 18-24
estimate is constructed bottom-up: Phase 7.1 realistic 16 weeks ≈
4 months, Phase 7.1.5 ≈ 3 weeks, Phase 7.2 ≈ 6 months *after Reto
9.1*, Phase 7.3 ≈ 6-9 months *after Reto 9.2*. The biggest
uncertainty is the Reto 9 gating: if Reto 9 takes 12 months
itself, Phase 7.2 starts in month 16 and finishes in month 22, so
the 18-24 estimate may be optimistic. We commit to re-estimating
at end of Phase 7.1 (≈ month 4) with empirical data on PDG
construction effort.

**Status:** Estimate is honest about its uncertainty. Disclosed as
±50 %. Re-estimation gate at end of Phase 7.1.

## Q9 — What does the paper say if Phase 7.1 ships and Phase 7.1.5 is a null result?

**Furia:** You're planning the paper before you have the data.
What is the *honest* paper if Phase 7.1.5 measurement shows
slice-augmented retrieval is no better than Type Ledger alone?

**Response (empírico):** Honest paper in that case:

> "We construct the first native TypeScript causal slicer with
> type-aware symbol resolution and demonstrate Weiser-canonical
> correctness on a 12-benchmark micro-suite. When integrated into
> the NREKI hybrid RRF retrieval pipeline on the PolyBench-Verified
> TypeScript N=99 benchmark, the slicer-augmented expander does
> not produce a statistically significant FHR improvement over the
> Type Ledger baseline. We hypothesise that the static
> conservative over-approximation produces slices too coarse for
> the file-level retrieval task, and propose Phase 7.2 hybrid
> dynamic instrumentation as the next empirical step."

That is a real, publishable null result. Honest. The slicer
remains useful as a standalone MCP tool even if it does not move
the retrieval needle.

**Status:** Null-result framing committed in advance. This is the
methodological discipline the paper Section 6.5 (Voyage quota
disclosure) already demonstrates. Acceptable.

## Q10 — Does Reto 8 *help any human*?

**Furia:** Forget the paper. Forget retrieval. Does a working
TypeScript causal slicer make any human's day better? If the
answer is "marginally for code-review automation", then this is
research, not product. Be honest about which it is.

**Response (empírico):** It is research-with-eventual-product-
candidacy. The honest user value, ranked:

1. **Debugging.** A developer asking "why does this user's email
   end up null at the API boundary?" gets back a 12-statement
   chain across 4 files, instead of a `git grep "email"` 200-line
   wall. This is real product value, accessible via the MCP tool.
2. **Code review automation.** A reviewer looking at a PR can
   forward-slice from the diff site and see the blast radius. Real
   value, especially for monorepos.
3. **Retrieval augmentation.** Phase 7.1.5 measurement is the
   bet. May or may not pay off.
4. **Compliance auditing.** "Show me every statement that affects
   what is logged to the audit channel." Real value for regulated
   environments; out of scope for Phase 7.1 but enabled by it.

Net: yes, Reto 8 helps humans, primarily via debugging and review,
even if the retrieval bet (#3) misses.

**Status:** User value defensible independent of paper claims.

---

## Path A / B / C Decision

**Path A — Proceed as designed (ADR-001..005 + Phase 7.1 +
Milestone 0 PoC).** Ship Phase 7.1 standalone slicer first, Phase
7.1.5 empirical measurement second, Phases 7.2/7.3 gated on Reto 9.

**Path B — Reduce scope to Milestone 0 + Phase 7.1.5 only.** Skip
Phase 7.1 (no full SDG, no MCP tool); just demonstrate end-to-end
on a single callback chain and measure the impact on the 40-task
subset. Lower commitment, lower payoff.

**Path C — Reformulate Reto 8 entirely.** Pivot from causal
slicing to a different attack on dynamic-flow failures (e.g.,
trace-based retrieval from existing test runs; LLM-based call-
graph reconstruction; abandon the symbolic approach).

### Firma empírico verifiable

**Path A — Accepted.**

Reasoning:
- Path B sacrifices the standalone-slicer product value (Q10 #1
  and #2) and forces all empirical bets on a single integration
  measurement. Too brittle.
- Path C requires throwing away the literature review's
  identification of a real research gap (Finding A) and the
  alignment with paper Section 7.3 articulation. Premature.
- Path A is the honest, phased, empirically-instrumented plan.
  All risks are disclosed; all wall-clock estimates are bounded
  by re-estimation gates.

**Outstanding ADRs to add before Phase 7.1 implementation
starts:** ADR-006 — Criterion Extraction (Gap 6.B). Designed at
Phase 7.1 kickoff, not in this Phase 0 sprint.

**Outstanding scope adjustment:** Add `SliceCompressor` /
`SliceBudget` interface to `src/causal-slicer/output/` module
structure (Gap 6.C). Will be reflected in `phase-7-1-scope.md` at
Phase 7.1 kickoff.
