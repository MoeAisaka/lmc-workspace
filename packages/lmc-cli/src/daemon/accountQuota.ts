import { readAgyQuota, unavailableAgy } from './antigravityQuota';
import { readCodexCredits } from './codexCredits';
import { createQuotaBackground } from './quotaBackground';
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
    const reserve = record(codexData.reserve);
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
            supplemental: reserve.present === true ? {
                remaining: percent(reserve.remainingWeeklyPercent), capturedAt: codexAt,
                resetsAt: timestamp(reserve.resetsWeeklyAt), pending: reserve.pendingWeekly === true,
                stale: codexEntry.ok !== true || codexData.stale === true || !codexAt || now - codexAt > 65 * 60_000 || codexAt > now + 60_000,
            } : null,
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
async function readDashboardSources(settings: Record<string, any>): Promise<AccountQuotaSnapshot> {
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
    const snapshot = projectAccountQuota(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return snapshot;
}

/** Explicit enablement is independent of collection failures. Missing configuration keeps legacy behavior. */
export function applyQuotaConfiguration(snapshot: AccountQuotaSnapshot, providers: unknown): AccountQuotaSnapshot {
    const configured = record(providers);
    return { providers: snapshot.providers.filter(p => record(configured[p.engine]).enabled !== false).map(p => ({
        ...p, plan: plan(record(configured[p.engine]).plan) ?? p.plan,
    })) };
}
export function createDashboardQuotaReader(
    readSettings = () => readSmallJson(settingsPath()),
    readDashboard = readDashboardSources,
    readCredits = readCodexCredits,
    readAgy = readAgyQuota,
) {
    const staleDashboard = (previous?: AccountQuotaSnapshot) => ({
        providers: (previous ?? projectAccountQuota(null)).providers.map(p => ({ ...p, stale: true, refreshFailed: true })),
    });
    let settingsKey = '';
    let dashboardCache = createQuotaBackground<AccountQuotaSnapshot>(15_000, staleDashboard);
    const creditsCache = createQuotaBackground<Awaited<ReturnType<typeof readCredits>>>(60_000,
        previous => previous ? { ...previous, stale: true } : null);
    const agyCache = createQuotaBackground<Awaited<ReturnType<typeof readAgy>>>(
        previous => previous?.status === 'ready' ? 300_000 : 30_000,
        () => unavailableAgy('unavailable'));
    return async (force = false): Promise<AccountQuotaSnapshot> => {
        // Fail closed before probing anything if this device is not a source.
        const settings = await readSettings();
        const nextKey = JSON.stringify(settings);
        if (nextKey !== settingsKey) {
            settingsKey = nextKey;
            dashboardCache = createQuotaBackground<AccountQuotaSnapshot>(15_000, staleDashboard);
        }
        const agyEnabled = record(record(settings.providers).agy).enabled === true;
        const codexEnabled = record(record(settings.providers).codex).enabled !== false;
        const [dashboard, credits, agy] = await Promise.all([
            dashboardCache(() => readDashboard(settings), force),
            codexEnabled ? creditsCache(readCredits) : Promise.resolve({ value: null, refreshing: false }),
            agyEnabled ? agyCache(() => readAgy(force), force) : Promise.resolve({ value: undefined, refreshing: false }),
        ]);
        const combined: AccountQuotaSnapshot = {
            providers: (dashboard.value ?? projectAccountQuota(null)).providers.map(p =>
                p.engine === 'codex' ? { ...p, usageCredits: credits.value ?? null,
                    ...(!credits.value?.stale && credits.value?.windows?.length ? { windows: credits.value.windows, capturedAt: credits.value.capturedAt, stale: false, refreshFailed: false } : {}) } : p),
            refreshing: dashboard.refreshing || credits.refreshing || agy.refreshing,
        };
        if (agyEnabled) combined.providers.push(agy.value ?? {
            ...unavailableAgy(undefined), checkedAt: undefined, refreshFailed: false,
        });
        return { ...applyQuotaConfiguration(combined, settings.providers), refreshing: combined.refreshing };
    };
}
export const readDashboardQuota = createDashboardQuotaReader();

export function createAccountQuotaHandler(read = readDashboardQuota) {
    type Reply = { snapshot?: AccountQuotaSnapshot; error?: 'unavailable' };
    let pending: Promise<Reply> | null = null;
    let last: Reply | null = null;
    let at = 0;
    return (options?: { force?: boolean }) => {
        const force = options?.force === true;
        if (!force && last && Date.now() - at < (last.snapshot?.refreshing ? 1_000 : 15_000)) return Promise.resolve(last);
        if (pending) return pending;
        pending = read(force).then(snapshot => ({ snapshot }), () => ({ error: 'unavailable' as const }))
            .then(result => { last = result; at = Date.now(); return result; }).finally(() => { pending = null; });
        return pending;
    };
}
