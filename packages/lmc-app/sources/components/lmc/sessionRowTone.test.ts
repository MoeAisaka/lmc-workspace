import { describe, expect, it } from 'vitest';
import type { BoardEntry } from '@/sync/storageTypes';
import { hasTaskAttention, resolveSessionRowTone, taskRowTone } from './sessionRowTone';

const entry = (state: BoardEntry['state']): Pick<BoardEntry, 'state'> => ({ state });

const UNSETTLED: BoardEntry['state'][] = ['rejected', 'blocked', 'failed'];

describe('resolveSessionRowTone', () => {
    // The regression: the row used to read `alert ? 'attention' : …`, so one
    // rejected task on the hub board painted the session orange for good.
    it.each(UNSETTLED)('leaves an idle session idle while a %s task sits on the board', (state) => {
        const tasks = [entry(state)];
        expect(hasTaskAttention(tasks)).toBe(true);
        expect(resolveSessionRowTone({ lineTone: 'idle', unread: false, taskAttention: hasTaskAttention(tasks) }))
            .toBe('idle');
    });

    it.each(UNSETTLED)('keeps a working session working while a %s task sits on the board', (state) => {
        expect(resolveSessionRowTone({ lineTone: 'working', unread: false, taskAttention: hasTaskAttention([entry(state)]) }))
            .toBe('working');
    });

    it.each(UNSETTLED)('keeps an offline session offline while a %s task sits on the board', (state) => {
        expect(resolveSessionRowTone({ lineTone: 'offline', unread: false, taskAttention: hasTaskAttention([entry(state)]) }))
            .toBe('offline');
    });

    // A real permission request or question still resolves to attention: that
    // is the session asking for a person, which is what orange is for.
    it('still reports attention when the session itself is waiting on the user', () => {
        expect(resolveSessionRowTone({ lineTone: 'attention', unread: false, taskAttention: false })).toBe('attention');
        expect(resolveSessionRowTone({ lineTone: 'attention', unread: true, taskAttention: true })).toBe('attention');
    });

    it('keeps the unread-done semantics: an idle session nobody has opened reads as done', () => {
        expect(resolveSessionRowTone({ lineTone: 'idle', unread: true, taskAttention: false })).toBe('done');
        // Unread does not promote anything but idle.
        expect(resolveSessionRowTone({ lineTone: 'working', unread: true, taskAttention: false })).toBe('working');
        expect(resolveSessionRowTone({ lineTone: 'offline', unread: true, taskAttention: false })).toBe('offline');
    });
});

describe('taskRowTone', () => {
    // The task layer is untouched: a failed attempt stays visible as a task
    // that needs a person, it just no longer speaks for the session.
    it.each(UNSETTLED)('draws a %s task as needing a person', (state) => {
        expect(taskRowTone(entry(state))).toBe('attention');
    });

    it('draws a dispatched task as working and a settled task as done', () => {
        expect(taskRowTone(entry('dispatched'))).toBe('working');
        expect(taskRowTone(entry('done'))).toBe('done');
        expect(taskRowTone(entry('accepted'))).toBe('done');
    });

    it('reports no task attention when every task is settled or running', () => {
        expect(hasTaskAttention([entry('dispatched'), entry('done'), entry('accepted')])).toBe(false);
        expect(hasTaskAttention([])).toBe(false);
    });
});
