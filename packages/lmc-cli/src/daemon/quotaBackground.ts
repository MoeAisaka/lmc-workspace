/** A slow optional provider must not hold up other providers or cached readings. */
export function createQuotaBackground<T>(ttlMs: number | ((value: T | undefined) => number), onFailure: (previous: T | undefined) => T, budgetMs = 200) {
    let value: T | undefined;
    let sampledAt = -Infinity;
    let pending: Promise<void> | null = null;
    return async (read: () => Promise<T>, force = false): Promise<{ value: T | undefined; refreshing: boolean }> => {
        if (!pending && (force || Date.now() - sampledAt >= (typeof ttlMs === 'function' ? ttlMs(value) : ttlMs))) {
            pending = Promise.resolve().then(read).then(result => { value = result; }, () => { value = onFailure(value); })
                .finally(() => { sampledAt = Date.now(); pending = null; });
        }
        // A warm cache never waits. A cold cache gives inexpensive local reads
        // a brief chance to finish; its in-flight refresh remains single-flight.
        if (value === undefined && pending) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, budgetMs); })]);
            if (timer) clearTimeout(timer);
        }
        return { value, refreshing: pending !== null };
    };
}
