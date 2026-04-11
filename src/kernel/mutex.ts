// src/kernel/mutex.ts
export class AsyncMutex {
    private queue: (() => void)[] = [];
    private locked = false;

    async lock(queueTimeoutMs: number = 60_000): Promise<() => void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: NodeJS.Timeout;
            const release = () => {
                if (this.queue.length > 0) this.queue.shift()!();
                else this.locked = false;
            };
            const doResolve = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(release);
                }
            };
            if (!this.locked) {
                this.locked = true;
                doResolve();
            } else {
                timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        const idx = this.queue.indexOf(doResolve);
                        if (idx !== -1) this.queue.splice(idx, 1);
                        reject(new Error(`[NREKI] Mutex queue timeout after ${queueTimeoutMs}ms - deadlock prevented`));
                    }
                }, queueTimeoutMs);
                this.queue.push(doResolve);
            }
        });
    }

    async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
        const unlock = await this.lock();
        try {
            return await fn();
        } finally {
            unlock();
        }
    }
}
