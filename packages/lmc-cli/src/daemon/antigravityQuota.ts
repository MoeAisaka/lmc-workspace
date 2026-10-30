import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import type { AccountQuotaProvider, AccountQuotaWindow } from 'lmc-wire';
import { findAgyBin } from '../agy/constants';

const execute = promisify(execFile);
const obj = (v: any): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
export function unavailableAgy(status: AccountQuotaProvider['status'], now = Date.now()): AccountQuotaProvider {
    return { engine: 'agy', plan: null, status, checkedAt: now, capturedAt: null, stale: true, refreshFailed: true, windows: [], groups: [], resetCredits: null };
}
/** Project only recognized quota pools. Never send account/project IDs or raw errors. */
export function projectAgyQuota(raw: unknown, now = Date.now()): AccountQuotaProvider {
    const root = obj(raw), command = obj(root.command), data = obj(command.data);
    if (root.status !== 'SUCCESS') {
        const error = typeof root.error === 'string' ? root.error.toLowerCase() : '';
        return unavailableAgy(/not.*available.*location|region|eligibility/.test(error) ? 'region_restricted' : /sign in|not authenticated|unauthenticated/.test(error) ? 'sign_in_required' : 'unavailable', now);
    }
    if (!['usage', 'quota'].includes(command.name) || root.num_turns !== 0 || !Array.isArray(data.groups)) return unavailableAgy('unavailable', now);
    const groups: NonNullable<AccountQuotaProvider['groups']> = [];
    for (const value of data.groups) {
        const group = obj(value);
        const id = group.name === 'Gemini Models' ? 'gemini' : group.name === 'Claude and GPT models' ? 'claude_gpt' : null;
        if (!id || groups.some(g => g.id === id) || !Array.isArray(group.buckets)) continue;
        const windows: AccountQuotaWindow[] = [];
        for (const value of group.buckets) {
            const bucket = obj(value);
            const wid = bucket.window === 'weekly' ? 'seven_day' : bucket.window === '5h' ? 'five_hour' : null;
            if (!wid || windows.some(w => w.id === wid)) continue;
            const fraction = bucket.remaining_fraction;
            const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN;
            windows.push({ id: wid, remaining: typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction * 100 : null,
                resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null, durationMins: wid === 'five_hour' ? 300 : 10080, pending: false });
        }
        if (windows.length) groups.push({ id, windows });
    }
    if (!groups.length) return unavailableAgy('unavailable', now);
    return { ...unavailableAgy('ready', now), capturedAt: now, stale: false, refreshFailed: false, groups };
}

/** Opt-in, serialized, five-minute cache. Native read-only command; no credential access. */
export function createAgyQuotaReader(run = async (): Promise<unknown> => {
    const binary = findAgyBin();
    if (!binary) return { status: 'NOT_INSTALLED' };
    const options = { cwd: tmpdir(), timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' as const };
    // models fails closed when signed out, unlike starting the interactive CLI.
    try { await execute(binary, ['models'], options); }
    catch (error: any) { return { status: 'ERROR', error: /sign in|not authenticated/i.test(String(error.stderr)) ? 'sign in required' : '' }; }
    try { return JSON.parse((await execute(binary, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '15s'], options)).stdout); }
    catch (error: any) { try { return JSON.parse(error.stdout); } catch { return { status: 'ERROR' }; } }
}) {
    let cached: AccountQuotaProvider | null = null, at = 0, pending: Promise<AccountQuotaProvider> | null = null;
    return () => {
        if (cached && Date.now() - at < 300_000) return Promise.resolve(cached);
        if (pending) return pending;
        pending = run().then(raw => obj(raw).status === 'NOT_INSTALLED' ? unavailableAgy('not_installed') : projectAgyQuota(raw), () => unavailableAgy('unavailable'))
            .then(result => { cached = result; at = Date.now(); return result; }).finally(() => { pending = null; });
        return pending;
    };
}
export const readAgyQuota = createAgyQuotaReader();
