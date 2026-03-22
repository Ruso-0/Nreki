import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        testTimeout: 60_000,
        hookTimeout: 30_000,
        teardownTimeout: 10_000,
        pool: "forks",
        fileParallelism: true,
    },
});
