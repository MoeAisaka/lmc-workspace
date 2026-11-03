import { describe, expect, it } from 'vitest';
import { latexToPlainText, renderMathToHtml } from './mathUtils';

describe('mathUtils - KaTeX HTML rendering and plain-text fallback', () => {
    it('renders the 609cm CJK + underbrace display equation without KaTeX errors', () => {
        const tex = String.raw`\text{西墙展示柜 } \mathbf{36.5\text{cm}} + \text{展示柜前过道 } \mathbf{75\text{cm}} + \text{对坐半岛桌 } \mathbf{125\text{cm}} + \underbrace{\text{书房柜 } 35\text{cm} + \text{隔音芯 } 10\text{cm} + \text{主卧柜 } 35\text{cm}}_{\text{双面隔断柜墙 } \mathbf{80\text{cm}}} + \text{主卧床尾道 } \mathbf{84\text{cm}} + \text{大床靠背 } 209\text{cm} = 609\text{cm}`;
        const html = renderMathToHtml(tex, true);
        expect(html).toContain('katex-display');
        expect(html).toContain('cjk_fallback');
        expect(html).toContain('西墙展示柜');
        expect(html).toContain('双面隔断柜墙');
        expect(html).not.toContain('katex-error');
    });

    it('renders inline math without display wrapper and handles malformed macros gracefully', () => {
        const inlineHtml = renderMathToHtml(String.raw`\frac{\alpha + \beta}{2}`, false);
        expect(inlineHtml).toContain('class="katex"');
        expect(inlineHtml).not.toContain('katex-display');
        expect(inlineHtml).not.toContain('katex-error');

        // Unknown / unclosed TeX must never throw during render
        expect(() => renderMathToHtml(String.raw`\frac{1}{`, false)).not.toThrow();
    });

    it('produces readable plain Unicode for native fallback and table column sizing', () => {
        const tex = String.raw`\text{西墙展示柜 } \mathbf{36.5\text{cm}} + \underbrace{35 + 10 + 35}_{\text{隔断墙 } 80\text{cm}} = 609\text{cm}`;
        const plain = latexToPlainText(tex);
        expect(plain).toContain('西墙展示柜');
        expect(plain).toContain('36.5cm');
        expect(plain).toContain('隔断墙 80cm');
        expect(plain).not.toContain('\\text');
        expect(plain).not.toContain('\\mathbf');
        expect(plain).not.toContain('\\underbrace');
    });
});
