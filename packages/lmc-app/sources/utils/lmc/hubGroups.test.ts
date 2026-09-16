import { vi, describe, expect, it } from 'vitest';
// The grouping module reports through the translation layer, and i18n reads
// stored settings when it loads.
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
import { splitHubGroups } from './hubGroups';

const session = (id: string, createdAt: number, orchestration?: any, extra: any = {}) => ({
    id, createdAt, updatedAt: createdAt, seq: 0, active: true, activeAt: createdAt, presence: 'online', thinking: false, thinkingAt: 0,
    metadata: { path: '/p', host: 'h', name: 'n', flavor: 'claude', orchestration, ...extra }, agentState: null, metadataVersion: 1, agentStateVersion: 1,
} as any);

describe('splitHubGroups', () => {
    it('groups a hub with the workers that both sides agree on, and leaves the rest to the device list', () => {
        const hub = session('H', 1, { role: 'hub', workers: [{ sessionId: 'W1', boundAt: 1, by: 'manual' }, { sessionId: 'W2', boundAt: 1, by: 'manual' }, { sessionId: 'GHOST', boundAt: 1, by: 'manual' }] });
        const w1 = session('W1', 3, { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'manual' } });
        const w2 = session('W2', 2, { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'manual' } });
        // Points at H, but H does not list it: not bound.
        const half = session('HALF', 4, { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'manual' } });
        const plain = session('P', 5);
        const { hubs, rest } = splitHubGroups([plain, w1, hub, half, w2]);
        expect(hubs).toHaveLength(1);
        expect(hubs[0].hub.id).toBe('H');
        expect(hubs[0].workers.map((w) => w.id)).toEqual(['W2', 'W1']);
        expect(rest.map((s) => s.id).sort()).toEqual(['HALF', 'P']);
    });

    it('drops archived hubs and workers out of the layer', () => {
        const hub = session('H', 1, { role: 'hub', workers: [{ sessionId: 'W', boundAt: 1, by: 'auto' }] }, { lifecycleState: 'archived' });
        const w = session('W', 2, { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } });
        const { hubs, rest } = splitHubGroups([hub, w]);
        expect(hubs).toHaveLength(0);
        expect(rest.map((s) => s.id)).toEqual(['H', 'W']);
    });

    it('orders hub groups by the saved order, falling any unlisted hub in behind by createdAt', () => {
        const h1 = session('H1', 1, { role: 'hub', workers: [] });
        const h2 = session('H2', 2, { role: 'hub', workers: [] });
        const h3 = session('H3', 3, { role: 'hub', workers: [] });
        // Saved order puts the newest first; H3 has no saved position and
        // keeps falling in after the ones that do, by createdAt.
        const { hubs } = splitHubGroups([h1, h2, h3], ['H2', 'H1']);
        expect(hubs.map((g) => g.hub.id)).toEqual(['H2', 'H1', 'H3']);
    });

    it('falls back to createdAt order when nothing is saved', () => {
        const h2 = session('H2', 2, { role: 'hub', workers: [] });
        const h1 = session('H1', 1, { role: 'hub', workers: [] });
        const { hubs } = splitHubGroups([h2, h1], null);
        expect(hubs.map((g) => g.hub.id)).toEqual(['H1', 'H2']);
    });
});
