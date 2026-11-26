/**
 * bootstrap-root.ts — imported FIRST by index.ts, for its side effect.
 *
 * ES modules evaluate their imports in order before the importing module's
 * body, so this runs before any other NREKI module can read process.cwd().
 */

import { applyProjectRoot } from "./project-root.js";

applyProjectRoot();
