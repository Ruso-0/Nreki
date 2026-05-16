import { afterAll } from "vitest";
import type { TestDisposable } from "../src/utils/test-resource-registry.js";

declare global {
    var __NREKI_REGISTER_TEST_RESOURCE__: ((resource: TestDisposable) => void) | undefined;
}

const resources: TestDisposable[] = [];

globalThis.__NREKI_REGISTER_TEST_RESOURCE__ = (resource: TestDisposable): void => {
    resources.push(resource);
};

async function dispose(resource: TestDisposable): Promise<void> {
    if (typeof resource.shutdown === "function") {
        await resource.shutdown();
        return;
    }
    if (typeof resource.close === "function") {
        await resource.close();
        return;
    }
    if (typeof resource.delete === "function") {
        await resource.delete();
    }
}

afterAll(async () => {
    const seen = new Set<TestDisposable>();
    for (const resource of resources.slice().reverse()) {
        if (seen.has(resource)) continue;
        seen.add(resource);
        try {
            await dispose(resource);
        } catch {
            // Best-effort cleanup in the test harness; individual tests
            // still assert functional shutdown behavior explicitly.
        }
    }
    resources.length = 0;
    globalThis.__NREKI_REGISTER_TEST_RESOURCE__ = undefined;
});
