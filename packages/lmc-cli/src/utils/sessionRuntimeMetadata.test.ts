import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import { refreshSessionRuntimeMetadata, SESSION_STATE_REVISION } from './sessionRuntimeMetadata';

describe('refreshSessionRuntimeMetadata', () => {
    it('reapplies current process identity to server metadata returned after a version conflict', () => {
        const launch = { hostPid: 222, startedBy: 'daemon', startedFromDaemon: true, version: '1.2.2' } as Metadata;
        const update = (metadata: Metadata) => refreshSessionRuntimeMetadata(metadata, launch);
        const initial = { hostPid: 111, startedBy: 'terminal', version: 'old', name: 'Initial', codexThreadId: 'thread' } as Metadata;
        update(initial);
        const latest = { ...initial, name: 'Renamed elsewhere', customField: 'preserve', hostPid: 333 };
        const result = update(latest);
        expect(result).toMatchObject({ hostPid: 222, startedBy: 'daemon', startedFromDaemon: true, version: '1.2.2', sessionStateRevision: SESSION_STATE_REVISION, name: 'Renamed elsewhere', customField: 'preserve', codexThreadId: 'thread' });
        expect(latest.hostPid).toBe(333);
    });
});

describe('refreshSessionRuntimeMetadata across an engine switch', () => {
    const stored = { flavor: 'claude', claudeSessionId: 'claude-thread', path: '/p', machineId: 'm' } as any;
    const launched = (flavor: string) => ({ flavor, hostPid: 7, startedBy: 'daemon', startedFromDaemon: true, version: '1.0.0' } as any);

    it('records the engine that actually booted', () => {
        expect(refreshSessionRuntimeMetadata(stored, launched('codex')).flavor).toBe('codex');
    });

    it('drops the thread id of the engine left behind, so a relaunch cannot resume it', () => {
        const next = refreshSessionRuntimeMetadata(stored, launched('codex'));
        expect(next.claudeSessionId).toBeUndefined();
        expect(next.codexThreadId).toBeUndefined();
    });

    it('leaves the thread id alone on an ordinary refresh of the same engine', () => {
        expect(refreshSessionRuntimeMetadata(stored, launched('claude')).claudeSessionId).toBe('claude-thread');
    });

    const configured = { ...stored, modelMode: 'claude-fable-5-1', effortLevel: 'medium' } as any;

    it('records the model the arriving engine actually booted with', () => {
        const next = refreshSessionRuntimeMetadata(configured, { ...launched('codex'), modelMode: 'gpt-5.6-sol', effortLevel: 'medium' });
        expect(next.modelMode).toBe('gpt-5.6-sol');
        expect(next.effortLevel).toBe('medium');
    });

    it('clears the departed engine\'s model when the arriving one names none, so its own default governs', () => {
        const next = refreshSessionRuntimeMetadata(configured, launched('codex'));
        expect(next.modelMode).toBeUndefined();
        expect(next.effortLevel).toBeUndefined();
    });

    it('keeps the model the user picked on an ordinary refresh of the same engine', () => {
        const next = refreshSessionRuntimeMetadata(configured, launched('claude'));
        expect(next.modelMode).toBe('claude-fable-5-1');
        expect(next.effortLevel).toBe('medium');
    });
});
