import { describe, expect, it } from 'vitest';
import { formatSubmittedHandoff } from './engineHandoff';

describe('formatSubmittedHandoff', () => {
    it('says who wrote it, since the receiver would read it as its user otherwise', () => {
        const text = formatSubmittedHandoff({ goal: 'Ship the switch', nextStep: 'Wire the UI' }, 'Claude');
        expect(text).toContain('[handoff from Claude]');
        expect(text).toContain('not carry across');
    });

    it('refuses a form with nothing the next engine could act on', () => {
        expect(formatSubmittedHandoff({ goal: '', done: '', nextStep: '' }, 'Claude')).toBeNull();
        expect(formatSubmittedHandoff({ files: ['a.ts'], pitfalls: ['x'] }, 'Claude')).toBeNull();
        expect(formatSubmittedHandoff(null, 'Claude')).toBeNull();
        expect(formatSubmittedHandoff('a briefing', 'Claude')).toBeNull();
    });

    it('leaves out the sections the engine did not fill in', () => {
        const text = formatSubmittedHandoff({ goal: 'Ship it', nextStep: 'Wire it' }, 'Codex')!;
        expect(text).toContain('## Goal');
        expect(text).not.toContain('## Not done');
        expect(text).not.toContain('## Files');
    });

    it('caps a submission that writes the conversation back out', () => {
        const text = formatSubmittedHandoff({
            goal: 'x'.repeat(5000),
            done: 'y'.repeat(5000),
            nextStep: 'z'.repeat(5000),
            files: Array.from({ length: 40 }, (_, i) => `f${i}.ts`),
        }, 'Claude')!;
        expect(text.length).toBeLessThanOrEqual(4000);
    });

    it('drops list entries that are not text rather than refusing the whole thing', () => {
        const text = formatSubmittedHandoff({ goal: 'Ship it', files: ['a.ts', 7, '', 'b.ts'] }, 'Claude')!;
        expect(text).toContain('- a.ts');
        expect(text).toContain('- b.ts');
        expect(text).not.toContain('- 7');
    });
});
