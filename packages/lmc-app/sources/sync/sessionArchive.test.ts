import { describe, expect, it } from 'vitest';
import { isSessionArchived, listArchiveRule } from './sessionArchive';

describe('explicit session archiving', () => {
    it.each(['claude', 'codex', 'gemini', 'opencode'])('keeps disconnected %s sessions unless explicitly archived', (flavor) => {
        for (const lifecycleState of [undefined, 'running', 'archiveRequested']) {
            for (const active of [true, false]) {
                expect(isSessionArchived({ active, metadata: { flavor, lifecycleState } as any })).toBe(false);
            }
        }
    });

    it('does not infer archiving before metadata has loaded', () => {
        expect(isSessionArchived({ active: false, metadata: null })).toBe(false);
    });

    it.each([true, false])('honours an explicit archive even when active=%s', (active) => {
        expect(isSessionArchived({ active, metadata: { lifecycleState: 'archived' } as any })).toBe(true);
    });
});

describe('removed-device archive exception', () => {
    it.each(['claude', 'codex'])('archives a disconnected %s session only when its device was removed', (flavor) => {
        const session = { active: false, activeAt: 1, metadata: { flavor, machineId: 'original', lifecycleState: 'running' } as any };
        for (const active of [true, false]) {
            const machines = [{ id: 'original', active }];
            expect(listArchiveRule(machines)(session)).toBe(false);
        }
        expect(listArchiveRule([{ id: 'other' }])(session)).toBe(true);
        expect(listArchiveRule([])(session)).toBe(false);
        expect(listArchiveRule([{ id: 'other' }])({ ...session, active: true })).toBe(false);
    });

    it('preserves unknown-device and Rig sessions, and explicit manual archives', () => {
        const rule = listArchiveRule([{ id: 'other' }]);
        expect(rule({ active: false, metadata: null })).toBe(false);
        expect(rule({ active: false, metadata: { client: { id: 'rig' }, machineId: 'rig-host' } as any })).toBe(false);
        expect(listArchiveRule([])({ active: true, metadata: { lifecycleState: 'archived' } as any })).toBe(true);
    });
});
