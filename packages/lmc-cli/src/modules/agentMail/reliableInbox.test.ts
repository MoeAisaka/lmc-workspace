import { describe, expect, it, vi } from 'vitest';
import { AGENT_MAIL_INBOX_LIMIT, type AgentMailInbox } from 'lmc-wire';
import type { Metadata } from '@/api/types';
import type { AgentMailMessage } from './agentMail';
import { acknowledgeProcessedMail, mailDeliveryId, processReliableMail } from './reliableInbox';
import { WorkerConfigValidationError } from '@/modules/orchestration/workerConfig';

const message = (text = '[task t · attempt 1]\ndispatch  d\ngoal  fix\nrun  model=catalog-model effort=high\nacceptance  tests', id = 'mail-1'): AgentMailMessage =>
    ({ id, text, from: null, fromSessionId: 'H', hop: 1, createdAt: 1 });

function fixture(flavor = 'claude', initial?: Metadata, durable = new Map<string, { kind: string; text: string }>()) {
    let metadata: Metadata = initial ?? { flavor, path: '/fixture', host: 'fixture', orchestration: { role: 'worker', hub: { sessionId: 'H', boundAt: 1, by: 'auto' } } } as Metadata;
    const post = async (kind: string, text: string, options: { localId: string }) => {
        if (!durable.has(options.localId)) durable.set(options.localId, { kind, text });
    };
    const session = {
        sessionId: 'worker', getMetadata: () => metadata,
        updateMetadata: vi.fn(async (update: (metadata: Metadata) => Metadata) => { metadata = update(metadata); }),
        sendUserTextMessage: vi.fn(async (text: string, _meta: unknown, options: { localId: string }) => post('user', text, options)),
        sendSessionEvent: vi.fn(async (event: { message: string }, _id: string, options: { localId: string }) => post('event', event.message, options)),
    };
    const mail = { acknowledge: vi.fn(async (_ids: string[]) => true), send: vi.fn(async (_id: string, _text: string, _hop: number) => ({ ok: true as const })) };
    return { session: session as any, mail, durable, snapshot: () => JSON.parse(JSON.stringify(metadata)) as Metadata };
}

describe('durable recipient effects, shared by Claude and Codex', () => {
    it.each(['claude', 'codex'])('persists projection and session delivery before ACK on %s', async flavor => {
        const f = fixture(flavor);
        let release!: () => void;
        f.session.sendUserTextMessage.mockImplementation(async () => new Promise<void>(resolve => { release = resolve; }));
        const processing = processReliableMail(f.session, f.mail, message());
        await vi.waitFor(() => expect(f.session.sendUserTextMessage).toHaveBeenCalled());
        expect(f.snapshot().agentMailInbox!['mail-1'].phase).toBe('projected');
        expect(f.snapshot().orchestration!.board![0].state).toBe('dispatched');
        expect(f.mail.acknowledge).not.toHaveBeenCalled();
        release();
        await processing;
        expect(f.snapshot().agentMailInbox!['mail-1'].phase).toBe('processed');
        await acknowledgeProcessedMail(f.session, f.mail);
        expect(f.mail.acknowledge).toHaveBeenCalledWith(['mail-1']);
        expect(f.snapshot().agentMailInbox!['mail-1'].phase).toBe('acked');
    });

    it.each(['claude', 'codex'])('recreates a receiver after processing but before confirmation without replaying effects on %s', async flavor => {
        const first = fixture(flavor);
        await processReliableMail(first.session, first.mail, message());
        first.mail.acknowledge.mockResolvedValue(false);
        await acknowledgeProcessedMail(first.session, first.mail);
        const second = fixture(flavor, first.snapshot(), first.durable);
        await processReliableMail(second.session, second.mail, message());
        await acknowledgeProcessedMail(second.session, second.mail);
        expect(second.session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(second.session.sendSessionEvent).not.toHaveBeenCalled();
        expect(second.durable.size).toBe(1);
        expect(second.mail.acknowledge).toHaveBeenCalledWith(['mail-1']);
        expect(second.snapshot().agentMailInbox!['mail-1'].phase).toBe('acked');
    });

    it('closes the crash window after session storage but before recording processed', async () => {
        const first = fixture();
        first.session.updateMetadata.mockImplementationOnce(async (update: any) => {
            const saved = update(first.session.getMetadata());
            first.session.getMetadata = () => saved;
        }).mockRejectedValueOnce(new Error('exit before processed receipt'));
        await expect(processReliableMail(first.session, first.mail, message())).rejects.toThrow('exit');
        expect(first.durable.size).toBe(1);
        const saved = JSON.parse(JSON.stringify(first.session.getMetadata()));
        saved.modelMode = 'newer-explicit-choice';
        const second = fixture('claude', saved, first.durable);
        await processReliableMail(second.session, second.mail, message());
        expect(second.snapshot().modelMode).toBe('newer-explicit-choice');
        expect(second.snapshot().agentMailInbox!['mail-1'].phase).toBe('processed');
        expect(second.durable.size).toBe(1);
        expect(second.session.sendUserTextMessage).toHaveBeenCalledWith(expect.any(String), undefined, { localId: mailDeliveryId('mail-1') });
    });

    it('keeps an unconfirmed POST identity stable across receiver restarts', async () => {
        const first = fixture();
        const store = first.session.sendUserTextMessage.getMockImplementation();
        first.session.sendUserTextMessage.mockImplementationOnce(async (...args: any[]) => { await store!(...args); throw new Error('response lost after storing'); });
        await expect(processReliableMail(first.session, first.mail, message())).rejects.toThrow('lost');
        const second = fixture('claude', first.snapshot(), first.durable);
        await processReliableMail(second.session, second.mail, message());
        expect(second.durable.size).toBe(1);
        expect(second.snapshot().agentMailInbox!['mail-1'].phase).toBe('processed');
    });

    it('retries a lost ACK response on the next poll without delivery, even when the center returns no mail', async () => {
        const f = fixture();
        await processReliableMail(f.session, f.mail, message());
        f.mail.acknowledge.mockResolvedValueOnce(false);
        await acknowledgeProcessedMail(f.session, f.mail);
        await acknowledgeProcessedMail(f.session, f.mail);
        expect(f.mail.acknowledge.mock.calls).toEqual([[['mail-1']], [['mail-1']]]);
        expect(f.session.sendUserTextMessage).toHaveBeenCalledTimes(1);
    });

    it('does not deliver or ACK when the atomic configuration/board write fails', async () => {
        const f = fixture();
        f.session.updateMetadata.mockRejectedValue(new Error('storage unavailable'));
        await expect(processReliableMail(f.session, f.mail, message())).rejects.toThrow('storage');
        expect(f.session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(f.mail.acknowledge).not.toHaveBeenCalled();
    });

    it.each(['[config for worker]\nmodel  catalog-model', '[review t · attempt 1 · accepted]\nsummary  verified'])('deduplicates control %s without a model turn', async text => {
        const first = fixture();
        await processReliableMail(first.session, first.mail, message(text));
        const second = fixture('codex', first.snapshot(), first.durable);
        await processReliableMail(second.session, second.mail, message(text));
        await acknowledgeProcessedMail(second.session, second.mail);
        expect(first.session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(second.session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(second.session.sendSessionEvent).not.toHaveBeenCalled();
        expect(second.durable.size).toBe(1);
    });

    it('records a rejected config once and retries only the idempotent report/notice and ACK', async () => {
        const first = fixture();
        const validate = vi.fn(async () => { throw new WorkerConfigValidationError('catalog choice unavailable'); });
        first.mail.send.mockResolvedValueOnce({ ok: false, error: 'offline' } as any);
        await expect(processReliableMail(first.session, first.mail, message(), validate)).rejects.toThrow('report');
        const second = fixture('claude', first.snapshot(), first.durable);
        await processReliableMail(second.session, second.mail, message(), validate);
        await acknowledgeProcessedMail(second.session, second.mail);
        expect(validate).toHaveBeenCalledTimes(1);
        expect(second.snapshot().modelMode).toBeUndefined();
        expect(second.snapshot().orchestration!.board![0]).toMatchObject({ state: 'blocked', dispatchId: 'd' });
        expect(first.mail.send.mock.calls[0][1]).toBe(second.mail.send.mock.calls[0][1]);
        expect(second.durable.size).toBe(1);
        expect(first.session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(second.session.sendUserTextMessage).not.toHaveBeenCalled();
    });

    it('quarantines invalid mail as one durable notice, without a model turn', async () => {
        const f = fixture();
        await processReliableMail(f.session, f.mail, { ...message(''), invalid: true });
        await acknowledgeProcessedMail(f.session, f.mail);
        expect(f.session.sendUserTextMessage).not.toHaveBeenCalled();
        expect(f.session.sendSessionEvent.mock.calls[0][0].message).toContain('invalid body');
        expect(f.snapshot().agentMailInbox!['mail-1'].phase).toBe('acked');
    });

    it('bounds receipts by evicting only confirmed IDs and fails closed when all are pending', async () => {
        const seed = fixture().snapshot();
        const inbox: AgentMailInbox = {};
        for (let i = 0; i < AGENT_MAIL_INBOX_LIMIT; i++) inbox['prior-' + i] = { phase: 'processed', kind: 'user', relation: 'hub', at: i };
        const full = fixture('claude', { ...seed, agentMailInbox: inbox });
        await expect(processReliableMail(full.session, full.mail, message())).rejects.toThrow('full');
        expect(full.durable.size).toBe(0);
        expect(Object.keys(full.snapshot().agentMailInbox!)).toHaveLength(512);
        await acknowledgeProcessedMail(full.session, full.mail);
        await processReliableMail(full.session, full.mail, message());
        const stored = full.snapshot().agentMailInbox!;
        // 32 acknowledged receipts are kept as a tail, plus the new letter.
        expect(Object.keys(stored)).toHaveLength(33);
        expect(stored['prior-0']).toBeUndefined();
        expect(stored['mail-1'].phase).toBe('processed');
        expect(full.mail.acknowledge.mock.calls.every(([ids]) => ids.length <= 20)).toBe(true);
    });

    it('does not reset malformed duplicate protection or deliver after stop', async () => {
        const f = fixture('claude', { ...fixture().snapshot(), agentMailInbox: { old: { phase: 'broken' } } } as any);
        await expect(processReliableMail(f.session, f.mail, message())).rejects.toThrow('invalid');
        expect(f.session.sendUserTextMessage).not.toHaveBeenCalled();
        const stopped = fixture();
        await processReliableMail(stopped.session, stopped.mail, message(), undefined, () => false);
        expect(stopped.session.updateMetadata).not.toHaveBeenCalled();
    });
    it('keeps only a short tail of acknowledged receipts in session metadata', async () => {
        const inbox: AgentMailInbox = {};
        for (let n = 0; n < 40; n++) inbox['old-' + n] = { phase: 'acked', kind: 'user', relation: 'hub', at: n };
        inbox.pending = { phase: 'projected', kind: 'user', relation: 'hub', at: 1 };
        inbox.done = { phase: 'processed', kind: 'user', relation: 'hub', at: 100 };
        const f = fixture('claude', { flavor: 'claude', path: '/fixture', host: 'fixture', agentMailInbox: inbox } as Metadata);
        await acknowledgeProcessedMail(f.session, f.mail);
        const kept = f.snapshot().agentMailInbox!;
        expect(Object.values(kept).filter(receipt => receipt.phase === 'acked')).toHaveLength(32);
        expect(kept.done.phase).toBe('acked');
        expect(kept.pending.phase).toBe('projected'); // Unfinished work is never dropped.
        expect(kept['old-0']).toBeUndefined();
        expect(kept['old-39']).toBeDefined();
    });
});
