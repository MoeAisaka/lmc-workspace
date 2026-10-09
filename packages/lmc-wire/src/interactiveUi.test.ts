import { describe, expect, it } from 'vitest';
import { extractInteractiveBlocks, interactiveAnswersPrompt, parseInteractiveFence } from './interactiveUi';

describe('interactive answers', () => {
    it('reads the fence info string and ignores other fences', () => {
        expect(parseInteractiveFence('lmc-ui id=plan-compare title="套餐对比"')).toEqual({ id: 'plan-compare', title: '套餐对比', ref: null });
        expect(parseInteractiveFence("lmc-ui ref=Plan_Compare title='x'")).toEqual({ id: null, title: 'x', ref: 'plan_compare' });
        expect(parseInteractiveFence('lmc-ui')).toEqual({ id: null, title: null, ref: null });
        expect(parseInteractiveFence('lmc-ui id="../etc" title=')).toEqual({ id: 'etc', title: null, ref: null });
        for (const info of ['html', 'lmc-uix', 'mermaid', '', null]) expect(parseInteractiveFence(info)).toBeNull();
    });
    it('extracts blocks and marks the one still being written', () => {
        const text = 'Here:\n```lmc-ui id=a title="A"\n<p>one</p>\n```\n```js\nx\n```\n```lmc-ui ref=a\n```\n~~~lmc-ui id=b\n<p>two';
        expect(extractInteractiveBlocks(text)).toEqual([
            { id: 'a', title: 'A', ref: null, html: '<p>one</p>', closed: true },
            { id: null, title: null, ref: 'a', html: '', closed: true },
            { id: 'b', title: null, ref: null, html: '<p>two', closed: false },
        ]);
    });
    it('says nothing when the feature is off and differs between the two active modes', () => {
        expect(interactiveAnswersPrompt('off')).toBe('');
        expect(interactiveAnswersPrompt('auto')).toContain('Use it whenever');
        expect(interactiveAnswersPrompt('ask')).toContain('Never volunteer');
        expect(interactiveAnswersPrompt('ask')).toContain('```lmc-ui ref=<id>```');
    });
});
