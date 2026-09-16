import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { watchSessionConfiguration } from './workerConfig';
import { readFileSync } from 'node:fs';

describe('runner-owned worker permission default', () => {
    it('keeps the complete app projection identical to the runtime implementation', () => {
        expect(readFileSync(new URL('../../../../lmc-app/sources/sync/workerPermission.ts', import.meta.url), 'utf8'))
            .toBe(readFileSync(new URL('./workerPermission.ts', import.meta.url), 'utf8'));
    });
    it.each([['claude', 'bypassPermissions'], ['codex', 'yolo']] as const)('applies %s full allow only after binding confirmation and restores the baseline on unbind', (flavor, full) => {
        const events = new EventEmitter();
        const initial = { flavor, permissionMode: 'default', permissionModeSource: 'ambient', orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } } };
        const modes: unknown[] = [];
        const stop = watchSessionConfiguration(Object.assign(events, { getMetadata: () => initial, sendSessionEvent: () => undefined }) as any, flavor, p => { if ('permissionMode' in p) modes.push(p.permissionMode); });
        expect(modes).toEqual(['default']);
        const confirmed = { ...initial, orchestration: { ...initial.orchestration, hub: { ...initial.orchestration.hub, autonomy: true } } };
        events.emit('metadata', confirmed);
        expect(modes.at(-1)).toBe(full);
        events.emit('metadata', { ...confirmed, permissionModeSource: 'explicit', permissionMode: 'read-only' });
        expect(modes.at(-1)).toBe('read-only');
        events.emit('metadata', { ...confirmed, orchestration: undefined });
        expect(modes.at(-1)).toBe('default');
        stop();
    });

    it('preserves legacy picks with unknown provenance, explicit same-value choices and hub guards', () => {
        const events = new EventEmitter();
        const seen: unknown[] = [];
        const session = Object.assign(events, { getMetadata: () => null, sendSessionEvent: () => undefined });
        const stop = watchSessionConfiguration(session as any, 'codex', p => { if ('permissionMode' in p) seen.push(p.permissionMode); });
        const worker = { flavor: 'codex', permissionMode: 'read-only', orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'manual', autonomy: true } } };
        events.emit('metadata', worker);
        expect(seen.at(-1)).toBe('read-only');
        events.emit('metadata', { ...worker, permissionMode: 'bypassPermissions', permissionModeSource: 'explicit' });
        expect(seen.at(-1)).toBe('yolo');
        events.emit('metadata', { ...worker, permissionMode: 'default', permissionModeSource: 'ambient', orchestration: { role: 'hub', workers: [] } });
        expect(seen.at(-1)).toBe('default');
        stop();
    });
});
