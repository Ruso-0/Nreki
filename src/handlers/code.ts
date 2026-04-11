/**
 * handlers/code.ts - Barrel file for code handlers.
 *
 * Extracted from a 1,119-line monolith to strict domain modules.
 * This preserves the O(1) facade pattern for router.ts without mixing layers.
 */

export { handleRead, handleCompress } from "./code/read.js";
export { handleEdit, handleBatchEdit } from "./code/edit.js";
export { handleUndo, handleFilterOutput } from "./code/utils.js";
