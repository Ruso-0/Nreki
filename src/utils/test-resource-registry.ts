export interface TestDisposable {
    shutdown?: () => void | Promise<void>;
    close?: () => void | Promise<void>;
    delete?: () => void | Promise<void>;
}

type RegisterTestResource = (resource: TestDisposable) => void;

interface TestResourceGlobal {
    __NREKI_REGISTER_TEST_RESOURCE__?: RegisterTestResource;
}

export function registerTestResource(resource: TestDisposable): void {
    const globalWithRegistry = globalThis as typeof globalThis & TestResourceGlobal;
    globalWithRegistry.__NREKI_REGISTER_TEST_RESOURCE__?.(resource);
}
