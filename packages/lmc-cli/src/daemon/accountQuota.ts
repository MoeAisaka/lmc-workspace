import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { configuration } from '@/configuration';
import { AccountQuotaSnapshotSchema, type AccountQuotaSnapshot, type AccountQuotaWindow } from 'lmc-wire';

const settingsPath = () => join(configuration.lmcHomeDir, 'quota-dashboard.json');
export const hasAccountQuotaSource = () => existsSync(settingsPath());
const record = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const percent = (v: unknown) => { const n = finite(v); return n !== null && n >= 0 && n <= 100 ? n : null; };
const timestamp = (v: unknown) => { const n = finite(v); return n !== null && n > 0 ? n * 1000 : null; };
const duration = (v: unknown) => { const n = finite(v); return n !== null && n > 0 ? n : null; };
const plan = (v: unknown) => typeof v === 'string' && /^[a-z0-9 +_-]{1,40}$/i.test(v) ? v : null;

export function projectAccountQuota(raw: unknown, now = Date.now()): AccountQuotaSnapshot {
    const sources = record(record(raw).sources);
    const codexEntry = record(sources.codex_spark), codexData = record(codexEntry.data), codex = record(codexData.codex);
    const claudeEntry = record(sources.claude_usage), claude = record(claudeEntry.data);
    // Polling the dashboard cache does NOT mean the provider was sampled again.
    const codexAt = timestamp(codexData.mtime);
    const claudeAt = timestamp(claudeEntry.last_success_ts);
    const window = (id: AccountQuotaWindow['id'], remaining: unknown, resets: unknown, mins: unknown, pending = false): AccountQuotaWindow =>
        ({ id, remaining: percent(remaining), resetsAt: timestamp(resets), durationMins: duration(mins), pending });
    const credits = record(codex.resetCredits);
    const count = finite(credits.availableCount);
    const expiry = (Array.isArray(credits.credits) ? credits.credits : []).filter((c: any) => c?.status === 'available')
        .map((c: any) => timestamp(c.expiresAt)).filter((n: number | null): n is number => n !== null && n > now);
    const claudeWindows = Array.isArray(claude.windows) ? claude.windows.map(record) : [];
    const find = (kind: string, scope?: string) => claudeWindows.find(w => w.kind === kind && (!scope || String(w.scopeModel).toLowerCase() === scope)) || {};
    const cw = (id: AccountQuotaWindow['id'], kind: string, mins: number, scope?: string) => {
        const row = find(kind, scope);
        return window(id, row.remainingPercent, row.resetsAt, mins);
    };
    return AccountQuotaSnapshotSchema.parse({ providers: [
        { engine: 'codex', plan: null, capturedAt: codexAt, refreshFailed: codexEntry.ok !== true,
            stale: codexData.stale === true || !codexAt || now - codexAt > 65 * 60_000 || codexAt > now + 60_000,
            windows: [window('five_hour', codex.remaining5hPercent, codex.resets5hAt, codex.window5hMins, codex.pending5h === true),
                window('seven_day', codex.remainingWeeklyPercent, codex.resetsWeeklyAt, codex.windowWeeklyMins, codex.pendingWeekly === true)],
            resetCredits: count !== null && Number.isInteger(count) && count >= 0 ? { count, expiresAt: expiry.length ? Math.min(...expiry) : null } : null },
        { engine: 'claude', plan: plan(claude.subscriptionType), capturedAt: claudeAt, refreshFailed: claudeEntry.ok !== true,
            stale: !claudeAt || now - claudeAt > 30 * 60_000 || claudeAt > now + 60_000,
            windows: [cw('five_hour', 'session', 300), cw('seven_day', 'weekly_all', 10080), cw('fable_week', 'weekly_scoped', 10080, 'fable')],
            resetCredits: null },
    ] });
}

async function readSmallJson(path: string) {
    if (!isAbsolute(path) || (await stat(path)).size > 64 * 1024) throw new Error('Invalid quota configuration');
    return JSON.parse(await readFile(path, 'utf8'));
}

/** Only an operator-configured loopback dashboard can be read. RPC callers cannot
 * supply paths, URLs or tokens. The existing credential stays on this device. */
export async function readDashboardQuota(): Promise<AccountQuotaSnapshot> {
    const settings = await readSmallJson(settingsPath());
    const config = await readSmallJson(settings.configPath);
    const port = config.port ?? 19390;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof config.token !== 'string' || !config.token || /[\r\n]/.test(config.token)) throw new Error('Invalid quota configuration');
    const response = await fetch(`http://127.0.0.1:${port}/api/summary`, {
        headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    if (!response.ok || !response.body) throw new Error('Quota source unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4 * 1024 * 1024) throw new Error('Quota response too large');
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); }
    return projectAccountQuota(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export function createAccountQuotaHandler(read = readDashboardQuota) {
    type Reply = { snapshot?: AccountQuotaSnapshot; error?: 'unavailable' };
    let pending: Promise<Reply> | null = null;
    let last: Reply | null = null;
    let at = 0;
    return () => {
        if (last && Date.now() - at < 15_000) return Promise.resolve(last);
        if (pending) return pending;
        pending = read().then(snapshot => ({ snapshot }), () => ({ error: 'unavailable' as const }))
            .then(result => { last = result; at = Date.now(); return result; }).finally(() => { pending = null; });
        return pending;
    };
}
