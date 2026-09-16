import { describe, expect, it } from 'vitest';
import { applyEnvelope, boardUpdate, BOARD_LIMIT } from './board';
import { parseEnvelope } from './envelope';

const task = (id: string, attempt = 1, goal = 'do the thing') => parseEnvelope(`[task ${id} · attempt ${attempt}]\nstage  build\ngoal  ${goal}\nacceptance  ok`)!;
const report = (id: string, status: string, attempt = 1) => parseEnvelope(`[report ${id} · attempt ${attempt} · ${status}]\nsummary  s`)!;

describe('board', () => {
    it('does not reopen a reviewed attempt or move it for duplicate/old reports', () => {
        let board = applyEnvelope([], task('a', 2), 'W1', 10);
        board = applyEnvelope(board, report('a', 'done', 2), 'W1', 20);
        board = applyEnvelope(board, parseEnvelope('[review a · attempt 2 · accepted]\nsummary  checked')!, 'W1', 30);
        expect(applyEnvelope(board, report('a', 'done', 2), 'W1', 40)).toEqual(board);
        expect(applyEnvelope(board, report('a', 'failed', 1), 'W1', 50)).toEqual(board);
        expect(applyEnvelope(board, task('a', 1), 'W1', 60)).toEqual(board);
        expect(applyEnvelope(board, task('a', 3), 'W1', 70)[0].state).toBe('dispatched');
    });

    it('keeps the new dispatch when an old phase arrives with the same attempt', () => {
        const first = parseEnvelope('[task a · attempt 1]\ndispatch  build-id\nstage  build\ngoal  build')!;
        const second = parseEnvelope('[task a · attempt 1]\ndispatch  review-id\nstage  review\ngoal  review')!;
        let board = applyEnvelope([], first, 'W1', 10);
        board = applyEnvelope(board, second, 'W1', 20);
        expect(applyEnvelope(board, parseEnvelope('[report a · attempt 1 · done]\ndispatch  build-id\nsummary  late')!, 'W1', 30)).toEqual(board);
        expect(applyEnvelope(board, parseEnvelope('[report a · attempt 1 · done]\ndispatch  review-id\nsummary  reviewed')!, 'W1', 40)[0].state).toBe('done');
    });

    it('records a dispatch, then the report that answers it, newest first', () => {
        let board = applyEnvelope([], task('a'), 'W1', 1000);
        board = applyEnvelope(board, task('b'), 'W2', 2000);
        board = applyEnvelope(board, report('a', 'failed'), 'W1', 3000);
        expect(board.map((e) => e.id)).toEqual(['a', 'b']);
        expect(board[0]).toMatchObject({ title: 'do the thing', stage: 'build', state: 'failed', attempt: 1, counterpart: 'W1', firstAt: 1000, updatedAt: 3000 });
        board = applyEnvelope(board, task('a', 2), 'W1', 4000);
        expect(board[0]).toMatchObject({ state: 'dispatched', attempt: 2 });
    });

    it('keeps the board bounded', () => {
        let board: any[] = [];
        for (let i = 0; i < BOARD_LIMIT + 5; i++) board = applyEnvelope(board, task(`t${i}`), 'W', i);
        expect(board).toHaveLength(BOARD_LIMIT);
        expect(board[0].id).toBe(`t${BOARD_LIMIT + 4}`);
    });

    it('produces a metadata updater only for envelopes, and only on a bound session', () => {
        expect(boardUpdate('hello', 'W')).toBeNull();
        const update = boardUpdate('[task z]\ngoal  g\nacceptance  a', 'W', 5)!;
        expect((update({ orchestration: { role: 'hub', workers: [] } } as any) as any).orchestration.board[0]).toMatchObject({ id: 'z', counterpart: 'W' });
        const plain = { path: '/p' } as any;
        expect(update(plain)).toBe(plain);
    });
});
