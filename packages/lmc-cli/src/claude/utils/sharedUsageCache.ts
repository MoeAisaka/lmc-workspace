/**
 * One plan-usage reading per Claude account per device, shared by every
 * session on it.
 *
 * The usage endpoint behind the SDK's get_usage is rate limited per account —
 * roughly five requests per rolling window, with a 300 s Retry-After. Each
 * running session used to pull it every 30 s on its own, so ten sessions kept
 * the window full: the pulls themselves mostly failed, and so did the device
 * dashboard and the interactive /usage that share it.
 *
 * Now a session reads the cached reading first. Only when it is older than
 * `maxAgeMs` does one session — whichever takes the lock — call the endpoint
 * and write the result back. A failed call starts a cooldown that every
 * session on the account honours, doubling while failures continue.
 *
 * The file carries plan-window percentages and reset times only: no token,
 * account name or e-mail. The account appears as a hash in the file name.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type UsageWindowRecord = { utilization: number | null; resets_at: string | null };
export type SharedUsageEntry = {
    capturedAt: number | null;
    rateLimits: Record<string, UsageWindowRecord> | null;
    /** No request is made before this time (epoch ms), by any session. */
    cooldownUntil: number;
    cooldownMs: number;
    /** The account has no plan limits (API key, 3P provider). */
    unavailable?: boolean;
};
export type UsageFetchResult = { available: boolean; rateLimits: unknown };

export const SHARED_USAGE_MAX_AGE_MS = 300_000;
const COOLDOWN_MIN_MS = 300_000;
const COOLDOWN_MAX_MS = 1_800_000;
const LOCK_STALE_MS = 30_000;

export function usageAccountKey(parts: Array<string | null | undefined>): string {
    return createHash('sha256').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}

/** Keeps only `{utilization, resets_at}` windows; anything else never reaches disk. */
export function sanitizeRateLimits(value: unknown): Record<string, UsageWindowRecord> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Record<string, UsageWindowRecord> = {};
    for (const [id, window] of Object.entries(value as Record<string, unknown>)) {
        if (!/^[a-z0-9_]{1,40}$/.test(id) || id === 'extra_usage') continue;
        if (!window || typeof window !== 'object') continue;
        const w = window as Record<string, unknown>;
        if (!('utilization' in w) && !('resets_at' in w)) continue;
        const utilization = typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? w.utilization : null;
        const resetsAt = typeof w.resets_at === 'string' && w.resets_at.length <= 40 ? w.resets_at : null;
        out[id] = { utilization, resets_at: resetsAt };
    }
    return Object.keys(out).length ? out : null;
}

const EMPTY: SharedUsageEntry = { capturedAt: null, rateLimits: null, cooldownUntil: 0, cooldownMs: 0 };

async function readEntry(path: string): Promise<SharedUsageEntry> {
    try {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        return {
            capturedAt: typeof raw.capturedAt === 'number' ? raw.capturedAt : null,
            rateLimits: sanitizeRateLimits(raw.rateLimits),
            cooldownUntil: typeof raw.cooldownUntil === 'number' ? raw.cooldownUntil : 0,
            cooldownMs: typeof raw.cooldownMs === 'number' ? raw.cooldownMs : 0,
            ...(raw.unavailable === true ? { unavailable: true } : {}),
        };
    } catch {
        return { ...EMPTY };
    }
}

async function writeEntry(path: string, entry: SharedUsageEntry): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
    await rename(tmp, path);
}

async function takeLock(lockPath: string, now: number): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await open(lockPath, 'wx', 0o600);
            await handle.close();
            return true;
        } catch (error: any) {
            if (error?.code !== 'EEXIST') return false;
            // A holder that crashed mid-call must not block the account forever.
            try {
                if (now - (await stat(lockPath)).mtimeMs < LOCK_STALE_MS) return false;
                await unlink(lockPath);
            } catch { return false; }
        }
    }
    return false;
}

const fresh = (entry: SharedUsageEntry, now: number, maxAgeMs: number) =>
    !!entry.rateLimits && entry.capturedAt !== null && now - entry.capturedAt < maxAgeMs && entry.capturedAt <= now + 60_000;

/**
 * The account's latest reading, calling `fetchUsage` only when the cache is
 * stale, no cooldown is running and this caller holds the lock. Returns the
 * cached reading (possibly stale) otherwise, or null when there is none.
 */
export async function readSharedUsage(opts: {
    dir: string;
    accountKey: string;
    fetchUsage: () => Promise<UsageFetchResult>;
    now?: () => number;
    maxAgeMs?: number;
}): Promise<{ rateLimits: Record<string, UsageWindowRecord>; capturedAt: number } | null> {
    const now = opts.now ?? Date.now;
    const maxAgeMs = opts.maxAgeMs ?? SHARED_USAGE_MAX_AGE_MS;
    const path = join(opts.dir, `${opts.accountKey}.json`);
    const result = (entry: SharedUsageEntry) =>
        entry.rateLimits && entry.capturedAt !== null ? { rateLimits: entry.rateLimits, capturedAt: entry.capturedAt } : null;

    let entry = await readEntry(path);
    if (fresh(entry, now(), maxAgeMs) || now() < entry.cooldownUntil) return result(entry);
    await mkdir(opts.dir, { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    if (!await takeLock(lockPath, now())) return result(entry);
    try {
        // Another session may have finished a call between the first read and the lock.
        entry = await readEntry(path);
        if (fresh(entry, now(), maxAgeMs) || now() < entry.cooldownUntil) return result(entry);
        let fetched: UsageFetchResult | null = null;
        try { fetched = await opts.fetchUsage(); } catch { fetched = null; }
        const rateLimits = fetched?.available ? sanitizeRateLimits(fetched.rateLimits) : null;
        if (rateLimits) {
            entry = { capturedAt: now(), rateLimits, cooldownUntil: 0, cooldownMs: 0 };
        } else if (fetched && !fetched.available) {
            entry = { ...entry, unavailable: true, cooldownMs: COOLDOWN_MAX_MS, cooldownUntil: now() + COOLDOWN_MAX_MS };
        } else {
            // The SDK reports a rate-limited endpoint as available with no
            // windows, and a thrown call looks the same from here.
            const cooldownMs = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, entry.cooldownMs * 2));
            entry = { ...entry, cooldownMs, cooldownUntil: now() + cooldownMs };
        }
        await writeEntry(path, entry);
        return result(entry);
    } finally {
        await unlink(lockPath).catch(() => {});
    }
}
