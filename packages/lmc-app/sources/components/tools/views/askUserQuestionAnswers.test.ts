import { describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/ops', () => ({ sessionAllow: vi.fn() }));
vi.mock('./InlineQuestionForm', () => ({ InlineQuestionForm: () => null }));
import { parseAskUserQuestionAnswers } from './AskUserQuestionView';

const questions = [
    { id: 'question-0', question: '粒度定到哪一层？' },
    { id: 'question-1', question: 'Access, "quoted" and all?' },
];

describe('parseAskUserQuestionAnswers', () => {
    it('reads each answer back from the tool result, keeping commas and quotes', () => {
        const result = 'Your questions have been answered: "粒度定到哪一层？"="按素材, 逐条", "Access, \"quoted\" and all?"="say "yes"". You can now continue with these answers in mind.';
        expect(parseAskUserQuestionAnswers(result, questions)).toEqual({
            'question-0': ['按素材, 逐条'],
            'question-1': ['say "yes"'],
        });
    });

    it('accepts the older wording and content-block results', () => {
        const result = [{ type: 'text', text: 'User has answered your questions: "粒度定到哪一层？"="按批次". You can now continue.' }];
        expect(parseAskUserQuestionAnswers(result, questions)).toEqual({ 'question-0': ['按批次'] });
    });

    it('reads the structured toolUseResult the app actually receives', () => {
        const result = { questions: [], answers: { '粒度定到哪一层？': '按素材', 'Access, "quoted" and all?': ['a', 'b'] } };
        expect(parseAskUserQuestionAnswers(result, questions)).toEqual({ 'question-0': ['按素材'], 'question-1': ['a', 'b'] });
    });

    it('returns nothing it cannot read', () => {
        expect(parseAskUserQuestionAnswers(undefined, questions)).toEqual({});
        expect(parseAskUserQuestionAnswers('User declined to answer', questions)).toEqual({});
    });
});
