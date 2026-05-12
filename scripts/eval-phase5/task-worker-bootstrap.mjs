/**
 * scripts/eval-phase5/task-worker-bootstrap.mjs
 *
 * Phase 5 C.4.B.2 Sprint 4.9 (Furia round 28).
 *
 * Worker bootstrap. The orchestrator spawns this .mjs file (which Node
 * resolves natively without any loader) so the worker can register
 * `tsx/esm` for itself and then import the .ts worker body. Without
 * this shim the worker would inherit the parent's loader -- which is
 * `tsx` when the orchestrator runs via `npx tsx` but is `vitest`'s own
 * transformer (or nothing) when the parent is the test runner. Doing
 * the registration from inside the worker makes the worker module
 * graph self-contained.
 */

// tsx 4.x ships its own register helper that wires the correct --import
// hook. Using `node:module`.register("tsx/esm", ...) is rejected by tsx
// since the legacy --loader flow was retired in Node 20.6 / 18.19.
import { register } from "tsx/esm/api";

register();

await import("./task-worker.ts");
