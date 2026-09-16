import { describe, expect, it } from 'vitest';
import { formatReportEnvelope, formatTaskEnvelope, looksLikeEnvelope, parseEnvelope, taskIsComplete } from './orchestrationEnvelope';

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
        const e = parseEnvelope('[task a-1]\ngoal  do it\nbudget  9999\nacceptance  it works');
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

    it('caps a runaway field so the hub\'s context is protected', () => {
        const e = parseEnvelope('[task big]\ngoal  ' + 'x'.repeat(5000) + '\nacceptance  y');
        if (e?.kind !== 'task') throw new Error();
        expect(e.fields.goal!.length).toBe(1200);
    });
});

describe('review envelope', () => {
    it('parses a verdict and keeps report evidence long', () => {
        expect(parseEnvelope('[review lmc-42 · attempt 2 · rejected]\nsummary  scope violated\nreasons  touched CLI')).toMatchObject({ kind: 'review', id: 'lmc-42', attempt: 2, status: 'rejected', fields: { reasons: 'touched CLI' } });
        const r = parseEnvelope(`[report r1 · attempt 1 · done]\nsummary  ok\nevidence  ${'x'.repeat(3000)}`);
        if (r?.kind !== 'report') throw new Error();
        expect(r.fields.evidence).toHaveLength(3000);
    });
});
