vi.mock('@/agy/modelDiscovery', () => ({ discoverAgyModels: vi.fn().mockRejectedValue(new Error('not installed')) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./poe', () => ({ readPoeSettings: () => null, fetchPoeJson: vi.fn() }));
const mocks = vi.hoisted(() => ({
    supportedModels: vi.fn(), close: vi.fn(), query: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), listModels: vi.fn(),
    read: vi.fn(), write: vi.fn(), rename: vi.fn(), selection: { claude: 'v1', codex: 'v1' },
}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), rename: mocks.rename, writeFile: mocks.write }));
vi.mock('./modelCatalogCache', () => ({ readModelCatalogs: mocks.read, modelCatalogPath: () => '/test/model-catalogs.json' }));
vi.mock('./managedRuntime', () => ({
    codexExecutable: () => '/selected/codex', runtimeRelease: (engine: 'claude' | 'codex') => ({ version: mocks.selection[engine] }),
    runtimeVersion: async (engine: 'claude' | 'codex') => ({ version: '2.1.0', packageVersion: mocks.selection[engine] }),
    sdkRequire: () => () => ({ query: mocks.query }),
}));
vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: class {
    connect = mocks.connect; disconnect = mocks.disconnect; listModels = mocks.listModels;
} }));
import { discoverModels, normalizeModels, startModelDiscovery } from './modelDiscovery';

beforeEach(() => {
    vi.clearAllMocks(); mocks.selection.claude = 'v1'; mocks.selection.codex = 'v1'; mocks.read.mockReturnValue({});
    mocks.query.mockReturnValue({ supportedModels: mocks.supportedModels, close: mocks.close });
    mocks.supportedModels.mockResolvedValue([{ value: 'claude-next', displayName: 'Next', supportedEffortLevels: ['future'] }]);
    mocks.listModels.mockResolvedValue([{ model: 'gpt-next', supportedReasoningEfforts: [{ reasoningEffort: 'future' }] }]);
});
afterEach(() => vi.useRealTimers());
describe('model discovery', () => {
    it('normalizes aliases and rejects malformed rows without dropping valid models', () => {
        expect(normalizeModels('claude', [null, {}, { value: 'opus', resolvedModel: 'claude-next', displayName: 'Next', supportsEffort: false }, { value: 'default', resolvedModel: 'claude-next', displayName: 'Next', supportsEffort: false }])).toEqual([
            { id: 'claude-next', name: 'Next', aliases: ['opus', 'default'], efforts: [] },
        ]);
        expect(normalizeModels('codex', [{model:'new', supportedReasoningEfforts:[null]}, {model:'valid', supportedReasoningEfforts:[{reasoningEffort:'future'}]}]).map(m=>m.id)).toEqual(['valid']);
    });
    it.each(['claude', 'codex'] as const)('discovers %s without a model turn and closes the discovery process', async engine => {
        expect((await discoverModels(engine))[0].efforts).toEqual(['future']);
        expect(engine === 'claude' ? mocks.close : mocks.disconnect).toHaveBeenCalledOnce();
        if (engine === 'claude') expect(mocks.query.mock.calls[0][0].options.persistSession).toBe(false);
    });
    it('bounds a hung Claude control request even if abort does not settle it', async () => {
        vi.useFakeTimers(); mocks.supportedModels.mockReturnValue(new Promise(() => {}));
        const result = expect(discoverModels('claude')).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(20_000); await result;
        expect(mocks.close).toHaveBeenCalledOnce();
    });
    it('does not let a delayed cached publication overwrite a fresh discovery', async () => {
        vi.useFakeTimers();
        let release!: () => void;
        const publish = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
        const stop = startModelDiscovery(publish);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.rename).toHaveBeenCalledOnce();
        expect(publish).toHaveBeenCalledTimes(1);
        release(); await vi.advanceTimersByTimeAsync(0);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.lastCall?.[0].codex.models[0].id).toBe('gpt-next');
        stop();
    });
    it('never starts Claude on idle ticks or runtime upgrades, while Codex keeps refreshing', async () => {
        vi.useFakeTimers();
        const cachedClaude = { models: [{ id: 'old', name: 'Old' }], runtimeVersion: 'v0', capturedAt: 1 };
        mocks.read.mockReturnValue({ claude: cachedClaude });
        const publish = vi.fn().mockResolvedValue(undefined);
        const stop = startModelDiscovery(publish);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.listModels).toHaveBeenCalledOnce();
        expect(mocks.query).not.toHaveBeenCalled();
        expect(publish.mock.lastCall?.[0].claude).toEqual(cachedClaude);
        mocks.selection.claude = 'v2';
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.listModels).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(29 * 60_000);
        expect(mocks.listModels).toHaveBeenCalledTimes(3);
        expect(mocks.query).not.toHaveBeenCalled();
        mocks.selection.codex = 'v2';
        await vi.advanceTimersByTimeAsync(60_000);
        expect(publish.mock.lastCall?.[0].codex.runtimeVersion).toBe('v2');
        expect(mocks.listModels).toHaveBeenCalledTimes(4);
        stop(); await vi.advanceTimersByTimeAsync(16 * 60_000);
        expect(mocks.listModels).toHaveBeenCalledTimes(4);
        expect(mocks.query).not.toHaveBeenCalled();
    });
    it('refreshes Claude once for live session demand, including a restart or switch back', async () => {
        vi.useFakeTimers();
        let sessions: string[] = [];
        const publish = vi.fn().mockResolvedValue(undefined);
        const stop = startModelDiscovery(publish, () => sessions);
        await vi.advanceTimersByTimeAsync(0);
        sessions = ['first:100', 'second:200'];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.query).toHaveBeenCalledOnce();
        expect(publish.mock.lastCall?.[0].claude).toMatchObject({runtimeVersion:'v1',stale:false,models:[{id:'claude-next'}]});
        mocks.selection.claude = 'v2';
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(mocks.query).toHaveBeenCalledOnce();
        sessions = ['first:101', 'second:200'];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.query).toHaveBeenCalledTimes(2);
        expect(publish.mock.lastCall?.[0].claude.runtimeVersion).toBe('v2');
        sessions = [];
        await vi.advanceTimersByTimeAsync(60_000);
        sessions = ['first:101'];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.query).toHaveBeenCalledTimes(3);
        stop();
    });
    it('preserves a failed Claude catalog without periodic retries; new demand can retry', async () => {
        vi.useFakeTimers();
        mocks.read.mockReturnValue({ claude: { models: [{ id: 'old', name: 'Old' }], runtimeVersion: 'v0', capturedAt: 1 } });
        mocks.supportedModels.mockRejectedValue(new Error('offline'));
        let sessions = ['first:100'];
        const publish = vi.fn().mockResolvedValue(undefined);
        const stop = startModelDiscovery(publish, () => sessions);
        await vi.advanceTimersByTimeAsync(0);
        expect(publish.mock.lastCall?.[0]).toMatchObject({ claude: { stale: true, models: [{id:'old'}] }, codex: { runtimeVersion:'v1',models:[{id:'gpt-next'}] } });
        expect(mocks.rename).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(mocks.query).toHaveBeenCalledOnce();
        mocks.selection.claude = 'v2'; mocks.supportedModels.mockResolvedValue([{value:'claude-new'}]);
        sessions = ['second:200'];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(publish.mock.lastCall?.[0].claude).toMatchObject({runtimeVersion:'v2',stale:false,models:[{id:'claude-new'}]});
        expect(mocks.query).toHaveBeenCalledTimes(2);
        stop();
    });
    it('retains Claude demand that arrives during a slow Codex refresh', async () => {
        vi.useFakeTimers();
        let finish!: (models: unknown[]) => void;
        mocks.listModels.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        let sessions: string[] = [];
        const stop = startModelDiscovery(vi.fn().mockResolvedValue(undefined), () => sessions);
        await vi.advanceTimersByTimeAsync(0);
        sessions = ['first:100'];
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.query).not.toHaveBeenCalled();
        finish([{model:'gpt-next'}]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.query).toHaveBeenCalledOnce();
        stop();
    });
});
