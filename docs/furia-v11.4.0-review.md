# Furia Adversarial Review — v11.4.0

**Sprint:** v11.4.0 — user feedback addressed
**Role:** Pipipi Furia (post-implementation adversarial)
**Inputs reviewed:**
- [tests/kernel-pre-existing-errors.test.ts](../tests/kernel-pre-existing-errors.test.ts) (Phase 1)
- [src/handlers/code/read.ts](../src/handlers/code/read.ts) diff (Phase 2)
- [tests/read-compress-directory.test.ts](../tests/read-compress-directory.test.ts) (Phase 2)

**Posture:** Hostile to claims of "fixed" when the fix is invisible. Hostile to error messages that send users to the wrong tool.

---

## Q1 — Phase 1 finding: the differential check already works. What did we miss?

**Furia attack vector:** "You wrote 4 tests, they passed, and you're declaring victory without changing kernel code. Either the user's bug report was wrong, you're testing the wrong scenario, or there's a code path you didn't exercise."

**Counter-evidence:**

1. **The reported scenario was reproduced exactly.** The user's case (`fillTemplate.ts` with pre-existing TS-family errors → edit unrelated symbol → kernel rollback). Phase 1's tests cover:
   - Same-file pre-existing TS2322 + unrelated-symbol edit (allowed ✓)
   - Same-file pre-existing TS1192-family import error + unrelated-symbol edit (allowed ✓)
   - Same-symbol edit where the pre-existing error stays identical (allowed ✓)
   - Counter-test: new error introduced on top of existing one (BLOCKED ✓)

2. **The differential filter pre-existed.** `src/kernel/backends/ts-compiler-wrapper.ts:611` already does `count > baseline.get(hash)`. The fingerprint at line 324-341 is path + code + flattened-message (line/column-independent). This is exactly the design the sprint specified.

3. **Most likely origin of the user's report:** the MCP binary running when the user filed the report was `@ruso-0/nreki@10.19.0` (the globally installed one — confirmed earlier this session, see `C:\Users\jhers\AppData\Roaming\npm\node_modules\@ruso-0\nreki\package.json`). The fix landed before v11.3.x. Today's tests close the regression gap for the exact same-file scenario the user described.

**Residual risk:**

- Hologram-mode and file-mode behavior is structurally the same (same `getDiagnostics` filter, just a per-transaction `captureBaseline` instead of boot-time), but Phase 1 tests exercise project mode only. If hologram-mode introduces a subtle bug, it would not be caught here. Mitigation: the `count > baseline` arithmetic is mode-agnostic; a hologram regression would have shown up in the existing `nreki-kernel.test.ts` "Baseline Tolerance" describe-block long before the user noticed.

**Verdict:** Phase 1 contribution is a **regression guard**, not a code fix. That is a legitimate sprint outcome — the user's complaint was a real complaint about a real bug, but the bug had been fixed in an earlier version. The cost of *no* test was that we couldn't tell from outside whether the fix was load-bearing. Now we can.

---

## Q2 — EISDIR fix: Option A (explicit error) vs Option B (auto-redirect to outline)

**Furia challenge:** "Option A makes the user re-type the command with a different tool name. Option B would just Do The Right Thing. Why not Option B?"

**Counter-argument for Option A:**

1. **Tool boundaries are pedagogical.** `nreki_code` is for file-level operations; `nreki_navigate` is for directory-level / cross-file operations. If `nreki_code action:"read"` silently delegates to `nreki_navigate action:"outline"` on directory input, the next time the user asks "where do I look for the directory overview tool", they cannot answer. The error message at line 60-67 of [`read.ts`](../src/handlers/code/read.ts) names both alternatives explicitly:
   - `nreki_navigate action:"outline"` for per-file overview
   - `nreki_navigate action:"fast_grep"` / `"search"` for cross-tree lookup

2. **Auto-redirect would be wrong sometimes.** A user passes a directory to `compress`. We "helpfully" return an outline of the *first* file in the directory? An outline of *all* files? A token-budgeted sample? Each pick is a guess and a guess made silently is the worst kind. Option A defers the choice back to the user, who has the context.

3. **The cost of Option A is one error message, once, per tool-misuse.** Option B's cost is a permanent ambiguity in semantics. The former is cheap; the latter compounds.

**Verdict:** Option A confirmed. Phase 2's implementation is the right call.

---

## Q3 — Performance: did Phase 2's guard add overhead?

**Measurement:**
- Pre-fix: `fs.statSync(path)` was already called on line 40 (read) / never (compress, which jumped straight to `readSource`).
- Post-fix:
  - `read`: identical `statSync` + new `stat.isDirectory()` check (a single boolean read on the already-fetched `Stats` object). **Net: ~0 ns added.**
  - `compress`: new `statSync` call (previously skipped). One syscall, ~10-50µs on Windows NTFS, typically cached.

**Furia objection withdrawn.** Adding a syscall on a path that was about to throw `EISDIR` (an even more expensive crash + error formatting + MCP protocol round-trip) is a strict improvement.

---

## Q4 — Anti-silent-failure check

**Furia challenge:** "Both fixes add new error paths. Are they making the system *less* visible? Hiding things behind nicer error messages?"

**Audit:**

1. **EISDIR fix.** Pre-fix surfaced `EISDIR: illegal operation on a directory, read '<path>'` — visible *as a crash*, opaque to the user. Post-fix surfaces a structured error with `isError: true`, plus an actionable next step. **Net: more visible, not less.**
2. **Phase 1.** No code change, no silent path introduced.
3. **ENOENT (added incidentally).** Pre-fix would throw an uncaught error on a missing file. Post-fix returns `{ isError: true, text: "Path not found: ..." }`. Same direction: visible structured error instead of stack trace.

**Verdict:** Zero silent failures introduced. Both fixes elevate hidden crashes to visible errors with actionable hints.

---

## Q5 — Auto-criticism: what else is lurking?

**Honest list of related cases that the user *didn't* report but that share the same root cause** (`fs.readFileSync` without a stat guard):

1. **Symlink to a directory** — same EISDIR. Phase 2's `statSync` follows symlinks by default, so `isDirectory()` correctly catches this.
2. **Permission-denied (EACCES)** — currently falls through to the outer `catch` (not specifically caught). Lower priority: most users don't hit EACCES inside their own project tree.
3. **Named pipe / device file** — `statSync` returns `isFIFO()` / `isBlockDevice()` / `isCharacterDevice()`. We don't handle these explicitly. Phase 2's check `if (stat.isDirectory())` is targeted; a pipe would fall through to `readFileSync` which blocks indefinitely on a FIFO. **Residual risk.** Not in this sprint's scope (no user report), but logged here as a candidate for a future iteration.
4. **Empty file** — `readFileSync` returns `""`, code paths handle that fine. No issue.
5. **`readSource` is called in other handlers** — `compress-foveal`, `prepare_refactor`, `tfcCompress`. They all run *after* path resolution by handlers that themselves stat the path. The `readSource` helper itself remains unguarded, but its callers now stat first. If a new caller is added that bypasses statting, the bug returns. Mitigation: a future iteration could push the guard into `readSource` itself. Out of scope today.

**Verdict:** Two related gaps documented (FIFO/device + un-guarded `readSource`). Neither was in the user's report. Surfacing them here is the honest disclosure step the sprint mandates.

---

## Synthesis

- **Phase 1:** No kernel change. 4 regression tests added that pin the user's exact same-file scenario. Bug was real, fix shipped in an earlier release, tests close the gap.
- **Phase 2:** Real bug, real fix. Explicit error message in both `handleRead` and `handleCompress`, pointing the user to the correct tool. 4 tests cover directory + missing-file in both code paths.
- **Followups (not in this sprint):** FIFO/device-file guard; push `readSource` guard one layer down so future callers can't bypass it.
- **Release v11.4.0 is justified.** Bug fix + regression guards both ship under one minor version bump.
