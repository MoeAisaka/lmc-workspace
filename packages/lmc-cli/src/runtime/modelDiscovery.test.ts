import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    supportedModels: vi.fn(), close: vi.fn(), query: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), listModels: vi.fn(),
    read: vi.fn(), write: vi.fn(), rename: vi.fn(), selection: { value: 'v1' },
}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), rename: mocks.rename, writeFile: mocks.write }));
vi.mock('./modelCatalogCache', () => ({ readModelCatalogs: mocks.read, modelCatalogPath: () => '/test/model-catalogs.json' }));
vi.mock('./managedRuntime', () => ({
    codexExecutable: () => '/selected/codex', runtimeRelease: () => ({ version: mocks.selection.value }),
    readRuntimeSelection: () => mocks.selection.value,
    runtimeVersion: async () => ({ version: '2.1.0', packageVersion: mocks.selection.value }),
    sdkRequire: () => () => ({ query: mocks.query }),
}));
vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: class {
    connect = mocks.connect; disconnect = mocks.disconnect; listModels = mocks.listModels;
} }));
import { discoverModels, normalizeModels, startModelDiscovery } from './modelDiscovery';

beforeEach(() => {
    vi.clearAllMocks(); mocks.selection.value = 'v1'; mocks.read.mockReturnValue({});
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
    it('refreshes both engines, preserves a failed engine, notices upgrades and stops polling', async () => {
        vi.useFakeTimers();
        mocks.read.mockReturnValue({ claude: { models: [{ id: 'old', name: 'Old' }], runtimeVersion: 'v0', capturedAt: 1 } });
        mocks.supportedModels.mockRejectedValue(new Error('offline'));
        const publish = vi.fn().mockResolvedValue(undefined);
        const stop = startModelDiscovery(publish);
        await vi.advanceTimersByTimeAsync(0);
        expect(publish.mock.lastCall?.[0]).toMatchObject({ claude: { stale: true, models: [{id:'old'}] }, codex: { runtimeVersion:'v1',models:[{id:'gpt-next'}] } });
        expect(mocks.rename).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(60_000); expect(mocks.listModels).toHaveBeenCalledTimes(1);
        mocks.selection.value = 'v2'; mocks.supportedModels.mockResolvedValue([{value:'claude-new'}]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(publish.mock.lastCall?.[0].claude).toMatchObject({runtimeVersion:'v2',stale:false,models:[{id:'claude-new'}]});
        stop(); await vi.advanceTimersByTimeAsync(16 * 60_000); expect(mocks.listModels).toHaveBeenCalledTimes(2);
    });
});
