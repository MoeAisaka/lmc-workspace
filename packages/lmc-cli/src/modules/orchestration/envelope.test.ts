import { describe, expect, it } from 'vitest';
import { applyEnvelope } from './board';
import { formatReportEnvelope, formatTaskEnvelope, looksLikeEnvelope, parseEnvelope, taskIsComplete } from './envelope';

const TASK = `[task lmc-42 · attempt 1]
goal        给 SessionRefreshBanner 加"放弃刷新"按钮
scope       packages/lmc-app/sources/components/SessionRefreshBanner.tsx
            packages/lmc-app/sources/text/**
acceptance  - vitest run sources/sync/sessionRefreshSteps 全绿
            - diff 不触碰 scope 之外的文件
constraints 不改 CLI
deliver     分支 task/lmc-42 推到 lmc 远程
run         模型 Sonnet 5 · 投入 medium`;

describe('envelope', () => {
    it('parses a task with continued fields', () => {
        const e = parseEnvelope(TASK);
        expect(e).toMatchObject({ kind: 'task', id: 'lmc-42', attempt: 1 });
        if (e?.kind !== 'task') throw new Error();
        expect(e.fields.scope?.split('\n')).toHaveLength(2);
        expect(e.fields.acceptance).toContain('- diff 不触碰');
        expect(e.fields.run).toBe('模型 Sonnet 5 · 投入 medium');
        expect(taskIsComplete(e)).toBe(true);
    });

    it('parses a report and reads status from the head, or infers blocked', () => {
        const r = parseEnvelope('[report lmc-42 · attempt 2 · failed]\nsummary  tests still red\nverification  vitest 1 failed');
        expect(r).toMatchObject({ kind: 'report', id: 'lmc-42', attempt: 2, status: 'failed' });
        const q = parseEnvelope('[report lmc-7]\nblocked  quota exhausted until 14:00\nsummary  stopped before editing');
        expect(q).toMatchObject({ kind: 'report', attempt: 1, status: 'blocked' });
    });

    it('rejects text that is not an envelope, and ignores unknown fields', () => {
        expect(parseEnvelope('hello [task x]')).toBeNull();
        expect(parseEnvelope('[task]\ngoal  x')).toBeNull();
        const e = parseEnvelope('[task a-1]\ngoal  do it\nunknown_field  9999\nacceptance  it works');
        if (e?.kind !== 'task') throw new Error();
        expect(Object.keys(e.fields).sort()).toEqual(['acceptance', 'goal']);
        expect(looksLikeEnvelope('  [report a-1]')).toBe(true);
        expect(looksLikeEnvelope('[agent mail from x]')).toBe(false);
    });

    it('round-trips through the formatters', () => {
        const text = formatTaskEnvelope({ id: 'lmc-9', attempt: 3, fields: { goal: 'g', scope: 'a\nb', acceptance: '- ok' } });
        const back = parseEnvelope(text);
        if (back?.kind !== 'task') throw new Error();
        expect(back).toMatchObject({ id: 'lmc-9', attempt: 3, fields: { goal: 'g', scope: 'a\nb', acceptance: '- ok' } });
        const report = parseEnvelope(formatReportEnvelope({ id: 'lmc-9', attempt: 3, status: 'done', fields: { summary: 's', changes: 'task/lmc-9 @ abc' } }));
        expect(report).toMatchObject({ kind: 'report', status: 'done', fields: { changes: 'task/lmc-9 @ abc' } });
    });

    it('round-trips the report model and records it on the receiving board', () => {
        const report = parseEnvelope(formatReportEnvelope({ id: 'model-task', attempt: 1, status: 'done', fields: { summary: 'ready', model: 'gpt-6-astra · high' } }));
        expect(report).toMatchObject({ kind: 'report', fields: { model: 'gpt-6-astra · high' } });
        if (report?.kind !== 'report') throw new Error('Expected report');
        const board = applyEnvelope([], report, 'W1', 100);
        expect(board[0]).toMatchObject({ id: 'model-task', model: 'gpt-6-astra · high', counterpart: 'W1' });
        const review = parseEnvelope('[review model-task · attempt 1 · accepted]');
        if (!review) throw new Error('Expected review');
        expect(applyEnvelope(board, review, 'W1', 200)[0].model).toBe('gpt-6-astra · high');
    });

    it('reads what a model actually writes: head and field on one line, colons, prose before the head', () => {
        const oneLine = parseEnvelope('[report lab-1 · attempt 1 · done] summary: LAB-DONE');
        expect(oneLine).toMatchObject({ kind: 'report', id: 'lab-1', attempt: 1, status: 'done', fields: { summary: 'LAB-DONE' } });
        const prose = parseEnvelope('Here is my report as requested.\n\n[report lab-1 | attempt 2 | failed]\nsummary: tests still red\nverification: 1 failing');
        expect(prose).toMatchObject({ kind: 'report', attempt: 2, status: 'failed', fields: { summary: 'tests still red', verification: '1 failing' } });
        const hash = parseEnvelope('[Task lmc-9 #3]\nGoal: do it\nAcceptance: it works');
        expect(hash).toMatchObject({ kind: 'task', id: 'lmc-9', attempt: 3, fields: { goal: 'do it', acceptance: 'it works' } });
        // A quoted envelope deep in prose is not an envelope.
        expect(parseEnvelope('first line\nsecond\nthird\nfourth\n[task deep]\ngoal  x')).toBeNull();
    });

    it('treats a report head with an unrecognised status word as not an envelope at all', () => {
        // "ack" is not done/blocked/failed — guessing 'done' here would let a
        // made-up word silently close a task on the board.
        expect(parseEnvelope('[report x · attempt 1 · ack]\nnote  hi')).toBeNull();
        // A bare head with no status word at all still defaults to done, as before.
        expect(parseEnvelope('[report x · attempt 1]\nsummary  fine')).toMatchObject({ status: 'done' });
        // An unrecognised word alongside an explicit blocked field is still a report.
        expect(parseEnvelope('[report x · attempt 1 · huh]\nblocked  waiting on you')).toMatchObject({ status: 'blocked' });
    });

    it('caps a runaway field so the hub\'s context is protected', () => {
        const e = parseEnvelope('[task big]\ngoal  ' + 'x'.repeat(5000) + '\nacceptance  y');
        if (e?.kind !== 'task') throw new Error();
        expect(e.fields.goal!.length).toBe(1200);
    });
});

describe('review envelope and evidence', () => {
    it('parses a review verdict and keeps evidence longer than an ordinary field', () => {
        const review = parseEnvelope('[review lmc-42 · attempt 2 · rejected]\nsummary  scope violated\nreasons  touched CLI');
        expect(review).toMatchObject({ kind: 'review', id: 'lmc-42', attempt: 2, status: 'rejected', fields: { summary: 'scope violated', reasons: 'touched CLI' } });
        const long = 'x'.repeat(3000);
        const report = parseEnvelope(`[report r1 · attempt 1 · done]\nsummary  ok\nevidence  ${long}`);
        if (report?.kind !== 'report') throw new Error();
        expect(report.fields.evidence).toHaveLength(3000);
        expect(parseEnvelope('[review r1 · accepted]')).toMatchObject({ kind: 'review', status: 'accepted', attempt: 1 });
    });
});
