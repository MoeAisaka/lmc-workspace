import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkEngineUpgrades, isNewerVersion, type AutoUpgradeDeps } from './autoUpgrade';

const release = (engine: 'codex' | 'claude', version: string) => ({ engine, version, directory: `/r/${engine}-${version}` });
async function deps(over: Partial<AutoUpgradeDeps> = {}): Promise<AutoUpgradeDeps & { start: ReturnType<typeof vi.fn> }> {
    const dir = await mkdtemp(join(tmpdir(), 'lmc-auto-upgrade-'));
    return {
        selection: () => ({ codex: release('codex', '0.156.1'), claude: release('claude', '0.3.280') }),
        latest: async (engine) => (engine === 'codex' ? '0.159.1' : '0.3.280'),
        job: async () => undefined,
        start: vi.fn(async () => ({})),
        stateFile: join(dir, 'auto-upgrade.json'),
        ...over,
    } as AutoUpgradeDeps & { start: ReturnType<typeof vi.fn> };
}

describe('isNewerVersion', () => {
    it('compares numerically and never prefers a pre-release', () => {
        expect(isNewerVersion('0.159.1', '0.156.1')).toBe(true);
        expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
        expect(isNewerVersion('0.156.1', '0.156.1')).toBe(false);
        expect(isNewerVersion('0.155.0', '0.156.1')).toBe(false);
        expect(isNewerVersion('0.160.0-alpha.1', '0.159.1')).toBe(false);
    });
});

describe('checkEngineUpgrades', () => {
    it('starts an upgrade for a managed engine with a newer release', async () => {
        const d = await deps();
        expect(await checkEngineUpgrades(d)).toBe('codex');
        expect(d.start).toHaveBeenCalledWith('codex');
    });

    it('leaves an engine the machine pins itself alone', async () => {
        const d = await deps({ selection: () => ({}) });
        expect(await checkEngineUpgrades(d)).toBeNull();
        expect(d.start).not.toHaveBeenCalled();
    });

    it('waits while another upgrade is running', async () => {
        const d = await deps({ job: async () => ({ id: 'j', engine: 'agent', state: 'refreshing', updatedAt: 0, sessions: [] }) });
        expect(await checkEngineUpgrades(d)).toBe('busy');
        expect(d.start).not.toHaveBeenCalled();
    });

    it('does not retry a version it already tried, but takes the next one', async () => {
        const d = await deps();
        await checkEngineUpgrades(d);
        d.start.mockClear();
        expect(await checkEngineUpgrades(d)).toBeNull();
        expect(d.start).not.toHaveBeenCalled();
        const next = await deps({ stateFile: d.stateFile, latest: async (e) => (e === 'codex' ? '0.160.0' : '0.3.280') });
        expect(await checkEngineUpgrades(next)).toBe('codex');
    });

    it('moves on to the next engine when the registry cannot be reached', async () => {
        const d = await deps({ latest: async (e) => { if (e === 'codex') throw new Error('offline'); return '0.3.281'; } });
        expect(await checkEngineUpgrades(d)).toBe('claude');
    });
});
