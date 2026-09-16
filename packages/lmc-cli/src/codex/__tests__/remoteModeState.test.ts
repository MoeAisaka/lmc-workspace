import { describe, expect, it } from 'vitest';

import { CodexRemoteModeState } from '../remoteModeState';

describe('CodexRemoteModeState', () => {
    it('uses the exact launch permission, model, and effort before any app override', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve(undefined)).toMatchObject({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
            permission: { kind: 'retained' },
            modelResolution: { kind: 'retained' },
            effortResolution: { kind: 'retained' },
        });
    });

    it('applies permission, model, and effort switches together mid-session', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve({
            permissionMode: 'auto',
            model: 'gpt-5.6-terra',
            effort: 'max',
        })).toMatchObject({
            permissionMode: 'auto',
            model: 'gpt-5.6-terra',
            effort: 'max',
            permission: { kind: 'updated' },
            modelResolution: { kind: 'updated' },
            effortResolution: { kind: 'updated' },
        });
        expect(state.currentPermissionModeExplicitlySet).toBe(true);
    });

    it('keeps model and effort sticky during the abort safety reset', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });
        state.resolve({
            permissionMode: 'yolo',
            model: 'gpt-5.6-luna',
            effort: 'high',
        });

        state.resetAfterAbort();

        expect(state.currentPermissionMode).toBe('safe-yolo');
        expect(state.currentPermissionModeExplicitlySet).toBe(false);
        expect(state.currentModel).toBe('gpt-5.6-luna');
        expect(state.currentEffort).toBe('high');
    });

    it('restores all app-selected values on the first message after abort', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'safe-yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });
        const stickySelection = {
            permissionMode: 'yolo' as const,
            model: 'gpt-5.6-terra',
            effort: 'max',
        };
        state.resolve(stickySelection);
        state.resetAfterAbort();

        expect(state.resolve(stickySelection)).toMatchObject({
            permissionMode: 'yolo',
            model: 'gpt-5.6-terra',
            effort: 'max',
        });
        expect(state.currentPermissionModeExplicitlySet).toBe(true);
    });

    it('resets explicit null model and effort without changing permission', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'auto',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve({ model: null, effort: null })).toMatchObject({
            permissionMode: 'auto',
            model: undefined,
            effort: undefined,
        });
    });

    it('rejects invalid remote values without poisoning sticky state', () => {
        const state = new CodexRemoteModeState({
            permissionMode: 'yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });

        expect(state.resolve({
            permissionMode: 'plan',
            model: 'custom-model',
            effort: 'impossible',
        })).toMatchObject({
            permissionMode: 'yolo',
            model: 'custom-model',
            effort: 'medium',
            permission: { kind: 'ignored', incoming: 'plan' },
            effortResolution: { kind: 'ignored', incoming: 'impossible' },
        });
    });
    it.each(['none', 'minimal', 'impossible'])('rejects Astra effort %s before changing any session state', (effort) => {
        const state = new CodexRemoteModeState({ permissionMode: 'auto', model: 'gpt-5.6-sol', effort: 'high' });
        expect(() => state.resolve({ model: 'gpt-6-astra', effort, permissionMode: 'yolo' }))
            .toThrow(/gpt-6-astra.*reasoning effort/);
        expect(state.resolve(undefined)).toMatchObject({ permissionMode: 'auto', model: 'gpt-5.6-sol', effort: 'high' });
        expect(state.currentPermissionModeExplicitlySet).toBe(false);
    });

    it('rejects an incompatible inherited effort on model-only switch, then accepts correction', () => {
        const state = new CodexRemoteModeState({ permissionMode: 'auto', model: 'custom-model', effort: 'minimal' });
        expect(() => state.resolve({ model: 'gpt-6-astra' })).toThrow(/reasoning effort/);
        expect(state.currentModel).toBe('custom-model');
        expect(state.resolve({ model: 'gpt-6-astra', effort: 'high' })).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
    });

    it('rejects incompatible launch settings', () => {
        expect(() => new CodexRemoteModeState({ permissionMode: 'auto', model: 'gpt-6-astra', effort: 'none' }))
            .toThrow(/reasoning effort/);
    });

    it('does not carry ultra into Luna', () => {
        const state = new CodexRemoteModeState({ permissionMode: 'auto', model: 'gpt-6-astra', effort: 'ultra' });
        expect(() => state.resolve({ model: 'gpt-5.6-luna' })).toThrow(/reasoning effort/);
        expect(state.currentModel).toBe('gpt-6-astra');
    });

    it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)('retains Astra %s across abort and omitted metadata', (effort) => {
        const state = new CodexRemoteModeState({ permissionMode: 'auto', model: 'gpt-6-astra', effort });
        state.resolve({ permissionMode: 'yolo' });
        state.resetAfterAbort();
        expect(state.resolve(undefined)).toMatchObject({ model: 'gpt-6-astra', effort, permissionMode: 'auto' });
    });

    it('permits explicit effort reset during a model switch and preserves unknown-model semantics', () => {
        const state = new CodexRemoteModeState({ permissionMode: 'auto', model: 'custom-model', effort: 'minimal' });
        expect(state.resolve({ model: 'gpt-6-astra', effort: null })).toMatchObject({ model: 'gpt-6-astra', effort: undefined });
        expect(state.resolve({ model: 'custom-model', effort: 'minimal' })).toMatchObject({ model: 'custom-model', effort: 'minimal' });
    });

});