import { z } from 'zod';
import { UsageRecordSchema, usageTotal, type UsageRecord } from 'lmc-wire';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import type { Fastify } from './types';
import type { ClientConnection } from '@/app/events/eventRouter';

export function mergeUsage(previous: UsageRecord, incoming: UsageRecord): UsageRecord {
    // Codex records are immutable cumulative deltas; replay may have a different
    // local baseline. Claude fragments refine the same provider request.
    if (previous.engine !== 'claude') return previous;
    return { ...previous, tokens: {
        input: Math.max(previous.tokens.input, incoming.tokens.input),
        output: Math.max(previous.tokens.output, incoming.tokens.output),
        cacheRead: Math.max(previous.tokens.cacheRead, incoming.tokens.cacheRead),
        cacheWrite: Math.max(previous.tokens.cacheWrite, incoming.tokens.cacheWrite),
    } };
}

export function usageAnalyticsHandler(userId: string, connection: ClientConnection) {
    connection.socket.on('usage-report-v2', async (body: unknown, callback?: (r: { success: boolean }) => void) => {
        const parsed = UsageRecordSchema.safeParse(body);
        if (!parsed.success || connection.connectionType !== 'session-scoped'
            || parsed.data.sessionId !== connection.sessionId
            || parsed.data.occurredAt > Date.now() + 300_000 || parsed.data.occurredAt < 946684800000) {
            callback?.({ success: false }); return;
        }
        try {
            const incoming = parsed.data;
            const owned = await db.session.findFirst({ where: { id: incoming.sessionId, accountId: userId }, select: { id: true } });
            const machine = await db.machine.findFirst({ where: { id: incoming.machineId, accountId: userId }, select: { id: true } });
            if (!owned || !machine) { callback?.({ success: false }); return; }
            await inTx(async tx => {
                const identity = { accountId: userId, sessionId: incoming.sessionId, key: incoming.key };
                const previous = await tx.usageReport.findUnique({ where: { accountId_sessionId_key: identity } });
                const detail = previous?.data.detail ? mergeUsage(previous.data.detail, incoming) : incoming;
                if (previous?.data.detail && JSON.stringify(previous.data.detail) === JSON.stringify(detail)) return;
                const data: PrismaJson.UsageReportData = { detail, tokens: { total: usageTotal(detail.tokens),
                    input: detail.tokens.input, output: detail.tokens.output,
                    cache_read: detail.tokens.cacheRead, cache_creation: detail.tokens.cacheWrite }, cost: { total: 0 } };
                if (previous) await tx.usageReport.update({ where: { id: previous.id }, data: { data } });
                else await tx.usageReport.create({ data: { ...identity, data, createdAt: new Date(detail.occurredAt) } });
            });
            callback?.({ success: true });
        } catch { callback?.({ success: false }); }
    });
}

export function usageAnalyticsRoutes(app: Fastify) {
    app.post('/v2/usage/query', { preHandler: app.authenticate, schema: { body: z.object({
        start: z.number().int().positive(), end: z.number().int().positive(),
        updatedSince: z.number().int().nonnegative().optional(),
        snapshotAt: z.number().int().positive().optional(), cursor: z.string().max(200).optional(),
    }) } }, async (request, reply) => {
        const { start, end, updatedSince, cursor } = request.body;
        if (end <= start || end - start > 32 * 86400_000) return reply.code(400).send({ error: 'Invalid time range' });
        const snapshotAt = Math.min(request.body.snapshotAt ?? Date.now(), Date.now());
        const base = { accountId: request.userId, key: { startsWith: 'u2:' }, sessionId: { not: null } };
        const reports = await db.usageReport.findMany({ where: { ...base, createdAt: { gte: new Date(start), lt: new Date(end) },
            updatedAt: { ...(updatedSince ? { gte: new Date(updatedSince) } : {}), lte: new Date(snapshotAt) },
            ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 1001,
            select: { id: true, data: true } });
        const first = await db.usageReport.findFirst({ where: base, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
        return { records: reports.slice(0, 1000).flatMap(r => {
            const value = UsageRecordSchema.safeParse(r.data.detail);
            return value.success ? [value.data] : [];
        }), nextCursor: reports.length > 1000 ? reports[999].id : null, snapshotAt,
            collectedSince: first?.createdAt.getTime() ?? null };
    });
}
