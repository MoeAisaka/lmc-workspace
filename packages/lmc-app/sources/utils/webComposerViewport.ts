import { readVisualViewportPageTop, usesNativeWebKitKeyboardPan } from './browserLayoutViewport';

// iOS WebKit (UI process, _keyboardChangedWithInfo -> _scrollToAndRevealSelectionIfNeeded)
// judges caret visibility against "web view height minus keyboard height", not
// the keyboard's position. In browsers whose web view ends above the screen
// bottom this hides a strip that is really visible, and WebKit pans the page
// once the keyboard settles. The strip height is a per-browser constant; once a
// settled reveal exposes it, remember it and pre-lift the field next time so
// WebKit has nothing to reveal.
// v2: a v1 value could have ratcheted up to its cap (see learnRevealGap), so
// those are left behind rather than read.
const REVEAL_GAP_KEY = 'lmc.ios-keyboard-reveal-gap.v2';
/** The strip is the browser's bottom chrome counted as keyboard: tens of points, never a third of the screen. */
export const MAX_REVEAL_GAP = 120;
const revealGapScope = () => `${navigator.userAgent}|${screen.height}|${document.documentElement.clientHeight}`;
export type LearnedKeyboard = { gap: number; keyboardHeight: number; misses: number; disabled: boolean };
const UNLEARNED: LearnedKeyboard = { gap: 0, keyboardHeight: 0, misses: 0, disabled: false };
export function readLearnedRevealGap(): LearnedKeyboard {
    try {
        const raw = localStorage.getItem(REVEAL_GAP_KEY);
        if (!raw) return UNLEARNED;
        const parsed = JSON.parse(raw) as { scope?: string; gap?: number; keyboardHeight?: number; misses?: number; disabled?: boolean };
        if (parsed.scope !== revealGapScope() || !Number.isFinite(parsed.gap)) return UNLEARNED;
        const misses = Number.isFinite(parsed.misses) ? Math.max(0, parsed.misses!) : 0;
        if (parsed.disabled === true) return { gap: 0, keyboardHeight: 0, misses, disabled: true };
        return { gap: Math.min(MAX_REVEAL_GAP, Math.max(0, parsed.gap!)), keyboardHeight: Number.isFinite(parsed.keyboardHeight) ? Math.max(0, parsed.keyboardHeight!) : 0, misses, disabled: false };
    } catch { return UNLEARNED; }
}
function writeLearnedRevealGap(learned: LearnedKeyboard) {
    try { localStorage.setItem(REVEAL_GAP_KEY, JSON.stringify({ scope: revealGapScope(), gap: Math.round(learned.gap), keyboardHeight: Math.round(learned.keyboardHeight), misses: learned.misses, disabled: learned.disabled })); } catch { /* storage unavailable */ }
}
/**
 * What one settled WebKit pan teaches.
 *
 * From a flush dock the pan is the strip, and it is remembered so the next
 * open can lift the field there first. A pan that happens although the field
 * was already lifted by the remembered strip means lifting does not satisfy
 * this browser. It must never be added on top: up to v305 it was, each open
 * lifted further, and on iPhone Safari the composer climbed to the cap and sat
 * under the header with a third of the screen empty below it (2026-10-08).
 * Two opens in a row like that and this browser goes back to plain anchoring.
 */
export function learnRevealGap(current: LearnedKeyboard, observedExtension: number, keyboardHeight: number): LearnedKeyboard {
    if (current.disabled) return current;
    if (current.gap === 0 && observedExtension <= MAX_REVEAL_GAP) return { gap: observedExtension, keyboardHeight, misses: 0, disabled: false };
    const misses = current.misses + 1;
    return misses >= 2 ? { gap: 0, keyboardHeight: 0, misses, disabled: true } : { ...current, misses };
}
/** The keyboard is about to appear for this field (first touch, or a tap after
 * dismissal). WebKit checks caret visibility while the keyboard frame is still
 * changing, before the page receives any viewport event; a remembered keyboard
 * lets the dock lift first so there is nothing to reveal. */
export const KEYBOARD_EXPECTED_EVENT = 'lmc-keyboard-expected';

/** Keep a focused web composer in the visual viewport without moving/replacing
 * its DOM node, asking for focus again, or rendering the transcript per frame. */
export function installWebComposerViewport(container: HTMLElement): () => void {
    const viewport = window.visualViewport;
    if (!viewport) return () => {};
    const nativeKeyboardPan = usesNativeWebKitKeyboardPan();
    let frame: number | null = null;
    let settleTimers: ReturnType<typeof setTimeout>[] = [];
    let focusedField: Element | null = null;
    let panAtLift: number | null = null;
    let widthAtLift: number | null = null;
    let touching = false;
    let pannedByTouch = false;
    let keyboardSeenFor: Element | null = null;
    let keyboardWasVisible = false;
    let learnTimer: ReturnType<typeof setTimeout> | null = null;
    let learnCandidate: number | null = null;
    let learned = readLearnedRevealGap();
    let learnedGap = learned.gap;
    // Whether this keyboard open saw a pan the remembered strip should have prevented.
    let missedThisOpen = false;
    let anticipateUntil = 0;
    let anticipateTimer: ReturnType<typeof setTimeout> | null = null;
    const clearAnticipate = () => { if (anticipateTimer !== null) clearTimeout(anticipateTimer); anticipateTimer = null; anticipateUntil = 0; };
    const clearLearn = () => { if (learnTimer !== null) clearTimeout(learnTimer); learnTimer = null; learnCandidate = null; };
    let obscuredSince: number | null = null;
    let obscuredTimer: ReturnType<typeof setTimeout> | null = null;
    const clearObscured = () => {
        obscuredSince = null;
        if (obscuredTimer !== null) clearTimeout(obscuredTimer);
        obscuredTimer = null;
    };
    let header: HTMLElement | null = null;
    let headerOffset = 0;
    const resetChrome = () => {
        header?.style.removeProperty('--lmc-session-header-offset');
        header = null;
        headerOffset = 0;
    };
    const overflowProperties = ['overflow', 'overflow-x', 'overflow-y'] as const;
    const clipped = new Map<HTMLElement, { name: string; value: string; priority: string }[]>();
    let clippingMode: 'clip' | 'visible' | null = null;
    const restoreClipping = () => {
        clipped.forEach((previous, element) => {
            if (element.style.getPropertyValue('overflow') !== clippingMode) return;
            overflowProperties.forEach(name => element.style.removeProperty(name));
            previous.forEach(({ name, value, priority }) => {
                if (value) element.style.setProperty(name, value, priority);
            });
        });
        clipped.clear();
        clippingMode = null;
    };
    const lockOuterScroll = (controlledNativeFocus: boolean) => {
        // Visible shells are not scroll containers either. A controlled iOS
        // dock may extend below the body's panned box to meet the keyboard;
        // clipping those shells would leave a correctly positioned but inert
        // send button. The root viewport still clips the page normally.
        const overflow = controlledNativeFocus ? 'visible' : 'clip';
        if (clippingMode && clippingMode !== overflow) restoreClipping();
        clippingMode = overflow;
        // overflow:hidden still permits focus/programmatic scrolling. That
        // can pan the whole app past the keyboard and leave an empty viewport;
        // changing the composer's inset alone cannot recover a clipped parent.
        // Only lock non-scrolling shell ancestors, never transcript/draft
        // scrollers (auto/scroll), and restore their styles when editing ends.
        for (let element = container.parentElement; element; element = element.parentElement) {
            const root = element === document.body || element === document.documentElement;
            // The iOS keyboard pans the root natively. Changing its clip while
            // that pan is in progress can also clip the composer's controls.
            // Nested navigation shells still must not scroll independently.
            if (root && nativeKeyboardPan && (!controlledNativeFocus || element !== document.body)) continue;
            // Navigation can replace an inline shell style during rotation.
            // Treat that as the new value to restore, rather than keeping a
            // stale lock record and overwriting the navigation's later change.
            if (clipped.has(element) && element.style.getPropertyValue('overflow') !== overflow) clipped.delete(element);
            if (!clipped.has(element)) {
                const style = getComputedStyle(element);
                if (!root && !(style.overflowY === 'hidden' && style.overflowX === 'hidden')) continue;
                clipped.set(element, overflowProperties.map(name => ({
                    name, value: element.style.getPropertyValue(name),
                    priority: element.style.getPropertyPriority(name),
                })));
                element.style.setProperty('overflow', overflow, 'important');
            }
            // Do not counter-scroll here. iOS can pan to reveal the caret
            // even with overflow clipped; resetting scrollTop from its scroll
            // event fights that reveal on every keystroke. CSS prevents normal
            // shell scrolling; any remaining browser pan is read below only.
        }
    };
    const set = (name: string, value: string) => {
        if (container.style.getPropertyValue(name) !== value) container.style.setProperty(name, value);
    };
    const update = () => {
        frame = null;
        const active = document.activeElement;
        const editing = active instanceof HTMLElement && container.contains(active)
            && (active.matches('textarea, input') || active.isContentEditable);
        // Pinch zoom is browser navigation, not a keyboard occlusion. Let the
        // browser pan normally instead of chasing it with composer movement.
        if (!editing || Math.abs(viewport.scale - 1) > 0.05) {
            if (keyboardSeenFor instanceof HTMLElement) delete keyboardSeenFor.dataset.lmcKeyboardDismissed;
            keyboardSeenFor = null;
            keyboardWasVisible = false;
            focusedField = null;
            panAtLift = widthAtLift = null;
            clearObscured();
            clearLearn();
            clearAnticipate();
            setPagePanBlocked(false);
            restoreClipping();
            resetChrome();
            set('--lmc-keyboard-inset', '0px');
            container.style.removeProperty('--lmc-composer-max-height');
            container.style.removeProperty('--lmc-dock-extension');
            return;
        }
        const controlledNativeFocus = nativeKeyboardPan && active.dataset.lmcFocusScroll === 'controlled';
        lockOuterScroll(controlledNativeFocus);
        if (!header?.isConnected) {
            header = null;
            headerOffset = 0;
            for (let parent = container.parentElement; parent; parent = parent.parentElement) {
                header = parent.querySelector<HTMLElement>('[data-lmc-session-header]');
                if (header) break;
            }
        }
        const rect = container.getBoundingClientRect();
        const zoom = container.clientWidth > 0 ? rect.width / container.clientWidth : 1;
        if (!Number.isFinite(zoom) || zoom <= 0 || viewport.height <= 0) return;
        if (active !== focusedField || (widthAtLift !== null && Math.abs(rect.width - widthAtLift) > 1)) {
            // A new field or a rotated/resized pane has a new native baseline.
            panAtLift = widthAtLift = null;
            focusedField = active;
        }
        const pageTop = readVisualViewportPageTop(viewport);
        // A finger pan with the keyboard open is the user's choice; follow the
        // visible bottom again once it ends. WebKit's own caret reveals have
        // no touch and must not be followed (see below).
        if (touching && controlledNativeFocus && panAtLift !== null && Math.abs(pageTop - panAtLift) > 1) pannedByTouch = true;
        // Account for native pan once, when first adding keyboard avoidance.
        // Afterwards keep the field's document position independent of pan:
        // reducing the inset on each caret reveal moves the field back down,
        // causing WebKit to reveal it again on the next input (v291 trace).
        // Keyboard height and real pane geometry may still change the inset.
        const documentBottom = rect.bottom + window.scrollY;
        // Mobile WebKit reveals the caret as part of opening/using its native
        // keyboard, sometimes AFTER the first viewport resize. Lifting here
        // first makes that later pan move the field twice (v283-v293).
        // Let its native focus reveal run; only other engines need this lift.
        // A touch focused with preventScroll skips WebKit's focus-time reveal,
        // so the dock lifts to the keyboard at scrollY=0 (v295 trace). WebKit
        // still reveals the caret while typing. Following the visible bottom
        // back down on each reveal re-exposed the same caret position, and the
        // page crept 419px in six reveals (v295 device trace). Keep the
        // field's document position after the lift; let the dock backdrop
        // extend down to the visible bottom instead. Only a field that stays
        // hidden after the pan settles is lifted again.
        const nativeKeyboardVisible = viewport.height < document.documentElement.clientHeight - 80;
        // The soft keyboard can be dismissed while the field keeps focus. A
        // later tap then re-focuses natively without preventScroll; the field
        // handles that tap itself when this marker is present. A hardware
        // keyboard never sets it, so ordinary taps keep native caret placement.
        if (nativeKeyboardPan) {
            if (nativeKeyboardVisible) { keyboardSeenFor = active; delete active.dataset.lmcKeyboardDismissed; }
            else if (keyboardSeenFor === active) active.dataset.lmcKeyboardDismissed = 'true';
        }
        // The visible -> hidden edge ends any pending expectation from this
        // focus; a later tap announces the next keyboard explicitly.
        if (nativeKeyboardVisible) keyboardWasVisible = true;
        else if (keyboardWasVisible) {
            keyboardWasVisible = false; clearAnticipate();
            // The keyboard has gone: the remembered strip may change now without
            // moving anything on screen. An open that needed no extra pan also
            // clears an earlier miss, so only two in a row switch the lift off.
            if (!missedThisOpen && learned.misses > 0 && !learned.disabled) { learned = { ...learned, misses: 0 }; writeLearnedRevealGap(learned); }
            missedThisOpen = false;
            learnedGap = learned.gap;
        }
        const visibleInset = (documentBottom - pageTop - viewport.height) / zoom;
        // A controlled lift anchors `learnedGap` above the visible bottom, so a
        // remembered WebKit reveal needs no page pan at all.
        // Before the keyboard arrives, a remembered keyboard height stands in
        // for the visual viewport. If no keyboard follows (hardware keyboard,
        // cancelled focus) the anticipation lapses and the dock drops back.
        const anticipating = controlledNativeFocus && !nativeKeyboardVisible && learned.keyboardHeight > 0 && Date.now() < anticipateUntil;
        const effectiveHeight = anticipating ? document.documentElement.clientHeight - learned.keyboardHeight : viewport.height;
        const controlledKeyboard = controlledNativeFocus && (nativeKeyboardVisible || anticipating);
        setPagePanBlocked(controlledNativeFocus && nativeKeyboardVisible);
        const anchorFor = (top: number) => controlledKeyboard ? top - learnedGap : top;
        let inset = nativeKeyboardPan && !controlledKeyboard ? 0
            : Math.max(0, (documentBottom - (panAtLift ?? anchorFor(pageTop)) - effectiveHeight) / zoom);
        let extension = 0;
        if (anticipating) {
            extension = learnedGap;
            if (anticipateTimer === null) anticipateTimer = setTimeout(() => { anticipateTimer = null; schedule(); }, Math.max(16, anticipateUntil - Date.now() + 1));
        } else if (controlledNativeFocus && nativeKeyboardVisible) {
            // WebKit can also pan far past the field: re-tapping an already
            // focused field after the keyboard was dismissed runs its focus
            // reveal without preventScroll, from the field's pre-lift
            // position (v296 device screenshot: controls under the header,
            // field above it, blank page below). Holding the anchor there
            // keeps the field invisible, so treat it like an occlusion.
            const fieldRect = active.getBoundingClientRect();
            const visualTop = pageTop - window.scrollY;
            const headerHeight = header?.isConnected ? header.getBoundingClientRect().height : 0;
            const hiddenAbove = fieldRect.height > 0 && fieldRect.bottom < visualTop + headerHeight + 1;
            if (visibleInset > inset + 1 || hiddenAbove) {
                // Hidden below the keyboard. A reveal in progress may still be
                // moving the page; re-anchor only once it has stayed hidden.
                const now = Date.now();
                obscuredSince ??= now;
                if (now - obscuredSince >= 350) {
                    panAtLift = anchorFor(pageTop);
                    inset = Math.max(0, visibleInset + learnedGap);
                    clearObscured();
                } else if (obscuredTimer === null) {
                    obscuredTimer = setTimeout(() => { obscuredTimer = null; schedule(); }, 350 - (now - obscuredSince));
                }
            } else {
                clearObscured();
            }
            extension = Math.max(0, inset - visibleInset);
            // Remember the strip WebKit insisted on once the pan has settled
            // and nothing is hidden or being dragged. Only a real reveal
            // teaches; a plain re-anchor (extension 0) keeps the old value.
            const candidate = Math.round(extension);
            // Only a page pan WebKit performed after the lift teaches. A shell
            // or container moving under the dock also changes the extension
            // without any pan; that must not become a remembered strip.
            const panSinceLift = panAtLift === null ? 0 : pageTop - panAtLift - learnedGap;
            const fromPanAlone = panSinceLift > 0.5 && Math.abs(extension - (learnedGap + panSinceLift)) < 1;
            const teachable = fromPanAlone && !touching && !pannedByTouch && obscuredSince === null && candidate !== learnedGap && !learned.disabled && !missedThisOpen;
            if (!teachable) clearLearn();
            else if (candidate !== learnCandidate) {
                // Settle re-measurements with the same value must not restart the wait.
                clearLearn();
                learnCandidate = candidate;
                const keyboardHeight = document.documentElement.clientHeight - viewport.height;
                learnTimer = setTimeout(() => {
                    learnTimer = null; learnCandidate = null;
                    const next = learnRevealGap(learned, candidate, keyboardHeight);
                    if (next === learned) return;
                    if (next.misses > learned.misses) missedThisOpen = true;
                    // A first lesson matches where the dock already is. A miss or
                    // a switch-off must not move the dock mid-keyboard: the new
                    // strip applies from the next open (see the hide edge).
                    else learnedGap = next.gap;
                    learned = next;
                    writeLearnedRevealGap(learned);
                }, 400);
            }
        } else {
            clearObscured();
            clearLearn();
        }
        if (inset > 0) {
            panAtLift ??= anchorFor(pageTop);
            widthAtLift = rect.width;
        } else {
            panAtLift = widthAtLift = null;
        }
        if (extension > 0) set('--lmc-dock-extension', `${Math.ceil(extension)}px`);
        else container.style.removeProperty('--lmc-dock-extension');
        set('--lmc-keyboard-inset', `${Math.ceil(inset)}px`);
        set('--lmc-composer-max-height', `${Math.max(44, Math.floor(viewport.height * 0.4 / zoom))}px`);

        const keyboardVisible = inset > 0 || viewport.height < document.documentElement.clientHeight - 80;
        if (!keyboardVisible) {
            resetChrome();
            return;
        }
        // A fixed header can still belong to WebKit's panned layout viewport.
        // Correct only that sibling, never the app/body or the focused field.
        // Measure the uncorrected position so engines that already pin it do
        // not receive a second offset, including after rotation / chrome resize.
        if (header) {
            const headerRect = header.getBoundingClientRect();
            const headerZoom = header.clientWidth > 0 ? headerRect.width / header.clientWidth : zoom;
            if (headerZoom > 0 && Number.isFinite(headerZoom)) {
                headerOffset = Math.round((headerOffset + (pageTop - window.scrollY - headerRect.top) / headerZoom) * 64) / 64;
                const value = `${headerOffset}px`;
                if (header.style.getPropertyValue('--lmc-session-header-offset') !== value) {
                    header.style.setProperty('--lmc-session-header-offset', value);
                }
            }
        }
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    const settle = () => {
        settleTimers.forEach(clearTimeout);
        schedule();
        // WebKit can deliver resize before its geometry settles and omit a
        // final event. Sample only this bounded transition;
        // ordinary input/composition/selection events do no geometry work.
        settleTimers = [100, 300, 700].map(delay => setTimeout(schedule, delay));
    };
    const ancestorScroll = (event: Event) => {
        // A nested shell can move without a viewport resize; remeasure its
        // real document geometry. Root pan is removed from that measurement
        // above. Transcript/textarea scrolls must not add work while typing.
        const target = event.target;
        if (target === document || target === window
            || (target instanceof HTMLElement && target.contains(container))) schedule();
    };
    const visible = () => { if (document.visibilityState !== 'hidden') settle(); };
    const expectKeyboard = (event: Event) => {
        if (!(event.target instanceof Element) || !container.contains(event.target)) return;
        anticipateUntil = Date.now() + 700;
        schedule();
    };
    // With the keyboard up the page is taller than what is visible, so iOS lets
    // a finger drag the whole page: the composer slides off under the header and
    // an empty page follows the finger (device recording, 2026-10-08). A finger
    // may scroll what scrolls, the transcript or a long draft, and nothing else.
    let pagePanBlocked = false;
    let touchVertical = false, touchHorizontal = false, touchEditable = false;
    let touchX = 0, touchY = 0, touchDecision: 'native' | 'blocked' | null = null;
    const contained = new Map<HTMLElement, string>();
    const classifyTouch = (target: EventTarget | null) => {
        touchVertical = touchHorizontal = false;
        touchEditable = target instanceof HTMLElement && (target.matches('textarea, input') || target.isContentEditable);
        for (let el = target instanceof Element ? target : null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
            if (!(el instanceof HTMLElement)) continue;
            const style = getComputedStyle(el);
            if (/auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) touchHorizontal = true;
            if (/auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
                touchVertical = true;
                // At either end the scroll must stop here instead of carrying on into the page.
                if (!contained.has(el)) { contained.set(el, el.style.overscrollBehaviorY); el.style.overscrollBehaviorY = 'contain'; }
                return;
            }
        }
    };
    const touchMove = (event: TouchEvent) => {
        if (!pagePanBlocked || event.touches.length !== 1 || !event.cancelable) return;
        // Caret and selection gestures inside a field stay the browser's.
        if (touchVertical || touchEditable) return;
        if (touchDecision === null) {
            const touch = event.touches[0];
            touchDecision = touchHorizontal && Math.abs(touch.clientX - touchX) > Math.abs(touch.clientY - touchY) ? 'native' : 'blocked';
        }
        if (touchDecision === 'blocked') event.preventDefault();
    };
    const setPagePanBlocked = (next: boolean) => {
        if (next === pagePanBlocked) return;
        pagePanBlocked = next;
        // Not passive, so it is only attached while it has something to prevent.
        if (next) document.addEventListener('touchmove', touchMove, { capture: true, passive: false });
        else {
            document.removeEventListener('touchmove', touchMove, true);
            for (const [el, previous] of contained) el.style.overscrollBehaviorY = previous;
            contained.clear();
        }
    };
    const touchStart = (event: TouchEvent) => {
        touching = true;
        touchDecision = null;
        const touch = event.touches?.[0];
        if (touch) { touchX = touch.clientX; touchY = touch.clientY; }
        if (pagePanBlocked) classifyTouch(event.target);
    };
    const touchEnd = (event: TouchEvent) => {
        if (event.touches.length > 0) return;
        touching = false;
        if (pannedByTouch) { pannedByTouch = false; panAtLift = null; settle(); }
    };
    document.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    document.addEventListener('touchend', touchEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', touchEnd, { capture: true, passive: true });
    viewport.addEventListener('resize', settle);
    viewport.addEventListener('scroll', schedule);
    window.addEventListener('resize', settle);
    window.addEventListener('pageshow', settle);
    window.addEventListener('scroll', ancestorScroll, { capture: true, passive: true });
    document.addEventListener('focusin', expectKeyboard, true);
    document.addEventListener(KEYBOARD_EXPECTED_EVENT, expectKeyboard, true);
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    document.addEventListener('visibilitychange', visible);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    observer?.observe(container);
    update();
    return () => {
        if (frame !== null) cancelAnimationFrame(frame);
        settleTimers.forEach(clearTimeout);
        clearObscured();
        clearLearn();
        clearAnticipate();
        setPagePanBlocked(false);
        restoreClipping();
        resetChrome();
        observer?.disconnect();
        viewport.removeEventListener('resize', settle);
        viewport.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', settle);
        window.removeEventListener('pageshow', settle);
        window.removeEventListener('scroll', ancestorScroll, true);
        document.removeEventListener('focusin', expectKeyboard, true);
        document.removeEventListener(KEYBOARD_EXPECTED_EVENT, expectKeyboard, true);
        document.removeEventListener('focusin', settle);
        document.removeEventListener('focusout', settle);
        document.removeEventListener('visibilitychange', visible);
        document.removeEventListener('touchstart', touchStart, true);
        document.removeEventListener('touchend', touchEnd, true);
        document.removeEventListener('touchcancel', touchEnd, true);
        container.style.removeProperty('--lmc-keyboard-inset');
        container.style.removeProperty('--lmc-composer-max-height');
        container.style.removeProperty('--lmc-dock-extension');
    };
}
