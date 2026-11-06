import { type AccountQuotaSnapshot } from 'lmc-wire';

/** Source-scoped, memory-only cache shared by rings, menu and usage view. */
export function createAccountQuotaCache(request: (id: string, force: boolean) => Promise<AccountQuotaSnapshot>, now = Date.now) {
    const entries = new Map<string, { snapshot?: AccountQuotaSnapshot; at: number; pending?: Promise<AccountQuotaSnapshot> }>();
    return {
        peek: (id: string) => entries.get(id)?.snapshot ?? null,
        read(id: string, force = false) {
            let entry = entries.get(id);
            if (!entry) { entry = { at: -Infinity }; entries.set(id, entry); }
            if (entry.pending) return entry.pending;
            if (!force && entry.snapshot && now() - entry.at < (entry.snapshot.refreshing ? 1_000 : 15_000)) {
                return Promise.resolve(entry.snapshot);
            }
            const current = entry;
            current.pending = Promise.resolve().then(() => request(id, force)).then(snapshot => {
                current.snapshot = snapshot; current.at = now(); return snapshot;
            }).finally(() => { current.pending = undefined; });
            return current.pending;
        },
    };
}
