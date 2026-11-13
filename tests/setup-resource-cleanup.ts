import { afterAll } from "vitest";
import os from "os";
import path from "path";
import type { TestDisposable } from "../src/utils/test-resource-registry.js";

// State-file signatures (utils/trust.ts) use a per-user key: keep the test
// suite off the developer's real ~/.nreki/trust.key. Child processes inherit it.
process.env.NREKI_TRUST_DIR ??= path.join(os.tmpdir(), "nreki-test-trust");

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
