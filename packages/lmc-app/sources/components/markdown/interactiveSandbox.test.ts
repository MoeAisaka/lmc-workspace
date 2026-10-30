import { describe, expect, it, vi } from 'vitest';
// jsdom is an existing test dependency without bundled TypeScript declarations.
const { JSDOM } = require('jsdom') as { JSDOM: new (html: string, options: object) => { window: Window & typeof globalThis & { close(): void } } };
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
    it.each([false, true])('forwards wheel without cancelling inline gestures (fullscreen=%s)', (fullscreen) => {
        const dom = new JSDOM(wrapForSandbox('<p>answer</p>', fullscreen), { runScripts: 'dangerously' });
        try {
            const sent = vi.spyOn(dom.window, 'postMessage');
            const wheel = new dom.window.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
            dom.window.document.querySelector('p')!.dispatchEvent(wheel);
            expect(sent).toHaveBeenCalledWith({ channel: SANDBOX_CHANNEL, type: 'wheel', deltaX: 0, deltaY: -120 }, '*');
            expect(wheel.defaultPrevented).toBe(fullscreen);
        } finally { dom.window.close(); }
    });
    it('leaves horizontal table scrolling and pinch zoom with the embedded page', () => {
        const dom = new JSDOM(wrapForSandbox('<div style="overflow-x:auto">table</div>'), { runScripts: 'dangerously' });
        try {
            const sent = vi.spyOn(dom.window, 'postMessage');
            const table = dom.window.document.querySelector('div')!;
            Object.defineProperties(table, { scrollWidth: { value: 1000 }, clientWidth: { value: 300 } });
            const wheel = new dom.window.WheelEvent('wheel', { deltaX: 100, bubbles: true, cancelable: true });
            table.dispatchEvent(wheel);
            expect(wheel.defaultPrevented).toBe(false);
            expect(sent).not.toHaveBeenCalled();
            table.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 10, ctrlKey: true, bubbles: true, cancelable: true }));
            expect(sent).not.toHaveBeenCalled();
        } finally { dom.window.close(); }
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
