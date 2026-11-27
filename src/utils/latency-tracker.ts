/**
 * latency-tracker.ts — Lightweight operation latency accumulator.
 *
 * Records timing for the last N operations and computes P50/P95/P99 percentiles.
 * Used by nreki_guard action:"status" to surface performance telemetry.
 * Zero external dependencies.
 *
 * Every NREKI tool call is recorded here (middleware/circuit-breaker.ts), with
 * the tokens it returned. Up to 12.5.1 only the kernel's edit intercepts were,
 * so a session of fast_grep/context/read calls with native edits showed
 * "No operations recorded yet." in status (measured 2026-11-27, ~20 calls).
 */

const MAX_SAMPLES = 200;

interface LatencyEntry {
    op: string;
    ms: number;
    ts: number;
}

/** Cumulative per-operation totals since the process started (not capped). */
interface OpTotals {
    count: number;
    tokens: number;
}

class LatencyTracker {
    private samples: LatencyEntry[] = [];
    private totals = new Map<string, OpTotals>();
    private startedAt = Date.now();

    /** A new session (a workspace bound by a global server): forget the previous one's numbers. */
    reset(): void {
        this.samples = [];
        this.totals.clear();
        this.startedAt = Date.now();
    }

    record(op: string, ms: number, tokens: number = 0): void {
        this.samples.push({ op, ms, ts: Date.now() });
        if (this.samples.length > MAX_SAMPLES) {
            this.samples.shift();
        }
        const t = this.totals.get(op) ?? { count: 0, tokens: 0 };
        t.count++;
        t.tokens += Math.max(0, Math.round(tokens));
        this.totals.set(op, t);
    }

    getStats(op?: string): { count: number; p50: number; p95: number; p99: number; avg: number } | null {
        const filtered = op
            ? this.samples.filter(s => s.op === op)
            : this.samples;

        if (filtered.length === 0) return null;

        const sorted = filtered.map(s => s.ms).sort((a, b) => a - b);
        const n = sorted.length;

        return {
            count: n,
            p50: sorted[Math.floor(n * 0.50)] ?? 0,
            p95: sorted[Math.floor(n * 0.95)] ?? 0,
            p99: sorted[Math.floor(n * 0.99)] ?? 0,
            avg: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
        };
    }

    /** Tool calls (ops named `tool:action`) since the process started, and the tokens they returned. */
    getCallTotals(): { calls: number; tokens: number; since: number } {
        let calls = 0;
        let tokens = 0;
        for (const [op, t] of this.totals) {
            if (!op.includes(":")) continue;
            calls += t.count;
            tokens += t.tokens;
        }
        return { calls, tokens, since: this.startedAt };
    }

    getSummary(): string {
        const ops = new Set(this.samples.map(s => s.op));
        if (ops.size === 0) return "  No operations recorded yet.";

        const lines: string[] = [];
        for (const op of ops) {
            const stats = this.getStats(op);
            if (!stats) continue;
            const t = this.totals.get(op);
            const tok = t && t.tokens > 0 ? `, ~${t.tokens.toLocaleString("en-US")} tok returned` : "";
            lines.push(
                `     ${op}: ${t?.count ?? stats.count} ops${tok}, avg=${stats.avg}ms, p50=${stats.p50}ms, p95=${stats.p95}ms, p99=${stats.p99}ms`
            );
        }
        return lines.join("\n");
    }
}

// Singleton
export const latencyTracker = new LatencyTracker();
