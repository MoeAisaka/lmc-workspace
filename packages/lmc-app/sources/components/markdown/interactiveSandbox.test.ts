import { describe, expect, it } from 'vitest';
import { isOverSandboxLimit, parseSandboxEvent, resolveInteractiveRef, wrapForSandbox, SANDBOX_CHANNEL } from './interactiveSandbox';

describe('interactive sandbox', () => {
    it('puts the shim inside head, or creates one, without disturbing the page', () => {
        expect(wrapForSandbox('<!doctype html><html><head><title>t</title></head><body>x</body></html>')).toMatch(/^<!doctype html><html><head><script>.*<\/style><title>t<\/title>/s);
        expect(wrapForSandbox('<html lang="zh"><body>x</body></html>')).toMatch(/^<html lang="zh"><head><script>.*<\/head><body>x/s);
        expect(wrapForSandbox('<p>bare</p>')).toMatch(/^<script>.*<\/style><p>bare<\/p>$/s);
    });
    it('enforces the size limit in bytes, not characters', () => {
        expect(isOverSandboxLimit('x'.repeat(200 * 1024))).toBe(false);
        expect(isOverSandboxLimit('中'.repeat(70 * 1024))).toBe(true);
    });
    it('accepts only messages from its own shim', () => {
        expect(parseSandboxEvent({ channel: SANDBOX_CHANNEL, type: 'size', height: 320.5 })).toEqual({ type: 'size', height: 320.5 });
        expect(parseSandboxEvent({ channel: SANDBOX_CHANNEL, type: 'size', height: 'tall' })).toBeNull();
        expect(parseSandboxEvent({ channel: SANDBOX_CHANNEL, type: 'error', message: 'boom' })).toEqual({ type: 'error', message: 'boom' });
        expect(parseSandboxEvent({ channel: SANDBOX_CHANNEL, type: 'network' })).toEqual({ type: 'network' });
        expect(parseSandboxEvent({ type: 'size', height: 1 })).toBeNull();
        expect(parseSandboxEvent({ channel: SANDBOX_CHANNEL, type: 'navigate' })).toBeNull();
        expect(parseSandboxEvent('string')).toBeNull();
    });
    it('resolves a reference to the newest complete block with that id', () => {
        const agent = (id: string, text: string) => ({ kind: 'agent-text' as const, id, localId: null, createdAt: 0, text });
        const messages = [
            agent('1', 'first\n```lmc-ui id=plan title="v1"\n<p>v1</p>\n```'),
            { ...agent('2', '```lmc-ui id=plan title="thinking"\n<p>no</p>\n```'), isThinking: true },
            agent('3', '```lmc-ui id=plan title="v2"\n<p>v2</p>\n```'),
            agent('4', '```lmc-ui id=plan title="half"\n<p>half'),
            agent('5', '```lmc-ui ref=plan\n```'),
        ];
        expect(resolveInteractiveRef(messages, 'plan')).toEqual({ html: '<p>v2</p>', title: 'v2' });
        expect(resolveInteractiveRef(messages, 'other')).toBeNull();
        expect(resolveInteractiveRef(undefined, 'plan')).toBeNull();
    });
});
