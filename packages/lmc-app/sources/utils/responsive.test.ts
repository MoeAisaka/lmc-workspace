// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    platform: { OS: 'web', isPad: false },
    size: { width: 932, height: 430, scale: 1, fontScale: 1 },
}));
vi.mock('react-native', () => ({
    Platform: native.platform,
    Dimensions: { get: () => native.size },
    useWindowDimensions: () => native.size,
}));
vi.mock('./platform', () => ({ isRunningOnMac: () => false }));

import { getDeviceType, useDeviceType } from './responsive';

describe('responsive layout viewport', () => {
    let root: Root;
    let container: HTMLDivElement;
    let wide: boolean;
    let query: MediaQueryList;

    function Probe() {
        return createElement('output', null, useDeviceType());
    }

    beforeEach(() => {
        native.platform.OS = 'web';
        native.platform.isPad = false;
        native.size = { width: 932, height: 430, scale: 1, fontScale: 1 };
        wide = false;
        query = new EventTarget() as MediaQueryList;
        Object.defineProperty(query, 'matches', { get: () => wide });
        vi.stubGlobal('matchMedia', () => query);
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('uses the portrait CSS viewport when RN still reports landscape dimensions', () => {
        act(() => root.render(createElement(Probe)));
        expect(getDeviceType()).toBe('phone');
        expect(container.textContent).toBe('phone');
    });

    it('follows CSS breakpoint changes even when RN dimensions never change', () => {
        act(() => root.render(createElement(Probe)));
        for (const next of [true, false, true]) {
            act(() => {
                wide = next;
                query.dispatchEvent(new Event('change'));
            });
            expect(container.textContent).toBe(next ? 'tablet' : 'phone');
            expect(getDeviceType()).toBe(next ? 'tablet' : 'phone');
        }
    });

    it.each(['pageshow', 'focus', 'resize', 'visibilitychange'])(
        'rechecks on %s when the breakpoint event was missed while suspended',
        (event) => {
            wide = true;
            act(() => root.render(createElement(Probe)));
            expect(container.textContent).toBe('tablet');
            act(() => {
                wide = false;
                const target = event === 'visibilitychange' ? document : window;
                target.dispatchEvent(new Event(event));
            });
            expect(container.textContent).toBe('phone');
        }
    );

    it('renders the phone shell during SSR and reads the real breakpoint on mount', () => {
        wide = true;
        expect(renderToString(createElement(Probe))).toContain('phone');
        act(() => root.render(createElement(Probe)));
        expect(container.textContent).toBe('tablet');
    });

    it.each(['ios', 'android'])('keeps native %s sizing independent of CSS media queries', (platform) => {
        native.platform.OS = platform;
        native.size = { width: 390, height: 844, scale: 3, fontScale: 1 };
        wide = true;
        act(() => root.render(createElement(Probe)));
        expect(container.textContent).toBe('phone');
        expect(getDeviceType()).toBe('phone');
    });
});
