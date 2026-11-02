// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { normalizeClonedDocumentColors, normalizeCssColorValue, resolveCssColorFunction } from './messageImage.web';
import { readingStyles } from '@/components/markdown/readingStyles';

vi.mock('@/text', () => ({ t: (key: string) => key }));

describe('messageImage.web CSS Color 4/5 normalization', () => {
    it('converts color(srgb ...), color(srgb-linear ...), and color(display-p3 ...) into rgb/rgba', () => {
        expect(resolveCssColorFunction('color(srgb 0 0.376471 0.941176)', null)).toBe('rgb(0, 96, 240)');
        expect(resolveCssColorFunction('color(srgb 0 0.376471 0.941176 / 0.45)', null)).toBe('rgba(0, 96, 240, 0.45)');
        expect(resolveCssColorFunction('color(srgb 100% 50% none / 50%)', null)).toBe('rgba(255, 128, 0, 0.5)');
        expect(resolveCssColorFunction('color(srgb 0.2 0.4 0.8 / 0)', null)).toBe('rgba(0, 0, 0, 0)');
        expect(resolveCssColorFunction('color(srgb-linear 1 0 0)', null)).toBe('rgb(255, 0, 0)');
        expect(resolveCssColorFunction('color(display-p3 0 0 1 / 0.8)', null)).toMatch(/^rgba\(\d+, \d+, 255, 0\.8\)$/);
    });

    it('uses a 1x1 2D canvas pixel sample for color-mix(...) and oklch(...)', () => {
        const fakeCtx = {
            clearRect: vi.fn(),
            fillRect: vi.fn(),
            fillStyle: '',
            getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([37, 99, 235, 102]) })),
        } as unknown as CanvasRenderingContext2D;

        expect(resolveCssColorFunction('color-mix(in srgb, #2563eb 40%, transparent)', fakeCtx)).toBe('rgba(37, 99, 235, 0.4)');
        expect(resolveCssColorFunction('oklch(0.62 0.19 259 / 0.4)', fakeCtx)).toBe('rgba(37, 99, 235, 0.4)');
    });

    it('normalizes nested color functions inside compound CSS values without altering property names', () => {
        const resolver = (expr: string) => expr.startsWith('color(')
            ? resolveCssColorFunction(expr, null)
            : 'rgba(0, 96, 240, 0.35)';

        expect(normalizeCssColorValue('0px 8px 24px color(srgb 0 0 0 / 0.12)', resolver))
            .toBe('0px 8px 24px rgba(0, 0, 0, 0.12)');
        expect(normalizeCssColorValue('linear-gradient(180deg, color-mix(in srgb, rgb(0, 96, 240) 35%, transparent), rgba(0, 0, 0, 0))', resolver))
            .toBe('linear-gradient(180deg, rgba(0, 96, 240, 0.35), rgba(0, 0, 0, 0))');
        expect(normalizeCssColorValue('background-color: #ffffff;', resolver))
            .toBe('background-color: #ffffff;');
    });

    it('scrubs both computed color(srgb ...) properties and readingStyles color-mix(...) rules on cloned documents', () => {
        const doc = document.implementation.createHTMLDocument('clone');
        const styleEl = doc.createElement('style');
        styleEl.textContent = readingStyles;
        doc.head.appendChild(styleEl);

        const prose = doc.createElement('div');
        prose.setAttribute('data-lmc-prose', 'prose');
        const link = doc.createElement('a');
        link.setAttribute('data-lmc-link', 'true');
        link.textContent = 'Link';
        prose.appendChild(link);
        doc.body.appendChild(prose);

        const realGetComputedStyle = window.getComputedStyle.bind(window);
        vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
            const base = realGetComputedStyle(el);
            if (el === link) {
                return {
                    getPropertyValue: (prop: string) => prop === 'text-decoration-color'
                        ? 'color(srgb 0 0.376471 0.941176 / 0.45)'
                        : base.getPropertyValue(prop),
                } as CSSStyleDeclaration;
            }
            return base;
        });

        normalizeClonedDocumentColors(doc, (expr) => expr.startsWith('color(')
            ? resolveCssColorFunction(expr, null)
            : 'rgba(0, 96, 240, 0.45)');

        expect(link.style.getPropertyValue('text-decoration-color')).toBe('rgba(0, 96, 240, 0.45)');
        expect(styleEl.textContent).not.toMatch(/color-mix\s*\(/i);
        vi.restoreAllMocks();
    });
});
