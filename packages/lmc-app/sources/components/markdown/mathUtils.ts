import katex from 'katex';

export type InlineMathMatch = {
    content: string;
    mode: 'inline' | 'display';
    endIndex: number;
};

/**
 * Find the index of the first unescaped `$$` in `src` starting at `from`.
 * Handles LaTeX row breaks (`\\$$` -> closes cleanly) and escaped dollars (`\$` -> skipped).
 */
export function findUnescapedDoubleDollar(src: string, from: number): number {
    let i = from;
    while (i <= src.length - 2) {
        if (src[i] === '\\') {
            const next = src[i + 1];
            if (next === '\\' || next === '$') {
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if (src[i] === '$' && src[i + 1] === '$') {
            return i;
        }
        i += 1;
    }
    return -1;
}

/**
 * Find the index of the backslash in an unescaped LaTeX closing delimiter `\)` or `\]`.
 * A `)` or `]` closes only when preceded by an odd number of consecutive backslashes
 * (`\)` or `\\\)` closes; `(a+b)` or `\\)` does not).
 */
export function findLatexDelimEnd(src: string, from: number, closeChar: ')' | ']'): number {
    let i = from;
    while (i < src.length) {
        if (src[i] === closeChar) {
            let slashes = 0;
            let k = i - 1;
            while (k >= from && src[k] === '\\') {
                slashes++;
                k--;
            }
            if (slashes % 2 === 1) {
                return i - 1;
            }
        }
        i++;
    }
    return -1;
}

function isAbortBoundaryLine(trimmed: string): boolean {
    if (/^(`{3,}|~{3,})/.test(trimmed)) return true;
    if (/^#{1,6}\s+/.test(trimmed)) return true;
    return false;
}

/**
 * Attempt to parse a standalone display math block (`$$...$$` or `\[...\]`,
 * single-line or multi-line) starting at `lines[startIndex]`.
 */
export function parseMathBlockAt(
    lines: string[],
    startIndex: number,
): { content: string; nextIndex: number } | null {
    if (startIndex < 0 || startIndex >= lines.length) return null;
    const firstTrimmed = lines[startIndex].trim();
    if (!firstTrimmed) return null;

    // 1. `$$ ... $$` (single-line or multi-line)
    if (firstTrimmed.startsWith('$$') && firstTrimmed[2] !== '$') {
        const closeOnFirst = findUnescapedDoubleDollar(firstTrimmed, 2);
        if (closeOnFirst !== -1) {
            if (closeOnFirst + 2 === firstTrimmed.length) {
                const inner = firstTrimmed.slice(2, closeOnFirst).trim();
                if (inner.length > 0) {
                    return { content: inner, nextIndex: startIndex + 1 };
                }
            }
            // Trailing content or multiple `$$...$$` on one line -> let inline parser handle it
            return null;
        }

        for (let k = startIndex + 1; k < lines.length; k++) {
            const tLine = lines[k].trim();
            if (isAbortBoundaryLine(tLine)) return null;
            const closePos = findUnescapedDoubleDollar(tLine, 0);
            if (closePos !== -1) {
                if (closePos + 2 !== tLine.length) return null;
                const parts = [
                    firstTrimmed.slice(2),
                    ...lines.slice(startIndex + 1, k),
                    tLine.slice(0, closePos),
                ];
                const content = parts.join('\n').trim();
                return content.length > 0 ? { content, nextIndex: k + 1 } : null;
            }
        }
        return null;
    }

    // 2. `\[ ... \]` (single-line or multi-line LaTeX display math)
    if (firstTrimmed.startsWith('\\[')) {
        const closeOnFirst = findLatexDelimEnd(firstTrimmed, 2, ']');
        if (closeOnFirst !== -1) {
            if (closeOnFirst + 2 === firstTrimmed.length) {
                const inner = firstTrimmed.slice(2, closeOnFirst).trim();
                // Avoid turning bare escaped numeric footnotes like `\[1\]` into display math
                if (inner.length > 0 && !/^\d+$/.test(inner)) {
                    return { content: inner, nextIndex: startIndex + 1 };
                }
            }
            return null;
        }

        for (let k = startIndex + 1; k < lines.length; k++) {
            const tLine = lines[k].trim();
            if (isAbortBoundaryLine(tLine)) return null;
            const closePos = findLatexDelimEnd(tLine, 0, ']');
            if (closePos !== -1) {
                if (closePos + 2 !== tLine.length) return null;
                const parts = [
                    firstTrimmed.slice(2),
                    ...lines.slice(startIndex + 1, k),
                    tLine.slice(0, closePos),
                ];
                const content = parts.join('\n').trim();
                return content.length > 0 ? { content, nextIndex: k + 1 } : null;
            }
        }
        return null;
    }

    return null;
}

/**
 * Match inline math (`\(...\)`, `\[...\]`, `$$...$$`, or `$...$`) starting at `src[index]`.
 * Strictly guards against currency (`$100`, `$1.00 / $0.05`, `单价$100，总计$x$`)
 * and shell/template variables (`$PATH:$HOME`, `${FOO}/${BAR}`).
 */
export function matchInlineMathAt(
    src: string,
    index: number,
    options?: { forbidSpacedPipe?: boolean },
): InlineMathMatch | null {
    const ch = src[index];

    // 1. `\(...\)` or inline `\[...\]`
    if (ch === '\\') {
        const next = src[index + 1];
        if (next === '(') {
            const closeIdx = findLatexDelimEnd(src, index + 2, ')');
            if (closeIdx !== -1) {
                const raw = src.slice(index + 2, closeIdx);
                if (!raw.includes('\n\n') && raw.trim().length > 0) {
                    return { content: raw.trim(), mode: 'inline', endIndex: closeIdx + 2 };
                }
            }
            return null;
        }
        if (next === '[') {
            const closeIdx = findLatexDelimEnd(src, index + 2, ']');
            if (closeIdx !== -1) {
                const raw = src.slice(index + 2, closeIdx);
                const trimmed = raw.trim();
                // Inline `\[...\]` requires explicit math operators/commands so escaped `[1]` stays literal
                if (
                    !raw.includes('\n\n')
                    && trimmed.length > 0
                    && (/\\[A-Za-z]/.test(trimmed) || /[=+\-*/^_{}]/.test(trimmed))
                ) {
                    return { content: trimmed, mode: 'display', endIndex: closeIdx + 2 };
                }
            }
            return null;
        }
        return null;
    }

    if (ch !== '$') return null;

    // 2. Inline `$$...$$`
    if (src[index + 1] === '$') {
        if (src[index + 2] === '$') return null;
        const closeIdx = findUnescapedDoubleDollar(src, index + 2);
        if (closeIdx !== -1) {
            const raw = src.slice(index + 2, closeIdx);
            if (!raw.includes('\n\n') && raw.trim().length > 0) {
                return { content: raw.trim(), mode: 'display', endIndex: closeIdx + 2 };
            }
        }
        return null;
    }

    // 3. Single `$...$` with strict Pandoc/GitHub + currency/shell-var guards
    const prev = index > 0 ? src[index - 1] : '';
    if (prev === '$' || /[A-Za-z0-9]/.test(prev)) return null;

    const firstInner = src[index + 1];
    if (!firstInner || /\s/.test(firstInner)) return null;

    let braceDepth = 0;
    let j = index + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === '\n') return null;

        if (c === '\\') {
            const esc = src[j + 1];
            if (esc === '\\' || esc === '$' || esc === '{' || esc === '}') {
                j += 2;
                continue;
            }
            j += 1;
            continue;
        }

        if (c === '{') {
            braceDepth++;
            j++;
            continue;
        }
        if (c === '}') {
            if (braceDepth === 0) return null;
            braceDepth--;
            j++;
            continue;
        }

        // Fullwidth prose punctuation outside `{...}` (e.g. `满月 $100，公式 $x$`) aborts currency scan
        if (braceDepth === 0 && /[，。；！？]/.test(c)) {
            return null;
        }

        if (options?.forbidSpacedPipe && src.startsWith(' | ', j)) {
            return null;
        }

        // In TeX, the VERY FIRST unescaped `$` must validly close `$...$`; otherwise abort immediately.
        if (c === '$') {
            if (braceDepth !== 0) return null;
            if (src[j + 1] === '$') return null;
            if (/\s/.test(src[j - 1])) return null;

            const after = src[j + 1] ?? '';
            if (/[0-9${]/.test(after)) return null;
            if (after === '\\' && /[A-Za-z]/.test(src[j + 2] ?? '')) return null;
            if (/[A-Za-z_]/.test(after) && !/^(?:st|nd|rd|th|s)\b/.test(src.slice(j + 1))) {
                return null;
            }

            const raw = src.slice(index + 1, j);
            if (!raw.trim()) return null;
            // Guard prose starting with a currency amount + word (`$100 USD ...`) with no math syntax
            if (/^\d+(?:[.,]\d+)*\s+[A-Za-z\u4e00-\u9fff]/.test(raw) && !/[\\=+\-*^_{}<>]/.test(raw)) {
                return null;
            }

            return { content: raw, mode: 'inline', endIndex: j + 1 };
        }

        j++;
    }

    return null;
}

const MAX_RENDER_CACHE = 512;
const renderCache = new Map<string, string>();

/**
 * Render LaTeX to KaTeX HTML + accessible MathML string (`throwOnError: false`, `trust: false`).
 */
export function renderMathToHtml(latex: string, displayMode: boolean): string {
    const key = `${displayMode ? 'D' : 'I'}:${latex}`;
    const cached = renderCache.get(key);
    if (cached !== undefined) return cached;

    const html = katex.renderToString(latex, {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
    });

    if (renderCache.size >= MAX_RENDER_CACHE) {
        const oldest = renderCache.keys().next().value;
        if (oldest !== undefined) renderCache.delete(oldest);
    }
    renderCache.set(key, html);
    return html;
}

const LATEX_SYMBOL_MAP: Record<string, string> = {
    times: '×',
    cdot: '·',
    div: '÷',
    pm: '±',
    mp: '∓',
    le: '≤',
    leq: '≤',
    ge: '≥',
    geq: '≥',
    ne: '≠',
    neq: '≠',
    approx: '≈',
    equiv: '≡',
    sim: '∼',
    simeq: '≃',
    cong: '≅',
    propto: '∝',
    to: '→',
    rightarrow: '→',
    leftarrow: '←',
    leftrightarrow: '↔',
    Rightarrow: '⇒',
    Leftarrow: '⇐',
    Leftrightarrow: '⇔',
    mapsto: '↦',
    infty: '∞',
    partial: '∂',
    nabla: '∇',
    in: '∈',
    notin: '∉',
    subset: '⊂',
    subseteq: '⊆',
    supset: '⊃',
    supseteq: '⊇',
    cup: '∪',
    cap: '∩',
    emptyset: '∅',
    varnothing: '∅',
    forall: '∀',
    exists: '∃',
    neg: '¬',
    land: '∧',
    lor: '∨',
    oplus: '⊕',
    otimes: '⊗',
    perp: '⊥',
    parallel: '∥',
    angle: '∠',
    triangle: '△',
    circ: '∘',
    degree: '°',
    sum: '∑',
    prod: '∏',
    int: '∫',
    oint: '∮',
    dots: '…',
    ldots: '…',
    cdots: '⋯',
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    epsilon: 'ϵ',
    varepsilon: 'ε',
    zeta: 'ζ',
    eta: 'η',
    theta: 'θ',
    vartheta: 'ϑ',
    iota: 'ι',
    kappa: 'κ',
    lambda: 'λ',
    mu: 'μ',
    nu: 'ν',
    xi: 'ξ',
    pi: 'π',
    rho: 'ρ',
    sigma: 'σ',
    tau: 'τ',
    upsilon: 'υ',
    phi: 'φ',
    varphi: 'ϕ',
    chi: 'χ',
    psi: 'ψ',
    omega: 'ω',
    Gamma: 'Γ',
    Delta: 'Δ',
    Theta: 'Θ',
    Lambda: 'Λ',
    Xi: 'Ξ',
    Pi: 'Π',
    Sigma: 'Σ',
    Upsilon: 'Υ',
    Phi: 'Φ',
    Psi: 'Ψ',
    Omega: 'Ω',
};

const SUPERSCRIPT_DIGITS: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ',
};

const SUBSCRIPT_DIGITS: Record<string, string> = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
};

function readBalancedGroup(s: string, openBraceIdx: number): { inner: string; afterIdx: number } | null {
    if (s[openBraceIdx] !== '{') return null;
    let depth = 1;
    let i = openBraceIdx + 1;
    while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) {
            i += 2;
            continue;
        }
        if (s[i] === '{') depth++;
        else if (s[i] === '}') {
            depth--;
            if (depth === 0) {
                return { inner: s.slice(openBraceIdx + 1, i), afterIdx: i + 1 };
            }
        }
        i++;
    }
    return null;
}

const UNWRAP_MACROS = new Set([
    'text', 'textbf', 'textit', 'textrm', 'textsf', 'texttt', 'textup',
    'mathbf', 'mathrm', 'mathit', 'mathsf', 'mathtt', 'mathbb', 'mathcal',
    'mathfrak', 'mathscr', 'boldsymbol', 'bm', 'operatorname', 'boxed',
]);

/**
 * Convert LaTeX math into clean readable Unicode text for column-width measurement,
 * TSV / Canvas table copy, and native `<Text>` inline fallback.
 */
export function latexToPlainText(latex: string): string {
    let s = latex.trim();
    if (!s) return '';

    s = s.replace(/\\(?:left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|Biggl|Biggr|middle)\b\s*/g, '');
    s = s.replace(/\\(?:,|;|:|!|quad|qquad|enspace|thinspace)\b/g, ' ');
    s = s.replace(/\\\\/g, '\n');
    s = s.replace(/\\([%$&#_{}])/g, '$1');

    // Iteratively expand structured macros (\underbrace, \overbrace, \frac, \sqrt, \text, \mathbf, ...)
    for (let pass = 0; pass < 8; pass++) {
        let out = '';
        let changed = false;
        let i = 0;
        while (i < s.length) {
            if (s[i] === '\\') {
                const cmdMatch = s.slice(i + 1).match(/^([A-Za-z]+)/);
                if (cmdMatch) {
                    const cmd = cmdMatch[1];
                    let afterCmd = i + 1 + cmd.length;
                    while (afterCmd < s.length && s[afterCmd] === ' ') afterCmd++;

                    if ((cmd === 'underbrace' || cmd === 'overbrace') && s[afterCmd] === '{') {
                        const g1 = readBalancedGroup(s, afterCmd);
                        if (g1) {
                            let nextPos = g1.afterIdx;
                            while (nextPos < s.length && s[nextPos] === ' ') nextPos++;
                            const subSup = cmd === 'underbrace' ? '_' : '^';
                            if (s[nextPos] === subSup) {
                                nextPos++;
                                while (nextPos < s.length && s[nextPos] === ' ') nextPos++;
                                if (s[nextPos] === '{') {
                                    const g2 = readBalancedGroup(s, nextPos);
                                    if (g2) {
                                        out += `${g1.inner} (${g2.inner})`;
                                        i = g2.afterIdx;
                                        changed = true;
                                        continue;
                                    }
                                }
                            }
                            out += g1.inner;
                            i = g1.afterIdx;
                            changed = true;
                            continue;
                        }
                    }

                    if ((cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') && s[afterCmd] === '{') {
                        const num = readBalancedGroup(s, afterCmd);
                        if (num) {
                            let denStart = num.afterIdx;
                            while (denStart < s.length && s[denStart] === ' ') denStart++;
                            const den = readBalancedGroup(s, denStart);
                            if (den) {
                                const nTxt = num.inner.trim();
                                const dTxt = den.inner.trim();
                                const nWrap = /[+\-\s]/.test(nTxt) ? `(${nTxt})` : nTxt;
                                const dWrap = /[+\-\s]/.test(dTxt) ? `(${dTxt})` : dTxt;
                                out += `${nWrap}/${dWrap}`;
                                i = den.afterIdx;
                                changed = true;
                                continue;
                            }
                        }
                    }

                    if (cmd === 'sqrt') {
                        let deg = '';
                        if (s[afterCmd] === '[') {
                            const closeBr = s.indexOf(']', afterCmd + 1);
                            if (closeBr !== -1) {
                                deg = s.slice(afterCmd + 1, closeBr).trim();
                                afterCmd = closeBr + 1;
                                while (afterCmd < s.length && s[afterCmd] === ' ') afterCmd++;
                            }
                        }
                        if (s[afterCmd] === '{') {
                            const rad = readBalancedGroup(s, afterCmd);
                            if (rad) {
                                const supDeg = deg ? [...deg].map(c => SUPERSCRIPT_DIGITS[c] ?? c).join('') : '';
                                out += `${supDeg}√(${rad.inner})`;
                                i = rad.afterIdx;
                                changed = true;
                                continue;
                            }
                        }
                    }

                    if (UNWRAP_MACROS.has(cmd) && s[afterCmd] === '{') {
                        const grp = readBalancedGroup(s, afterCmd);
                        if (grp) {
                            out += grp.inner;
                            i = grp.afterIdx;
                            changed = true;
                            continue;
                        }
                    }
                }
            }
            out += s[i];
            i++;
        }
        s = out;
        if (!changed) break;
    }

    // Replace remaining symbol commands (\alpha, \times, \le, ...)
    s = s.replace(/\\([A-Za-z]+)/g, (full, name: string) => {
        return Object.prototype.hasOwnProperty.call(LATEX_SYMBOL_MAP, name)
            ? LATEX_SYMBOL_MAP[name]
            : name;
    });

    // Simple superscripts & subscripts (^2 -> ², _1 -> ₁)
    s = s.replace(/\^\{([0-9+\-=()ni]+)\}/g, (_, g: string) => [...g].map(c => SUPERSCRIPT_DIGITS[c] ?? c).join(''));
    s = s.replace(/\^([0-9ni])/g, (_, c: string) => SUPERSCRIPT_DIGITS[c] ?? `^${c}`);
    s = s.replace(/_\{([0-9+\-=()]+)\}/g, (_, g: string) => [...g].map(c => SUBSCRIPT_DIGITS[c] ?? c).join(''));
    s = s.replace(/_([0-9])/g, (_, c: string) => SUBSCRIPT_DIGITS[c] ?? `_${c}`);

    // Unwrap residual grouping braces
    s = s.replace(/[{}]/g, '');
    return s.replace(/[ \t]+/g, ' ').trim();
}
