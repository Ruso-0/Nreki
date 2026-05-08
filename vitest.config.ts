import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        pool: "forks",
        maxWorkers: 2,
        maxConcurrency: 2,
        testTimeout: 120_000,
        hookTimeout: 60_000,
        teardownTimeout: 10_000,
        fileParallelism: true,
        exclude: ["**/node_modules/**", "**/dist/**", "**/corpus/**"],
    },
});
