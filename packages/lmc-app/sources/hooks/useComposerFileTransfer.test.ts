import { describe, expect, it, vi } from 'vitest';
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/thumbhash', () => ({ generateThumbhash: vi.fn() }));
vi.mock('@/utils/pasteImages.web', () => ({ getFilesFromClipboard: vi.fn(), getFilesFromDrop: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
import { pickTransferOwner } from './useComposerFileTransfer';

type Node = { name: string; parentNode: Node | null };
const node = (name: string, parentNode: Node | null = null): Node => ({ name, parentNode });

describe('paste and drop ownership', () => {
    // body > stack > [screen A > composer A > textarea A] [screen B > (transcript B, composer B > textarea B)]
    const body = node('body'), stack = node('stack', body);
    const screenA = node('screen A', stack), composerA = node('composer A', screenA), textareaA = node('textarea A', composerA);
    const screenB = node('screen B', stack), transcriptB = node('transcript B', screenB), composerB = node('composer B', screenB), textareaB = node('textarea B', composerB);

    it('gives a paste to the composer that holds the focus, not to every mounted one', () => {
        expect(pickTransferOwner([composerA, composerB], textareaB)).toBe(1);
        expect(pickTransferOwner([composerA, composerB], textareaA)).toBe(0);
        // Mount order does not matter.
        expect(pickTransferOwner([composerB, composerA], textareaB)).toBe(0);
    });
    it('gives a drop on a transcript to that screen\'s composer', () => {
        expect(pickTransferOwner([composerA, composerB], transcriptB)).toBe(1);
        expect(pickTransferOwner([composerB, composerA], transcriptB)).toBe(0);
    });
    it('lets the composer on top take an event outside every screen', () => {
        const modalInput = node('modal input', node('modal', body));
        expect(pickTransferOwner([composerA, composerB], modalInput)).toBe(1);
        expect(pickTransferOwner([composerA, composerB], null)).toBe(1);
    });
    it('keeps a single composer working with or without a scope node', () => {
        expect(pickTransferOwner([null], textareaA)).toBe(0);
        expect(pickTransferOwner([composerA], textareaB)).toBe(0);
        expect(pickTransferOwner([], textareaA)).toBe(-1);
    });
    it('does not let an unscoped composer take what a scoped one owns', () => {
        expect(pickTransferOwner([composerB, null], textareaB)).toBe(0);
        expect(pickTransferOwner([null, composerB], textareaB)).toBe(1);
    });
});
