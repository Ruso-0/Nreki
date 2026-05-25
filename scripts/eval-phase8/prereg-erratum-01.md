# Sprint 8.0 Pre-registration — Erratum 01

**Date:** 2026-05-24
**Author:** Pipipi Code (release v12.0.0-rc.1 execution), under Jherson Eddie Tintaya Holguin's direction.
**Status:** Erratum to the FROZEN pre-registration `scripts/eval-phase8/sprint80-prereg.md`. The pre-registration itself is NOT edited (freeze preserved). This file records a factual error and the corrected implementation, with the control's intent preserved.

---

## The error

`sprint80-prereg.md`, §"foveal_off control — operational definition", final paragraph (≈ L67) states:

> *Implementation: a `FOVEAL_OFF=1` env var gates the compression paths in `compressor-foveal.ts` (bypass at line 109 ALWAYS fires), `handlers/code/edit.ts` (skip tfcCompress invocation), and `handlers/navigate.ts` (force `include_raw=true`).*

The clause **"`handlers/code/edit.ts` (skip tfcCompress invocation)"** is factually wrong.

**Verified (call-graph investigation, 2026-05-24):** `src/handlers/code/edit.ts` does **NOT** invoke `tfcCompress` at any point. The sole production call site of `tfcCompress` is **`src/handlers/code/read.ts:283`** (inside `handleCompress`, the `focus`-present branch). `grep -n tfcCompress src/` confirms: zero occurrences in `edit.ts`. A gate placed in `edit.ts` would be dead code that never executes.

Root cause: the pre-registration was written from memory of the handler layout, not from a verified call graph. The investigation (documented in the v12.0.0 release session) established the real topology after the prereg was frozen.

## The correction (control intent preserved)

The control arm's INTENT — *"a vanilla semantic retriever with K-hop neighbor expansion to rawCode; foveal_off delivers raw content with zero NREKI compression"* — is unchanged. The corrected gate locations are:

| Path | Gate behavior when `FOVEAL_OFF=1` | File:loc |
|---|---|---|
| Compressor bypass | `tfcCompress` returns raw content (bypass fires unconditionally) | `src/compressor-foveal.ts` (the `fovealOff \|\| lineCount < 100 \|\| ...` guard) |
| Compress handler | `handleCompress` `focus` branch returns the raw file, skips `tfcCompress` entirely | `src/handlers/code/read.ts` (focus branch top) |
| Search handler | `handleSearch` forces `include_raw=true` → returns full `rawCode` per chunk | `src/handlers/navigate.ts` (`include_raw` derivation) |
| Outline handler | `handleOutline` lifts the triage-risk filter + token budget → body of every method, no `[BUDGET LIMIT REACHED]` | `src/handlers/navigate.ts` (DYNAMIC RISK EXPANSION block) |

**`edit.ts` is intentionally NOT gated** — there is nothing to gate (it never compresses).

### Note on the outline gate phrasing

ROJO-1 resolution (release runbook) said "handleOutline skip auto-expand". The frozen prereg §foveal_off said "body of every method (no `[BUDGET LIMIT REACHED]` auto-expand)". These reconcile to the implemented behavior: when `FOVEAL_OFF=1`, the budget cap is lifted (`MAX_EXPAND_TOKENS = Infinity`) and the triage-risk filter is dropped (`expandable = symbols`), so **every** method body is expanded with no truncation banner. This realizes "body of every method, no `[BUDGET LIMIT REACHED]`" — the full-dump control — rather than literally emitting zero expansions.

## Invariant preserved

`FOVEAL_OFF` unset or `!= "1"` → **every** gated path is byte-identical to pre-v12 behaviour. The production foveal_on arm is frozen exactly as the pre-registration requires. Verified by `tests/sprint80-foveal-epicenter.test.ts` tests D (FOVEAL_OFF=1 raw passthrough) and E (FOVEAL_OFF=0 still compresses, byte-identical to Phase 1.2).

— signed: Pipipi Code, 2026-05-24, on behalf of the v12.0.0-rc.1 release.
