import { describe, expect, it } from 'vitest';
import {
    getCodeAgentDefaults,
    resolveAgentDefaultConfig,
} from './agentDefaults';

describe('agent defaults', () => {
    it('uses Auto as the code default for Claude and Codex', () => {
        expect(getCodeAgentDefaults('claude').permissionMode).toBe('auto');
        expect(getCodeAgentDefaults('codex').permissionMode).toBe('auto');
    });

    it.each(['claude', 'codex'] as const)('falls back to Default for %s on an old CLI', (flavor) => {
        expect(getCodeAgentDefaults(flavor, '1.2.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.1-beta.1').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, flavor, 'not-a-version').permissionMode).toBe('default');
    });

    it.each(['claude', 'codex'] as const)('keeps Auto for %s on a new or unknown-version CLI', (flavor) => {
        expect(resolveAgentDefaultConfig({}, flavor, '1.2.1-beta.2').permissionMode).toBe('auto');
        expect(resolveAgentDefaultConfig({}, flavor, '1.3.0').permissionMode).toBe('auto');
        expect(resolveAgentDefaultConfig({}, flavor).permissionMode).toBe('auto');
    });

    it('does not rewrite an explicit YOLO override for an old CLI', () => {
        expect(resolveAgentDefaultConfig(
            { claude: { permissionMode: 'bypassPermissions' } },
            'claude',
            '1.2.0',
        ).permissionMode).toBe('bypassPermissions');
        expect(resolveAgentDefaultConfig(
            { codex: { permissionMode: 'yolo' } },
            'codex',
            '1.2.0',
        ).permissionMode).toBe('yolo');
    });

    it('leaves an explicit unsupported Auto override available for the send path to reject', () => {
        expect(resolveAgentDefaultConfig(
            { claude: { permissionMode: 'auto' } },
            'claude',
            '1.2.0',
        ).permissionMode).toBe('auto');
    });

    it('falls back to the current models when a device publishes no catalog', () => {
        expect(getCodeAgentDefaults('codex').modelMode).toBe('gpt-6.1-sol');
        expect(resolveAgentDefaultConfig({}, 'claude').modelMode).toBe('claude-opus-5-5');
        expect(resolveAgentDefaultConfig(undefined, 'codex', '1.3.0')).toMatchObject({ modelMode: 'gpt-6.1-sol', effortLevel: 'medium' });
    });

    it('follows the default each engine catalog declares', () => {
        const catalog = (models: any[]) => ({ models, capturedAt: 1, runtimeVersion: '1.0.0' });
        const catalogs = {
            codex: catalog([{ id: 'gpt-old', name: 'Old' }, { id: 'gpt-next', name: 'Next', isDefault: true }]),
            claude: catalog([{ id: 'claude-next', name: 'Next', aliases: ['default', 'opus'] }]),
        };
        expect(resolveAgentDefaultConfig({}, 'codex', undefined, catalogs).modelMode).toBe('gpt-next');
        expect(resolveAgentDefaultConfig({}, 'claude', undefined, catalogs).modelMode).toBe('claude-next');
        // A person's own choice still wins, and a catalog with no declared default changes nothing.
        expect(resolveAgentDefaultConfig({ codex: { modelMode: 'gpt-old' } }, 'codex', undefined, catalogs).modelMode).toBe('gpt-old');
        expect(resolveAgentDefaultConfig({}, 'codex', undefined, { codex: catalog([{ id: 'gpt-old', name: 'Old' }]) }).modelMode).toBe('gpt-6.1-sol');
    });

    it('keeps an explicit Codex model choice ahead of the default', () => {
        expect(resolveAgentDefaultConfig(
            { codex: { modelMode: 'gpt-6-astra' } },
            'codex',
        ).modelMode).toBe('gpt-6-astra');
        // A key nobody's catalog lists belongs to whoever configured it.
        expect(resolveAgentDefaultConfig(
            { codex: { modelMode: 'codex-test-custom-model', effortLevel: 'high' } },
            'codex',
        )).toMatchObject({ modelMode: 'codex-test-custom-model', effortLevel: 'high' });
    });

    it('does not change non-code-agent defaults for an old CLI', () => {
        expect(resolveAgentDefaultConfig({}, 'gemini', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'openclaw', '1.0.0').permissionMode).toBe('default');
        expect(resolveAgentDefaultConfig({}, 'agy', '1.0.0').permissionMode).toBe('default');
    });
});