# KNOWN DIVERGENCES — NREKI v12.0.0

Documented gaps between NREKI's marketing/design intent and verified runtime behavior. Each entry is empirically established (code-read + test), not inferred. Honest debt ledger; not a roadmap promise.

---

## KD-01 — Epicenter-body-blindness in the foveal compress path

**Severity:** medium (affects retrieval-payload quality, not correctness or edit-safety).
**Status:** open. No fix in v12.0.0. Tracked for Sprint 8.0.1+.
**Established by:** call-graph investigation 2026-05-24 + empirical probe + `tests/sprint80-foveal-epicenter.test.ts`.

### Claim vs reality

Earlier positioning (internal) implied foveal compression preserves topological epicenters — i.e., a file that is heavily depended-upon (`[EPICENTER]` / high in-degree / `[BLAST RADIUS]`) keeps its body when surfaced.

**Verified reality:** `tfcCompress` (`src/compressor-foveal.ts`) preserves the body of **the focus symbol only**. It has ZERO topology awareness — `grep` confirms no reference to `isEpicenter` / `isBlastRadius` / `sensoryTag` / `topology` inside the compressor. A non-focus symbol that is a topological epicenter is elided regardless of its centrality:

- if it is an **upstream caller** of the focus → collapsed to a bare **name** (vectorial upstream collapse)
- if it is a **downstream dependency** of the focus → reduced to a **signature** via `cleanSignature` (body → `{ }`)
- if it is **orthogonal** → omitted entirely (counted only as `darkMatterLines`)

The `[EPICENTER]` / `[BLAST RADIUS]` per-symbol markers are produced by **`handleSearch`** (`src/handlers/navigate.ts`, `sensoryTag`), keyed on `searcher.ts` topology flags — and are **never generated in the compress path**. `tfcCompress` emits only a file-level `// ⚠️ EXTERNAL BLAST RADIUS` line (which other files import this module, top-3), not per-symbol epicenter preservation.

### Empirical demonstration

Input: `focusFn` (focus) calls `epicenterHelper` 5×. `tfcCompress(focus="focusFn")`:
- focus body present: **true**
- neighbor (epicenter) body present: **false** — appears as `export function epicenterHelper(c: Ctx): number { }` (body collapsed)
- `[EPICENTER]` marker present: **false** (never produced in compress)

### Adjacent fact: outline uses a different signal

`handleOutline`'s auto-expand (`src/handlers/navigate.ts`, DYNAMIC RISK EXPANSION block) preserves bodies based on **`computeTriageRisk`** — intra-symbol complexity (line count, branches, mutations, business-logic/critical-domain name patterns, math density, `as any`). It does **NOT** consult topology either. So neither the compress path nor the outline path preserves topological epicenters; outline preserves *complex* symbols, compress preserves the *focus*.

### Consequence

If an agent focuses on symbol F to fix a bug, but the fix requires reading the body of a non-focus topological epicenter E that F depends on, E arrives as a signature `{ }`. The agent must issue a secondary `compress focus:"E"` / `read` call to see E's body — a Secondary Fetch. The net token impact of this is **unmeasured** (requires a real agent loop; blocked by API-key/Docker per Sprint 8.0 Phase 3 NOT-MEASURED).

### Why not fixed in v12.0.0

The anti-elision logic does not exist in `tfcCompress` and is non-trivial to add:
- the topology signal lives in `searcher.ts` (operates on `SearchResult`), the compressor operates on `ParsedChunk` — different shapes
- the closest reference (outline auto-expand) is inline + entangled with outline rendering + keyed on the wrong signal (complexity, not topology)
- the port is "extract + adapt to ParsedChunk + choose signal", not "export and call"

A future toggle would land as `antiElision?: boolean` on `TfcCrossFileOptions` (`src/compressor-foveal.ts`), threaded from `CodeParams` via `read.ts` — following the existing `walkDepth`/`maxCrossFile` per-call pattern. The flag is cheap; the behavior it gates is the work.

The `FOVEAL_OFF=1` control arm shipped in v12.0.0 is the measurement scaffold to quantify whether KD-01 matters in practice (Secondary Fetch Rate, AHORRO_NETO), before investing in the fix.
