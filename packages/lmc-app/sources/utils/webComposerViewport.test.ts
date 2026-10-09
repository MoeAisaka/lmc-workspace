// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnRevealGap, MAX_REVEAL_GAP, installWebComposerViewport } from './webComposerViewport';

describe('web composer keyboard avoidance', () => {
    let container: HTMLDivElement;
    let input: HTMLTextAreaElement;
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let cleanup: () => void;
    const flush = () => vi.advanceTimersByTime(20);
    const inset = () => container.style.getPropertyValue('--lmc-keyboard-inset');
    // jsdom's opaque test origin has no localStorage; the hook must still work
    // and the learned value must survive only within the same browser profile.
    const storage = new Map<string, string>();
    beforeEach(() => {
        storage.clear();
        vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } });
        vi.useFakeTimers();
        viewport = Object.assign(new EventTarget(), { height: 1080, offsetTop: 0, scale: 1 });
        vi.stubGlobal('visualViewport', viewport);
        container = document.createElement('div');
        input = document.createElement('textarea');
        input.value = '未发送的中文草稿';
        container.appendChild(input); document.body.appendChild(container);
        vi.spyOn(container, 'clientWidth', 'get').mockReturnValue(820);
        vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ bottom: 1080, width: 820 } as DOMRect);
        // The field sits 77px above the container's lifted bottom (device layout).
        vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => {
            const bottom = container.getBoundingClientRect().bottom - (parseFloat(container.style.getPropertyValue('--lmc-keyboard-inset')) || 0) - 77;
            return { top: bottom - 42, bottom, height: 42, width: 360 } as DOMRect;
        });
        cleanup = installWebComposerViewport(container);
    });
    afterEach(() => { cleanup(); container.remove(); delete (document.body as any).scrollTop; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('lifts the same focused field above a docked keyboard and restores it without focus calls', () => {
        input.focus(); const focus = vi.spyOn(input, 'focus'); const blur = vi.spyOn(input, 'blur');
        for (const height of [900, 650, 450, 600, 1080]) {
            viewport.height = height; viewport.dispatchEvent(new Event('resize')); flush();
            expect(inset()).toBe(`${1080 - height}px`);
            expect(document.activeElement).toBe(input);
            expect(input.value).toBe('未发送的中文草稿');
        }
        expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled();
    });
    it('does not undo native caret reveals after lifting for the keyboard (v291 device sequence)', () => {
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        vi.stubGlobal('innerHeight', 756); vi.stubGlobal('scrollY', 0);
        vi.mocked(container.getBoundingClientRect).mockImplementation(() => ({ bottom: 756 - window.scrollY, width: 820 } as DOMRect));
        Object.assign(viewport, { height: 756, pageTop: 0, offsetTop: 0 });
        input.focus(); flush();
        // The device initially stays at scrollY=0 while the keyboard opens.
        viewport.height = 447; viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('309px');
        // Its remaining 23px keyboard resize is independent of document pan.
        // Do not lower the dock inset by each 54px native caret reveal, which
        // would pull the field back down and provoke the same reveal again.
        for (const pan of [45, 77, 131, 185, 239, 293]) {
            vi.stubGlobal('innerHeight', 756 - pan); vi.stubGlobal('scrollY', pan);
            Object.assign(viewport, { height: 424, pageTop: pan, offsetTop: pan });
            viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); flush();
            expect(inset()).toBe('332px');
        }
        vi.stubGlobal('scrollY', 0); vi.stubGlobal('innerHeight', 756);
        Object.assign(viewport, { height: 756, pageTop: 0, offsetTop: 0 });
        viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('0px');
    });
    it('does not turn one browser caret reveal into repeated scroll requests', () => {
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        let pan = 0;
        vi.stubGlobal('scrollY', 0); vi.stubGlobal('innerHeight', 756);
        vi.mocked(container.getBoundingClientRect).mockImplementation(() => ({ bottom: 756 - pan, width: 820 } as DOMRect));
        Object.assign(viewport, { height: 424, pageTop: 0, offsetTop: 0 });
        input.focus(); flush();
        // A bounded feedback model, not an emulation of iOS: the recorded
        // native reveal repeatedly tries to raise a field from y=305 to 251.
        let reveals = 0;
        while (637 - pan - parseFloat(inset()) > 251 && reveals < 10) {
            pan += Math.min(54, 637 - pan - parseFloat(inset()) - 251);
            reveals++;
            vi.stubGlobal('scrollY', pan); vi.stubGlobal('innerHeight', Math.max(424, 756 - pan));
            Object.assign(viewport, { pageTop: pan, offsetTop: pan });
            viewport.dispatchEvent(new Event('scroll')); flush();
        }
        expect(reveals).toBe(1);
        expect(pan).toBe(54);
        expect(637 - pan - parseFloat(inset())).toBe(251);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('未发送的中文草稿');
    });
    it('keeps the editor compact instead of turning native pan into field height', () => {
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        vi.stubGlobal('scrollY', 0); vi.stubGlobal('innerHeight', 756);
        vi.mocked(container.getBoundingClientRect).mockImplementation(() => ({ bottom: 756 - window.scrollY, width: 820 } as DOMRect));
        Object.assign(viewport, { height: 424, pageTop: 0 });
        input.focus(); flush();
        for (const pan of [54, 77, 332, 54, 0]) {
            vi.stubGlobal('scrollY', pan); vi.stubGlobal('innerHeight', Math.max(424, 756 - pan));
            Object.assign(viewport, { pageTop: pan, offsetTop: pan });
            viewport.dispatchEvent(new Event('scroll')); flush();
            expect(container.style.getPropertyValue('--lmc-composer-extension')).toBe('');
            expect(container.dataset.lmcKeyboardExpanded).toBeUndefined();
        }
    });
    it.each([
        ['iPhone Edge', 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/153.0 Mobile Safari/604.1', 'iPhone', 5],
        ['iPad desktop Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15', 'MacIntel', 5],
    ])('lets %s reveal the caret without a second lift or root clip', (_label, userAgent, platform, maxTouchPoints) => {
        cleanup();
        vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints });
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        vi.mocked(container.getBoundingClientRect).mockImplementation(() => ({ bottom: 756 - window.scrollY, width: 820 } as DOMRect));
        cleanup = installWebComposerViewport(container);
        input.focus();
        // Both orders occur in the device records: viewport shrink precedes
        // native pan, or both arrive together. Reopen without a blur as well.
        for (const [height, pan] of [[756, 0], [447, 0], [424, 332], [424, 386], [756, 0], [424, 332], [756, 0]]) {
            vi.stubGlobal('scrollY', pan); vi.stubGlobal('innerHeight', Math.max(height, 756 - pan));
            Object.assign(viewport, { height, pageTop: pan, offsetTop: Math.min(pan, 756 - height) });
            viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
            vi.advanceTimersByTime(750);
            expect(inset()).toBe('0px');
            expect(document.body.style.overflow).not.toBe('clip');
            expect(document.documentElement.style.overflow).not.toBe('clip');
            expect(container.style.getPropertyValue('--lmc-composer-extension')).toBe('');
            expect(document.activeElement).toBe(input);
        }
    });
    const controlledIos = () => {
        cleanup();
        vi.stubGlobal('navigator', { userAgent: 'iPhone AppleWebKit EdgiOS', platform: 'iPhone', maxTouchPoints: 5 });
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        vi.mocked(container.getBoundingClientRect).mockImplementation(() => ({ bottom: 756 - window.scrollY, width: 820 } as DOMRect));
        input.dataset.lmcFocusScroll = 'controlled';
        cleanup = installWebComposerViewport(container);
        input.focus();
        return (height: number, pan: number, pageTop = pan) => {
            vi.stubGlobal('scrollY', pan); vi.stubGlobal('innerHeight', Math.max(height, 756 - pan));
            Object.assign(viewport, { height, pageTop, offsetTop: Math.min(pan, 756 - height) });
            viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')); flush();
        };
    };
    const extension = () => container.style.getPropertyValue('--lmc-dock-extension');
    it('keeps a controlled iOS field where WebKit revealed it and fills the strip below the body (v295 device trace)', () => {
        const pan = controlledIos();
        // preventScroll focus: the keyboard opens at scrollY=0, so the dock lifts.
        pan(756, 0); expect(inset()).toBe('0px'); expect(extension()).toBe('');
        pan(447, 0); expect(inset()).toBe('309px');
        pan(424, 0); expect(inset()).toBe('332px'); expect(extension()).toBe('');
        // The device then revealed the caret while typing. v295 followed the
        // visible bottom back down each time and crept to scrollY=419. Model
        // WebKit raising the field top from 305 to 251 per keystroke.
        let scroll = 0, reveals = 0;
        const fieldTop = () => 637 - scroll - parseFloat(inset());
        for (let keystroke = 0; keystroke < 6; keystroke++) {
            while (fieldTop() > 251 && reveals < 10) {
                scroll += Math.min(54, fieldTop() - 251); reveals++;
                pan(424, scroll, scroll - 0.3);
            }
            expect(inset()).toBe('332px');
            expect(extension()).toBe(`${scroll}px`);
        }
        expect(reveals).toBe(1);
        expect(scroll).toBe(54);
        expect(document.body.style.overflow).toBe('visible');
        expect(document.activeElement).toBe(input);
        pan(756, 0);
        expect(inset()).toBe('0px'); expect(extension()).toBe('');
        input.blur(); flush();
        expect(document.body.style.overflow).toBe('');
    });
    it('lifts a controlled field again only after it stays hidden, and follows a finger pan once it ends', () => {
        const pan = controlledIos();
        vi.stubGlobal('scrollY', 100);
        pan(424, 100); expect(inset()).toBe('232px'); expect(extension()).toBe('');
        // A reveal in progress passes through hidden states; do not re-anchor on each frame.
        pan(424, 60); expect(inset()).toBe('232px'); expect(extension()).toBe('');
        vi.advanceTimersByTime(120); pan(424, 40); expect(inset()).toBe('232px');
        vi.advanceTimersByTime(400); flush();
        expect(inset()).toBe('292px'); expect(extension()).toBe('');
        pan(424, 40); expect(inset()).toBe('292px');
        // WebKit pans past the document; the dock stays and the backdrop covers the strip.
        pan(424, 94); expect(inset()).toBe('292px'); expect(extension()).toBe('54px');
        // The user drags the page with the keyboard open: follow the visible bottom after the touch ends.
        document.dispatchEvent(new Event('touchstart'));
        pan(424, 300); expect(inset()).toBe('292px'); expect(extension()).toBe('260px');
        const end = new Event('touchend'); Object.defineProperty(end, 'touches', { value: [] });
        document.dispatchEvent(end); flush();
        expect(inset()).toBe('32px'); expect(extension()).toBe('');
        // The next WebKit reveal after that is again anchored, not chased.
        pan(424, 354); expect(inset()).toBe('32px'); expect(extension()).toBe('54px');
    });
    it('remembers a settled WebKit reveal and pre-lifts the next keyboard so no pan is needed', () => {
        let pan = controlledIos();
        pan(756, 0); pan(424, 0); expect(inset()).toBe('332px');
        // WebKit's keyboard-change reveal pans 77px (v296 device probe); it settles.
        pan(424, 77, 77); expect(inset()).toBe('332px'); expect(extension()).toBe('77px');
        vi.advanceTimersByTime(450);
        expect(JSON.parse(storage.get('lmc.ios-keyboard-reveal-gap.v2')!)).toMatchObject({ gap: 77, keyboardHeight: 332 });
        // Dismiss and reopen without blur (device trace): the field is placed
        // 77px above the keyboard immediately, so WebKit's check passes.
        pan(756, 0); expect(inset()).toBe('0px');
        // v299 device trace: WebKit judges the caret while the keyboard frame
        // is still changing, before the page sees any viewport event. The
        // tap announces the keyboard and the dock lifts to the remembered
        // geometry at once (keyboard 332 + strip 77), without any pan.
        // Same order as the field's tap handler: clear the dismissed marker,
        // announce, blur, refocus with preventScroll.
        expect(input.dataset.lmcKeyboardDismissed).toBe('true');
        delete input.dataset.lmcKeyboardDismissed;
        input.dispatchEvent(new CustomEvent('lmc-keyboard-expected', { bubbles: true }));
        input.blur(); input.focus({ preventScroll: true }); flush();
        expect(inset()).toBe('409px'); expect(extension()).toBe('77px');
        pan(447, 0); pan(424, 0);
        expect(inset()).toBe('409px'); expect(extension()).toBe('77px');
        expect(637 - parseFloat(inset())).toBe(228);
        // A new install of the hook (reload) reads the remembered value, and a
        // first focus lifts before the keyboard too; without a keyboard the
        // anticipation lapses after 700ms (hardware keyboard, cancelled focus).
        cleanup(); input.blur(); pan = controlledIos();
        pan(756, 0); expect(inset()).toBe('409px'); expect(extension()).toBe('77px');
        vi.advanceTimersByTime(800); flush();
        expect(inset()).toBe('0px'); expect(extension()).toBe('');
        input.dispatchEvent(new CustomEvent('lmc-keyboard-expected', { bubbles: true })); flush();
        pan(424, 0); expect(inset()).toBe('409px'); expect(extension()).toBe('77px');
        // Re-anchoring after an over-pan keeps the learned strip as well.
        pan(424, 332); vi.advanceTimersByTime(400); flush();
        expect(inset()).toBe('77px'); expect(extension()).toBe('77px');
        // A value remembered by another browser/screen is not inherited.
        storage.set('lmc.ios-keyboard-reveal-gap.v2', JSON.stringify({ scope: 'Safari|956|756', gap: 77 }));
        cleanup(); pan = controlledIos();
        pan(756, 0); pan(424, 0); expect(inset()).toBe('332px');
    });
    it('never adds a later pan to the remembered strip, and stops lifting after two opens in a row that still pan (iPhone Safari, 2026-10-08)', () => {
        const reopen = () => {
            pan(756, 0);
            delete input.dataset.lmcKeyboardDismissed;
            input.dispatchEvent(new CustomEvent('lmc-keyboard-expected', { bubbles: true }));
            input.blur(); input.focus({ preventScroll: true }); flush();
        };
        const stored = () => JSON.parse(storage.get('lmc.ios-keyboard-reveal-gap.v2')!);
        // A strip remembered by the accumulating v1 rule had reached its cap.
        storage.set('lmc.ios-keyboard-reveal-gap', JSON.stringify({ scope: `${navigator.userAgent}|${screen.height}|${document.documentElement.clientHeight}`, gap: 240, keyboardHeight: 332 }));
        const pan = controlledIos();
        // It is not read: the first open starts flush with the keyboard.
        pan(756, 0); expect(inset()).toBe('0px');
        pan(424, 0); expect(inset()).toBe('332px');
        pan(424, 77, 77); vi.advanceTimersByTime(450);
        expect(stored()).toMatchObject({ gap: 77, misses: 0, disabled: false });
        // Second open: lifted by 77 first, and WebKit pans another 54 anyway.
        reopen(); expect(inset()).toBe('409px');
        pan(424, 0); pan(424, 54, 54); expect(extension()).toBe('131px');
        vi.advanceTimersByTime(450);
        // The strip stays 77: nothing is added, and the dock does not move mid-keyboard.
        expect(stored()).toMatchObject({ gap: 77, misses: 1, disabled: false });
        expect(extension()).toBe('131px');
        // Third open lifts by the same 77, not 131, and is panned again.
        reopen(); expect(inset()).toBe('409px'); expect(extension()).toBe('77px');
        pan(424, 0); pan(424, 54, 54); vi.advanceTimersByTime(450);
        expect(stored()).toMatchObject({ gap: 0, keyboardHeight: 0, misses: 2, disabled: true });
        // From now on this browser is plainly anchored: no lift before the
        // keyboard, flush when it shows, and a pan is absorbed but never remembered.
        reopen(); expect(inset()).toBe('0px'); expect(extension()).toBe('');
        pan(424, 0); expect(inset()).toBe('332px'); expect(extension()).toBe('');
        pan(424, 60, 60); expect(inset()).toBe('332px'); expect(extension()).toBe('60px');
        vi.advanceTimersByTime(450);
        expect(stored()).toMatchObject({ gap: 0, disabled: true, misses: 2 });
        // A reload stays switched off.
        cleanup(); input.blur(); const again = controlledIos();
        again(756, 0); expect(inset()).toBe('0px');
        again(424, 0); expect(inset()).toBe('332px');
    });
    it('forgives a single stray pan once an open goes by without one', () => {
        const pan = controlledIos();
        const reopen = () => { pan(756, 0); delete input.dataset.lmcKeyboardDismissed; input.dispatchEvent(new CustomEvent('lmc-keyboard-expected', { bubbles: true })); input.blur(); input.focus({ preventScroll: true }); flush(); };
        const stored = () => JSON.parse(storage.get('lmc.ios-keyboard-reveal-gap.v2')!);
        pan(756, 0); pan(424, 0); pan(424, 77, 77); vi.advanceTimersByTime(450);
        reopen(); pan(424, 0); pan(424, 54, 54); vi.advanceTimersByTime(450);
        expect(stored()).toMatchObject({ gap: 77, misses: 1 });
        // A clean open: lifted, no pan.
        reopen(); pan(424, 0); vi.advanceTimersByTime(450);
        pan(756, 0);
        expect(stored()).toMatchObject({ gap: 77, misses: 0, disabled: false });
        // So one more stray pan later does not switch the lift off.
        reopen(); pan(424, 0); pan(424, 54, 54); vi.advanceTimersByTime(450);
        expect(stored()).toMatchObject({ gap: 77, misses: 1, disabled: false });
    });
    it('decides what a settled pan teaches', () => {
        const none = { gap: 0, keyboardHeight: 0, misses: 0, disabled: false };
        expect(learnRevealGap(none, 77, 332)).toEqual({ gap: 77, keyboardHeight: 332, misses: 0, disabled: false });
        // A first pan beyond any plausible strip is not a strip.
        expect(learnRevealGap(none, MAX_REVEAL_GAP + 1, 332)).toEqual({ ...none, misses: 1 });
        const learned = { gap: 77, keyboardHeight: 332, misses: 0, disabled: false };
        expect(learnRevealGap(learned, 131, 332)).toEqual({ ...learned, misses: 1 });
        expect(learnRevealGap({ ...learned, misses: 1 }, 131, 332)).toEqual({ gap: 0, keyboardHeight: 0, misses: 2, disabled: true });
        const off = { gap: 0, keyboardHeight: 0, misses: 2, disabled: true };
        expect(learnRevealGap(off, 60, 332)).toBe(off);
    });
    it('does not let a finger drag the whole page while the keyboard is open, only what scrolls (device recording, 2026-10-08)', () => {
        const touch = (type: string, target: Element, x: number, y: number, count = 1) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) });
            target.dispatchEvent(event);
            return event.defaultPrevented;
        };
        const swipe = (target: Element, dx: number, dy: number, count = 1) => { touch('touchstart', target, 100, 300, count); return touch('touchmove', target, 100 + dx, 300 + dy, count); };
        // header (does not scroll), transcript (scrolls vertically) > code block (scrolls sideways)
        const header = document.createElement('div'), transcript = document.createElement('div'), code = document.createElement('pre'), short = document.createElement('div');
        transcript.style.overflowY = 'auto'; code.style.overflowX = 'auto'; short.style.overflowY = 'auto';
        Object.defineProperties(transcript, { scrollHeight: { value: 2000 }, clientHeight: { value: 300 } });
        Object.defineProperties(code, { scrollWidth: { value: 900 }, clientWidth: { value: 300 } });
        Object.defineProperties(short, { scrollHeight: { value: 200 }, clientHeight: { value: 200 } });
        const loose = document.createElement('pre'); loose.style.overflowX = 'auto';
        Object.defineProperties(loose, { scrollWidth: { value: 900 }, clientWidth: { value: 300 } });
        transcript.appendChild(code); container.append(header, transcript, short, loose);

        const pan = controlledIos();
        // No keyboard yet: nothing is intercepted.
        pan(756, 0); expect(swipe(header, 0, -80)).toBe(false);
        pan(424, 0);
        // The drag that pulled the composer off the screen.
        expect(swipe(header, 0, -80)).toBe(true);
        expect(swipe(container, 0, 120)).toBe(true);
        // A list too short to scroll would hand the drag to the page as well.
        expect(swipe(short, 0, -80)).toBe(true);
        // The transcript scrolls itself, and stops at its ends instead of carrying on into the page.
        expect(swipe(transcript, 0, -80)).toBe(false);
        expect(transcript.style.overscrollBehaviorY).toBe('contain');
        expect(swipe(code, 0, -80)).toBe(false);
        // A sideways block outside any vertical scroller: sideways is its own, up and down is not.
        expect(swipe(loose, -80, 5)).toBe(false);
        expect(swipe(loose, 5, -80)).toBe(true);
        // Caret and selection gestures in the field, and pinch, stay the browser's.
        expect(swipe(input, 0, -80)).toBe(false);
        expect(swipe(header, 0, -80, 2)).toBe(false);
        // Keyboard gone: the page is the browser's again and the scroller is as it was.
        pan(756, 0);
        expect(swipe(header, 0, -80)).toBe(false);
        expect(transcript.style.overscrollBehaviorY).toBe('');
        header.remove(); transcript.remove(); short.remove(); loose.remove();
    });
    it('does not learn a strip from a container that moved without any page pan', () => {
        const pan = controlledIos();
        pan(756, 0); pan(424, 0); expect(inset()).toBe('332px');
        // A clipped shell scrolls the dock's container up by 236px (keyboard-input
        // harness, desktop-sized scene): the extension grows, the page did not pan.
        vi.mocked(container.getBoundingClientRect).mockImplementation(() => ({ bottom: 756 - window.scrollY - 236, width: 820 } as DOMRect));
        document.body.dispatchEvent(new Event('scroll')); flush();
        vi.advanceTimersByTime(1200);
        expect(storage.get('lmc.ios-keyboard-reveal-gap.v2')).toBeUndefined();
    });
    it('marks a focused field whose soft keyboard was dismissed, and only then', () => {
        const pan = controlledIos();
        pan(756, 0); expect(input.dataset.lmcKeyboardDismissed).toBeUndefined();
        pan(424, 0); expect(input.dataset.lmcKeyboardDismissed).toBeUndefined();
        pan(756, 0); expect(input.dataset.lmcKeyboardDismissed).toBe('true');
        pan(424, 332); expect(input.dataset.lmcKeyboardDismissed).toBeUndefined();
        pan(756, 0); expect(input.dataset.lmcKeyboardDismissed).toBe('true');
        input.blur(); flush(); expect(input.dataset.lmcKeyboardDismissed).toBeUndefined();
    });
    it('returns a controlled field that WebKit panned above the visible top (v296 device screenshot)', () => {
        const pan = controlledIos();
        const header = document.createElement('div'); header.dataset.lmcSessionHeader = 'true'; document.body.prepend(header);
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 56, height: 56, width: 440 } as DOMRect);
        pan(756, 0); pan(424, 0); expect(inset()).toBe('332px');
        // Re-tapping the focused field after dismissing the keyboard runs an
        // unsuppressed focus reveal from the field's pre-lift position: the
        // page pans to its 332px limit while the anchor still holds 332px.
        pan(424, 332); expect(inset()).toBe('332px'); expect(extension()).toBe('332px');
        vi.advanceTimersByTime(120); pan(424, 332); expect(inset()).toBe('332px');
        vi.advanceTimersByTime(400); flush();
        expect(inset()).toBe('0px'); expect(extension()).toBe('');
        // WebKit then reveals the caret once more; anchored again, not chased.
        pan(424, 386, 365.7); expect(inset()).toBe('0px'); expect(extension()).toBe('54px');
        pan(424, 386, 386); expect(inset()).toBe('0px'); expect(extension()).toBe('54px');
        header.remove();
    });
    it('keeps a panned header at the visible top without correcting an already fixed header twice', () => {
        const header = document.createElement('div');
        header.dataset.lmcSessionHeader = 'true'; document.body.prepend(header);
        vi.spyOn(header, 'clientWidth', 'get').mockReturnValue(820);
        let nativeTop = -77;
        vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({
            top: nativeTop + parseFloat(header.style.getPropertyValue('--lmc-session-header-offset') || '0'), width: 820,
        } as DOMRect));
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        vi.stubGlobal('scrollY', 77); vi.stubGlobal('innerHeight', 679);
        Object.assign(viewport, { height: 424, pageTop: 77, offsetTop: 77 });
        input.focus(); flush();
        expect(header.style.getPropertyValue('--lmc-session-header-offset')).toBe('77px');
        viewport.dispatchEvent(new Event('scroll')); flush();
        expect(header.style.getPropertyValue('--lmc-session-header-offset')).toBe('77px');
        nativeTop = 0;
        viewport.dispatchEvent(new Event('scroll')); flush();
        expect(header.style.getPropertyValue('--lmc-session-header-offset')).toBe('0px');
        input.blur(); flush();
        expect(header.style.getPropertyValue('--lmc-session-header-offset')).toBe('');
        header.remove();
    });
    it('lets a controlled iOS dock extend through shells, preserves real scrollers, and restores clipping on blur', () => {
        cleanup();
        vi.stubGlobal('navigator', { userAgent: 'iPhone AppleWebKit EdgiOS', platform: 'iPhone', maxTouchPoints: 5 });
        const shell = document.createElement('div');
        shell.style.overflow = 'hidden'; shell.style.overflowX = 'hidden'; shell.style.overflowY = 'hidden';
        document.body.appendChild(shell); shell.appendChild(container);
        const scroller = document.createElement('div'); scroller.style.overflowY = 'auto'; container.appendChild(scroller);
        input.dataset.lmcFocusScroll = 'controlled';
        cleanup = installWebComposerViewport(container);
        input.focus(); flush();
        expect(shell.style.overflow).toBe('visible');
        expect(document.body.style.overflow).toBe('visible');
        expect(scroller.style.overflowY).toBe('auto');
        expect(document.documentElement.style.overflow).not.toBe('visible');
        input.blur(); flush();
        expect(shell.style.overflow).toBe('hidden');
        expect(document.body.style.overflow).toBe('');
        container.remove(); shell.remove();
    });
    it('accounts for visual viewport panning without double counting the offset', () => {
        input.focus(); viewport.height = 450; viewport.offsetTop = 120;
        viewport.dispatchEvent(new Event('scroll')); flush();
        expect(inset()).toBe('510px');
    });
    it('does not count the iOS document scroll again as a visual-only offset', () => {
        input.focus();
        vi.stubGlobal('scrollY', 218);
        Object.assign(viewport, { height: 424, offsetTop: 218, pageTop: 218 });
        vi.mocked(container.getBoundingClientRect).mockReturnValue({ bottom: 538, width: 820 } as DOMRect);
        viewport.dispatchEvent(new Event('scroll')); flush();
        expect(inset()).toBe('114px');
        // Once the lift is applied, a later visual-only caret reveal must
        // move the field normally, rather than reduce its inset in response.
        Object.assign(viewport, { pageTop: 258, offsetTop: 40 });
        viewport.dispatchEvent(new Event('scroll')); flush();
        expect(inset()).toBe('114px');
    });
    it('does not add keyboard lift after native panning already reveals the full composer', () => {
        vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(756);
        vi.stubGlobal('innerHeight', 424);
        input.focus(); viewport.height = 424;
        for (const pan of [332, 346, 380, 332]) {
            vi.stubGlobal('scrollY', pan);
            Object.assign(viewport, { pageTop: pan - 0.3, offsetTop: 332 });
            // Normal-flow body retains its 756px height; its client rect
            // includes the native document pan, without any top correction.
            vi.mocked(container.getBoundingClientRect).mockReturnValue({ bottom: 756 - pan, width: 820 } as DOMRect);
            viewport.dispatchEvent(new Event('scroll')); flush();
            expect(inset()).toBe('0px');
            expect(container.style.getPropertyValue('--lmc-composer-max-height')).toBe('169px');
        }
    });
    it('recalculates after a clipped ancestor scrolls without any viewport resize', () => {
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('630px');
        vi.mocked(container.getBoundingClientRect).mockReturnValue({ bottom: 760, width: 820 } as DOMRect);
        document.body.dispatchEvent(new Event('scroll')); flush();
        expect(inset()).toBe('310px');
        expect(document.activeElement).toBe(input);
        // A root document pan has the same effect on the container's rect.
        vi.mocked(container.getBoundingClientRect).mockReturnValue({ bottom: 680, width: 820 } as DOMRect);
        document.dispatchEvent(new Event('scroll')); flush();
        expect(inset()).toBe('230px');
    });
    it('does not measure again for textarea or transcript scrolling and removes the ancestor listener', () => {
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        const measure = vi.mocked(container.getBoundingClientRect); measure.mockClear();
        const transcript = document.createElement('div'); container.appendChild(transcript);
        input.dispatchEvent(new Event('scroll')); transcript.dispatchEvent(new Event('scroll')); flush();
        expect(measure).not.toHaveBeenCalled();
        cleanup(); document.body.dispatchEvent(new Event('scroll')); flush();
        expect(measure).not.toHaveBeenCalled();
    });
    it('does not move an unfocused composer or fight pinch zoom', () => {
        viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('0px');
        input.focus(); viewport.scale = 2; flush();
        expect(inset()).toBe('0px');
    });
    it('does not counter-scroll against repeated browser caret reveals while typing', () => {
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        // WKWebView may pan independently of overflow:clip. A scroll handler
        // writing scrollTop=0 provokes a second caret reveal on the next key.
        // Preserve the browser's state and use geometry only for the dock.
        let browserPan = 0;
        const counterScroll = vi.fn((value: number) => { browserPan = value; });
        Object.defineProperty(document.body, 'scrollTop', {
            configurable: true, get: () => browserPan, set: counterScroll,
        });
        for (const pan of [24, 40, 24, 40]) {
            browserPan = pan;
            document.dispatchEvent(new Event('scroll')); flush();
            expect(document.activeElement).toBe(input);
        }
        expect(counterScroll).not.toHaveBeenCalled();
        delete (document.body as any).scrollTop;
    });
    it('stops focus panning in clipped shell ancestors without changing a real scroller', () => {
        const shell = document.createElement('div');
        const scroller = document.createElement('div');
        shell.style.overflow = 'hidden';
        // jsdom does not expand this shorthand in getComputedStyle.
        shell.style.overflowX = 'hidden'; shell.style.overflowY = 'hidden';
        scroller.style.overflowY = 'auto';
        document.body.appendChild(shell); shell.appendChild(scroller); scroller.appendChild(container);
        shell.scrollTop = 720; scroller.scrollTop = 42;
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        expect(shell.style.overflow).toBe('clip');
        // jsdom has no layout engine: CSS clipping doesn't reset its mock
        // scrollTop. Production browsers apply that constraint themselves.
        expect(shell.scrollTop).toBe(720);
        expect(scroller.style.overflowY).toBe('auto');
        expect(scroller.scrollTop).toBe(42);
        input.blur(); flush();
        expect(shell.style.overflow).toBe('hidden');
        container.remove(); shell.remove();
    });
    it('does not counteract a delayed native pan from the keyboard settle timer', () => {
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('630px');
        viewport.offsetTop = 120;
        vi.advanceTimersByTime(330);
        expect(inset()).toBe('630px');
        vi.advanceTimersByTime(700);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('still follows keyboard height changes without consuming later document pan', () => {
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('630px');
        vi.stubGlobal('scrollY', 54);
        vi.mocked(container.getBoundingClientRect).mockReturnValue({ bottom: 1026, width: 820 } as DOMRect);
        Object.assign(viewport, { pageTop: 54, offsetTop: 54 });
        for (const height of [500, 420, 1080]) {
            viewport.height = height; viewport.dispatchEvent(new Event('resize')); flush();
            expect(inset()).toBe(`${1080 - height}px`);
        }
        input.blur(); flush();
        expect(inset()).toBe('0px');
        // A later focus uses its current native position, not the old anchor.
        viewport.height = 450; input.focus(); flush();
        expect(inset()).toBe('576px');
    });
    it('rebases the native pan when rotation changes the pane width', () => {
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('630px');
        vi.stubGlobal('scrollY', 100);
        vi.spyOn(container, 'clientWidth', 'get').mockReturnValue(1080);
        vi.mocked(container.getBoundingClientRect).mockReturnValue({ bottom: 720, width: 1080 } as DOMRect);
        Object.assign(viewport, { height: 450, pageTop: 100, offsetTop: 100 });
        viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe('270px');
    });
    it('limits long drafts to leave room for controls and resets after blur', () => {
        input.focus(); viewport.height = 450; viewport.dispatchEvent(new Event('resize')); flush();
        expect(container.style.getPropertyValue('--lmc-composer-max-height')).toBe('180px');
        input.blur(); flush();
        expect(inset()).toBe('0px');
        expect(container.style.getPropertyValue('--lmc-composer-max-height')).toBe('');
    });
    it('coalesces a resize burst and removes all pending work on cleanup', () => {
        input.focus(); flush();
        const request = vi.spyOn(window, 'requestAnimationFrame');
        const cancel = vi.spyOn(window, 'cancelAnimationFrame');
        for (let i = 0; i < 100; i++) viewport.dispatchEvent(new Event('resize'));
        expect(request).toHaveBeenCalledTimes(1);
        cleanup(); flush();
        expect(cancel).toHaveBeenCalledWith(request.mock.results[0].value);
        expect(inset()).toBe('');
        viewport.dispatchEvent(new Event('resize')); flush();
        expect(inset()).toBe(''); expect(request).toHaveBeenCalledTimes(1);
    });
});
