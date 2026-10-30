import { createHash } from 'node:crypto';
import type { PoeBalance } from 'lmc-wire';
import { fetchPoeJson, readPoeSettings } from '@/runtime/poe';

export function parsePoePoints(raw: unknown): number {
    const value = (raw as { current_point_balance?: unknown } | null)?.current_point_balance;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('unavailable');
    return value;
}

/** Only one source is selected by the UI; requests are coalesced and limited to once per minute. */
export function createPoeBalanceReader(read = readPoeSettings, request = fetchPoeJson, now = Date.now) {
    let cached: PoeBalance | null = null;
    let identity = '';
    let attemptedAt = -Infinity;
    let pending: Promise<PoeBalance> | null = null;
    return async (): Promise<PoeBalance> => {
        let settings;
        try { settings = read(); }
        catch { return { points: null, capturedAt: null, status: 'unavailable', stale: true }; }
        if (!settings) return { points: null, capturedAt: null, status: 'unconfigured', stale: false };
        const current = createHash('sha256').update(settings.apiKey).digest('hex');
        if (identity !== current) { identity = current; cached = null; pending = null; attemptedAt = -Infinity; }
        if (cached && now() - attemptedAt < 60_000) return cached;
        if (pending) return pending;
        const previous = cached;
        const operation = request('/usage/current_balance', settings.apiKey).then(raw => ({
            points: parsePoePoints(raw), capturedAt: now(), status: 'ok' as const, stale: false,
        })).catch((error): PoeBalance => ({
            points: previous?.points ?? null, capturedAt: previous?.capturedAt ?? null,
            status: error instanceof Error && error.message === 'authentication' ? 'authentication' : 'unavailable', stale: true,
        })).then(result => {
            if (identity !== current) return { points: null, capturedAt: null, status: 'unavailable' as const, stale: true };
            if (identity === current) { cached = result; attemptedAt = now(); }
            return result;
        }).finally(() => { if (pending === operation) pending = null; });
        pending = operation;
        return operation;
    };
}
