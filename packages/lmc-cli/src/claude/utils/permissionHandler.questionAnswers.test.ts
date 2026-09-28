import { describe, expect, it } from 'vitest';
import { questionAnswers } from './permissionHandler';

describe('questionAnswers', () => {
    it('keeps the chosen answer per question from an approved AskUserQuestion', () => {
        expect(questionAnswers({ questions: [], answers: { '怎么拆？': '拆成两类独立条目（推荐）' } }))
            .toEqual({ answers: { '怎么拆？': '拆成两类独立条目（推荐）' } });
    });
    it('records nothing for other tools or malformed answers', () => {
        expect(questionAnswers({ command: 'ls' })).toEqual({});
        expect(questionAnswers({ answers: ['x'] })).toEqual({});
        expect(questionAnswers({ answers: { q: 3 } })).toEqual({});
        expect(questionAnswers(undefined)).toEqual({});
    });
});
