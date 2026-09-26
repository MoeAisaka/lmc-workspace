import { describe, expect, it } from 'vitest';
import { readFallbackBriefing, readSwitchEngine, readSwitchSettings } from './engineSwitchRequest';

describe('readSwitchEngine', () => {
    it('reads a request that names an engine', () => {
        expect(readSwitchEngine({ engine: 'codex' })).toBe('codex');
        expect(readSwitchEngine({ engine: 'claude', permissionMode: 'plan' })).toBe('claude');
    });

    it('leaves the plain refresh both runners already handle alone', () => {
        expect(readSwitchEngine({ refreshCli: true })).toBeNull();
    });

    it('refuses an engine no session can switch to', () => {
        expect(readSwitchEngine({ engine: 'gemini' })).toBeNull();
    });

    it('refuses a request carrying anything it does not understand', () => {
        expect(readSwitchEngine({ engine: 'codex', refreshCli: true })).toBeNull();
        expect(readSwitchEngine({ engine: 'codex', permissionMode: 7 })).toBeNull();
    });

    it('refuses what is not a request at all', () => {
        expect(readSwitchEngine(null)).toBeNull();
        expect(readSwitchEngine('codex')).toBeNull();
    });
});

describe('readFallbackBriefing', () => {
    it('takes the briefing that arrives with the request', () => {
        expect(readFallbackBriefing({ engine: 'codex', fallbackBriefing: '## Goal\nShip it' })).toBe('## Goal\nShip it');
    });

    it('treats an absent or empty briefing as none', () => {
        expect(readFallbackBriefing({ engine: 'codex' })).toBeNull();
        expect(readFallbackBriefing({ engine: 'codex', fallbackBriefing: '   ' })).toBeNull();
        expect(readFallbackBriefing(null)).toBeNull();
    });
});

describe('readSwitchSettings', () => {
    it('carries the mapped mode and the model picked for the destination', () => {
        expect(readSwitchSettings({ engine: 'claude', permissionMode: 'bypassPermissions', model: 'claude-opus-5-5[1m]', fallbackBriefing: 'x' }))
            .toEqual({ permissionMode: 'bypassPermissions', model: 'claude-opus-5-5[1m]' });
        expect(readSwitchSettings({ engine: 'codex', model: 'gpt-6-astra', effort: 'high' })).toEqual({ model: 'gpt-6-astra', effort: 'high' });
    });

    it('leaves the destination on its own defaults when nothing was picked', () => {
        expect(readSwitchSettings({ engine: 'claude' })).toEqual({});
        expect(readSwitchSettings({ engine: 'claude', model: '  ' })).toEqual({});
        expect(readSwitchSettings(null)).toEqual({});
    });
});
