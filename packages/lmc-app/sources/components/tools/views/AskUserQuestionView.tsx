import * as React from 'react';

import { sessionAllow } from '@/sync/ops';
import { ToolViewProps } from './_all';
import {
    InlineQuestionForm,
    type InlineQuestion,
    type InlineQuestionAnswers,
} from './InlineQuestionForm';

interface AskUserQuestionInput {
    questions?: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
}

/**
 * The answers as Claude Code reports them back in the tool result:
 * `Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now …`
 * (older builds: `User has answered your questions: …`). The permission reply
 * that carried them is not kept, so this text is the only record left once
 * the call completes. Each value runs up to the next question's key, so
 * quotes and commas inside an answer survive.
 */
export function parseAskUserQuestionAnswers(result: unknown, questions: Array<{ id: string; question: string }>): Record<string, string[]> {
    const text = typeof result === 'string'
        ? result
        : Array.isArray(result)
            ? result.map((part: any) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
            : '';
    const answers: Record<string, string[]> = {};
    if (!text) return answers;
    questions.forEach((question, index) => {
        const key = `"${question.question}"="`;
        const start = text.indexOf(key);
        if (start < 0) return;
        const from = start + key.length;
        const next = questions[index + 1];
        let end = next ? text.indexOf(`", "${next.question}"="`, from) : -1;
        if (end < 0) {
            const tail = text.indexOf('". ', from);
            end = tail >= 0 ? tail : text.lastIndexOf('"');
        }
        if (end > from) answers[question.id] = [text.slice(from, end)];
    });
    return answers;
}

export const AskUserQuestionView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const input = tool.input as AskUserQuestionInput | undefined;
    const questions = React.useMemo<InlineQuestion[]>(() => (
        (input?.questions ?? []).map((question, index) => ({
            ...question,
            id: `question-${index}`,
            required: true,
        }))
    ), [input?.questions]);

    const handleSubmit = React.useCallback(async (answers: InlineQuestionAnswers) => {
        if (!sessionId || !tool.permission?.id) return;

        const providerAnswers: Record<string, string> = {};
        questions.forEach((question, index) => {
            const originalQuestion = input?.questions?.[index];
            const selected = answers[question.id];
            if (originalQuestion && selected?.length) {
                providerAnswers[originalQuestion.question] = selected.join(', ');
            }
        });

        // Claude resolves AskUserQuestion through its permission callback and
        // expects the chosen values merged into the tool input.
        await sessionAllow(
            sessionId,
            tool.permission.id,
            undefined,
            undefined,
            'approved',
            { answers: providerAnswers },
        );
    }, [input?.questions, questions, sessionId, tool.permission?.id]);

    if (questions.length === 0) return null;

    return (
        <InlineQuestionForm
            questions={questions}
            canInteract={tool.state === 'running'}
            submittedAnswers={tool.state === 'completed' ? parseAskUserQuestionAnswers(tool.result, questions) : undefined}
            onSubmit={handleSubmit}
        />
    );
});