import { describe, expect, it, vi } from 'vitest';
import { NativeTerminalRelay, encodeNativeInput, nativeComposerReady } from './terminalRelay';
function setup() {
    let now = 100;
    const write = vi.fn();
    const relay = new NativeTerminalRelay({ write, now: () => now, screen: () => ({ lines: ['native consent'], cursor: { x: 0, y: 0 }, composer: false }) });
    relay.claim('client_001');
    const request = { clientId: 'client_001', epoch: relay.epoch, revision: 0, requestId: 'request_001', input: { type: 'choice' as const, choice: 2 } };
    return { relay, request, write, tick: () => { now += 16000; } };
}
describe('native terminal ownership and input', () => {
    it('does not exit or send queued work while native Stop hooks still run', () => {
        expect(nativeComposerReady(['Saving current thread…', 'manual mode on · esc to interrupt', '$'], { x: 1, y: 2 })).toBe(false);
        expect(nativeComposerReady(['Worked for 34s · done', 'manual mode on', '$'], { x: 1, y: 2 })).toBe(true);
        expect(nativeComposerReady(['Enter to confirm · Esc to cancel'], { x: 32, y: 0 })).toBe(false);
    });
    it('rejects stale approval and process epochs', () => {
        const { relay, request, write } = setup(); relay.outputChanged();
        expect(() => relay.input(request)).toThrow('latest screen');
        expect(() => relay.input({ ...request, epoch: 'old' })).toThrow('reconnect');
        expect(write).not.toHaveBeenCalled();
    });
    it('retries a lost response without submitting the approval twice', () => {
        const { relay, request, write } = setup();
        relay.input(request);relay.outputChanged();
        expect(relay.input(request).repeated).toBe(true);
        expect(write).toHaveBeenCalledExactlyOnceWith('2\r');
        expect(() => relay.input({ ...request, input: { type: 'choice', choice: 1 } })).toThrow('reused');
    });
    it('replays the current screen after disconnect without restarting or approving', () => {
        const { relay, request, write, tick } = setup();
        expect(() => relay.claim('client_002')).toThrow('another screen');
        tick();expect(() => relay.input(request)).toThrow('expired');
        const snapshot = relay.claim('client_002');
        expect(snapshot.lines).toEqual(['native consent']);expect(snapshot.epoch).toBe(request.epoch);
        expect(write).not.toHaveBeenCalled();
    });
    it('invalidates inputs after native exit', () => {
        const { relay, request, write } = setup();relay.close();
        expect(() => relay.input(request)).toThrow('reconnect');expect(write).not.toHaveBeenCalled();
    });
    it('keeps message paste separate from submit and rejects control-sequence injection', () => {
        expect(encodeNativeInput({ type: 'text', text: 'a\nb' })).toBe('\x1b[200~a\nb\x1b[201~');
        for (const text of ['x\x1b[201~', '\r', '\x03', 'x'.repeat(16385)]) expect(() => encodeNativeInput({ type: 'text', text })).toThrow();
        expect(() => encodeNativeInput({ type: 'key', key: 'kill' })).toThrow();
    });
});
