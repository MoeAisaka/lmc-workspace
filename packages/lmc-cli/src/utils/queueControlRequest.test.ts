import { describe, it, expect } from 'vitest';
import { readMessageIntent, readQueueKey, readQueueMode } from './queueControlRequest';

describe('readMessageIntent', () => {
    it('accepts the three intents and nothing else', () => {
        expect(readMessageIntent({ intent: 'queue' })).toBe('queue');
        expect(readMessageIntent({ intent: 'steer' })).toBe('steer');
        expect(readMessageIntent({ intent: 'interrupt' })).toBe('interrupt');
        expect(readMessageIntent({ intent: 'now' })).toBeUndefined();
        expect(readMessageIntent({})).toBeUndefined();
        expect(readMessageIntent(undefined)).toBeUndefined();
        expect(readMessageIntent('interrupt')).toBeUndefined();
    });
});

describe('readQueueMode', () => {
    it('reads a request that carries only queueMode', () => {
        expect(readQueueMode({ queueMode: 'batch' })).toBe('batch');
        expect(readQueueMode({ queueMode: 'sequential' })).toBe('sequential');
    });

    it('rejects other shapes so refresh and switch keep their own parsing', () => {
        expect(readQueueMode({ queueMode: 'sequential', refreshCli: true })).toBeNull();
        expect(readQueueMode({ refreshCli: true })).toBeNull();
        expect(readQueueMode({ queueMode: 'one-by-one' })).toBeNull();
        expect(readQueueMode(null)).toBeNull();
    });
});

describe('readQueueKey', () => {
    it('needs a non-empty string key', () => {
        expect(readQueueKey({ key: 'abc' })).toBe('abc');
        expect(readQueueKey({ key: '' })).toBeNull();
        expect(readQueueKey({ key: 3 })).toBeNull();
        expect(readQueueKey({})).toBeNull();
        expect(readQueueKey(undefined)).toBeNull();
    });
});
