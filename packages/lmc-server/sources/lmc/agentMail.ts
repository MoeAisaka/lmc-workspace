import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { db } from '@/storage/db';
import { lmcAuth } from './auth';

/**
 * Agent-to-agent mail.
 *
 * Sessions cannot read one another: each has its own data key, sealed to the
 * account's public key, and a paired agent holds no account secret. So agents
 * share one derived channel key instead, and the center only ever sees
 * ciphertext for both the mail and the directory that lets one agent name
 * another. What the center does see — which session wrote to which, and when —
 * it already stores for every message.
 *
 * A hop counter travels with each message so two agents answering each other
 * cannot bill an account forever.
 */
export const AGENT_MAIL_MAX_HOPS = 4;
const MAX_BODY = 64 * 1024;

const bearer = (request: FastifyRequest) => request.headers.authorization?.replace(/^Bearer /, '') || '';

async function agentAccount(request: FastifyRequest) {
    const verified = await lmcAuth.verifyToken(bearer(request));
    return verified && verified.kind === 'device' ? verified.userId : null;
}

/** Sessions an agent may name: only ones on its own account. */
async function ownSession(accountId: string, sessionId: string) {
    return db.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } });
}

export function lmcAgentMailRoutes(app: FastifyInstance<any, any, any, any>) {
    app.get('/v1/lmc/agent/channel-key', async (request, reply) => {
        const accountId = await agentAccount(request);
        if (!accountId) return reply.code(401).send({ error: 'Device authorization is no longer valid' });
        const key = await lmcAuth.agentChannelKey(accountId);
        if (!key) return reply.code(404).send({ error: 'This account has no channel key' });
        return { key, mailProtocol: 2 };
    });

    app.put('/v1/lmc/agent/directory', async (request, reply) => {
        const accountId = await agentAccount(request);
        if (!accountId) return reply.code(401).send({ error: 'Device authorization is no longer valid' });
        const parsed = z.object({ sessionId: z.string().min(1).max(64), body: z.string().max(MAX_BODY) }).safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid directory entry' });
        if (!await ownSession(accountId, parsed.data.sessionId)) return reply.code(404).send({ error: 'Unknown session' });
        await db.agentDirectoryEntry.upsert({
            where: { sessionId: parsed.data.sessionId },
            create: { accountId, sessionId: parsed.data.sessionId, body: parsed.data.body },
            update: { body: parsed.data.body },
        });
        return { success: true };
    });

    app.get('/v1/lmc/agent/directory', async (request, reply) => {
        const accountId = await agentAccount(request);
        if (!accountId) return reply.code(401).send({ error: 'Device authorization is no longer valid' });
        const entries = await db.agentDirectoryEntry.findMany({
            where: { accountId },
            select: { sessionId: true, body: true, updatedAt: true },
            orderBy: { updatedAt: 'desc' },
            take: 200,
        });
        // Only sessions that are still live: a directory full of finished
        // sessions would have agents writing to nobody.
        const live = new Set((await db.session.findMany({
            where: { accountId, active: true, id: { in: entries.map((entry) => entry.sessionId) } },
            select: { id: true },
        })).map((session) => session.id));
        return { entries: entries.filter((entry) => live.has(entry.sessionId)) };
    });

    app.post('/v1/lmc/agent/mail', async (request, reply) => {
        const accountId = await agentAccount(request);
        if (!accountId) return reply.code(401).send({ error: 'Device authorization is no longer valid' });
        const parsed = z.object({
            toSessionId: z.string().min(1).max(64),
            fromSessionId: z.string().min(1).max(64),
            body: z.string().max(MAX_BODY),
            hop: z.number().int().min(1).max(AGENT_MAIL_MAX_HOPS),
            idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        }).safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid message' });
        const { toSessionId, fromSessionId, body, hop, idempotencyKey } = parsed.data;
        if (toSessionId === fromSessionId) return reply.code(400).send({ error: 'A session cannot write to itself' });
        if (!await ownSession(accountId, toSessionId)) return reply.code(404).send({ error: 'Unknown recipient' });
        if (!await ownSession(accountId, fromSessionId)) return reply.code(404).send({ error: 'Unknown sender' });
        // Reuse the existing primary-key constraint. Keep delivered rows as tombstones;
        // neither a process restart nor a board's 40-row limit expires report identity.
        const id = idempotencyKey ? 'mail-' + createHash('sha256')
            .update(JSON.stringify([accountId, fromSessionId, toSessionId, idempotencyKey])).digest('hex') : undefined;
        try {
            const mail = await db.agentMail.create({ data: { ...(id ? { id } : {}), accountId, toSessionId, fromSessionId, body, hop } });
            return { id: mail.id, duplicate: false };
        } catch (error) {
            if (!id || (error as { code?: string }).code !== 'P2002') throw error;
            const existing = await db.agentMail.findUnique({ where: { id } });
            if (!existing || existing.accountId !== accountId || existing.fromSessionId !== fromSessionId || existing.toSessionId !== toSessionId) throw error;
            return { id: existing.id, duplicate: true };
        }
    });

    app.get('/v1/lmc/agent/mail', async (request, reply) => {
        const accountId = await agentAccount(request);
        if (!accountId) return reply.code(401).send({ error: 'Device authorization is no longer valid' });
        const parsed = z.object({ sessionId: z.string().min(1).max(64) }).safeParse(request.query);
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
        const pending = await db.agentMail.findMany({
            where: { accountId, toSessionId: parsed.data.sessionId, deliveredAt: null },
            orderBy: { createdAt: 'asc' },
            take: 20,
        });
        const claimed: typeof pending = [];
        for (const mail of pending) {
            // Marked as the agent takes them: a crash between here and the
            // engine loses a message, which is the safer failure — redelivery
            // would replay work the agent may already have done.
            const result = await db.agentMail.updateMany({
                where: { id: mail.id, accountId, toSessionId: parsed.data.sessionId, deliveredAt: null },
                data: { deliveredAt: new Date() },
            });
            if (result.count === 1) claimed.push(mail);
        }
        return {
            mail: claimed.map((mail) => ({
                id: mail.id,
                fromSessionId: mail.fromSessionId,
                body: mail.body,
                hop: mail.hop,
                createdAt: mail.createdAt.getTime(),
            })),
        };
    });
}
