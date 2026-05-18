# ADR-003 — Slicing Direction

Status: **Accepted (Phase 0 — Sprint Initial)**
Date: 2026-05-16
Related: ADR-001 (approach), ADR-005 (NREKI integration)

---

## Context

Classical slicing distinguishes two directions:

- **Backward slice** — given a criterion `<statement S, variable v>`,
  the set of all statements that may affect the value of `v` at
  `S`. Answers: *"what code is responsible for this state at this
  point?"*
- **Forward slice** — given a criterion `<statement S, variable v>`,
  the set of all statements whose execution may be affected by the
  value of `v` at `S`. Answers: *"if I change this, what breaks?"*

The paper's Section 7.3 articulation of Reto 8 is:

> "Causal slicing would attempt to recover minimal evidence chains
> *from symptom to edit location*."

"Symptom to edit location" is a backward direction (the symptom is
where the failure manifests; the edit location is upstream). But
the agent's edit also has a *forward* concern: once we propose an
edit at the edit location, we need to know what else it perturbs —
the forward slice from the proposed edit.

NREKI's existing retrieval thesis frames a query as "task
description → relevant files". A NREKI retrieval task has both:

- A *symptom* (the error message, the failing test, the user's
  question), which seeds a *backward* causal walk.
- A *candidate edit site* (after retrieval ranks files), which
  benefits from a *forward* slice to know blast radius.

## Decision

**Reto 8 Phase 7.1 implements both backward and forward slicing
from a unified slice operator, with backward as the default
operation for "symptom-to-edit-location" queries and forward
available as a complementary blast-radius operation.**

Concretely:

1. The slice operator takes `direction: "backward" | "forward"`
   and a slicing criterion `<file, line, [variableName?]>`.
2. Both directions share the same SDG and PDG; the two-pass
   Horwitz-Reps-Binkley algorithm naturally generalises to both
   directions by traversing the dependence edges in their natural
   versus reverse orientation.
3. A convenience entry point `evidenceChain(symptom, editSite)`
   composes backward-from-symptom ∩ forward-from-editSite to
   produce the minimal common evidence corridor — this is the
   "evidence chain" semantics paper Section 7.3 articulates.

## Rationale

**Why both, not just backward.** The paper articulates symptom-to-
edit as the primary direction. But the *evidence chain* semantics
(minimal connecting set between two endpoints) requires both
directions: the symptom contributes the backward slice, the edit
site contributes the forward slice, and the chain is their
intersection. Implementing only backward would force the consumer
to re-implement forward slicing themselves at the call-site, which
violates the encapsulation property.

**Why a unified operator, not two separate ones.** SDG dependence
edges are directional. A *backward* slice traverses them in the
"depends-on" direction (against the arrow). A *forward* slice
traverses them in the "depended-by" direction (with the arrow). The
underlying graph traversal is identical modulo edge orientation.
Two separate implementations would duplicate the marking-algorithm
state machine and create maintenance drift; one implementation
parameterised by direction is the canonical refactoring.

**Why a convenience `evidenceChain` entry point.** Paper Section 7.3
specifies the user-facing semantics ("from symptom to edit
location"). Exposing this directly avoids the consumer having to
re-derive intersection logic. Internally it is
`intersect(backward(symptom), forward(editSite))`; externally it is
a single call.

**Why criterion `<file, line, [variableName?]>` not `<statement,
variable>`.** NREKI clients (the foveal compressor, the search
pipeline, the human reviewer) operate in file/line coordinates;
they do not have AST node references. Mapping file/line to the
enclosing statement is a one-line `ts.getLineAndCharacterOfPosition`
helper. Variable name is optional: when absent, the slice criterion
is over *all variables defined at that statement* (the canonical
Tip 1995 default).

## Consequences

Positive:

- Both directional queries available from a single SDG construction
  (constructed once, queried many times — amortises the
  expensive setup over many retrievals).
- `evidenceChain` is one composition primitive built on backward +
  forward; clean compositionality.
- Blast-radius queries become free as a side-effect; they would
  augment NREKI's existing change-impact analysis.

Negative:

- Two-direction state in the marking algorithm complicates
  correctness review; the implementation must include round-trip
  tests proving the two directions agree on a symmetric
  micro-benchmark (`backward(forward(x)) ⊇ {x}` and
  `forward(backward(x)) ⊇ {x}`).
- Forward slicing on hub-like definitions (e.g., a popular utility
  function) produces enormous slices; the consumer must accept that
  forward slices on hubs are inherently large and either filter or
  rank them post-hoc.

## Verification (Phase 7.1 exit criteria for this ADR)

- [ ] Backward slice on a known-answer micro-benchmark matches the
      Weiser-canonical expected statement set empírico verifiable.
- [ ] Forward slice on the same micro-benchmark, with the criterion
      moved to the slice endpoint, matches the expected reverse set
      empírico verifiable.
- [ ] `evidenceChain(symptom, editSite)` on a 3-hop synthetic case
      returns the expected intersection empírico verifiable.
- [ ] Round-trip property: for any criterion `c`, every node in
      `forward(c)` has `c` in its `backward` slice (modulo dynamic-
      dispatch over-approximation). Tested empírico on PoC.
