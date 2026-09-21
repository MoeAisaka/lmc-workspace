import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), release: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: mocks.read }));
vi.mock('./managedRuntime', () => ({ runtimeRelease: mocks.release }));
vi.mock('@/configuration', () => ({ configuration: { lmcHomeDir: '/tmp/discovery-test' } }));
import { cachedModel, cachedDefaultEffort, readModelCatalogs } from './modelCatalogCache';
import { CodexRemoteModeState } from '@/codex/remoteModeState';
beforeEach(() => {
    mocks.release.mockReturnValue({version:'9.0.0'});
    mocks.read.mockReturnValue(JSON.stringify({codex:{runtimeVersion:'9.0.0',capturedAt:1,models:[{id:'gpt-future',name:'Future',efforts:['future'],defaultEffort:'future'}]},claude:{runtimeVersion:'9.0.0',capturedAt:1,models:[{id:'claude-basic',name:'Basic',efforts:[]}]}}));
});
describe('runtime catalog consumption', () => {
    it('does not use a newly installed engine catalog in an older pinned runner', () => {
        expect(cachedModel('codex','gpt-future')?.efforts).toEqual(['future']);
        mocks.release.mockReturnValue({version:'8.0.0'});
        expect(cachedModel('codex','gpt-future')).toBeUndefined();
    });
    it('adapts implicit defaults and omits effort for models advertising none', () => {
        expect(cachedDefaultEffort('codex','gpt-future','medium')).toBe('future');
        expect(cachedDefaultEffort('claude','claude-basic','medium')).toBeUndefined();
    });
    it('passes a newly advertised effort through the runner and refuses incompatible values before mutating state', () => {
        const state = new CodexRemoteModeState({permissionMode:'auto',model:'gpt-future'});
        state.resolve({model:'gpt-future',effort:'future'} as any);
        expect(state.currentEffort).toBe('future');
        expect(() => state.resolve({effort:'medium',permissionMode:'yolo'} as any)).toThrow('does not support');
        expect(state.currentPermissionMode).toBe('auto');
        expect(state.currentEffort).toBe('future');
    });
    it('falls back if the cache is missing or malformed', () => {
        mocks.read.mockReturnValue('{broken'); expect(readModelCatalogs()).toEqual({});
        mocks.read.mockImplementation(() => {throw new Error('missing')}); expect(cachedModel('claude','x')).toBeUndefined();
    });
});
