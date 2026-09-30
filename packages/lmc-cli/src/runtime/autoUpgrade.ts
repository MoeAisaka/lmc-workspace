import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Engine, RuntimeSelection } from './managedRuntime';
import type { UpgradeJob } from './upgradeManager';

/**
 * Engines follow their upstream releases on their own. A new model only shows
 * up in the list once the engine that serves it is installed, and upgrades were
 * started by hand, so a release could sit unnoticed for days.
 *
 * Only engines the Agent already manages are touched: a machine that pins its
 * own engine (the company node runs a fixed Codex against an internal gateway)
 * has no entry in the selection and is left alone. One upgrade runs at a time,
 * and a version that failed once is not retried automatically — a newer
 * release or a manual upgrade moves it on.
 */
export const AUTO_UPGRADE = { firstCheckMs: 10 * 60_000, intervalMs: 6 * 60 * 60_000, busyRetryMs: 10 * 60_000 } as const;
const ENGINES: Engine[] = ['codex', 'claude'];

export type AutoUpgradeDeps = {
    selection(): RuntimeSelection;
    latest(engine: Engine): Promise<string>;
    job(): Promise<UpgradeJob | undefined>;
    start(engine: Engine): Promise<unknown>;
    /** Where the versions already tried are remembered, across daemon restarts. */
    stateFile: string;
};
type Attempts = Partial<Record<Engine, string>>;

/** a > b for plain x.y.z versions; a pre-release is never taken as newer. */
export function isNewerVersion(a: string, b: string): boolean {
    if (!/^\d+\.\d+\.\d+$/.test(a)) return false;
    const pa = a.split('.').map(Number);
    const pb = b.split(/[.-]/).slice(0, 3).map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] > (pb[i] || 0);
    }
    return false;
}

async function readAttempts(file: string): Promise<Attempts> {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}
async function writeAttempts(file: string, value: Attempts) {
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
}

/**
 * One pass: starts at most one engine upgrade. Returns the engine started,
 * 'busy' when another upgrade is still handing sessions over (the caller asks
 * again soon rather than at the next long interval), or null.
 */
export async function checkEngineUpgrades(deps: AutoUpgradeDeps): Promise<Engine | 'busy' | null> {
    const job = await deps.job();
    if (job && ['installing', 'activating', 'refreshing'].includes(job.state)) return 'busy';
    const selection = deps.selection();
    const attempts = await readAttempts(deps.stateFile);
    for (const engine of ENGINES) {
        const current = selection[engine];
        if (!current) continue;
        let latest: string;
        try { latest = await deps.latest(engine); } catch { continue; }
        if (!isNewerVersion(latest, current.version) || attempts[engine] === latest) continue;
        await writeAttempts(deps.stateFile, { ...attempts, [engine]: latest });
        try { await deps.start(engine); } catch { continue; }
        return engine;
    }
    return null;
}
