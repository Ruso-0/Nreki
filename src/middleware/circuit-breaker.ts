/**
 * middleware/circuit-breaker.ts — Passive circuit breaker middleware for TokenGuard v3.0.
 *
 * Wraps all router tool handlers with automatic loop detection.
 * Records every tool call result and trips the breaker when it detects
 * destructive patterns (repeated errors, excessive edits, doom loops).
 *
 * This is the former tg_circuit_breaker tool, now running automatically
 * as invisible middleware monitoring all tool calls.
 */

import { CircuitBreaker, containsError } from "../circuit-breaker.js";
import type { McpToolResponse } from "../router.js";

/** Last activity timestamp for auto-reset. */
let lastActivityTimestamp = Date.now();

/** Last tool+action combo for diversity detection. */
let lastToolAction = "";

/** Inactivity timeout for auto-reset (60 seconds). */
const INACTIVITY_TIMEOUT_MS = 60_000;

/**
 * Wrap a router handler with passive circuit breaker monitoring.
 *
 * Before executing the handler, checks:
 *   1. If the breaker was tripped but 60s have elapsed → auto-reset
 *   2. If the breaker was tripped but a different tool/action is requested → auto-reset
 *   3. If the breaker is currently tripped → return isError: true immediately
 *
 * After execution, records the result for pattern detection.
 */
export function wrapWithCircuitBreaker(
    cb: CircuitBreaker,
    toolName: string,
    action: string,
    handler: () => Promise<McpToolResponse>,
    filePath?: string,
): Promise<McpToolResponse> {
    return (async () => {
        const toolAction = `${toolName}:${action}`;
        const now = Date.now();

        // Auto-reset: 60s inactivity
        if (now - lastActivityTimestamp > INACTIVITY_TIMEOUT_MS) {
            const state = cb.getState();
            if (state.tripped) {
                cb.reset();
            }
        }

        // Auto-reset: different request type
        if (toolAction !== lastToolAction && lastToolAction !== "") {
            const state = cb.getState();
            if (state.tripped) {
                cb.reset();
            }
        }

        lastActivityTimestamp = now;
        lastToolAction = toolAction;

        // If breaker is still tripped after potential resets, block
        const preState = cb.getState();
        if (preState.tripped) {
            return {
                content: [{
                    type: "text" as const,
                    text:
                        `⚠️ CIRCUIT BREAKER TRIPPED: ${preState.tripReason}. ` +
                        `TokenGuard detected a destructive loop pattern. ` +
                        `STOP and ask the human for guidance before proceeding. ` +
                        `Pattern detected: ${preState.tripReason}`,
                }],
                isError: true,
            };
        }

        // Execute the actual handler
        const response = await handler();

        // Record the result for pattern detection
        const responseText = response.content.map(c => c.text).join("\n");
        const hasError = response.isError === true || containsError(responseText);

        if (hasError) {
            const loopCheck = cb.recordToolCall(
                toolAction,
                responseText,
                filePath,
            );

            if (loopCheck.tripped) {
                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `⚠️ CIRCUIT BREAKER TRIPPED: ${loopCheck.reason}. ` +
                            `TokenGuard detected a destructive loop pattern. ` +
                            `STOP and ask the human for guidance before proceeding. ` +
                            `Pattern detected: ${loopCheck.reason}`,
                    }],
                    isError: true,
                };
            }
        } else {
            // Record non-error calls too (for same-file tracking)
            cb.recordToolCall(
                toolAction,
                "",
                filePath,
            );
        }

        return response;
    })();
}

/**
 * Reset middleware state (for testing).
 */
export function resetMiddlewareState(): void {
    lastActivityTimestamp = Date.now();
    lastToolAction = "";
}
