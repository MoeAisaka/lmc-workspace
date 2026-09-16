import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { applyWorkerConfig, configAsMeta, configDirectives, formatConfigMail, isConfigMail, watchSessionConfiguration } from './workerConfig';
import { CodexRemoteModeState } from '@/codex/remoteModeState';

describe('worker config', () => {
    it('ignores a failed in-flight configuration after its watcher has stopped', async () => {
        const events = new EventEmitter();
        const sendSessionEvent = vi.fn();
        const requestHubDecision = vi.fn();
        let reject!: (error: Error) => void;
        const stop = watchSessionConfiguration(Object.assign(events, {
            getMetadata: () => ({ flavor: 'codex', permissionMode: 'yolo' }), sendSessionEvent, requestHubDecision,
        }) as any, 'codex', () => new Promise<void>((_, fail) => { reject = fail; }));
        stop();
        reject(new Error('old runner closed'));
        await Promise.resolve(); await Promise.resolve();
        expect(sendSessionEvent).not.toHaveBeenCalled();
        expect(requestHubDecision).not.toHaveBeenCalled();
    });

    it('retries only failed configuration fields on a later metadata event', async () => {
        const events = new EventEmitter();
        const metadata = { flavor: 'codex', permissionMode: 'auto', modelMode: 'gpt-6-astra' };
        const apply = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValue(undefined);
        const stop = watchSessionConfiguration(Object.assign(events, { getMetadata: () => metadata, sendSessionEvent: vi.fn() }) as any, 'codex', apply);
        await Promise.resolve();
        events.emit('metadata', { ...metadata, permissionMode: 'yolo' });
        await Promise.resolve(); await Promise.resolve();
        events.emit('metadata', { ...metadata, permissionMode: 'yolo' });
        expect(apply).toHaveBeenLastCalledWith({ permissionMode: 'yolo' });
        expect(apply).toHaveBeenCalledTimes(3);
        stop();
    });
    it('does not lose a permission failure behind an unrelated newer model update', async () => {
        const events = new EventEmitter();
        const metadata = { flavor: 'codex', permissionMode: 'auto', modelMode: 'gpt-6-astra' };
        let reject!: (error: Error) => void;
        const apply = vi.fn().mockResolvedValueOnce(undefined)
            .mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
            .mockResolvedValue(undefined);
        const sendSessionEvent = vi.fn();
        const stop = watchSessionConfiguration(Object.assign(events, { getMetadata: () => metadata, sendSessionEvent }) as any, 'codex', apply);
        events.emit('metadata', { ...metadata, permissionMode: 'yolo' });
        const newer = { ...metadata, permissionMode: 'yolo', modelMode: 'custom-endpoint' };
        events.emit('metadata', newer);
        reject(new Error('permission setter failed'));
        await Promise.resolve(); await Promise.resolve();
        expect(sendSessionEvent).toHaveBeenCalledTimes(1);
        events.emit('metadata', newer);
        expect(apply).toHaveBeenLastCalledWith({ permissionMode: 'yolo' });
        stop();
    });
    it('rejects unsupported permission directives instead of leaving the runner silently on its old full mode', () => {
        const metadata = { flavor: 'codex', permissionMode: 'yolo', orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } } } as any;
        expect(() => applyWorkerConfig(metadata, configDirectives('permission=plan'))).toThrow('not supported');
        expect(applyWorkerConfig(metadata, configDirectives('permission=bypassPermissions'))).toMatchObject({ permissionMode: 'yolo', permissionModeSource: 'explicit' });
        expect(applyWorkerConfig({ ...metadata, flavor: 'claude' }, configDirectives('permission=auto'))).toMatchObject({ permissionMode: 'auto', permissionModeSource: 'explicit' });
    });
    it('updates Codex from control metadata without reapplying unrelated old model fields', () => {
        const events = new EventEmitter();
        const state = new CodexRemoteModeState({ permissionMode: 'auto', model: 'gpt-6-astra', effort: 'medium' });
        const metadata = { flavor: 'codex', permissionMode: 'auto', modelMode: 'gpt-6-astra', effortLevel: 'medium' };
        const stop = watchSessionConfiguration(Object.assign(events, { getMetadata: () => metadata, sendSessionEvent: vi.fn() }) as any, 'codex', patch => {
            state.resolve({ ...(patch.permissionMode ? { permissionMode: patch.permissionMode } : {}),
                ...(patch.modelMode !== undefined ? { model: patch.modelMode } : {}), ...(patch.effortLevel !== undefined ? { effort: patch.effortLevel as any } : {}) });
        });
        state.resolve({ model: 'custom-endpoint', effort: 'high' });
        events.emit('metadata', { ...metadata, permissionMode: 'yolo' });
        expect(state.currentPermissionMode).toBe('yolo');
        expect(state.currentModel).toBe('custom-endpoint');
        expect(state.currentEffort).toBe('high');
        stop();
        events.emit('metadata', { ...metadata, permissionMode: 'default' });
        expect(state.currentPermissionMode).toBe('yolo');
    });

    it('reads model, effort and permission directives from a run line or a config mail', () => {
        expect(configDirectives('worker_default=full')).toEqual({ workerDefault: true });
        expect(configDirectives('Sonnet, quick pass · model=claude-sonnet-5 effort=high')).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
        const mail = formatConfigMail('W1', { model: 'gpt-5.6-sol', effort: 'medium', permissionMode: 'yolo' });
        expect(isConfigMail(mail)).toBe(true);
        expect(configDirectives(mail)).toEqual({ model: 'gpt-5.6-sol', effort: 'medium', permissionMode: 'yolo' });
        expect(configAsMeta({ effort: 'low' })).toEqual({ effort: 'low' });
        expect(isConfigMail('[task t1 · attempt 1]\ngoal x')).toBe(false);
        expect(configDirectives('nothing here')).toEqual({});
    });
});
