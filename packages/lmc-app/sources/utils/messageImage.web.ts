import html2canvas from 'html2canvas';
import { t } from '@/text';

const UNSUPPORTED_COLOR_FN_RE = /(^|[\s,:;(])((?:color-mix|color|oklch|oklab|lch|lab|hwb|light-dark)\s*\()/i;
const COLOR_PROPERTIES = [
    'color',
    'background-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'text-decoration-color',
    '-webkit-text-stroke-color',
    'box-shadow',
    'text-shadow',
    'background-image',
] as const;

let sharedColorCanvasCtx: CanvasRenderingContext2D | null | undefined;

function getColorCanvasContext(doc: Document = document): CanvasRenderingContext2D | null {
    if (sharedColorCanvasCtx !== undefined) return sharedColorCanvasCtx;
    try {
        const canvas = doc.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        sharedColorCanvasCtx = canvas.getContext('2d', { willReadFrequently: true });
    } catch {
        sharedColorCanvasCtx = null;
    }
    return sharedColorCanvasCtx;
}

function clampByte(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(255, Math.max(0, Math.round(value)));
}

function linearToSrgb(channel: number): number {
    const clamped = Math.min(1, Math.max(0, channel));
    return clamped <= 0.0031308
        ? 12.92 * clamped
        : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function srgbToLinear(channel: number): number {
    const clamped = Math.min(1, Math.max(0, channel));
    return clamped <= 0.04045
        ? clamped / 12.92
        : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

function parseColorChannel(raw: string): number | null {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === 'none') return 0;
    if (trimmed.endsWith('%')) {
        const pct = Number.parseFloat(trimmed.slice(0, -1));
        return Number.isFinite(pct) ? pct / 100 : null;
    }
    const num = Number.parseFloat(trimmed);
    return Number.isFinite(num) ? num : null;
}

function formatRgba(r: number, g: number, b: number, alpha: number): string {
    const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
    if (a <= 0) return 'rgba(0, 0, 0, 0)';
    if (a >= 0.99995) return `rgb(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)})`;
    return `rgba(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)}, ${Number(a.toFixed(4))})`;
}

function parseCssColorSpaceFunction(expr: string): string | null {
    const match = expr.trim().match(/^color\(\s*([a-z0-9-]+)\s+([^)]*)\)$/i);
    if (!match) return null;
    const space = match[1].toLowerCase();
    const rest = match[2].trim();
    const slashIndex = rest.indexOf('/');
    const channelsPart = (slashIndex >= 0 ? rest.slice(0, slashIndex) : rest).trim();
    const alphaPart = slashIndex >= 0 ? rest.slice(slashIndex + 1).trim() : null;
    const parts = channelsPart.split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const c1 = parseColorChannel(parts[0]);
    const c2 = parseColorChannel(parts[1]);
    const c3 = parseColorChannel(parts[2]);
    const alpha = alphaPart !== null ? parseColorChannel(alphaPart) : 1;
    if (c1 === null || c2 === null || c3 === null || alpha === null) return null;

    if (space === 'srgb') {
        return formatRgba(c1 * 255, c2 * 255, c3 * 255, alpha);
    }
    if (space === 'srgb-linear') {
        return formatRgba(linearToSrgb(c1) * 255, linearToSrgb(c2) * 255, linearToSrgb(c3) * 255, alpha);
    }
    if (space === 'display-p3') {
        const lr = srgbToLinear(c1);
        const lg = srgbToLinear(c2);
        const lb = srgbToLinear(c3);
        const sr = 1.2249401 * lr - 0.2249404 * lg;
        const sg = -0.0420569 * lr + 1.0420571 * lg;
        const sb = -0.0196376 * lr - 0.0786361 * lg + 1.0982735 * lb;
        return formatRgba(linearToSrgb(sr) * 255, linearToSrgb(sg) * 255, linearToSrgb(sb) * 255, alpha);
    }
    return null;
}

/** Resolve a modern CSS Color 4/5 function expression into rgb(...) / rgba(...) for html2canvas. */
export function resolveCssColorFunction(
    expr: string,
    ctx: CanvasRenderingContext2D | null = typeof document !== 'undefined' ? getColorCanvasContext() : null,
): string {
    const direct = parseCssColorSpaceFunction(expr);
    if (direct) return direct;
    if (ctx) {
        try {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = 'rgba(0, 0, 0, 0)';
            ctx.fillStyle = expr;
            ctx.fillRect(0, 0, 1, 1);
            const data = ctx.getImageData(0, 0, 1, 1).data;
            return formatRgba(data[0], data[1], data[2], data[3] / 255);
        } catch {
            // Fall through to safe transparent fallback below.
        }
    }
    return 'rgba(0, 0, 0, 0)';
}

/** Replace any unsupported CSS Color 4/5 functions inside a CSS property value or stylesheet text. */
export function normalizeCssColorValue(
    value: string,
    resolve: (expr: string) => string = (expr) => resolveCssColorFunction(expr),
): string {
    if (!value || !UNSUPPORTED_COLOR_FN_RE.test(value)) return value;
    let out = '';
    let cursor = 0;
    const fnPattern = /(^|[\s,:;(])((?:color-mix|color|oklch|oklab|lch|lab|hwb|light-dark)\s*\()/gi;
    let match: RegExpExecArray | null;
    while ((match = fnPattern.exec(value)) !== null) {
        const prefix = match[1];
        const fnStart = match.index + prefix.length;
        if (fnStart < cursor) continue;
        let depth = 1;
        let i = fnStart + match[2].length;
        while (i < value.length && depth > 0) {
            const ch = value[i];
            if (ch === '(') depth += 1;
            else if (ch === ')') depth -= 1;
            i += 1;
        }
        if (depth !== 0) break;
        out += value.slice(cursor, fnStart) + resolve(value.slice(fnStart, i));
        cursor = i;
        fnPattern.lastIndex = i;
    }
    return cursor === 0 ? value : out + value.slice(cursor);
}

/** Inline resolved rgb/rgba colors on a cloned html2canvas document before its CSS parser runs. */
export function normalizeClonedDocumentColors(
    clonedDoc: Document,
    resolve: (expr: string) => string = (expr) => resolveCssColorFunction(expr, getColorCanvasContext(clonedDoc)),
): void {
    const win = clonedDoc.defaultView ?? (typeof window !== 'undefined' ? window : null);
    const rootEl = clonedDoc.documentElement;
    if (win && rootEl) {
        const elements: Element[] = [rootEl, ...rootEl.querySelectorAll('*')];
        for (const el of elements) {
            const styled = el as HTMLElement;
            if (!styled.style) continue;
            const computed = win.getComputedStyle(el);
            for (const prop of COLOR_PROPERTIES) {
                const raw = computed.getPropertyValue(prop);
                if (raw && UNSUPPORTED_COLOR_FN_RE.test(raw)) {
                    styled.style.setProperty(prop, normalizeCssColorValue(raw, resolve), 'important');
                }
            }
        }
    }
    for (const styleEl of clonedDoc.querySelectorAll('style')) {
        const css = styleEl.textContent;
        if (css && UNSUPPORTED_COLOR_FN_RE.test(css)) {
            styleEl.textContent = normalizeCssColorValue(css, resolve);
        }
    }
}

/** Bound canvas memory without cropping the bottom of a long reply. */
export function messageImageScale(width: number, height: number): number {
    const scale = Math.min(2, 16384 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
    if (!Number.isFinite(scale) || scale < 0.5 || width <= 0 || height <= 0) {
        throw new Error(t('lmc.messageImage.tooLong'));
    }
    return scale;
}

export async function renderMessageImage(node: HTMLElement): Promise<Blob> {
    await document.fonts.ready;
    const deadline = Date.now() + 15000;
    while (node.querySelector('[role="progressbar"]')) {
        if (Date.now() > deadline) throw new Error(t('lmc.messageImage.mediaLoadingTimeout'));
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await Promise.all([...node.querySelectorAll('img')].map(async image => {
        await image.decode();
        if (!image.naturalWidth) throw new Error(t('lmc.messageImage.mediaLoadFailed'));
    }));
    // Expand horizontal code/table scrollers in the export only.
    for (const child of [...node.querySelectorAll<HTMLElement>('div')].reverse()) {
        const style = getComputedStyle(child);
        if (/auto|scroll|hidden/.test(style.overflowX)) {
            child.style.width = `${child.scrollWidth}px`;
            child.style.maxWidth = 'none';
            child.style.flexShrink = '0';
            child.style.overflow = 'visible';
        }
    }
    node.style.width = `${Math.max(node.offsetWidth, node.scrollWidth + 24)}px`;
    const width = node.offsetWidth, height = node.scrollHeight;
    const canvas = await html2canvas(node, {
        width, height, scale: messageImageScale(width, height),
        backgroundColor: normalizeCssColorValue(getComputedStyle(node).backgroundColor),
        useCORS: true, logging: false,
        ignoreElements: element => element.hasAttribute('data-image-export-ignore'),
        onclone: clonedDoc => normalizeClonedDocumentColors(clonedDoc),
    });
    try {
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(t('lmc.messageImage.renderFailed'))), 'image/png'));
    } finally {
        canvas.width = canvas.height = 0;
    }
}

export function downloadMessageImage(blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lmc-reply.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
