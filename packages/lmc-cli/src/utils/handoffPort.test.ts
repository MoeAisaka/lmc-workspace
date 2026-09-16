import { describe, expect, it, vi } from 'vitest';
import { createHandoffPort } from './handoffPort';

function fixture(prior: { engine: string; id: string; transcriptPath?: string } | null) {
    let metadata: any = {};
    const client = {
        updateMetadata: vi.fn((update: (m: any) => any) => { metadata = update(metadata); }),
        getMetadata: () => metadata,
    } as any;
    return { client, port: createHandoffPort(client, 'Claude Code', 'claude', () => prior), read: () => metadata.pendingHandoff };
}

describe('createHandoffPort', () => {
    it('stores the fallback the moment it is armed, before the engine is asked anything', () => {
        const { port, read } = fixture(null);
        port.arm('## Goal\nShip it');
        expect(read().source).toBe('compiled');
        expect(read().briefing).toContain('Ship it');
    });

    it('replaces the fallback when the engine writes its own', () => {
        const { port, read } = fixture(null);
        port.arm('compiled text');
        expect(port.submit({ goal: 'Ship the switch', nextStep: 'Wire the UI' })).toBe(true);
        expect(read().source).toBe('engine');
        expect(read().briefing).toContain('Wire the UI');
    });

    it('refuses a submission when no switch is pending', () => {
        const { port } = fixture(null);
        expect(port.submit({ goal: 'Ship it', nextStep: 'Go' })).toBe(false);
    });

    it('keeps the fallback when the engine submits an empty form', () => {
        const { port, read } = fixture(null);
        port.arm('compiled text');
        expect(port.submit({ goal: '', done: '', nextStep: '' })).toBe(false);
        expect(read().source).toBe('compiled');
    });

    it('points at the conversation being left, so the next engine can read it', () => {
        const { port, read } = fixture({ engine: 'Claude Code', id: 'abc', transcriptPath: '/home/me/.claude/projects/p/abc.jsonl' });
        port.arm('compiled text');
        expect(read().briefing).toContain('/home/me/.claude/projects/p/abc.jsonl');
        expect(read().priorThread.id).toBe('abc');
    });

    it('names the thread when the transcript has no addressable file', () => {
        const { port, read } = fixture({ engine: 'Codex', id: 'thread-1' });
        port.arm('compiled text');
        expect(read().briefing).toContain('thread-1');
    });

    it('drops the briefing when the switch is called off', () => {
        const { port, read } = fixture(null);
        port.arm('compiled text');
        port.disarm();
        expect(read()).toBeUndefined();
        expect(port.submit({ goal: 'Ship it', nextStep: 'Go' })).toBe(false);
    });
});

describe('consumePendingHandoff', () => {
    it('reads the briefing the server has, not the one the process started with', async () => {
        // A relaunched process begins with metadata of its own making. The
        // server's copy — the one carrying the briefing — only arrives inside
        // the update round-trip, so that is where it must be read.
        let server: any = { pendingHandoff: { from: 'Claude Code', fromFlavor: 'claude', source: 'engine', briefing: '## Goal\nShip it' } };
        const client = {
            updateMetadata: vi.fn(async (update: (m: any) => any) => { server = update(server); }),
            getMetadata: () => ({}),   // the stale local copy: nothing pending here
        } as any;
        const { consumePendingHandoff } = await import('./handoffPort');
        const inherited = await consumePendingHandoff(client);
        expect(inherited?.briefing).toContain('Ship it');
        expect(inherited?.fromFlavor).toBe('claude');
        expect(server.pendingHandoff).toBeUndefined();
    });

    it('is a plain read when nothing is pending, and writes nothing', async () => {
        let writes = 0;
        const client = { updateMetadata: vi.fn(async (update: (m: any) => any) => { const before = { flavor: 'codex' }; const after = update(before); if (after !== before) writes += 1; }), getMetadata: () => ({}) } as any;
        const { consumePendingHandoff } = await import('./handoffPort');
        expect(await consumePendingHandoff(client)).toBeNull();
        expect(writes).toBe(0);
    });
});

describe('the record the briefing points at', () => {
    function fixtureWithHistory(prior: { engine: string; id: string; transcriptPath?: string } | null, history: any[] = []) {
        let metadata: any = { engineThreadHistory: history };
        const client = {
            updateMetadata: vi.fn((update: (m: any) => any) => { metadata = update(metadata); }),
            getMetadata: () => metadata,
        } as any;
        return { client, port: createHandoffPort(client, 'Claude Code', 'claude', () => prior), read: () => metadata };
    }

    it('adds the conversation being left to the session\'s history, once', () => {
        const { port, read } = fixtureWithHistory({ engine: 'Claude Code', id: 'c1', transcriptPath: '/p/c1.jsonl' });
        port.arm('compiled', 'codex');
        port.submit({ goal: 'Ship it', nextStep: 'Go' });
        expect(read().engineThreadHistory).toHaveLength(1);
        expect(read().engineThreadHistory[0]).toMatchObject({ engine: 'Claude Code', flavor: 'claude', id: 'c1', transcriptPath: '/p/c1.jsonl' });
    });

    it('lists every earlier stretch, marks the arriving engine\'s own as history, and names the transcript tool', () => {
        const earlier = [{ engine: 'Codex', flavor: 'codex', id: 'x1', endedAt: 1 }, { engine: 'Claude Code', flavor: 'claude', id: 'c0', transcriptPath: '/p/c0.jsonl', endedAt: 2 }];
        const { port, read } = fixtureWithHistory({ engine: 'Claude Code', id: 'c1', transcriptPath: '/p/c1.jsonl' }, earlier);
        port.arm('compiled', 'codex');
        const briefing: string = read().pendingHandoff.briefing;
        expect(briefing).toContain('read_session_transcript');
        expect(briefing).toContain('Codex · thread x1 — yours');
        expect(briefing).toContain('Claude Code · /p/c0.jsonl');
        expect(briefing).toContain('Claude Code · /p/c1.jsonl');
        // Claude's stretches are not marked as the arriving Codex's own.
        expect(briefing).not.toContain('/p/c1.jsonl — yours');
        expect(read().engineThreadHistory.map((r: any) => r.id)).toEqual(['x1', 'c0', 'c1']);
    });

    it('points at the tool even when the session has no engine history yet', () => {
        const { port, read } = fixtureWithHistory(null);
        port.arm('compiled', 'codex');
        expect(read().pendingHandoff.briefing).toContain('read_session_transcript');
        expect(read().engineThreadHistory).toEqual([]);
    });
});
