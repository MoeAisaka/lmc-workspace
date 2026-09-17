import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { resolveSessionModelDisplay } from './sessionModelDisplay';

const translate = (key: string) => key;
const session = (flavor: string, metadata: Record<string, unknown> = {}, picks: Record<string, unknown> = {}) => ({
    metadata: { flavor, version: '1.2.45', ...metadata },
    modelMode: null,
    effortLevel: null,
    ...picks,
} as Session);

describe('sidebar model display before any manual selection', () => {
    it.each([['codex', 'GPT-6 Astra'], ['claude', 'Opus 5']])('shows the %s configured default on first load', (flavor, modelName) => {
        expect(resolveSessionModelDisplay(session(flavor), {}, translate)).toEqual({ modelName, effortName: 'Medium' });
    });

    it('uses account defaults without writing a model pick into the session', () => {
        const input = session('claude');
        expect(resolveSessionModelDisplay(input, { claude: { modelMode: 'claude-fable-5-1', effortLevel: 'high' } }, translate))
            .toEqual({ modelName: 'Fable 5.1', effortName: 'High' });
        expect(input.modelMode).toBeNull();
        expect(input.metadata?.modelMode).toBeUndefined();
    });

    it('keeps explicit session settings ahead of account defaults', () => {
        expect(resolveSessionModelDisplay(session('claude', { modelMode: 'claude-opus-5[1m]', effortLevel: 'max' }),
            { claude: { modelMode: 'claude-fable-5-1', effortLevel: 'medium' } }, translate))
            .toEqual({ modelName: 'Opus 5 [1M]', effortName: 'Max' });
    });

    it('shows a local effort change while its metadata update is in flight', () => {
        expect(resolveSessionModelDisplay(session('codex', { modelMode: 'gpt-6-astra', effortLevel: 'medium' },
            { modelMode: 'gpt-6-astra', effortLevel: 'high' }), {}, translate))
            .toEqual({ modelName: 'GPT-6 Astra', effortName: 'High' });
    });

    it('keeps a custom model label and does not borrow a model from the previous engine', () => {
        expect(resolveSessionModelDisplay(session('codex', { modelMode: 'my-codex-model', effortLevel: 'high' }), {}, translate).modelName)
            .toBe('my-codex-model');
        expect(resolveSessionModelDisplay(session('codex', {}, { modelMode: 'claude-fable-5-1' }), {}, translate).modelName)
            .toBe('GPT-6 Astra');
    });

    it('does not invent a Claude model for an unrelated engine', () => {
        expect(resolveSessionModelDisplay(session('gemini'), {}, translate)).toEqual({ modelName: null, effortName: null });
    });
});
