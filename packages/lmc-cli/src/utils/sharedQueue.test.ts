import { describe, it, expect, vi } from 'vitest';
import { MessageQueue2 } from './MessageQueue2';

describe('shared turn authorization', () => {
    it('deduplicates recovery against live delivery and never reruns an admitted command', async () => {
        const queue = new MessageQueue2<string>(v => v);
        queue.setExecutionGuard(async () => true);
        queue.push('one prompt', 'same', undefined, { key: 'lmc-shared:recovery' });
        queue.push('one prompt', 'same', undefined, { key: 'lmc-shared:recovery' });
        expect(queue.size()).toBe(1);
        expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('one prompt');
        queue.push('one prompt', 'same', undefined, { key: 'lmc-shared:recovery' });
        expect(queue.size()).toBe(0);
        queue.push('ordinary authorized', 'same', undefined, { key: 'ordinary' });
        expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('ordinary authorized');
    });
    it('does not combine two actors or bypass a revoked item at consumption', async () => {
        const queue = new MessageQueue2<string>(v => v);
        const gate = vi.fn(async (key: string) => key !== 'lmc-shared:revoked');
        queue.setExecutionGuard(gate);
        queue.push('revoked', 'same', undefined, { key: 'lmc-shared:revoked' });
        queue.push('first actor', 'same', undefined, { key: 'lmc-shared:first' });
        queue.push('second actor', 'same', undefined, { key: 'lmc-shared:second' });
        expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('first actor');
        expect((await queue.waitForMessagesAndGetAsString())?.message).toBe('second actor');
        expect(gate.mock.calls.map(v => v[0])).toEqual(['lmc-shared:revoked', 'lmc-shared:first', 'lmc-shared:second']);
    });
    it('fails closed without a guard or on a lost permission check', async () => {
        const queue = new MessageQueue2<string>(v => v);
        queue.push('never execute', 'same', undefined, { key: 'lmc-shared:unguarded' });
        expect(await queue.authorizeItem('lmc-shared:unguarded')).toBe(false);
        queue.setExecutionGuard(async () => { throw new Error('network down'); });
        queue.push('also never execute', 'same', undefined, { key: 'lmc-shared:offline' });
        expect(await queue.authorizeItem('lmc-shared:offline')).toBe(false);
        expect(queue.size()).toBe(0);
    });
    it('authorizes native terminal consumption and ordinary shared-device turns', async () => {
        const queue = new MessageQueue2<string>(v => v);
        const gate = vi.fn(async () => false);
        queue.setExecutionGuard(gate);
        queue.push('device access removed', 'same', undefined, { key: 'ordinary-prompt' });
        expect(await queue.authorizeItem('ordinary-prompt')).toBe(false);
        expect(queue.takeByKey('ordinary-prompt')).toBeNull();
        expect(gate).toHaveBeenCalledWith('ordinary-prompt');
    });
});
