import { codexExecutable, runtimeRelease } from '@/runtime/managedRuntime';

export type CodexCredits = { balance: number | null; unlimited: boolean; capturedAt: number; stale: boolean };
export function parseCodexCredits(value: any, now = Date.now()): CodexCredits | null {
    const pool = value?.rateLimitsByLimitId?.codex ?? value?.rateLimits;
    if (!pool || (pool.limitId && pool.limitId !== 'codex') || !pool.credits) return null;
    const credits = pool.credits;
    const raw = credits.balance;
    const balance = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    return { balance: Number.isFinite(balance) && balance >= 0 && balance <= Number.MAX_SAFE_INTEGER ? balance : null,
        unlimited: credits.unlimited === true, capturedAt: now, stale: false };
}

/** Account-only probe: no thread creation, prompts, credential copies or session restart. */
async function probeCredits(): Promise<CodexCredits | null> {
    const { CodexAppServerClient } = await import('@/codex/codexAppServerClient');
    const client = new CodexAppServerClient(undefined, undefined, undefined, codexExecutable(runtimeRelease('codex', true) ?? null));
    try { await client.connect(); return parseCodexCredits(await client.readRateLimits()); }
    finally { await client.disconnect(); }
}
export function createCreditsReader(probe = probeCredits, now = Date.now) {
    let cached: CodexCredits | null = null;
    let sampledAt = -Infinity;
    let pending: Promise<CodexCredits | null> | null = null;
    return () => {
        if (now() - sampledAt < 60_000) return Promise.resolve(cached);
        if (pending) return pending;
        pending = probe().then(value => { cached = value; return cached; }, () => {
            cached = cached ? { ...cached, stale: true } : null; return cached;
        }).finally(() => { sampledAt = now(); pending = null; });
        return pending;
    };
}
export const readCodexCredits = createCreditsReader();
