import { describe, expect, it } from 'vitest';
import { isEngineSwitchRequest, isSwitchableEngine, mapPermissionMode } from './engineSwitch';

describe('mapPermissionMode', () => {
    it('carries each mode to the one that lets the agent do the same amount', () => {
        expect(mapPermissionMode('claude', 'codex', 'acceptEdits')).toBe('safe-yolo');
        expect(mapPermissionMode('claude', 'codex', 'plan')).toBe('read-only');
        expect(mapPermissionMode('claude', 'codex', 'bypassPermissions')).toBe('yolo');
        expect(mapPermissionMode('codex', 'claude', 'safe-yolo')).toBe('acceptEdits');
        expect(mapPermissionMode('codex', 'claude', 'read-only')).toBe('plan');
        expect(mapPermissionMode('codex', 'claude', 'yolo')).toBe('bypassPermissions');
    });

    it('round-trips every mode both engines have', () => {
        for (const mode of ['auto', 'acceptEdits', 'plan', 'bypassPermissions', 'default']) {
            const there = mapPermissionMode('claude', 'codex', mode);
            expect(mapPermissionMode('codex', 'claude', there)).toBe(mode);
        }
    });

    it('keeps the two spellings the engines already share', () => {
        expect(mapPermissionMode('claude', 'codex', 'auto')).toBe('auto');
        expect(mapPermissionMode('codex', 'claude', 'default')).toBe('default');
    });

    it('falls back to the stricter default rather than guessing', () => {
        expect(mapPermissionMode('claude', 'codex', 'somethingNew')).toBe('default');
        expect(mapPermissionMode('claude', 'codex', null)).toBe('default');
        expect(mapPermissionMode('claude', 'codex', undefined)).toBe('default');
    });

    it('leaves a mode alone when the engine is not changing', () => {
        expect(mapPermissionMode('codex', 'codex', 'safe-yolo')).toBe('safe-yolo');
    });
});

describe('isEngineSwitchRequest', () => {
    it('accepts a request naming an engine, with or without the optional fields', () => {
        expect(isEngineSwitchRequest({ engine: 'codex' })).toBe(true);
        expect(isEngineSwitchRequest({ engine: 'claude', permissionMode: 'plan', model: 'opus', effort: 'high' })).toBe(true);
    });

    it('refuses anything that is not a switch', () => {
        expect(isEngineSwitchRequest({ engine: 'gemini' })).toBe(false);
        expect(isEngineSwitchRequest({ refreshCli: true })).toBe(false);
        expect(isEngineSwitchRequest({ engine: 'codex', permissionMode: 3 })).toBe(false);
        expect(isEngineSwitchRequest({ engine: 'codex', somethingElse: 'x' })).toBe(false);
        expect(isEngineSwitchRequest(null)).toBe(false);
    });
});

describe('isSwitchableEngine', () => {
    it('names only the two engines a session can move between', () => {
        expect(isSwitchableEngine('claude')).toBe(true);
        expect(isSwitchableEngine('codex')).toBe(true);
        expect(isSwitchableEngine('gemini')).toBe(false);
        expect(isSwitchableEngine(undefined)).toBe(false);
    });
});
