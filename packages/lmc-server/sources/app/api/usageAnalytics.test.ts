import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { UsageRecordSchema, type UsageRecord } from 'lmc-wire';
const mocks = vi.hoisted(() => ({
    session: { findFirst: vi.fn() }, machine: { findFirst: vi.fn() },
    usageReport: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock('@/storage/db', () => ({ db: mocks }));
vi.mock('@/storage/inTx', () => ({ inTx: (fn: any) => fn(mocks) }));
import { mergeUsage, usageAnalyticsHandler, usageAnalyticsRoutes } from './usageAnalytics';
const record: UsageRecord = { key: 'u2:claude:one', sessionId: 's1', machineId: 'm1', engine: 'claude', model: 'claude', occurredAt: 1791158400000, tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } };
beforeEach(() => { vi.resetAllMocks(); mocks.session.findFirst.mockResolvedValue({ id: 's1' }); mocks.machine.findFirst.mockResolvedValue({ id: 'm1' }); });
describe('usage storage contract', () => {
    it('merges Claude fragments monotonically, keeps original time and never mutates Codex deltas', () => {
        const newer = { ...record, occurredAt: record.occurredAt + 1000, tokens: { ...record.tokens, output: 80, input: 0 } };
        const merged = mergeUsage(record, newer);
        expect(merged.tokens.input).toBe(10); expect(merged.tokens.output).toBe(80); expect(merged.occurredAt).toBe(record.occurredAt);
        expect(mergeUsage({ ...record, engine: 'codex' }, newer).tokens.output).toBe(20);
    });
    it('rejects negative/nonfinite counts and engines outside the requested scope', () => {
        expect(UsageRecordSchema.safeParse({ ...record, engine: 'gemini' }).success).toBe(false);
        expect(UsageRecordSchema.safeParse({ ...record, tokens: { ...record.tokens, input: -1 } }).success).toBe(false);
        expect(UsageRecordSchema.safeParse({ ...record, tokens: { ...record.tokens, input: Infinity } }).success).toBe(false);
    });
    it('requires a matching authenticated LMC session and owned machine', async () => {
        let handler: any; const reply = vi.fn();
        usageAnalyticsHandler('owner', { connectionType: 'session-scoped', sessionId: 'different', socket: { on: (_: string, fn: any) => { handler = fn; } } } as any);
        await handler(record, reply); expect(reply).toHaveBeenLastCalledWith({ success: false }); expect(mocks.usageReport.create).not.toHaveBeenCalled();
        usageAnalyticsHandler('owner', { connectionType: 'session-scoped', sessionId: 's1', socket: { on: (_: string, fn: any) => { handler = fn; } } } as any);
        mocks.machine.findFirst.mockResolvedValue(null);
        await handler(record, reply); expect(reply).toHaveBeenLastCalledWith({ success: false });
        mocks.machine.findFirst.mockResolvedValue({ id: 'm1' });
        await handler(record, reply); expect(reply).toHaveBeenLastCalledWith({ success: true });
        expect(mocks.usageReport.create.mock.calls[0][0].data.data.tokens.total).toBe(100);
        expect(mocks.session.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1', accountId: 'owner' } }));
    });
    it('queries only owned v2 records with bounded range and stable paging', async () => {
        const app = Fastify().setValidatorCompiler(validatorCompiler).setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (req: any) => { req.userId = 'owner'; });
        usageAnalyticsRoutes(app as any);
        mocks.usageReport.findMany.mockResolvedValue(Array.from({ length: 1001 }, (_, i) => ({ id: `id-${i}`, data: { detail: record } })));
        mocks.usageReport.findFirst.mockResolvedValue({ createdAt: new Date(record.occurredAt) });
        const start = record.occurredAt, end = start + 86400_000;
        const response = await app.inject({ method: 'POST', url: '/v2/usage/query', payload: { start, end, cursor: 'cursor', updatedSince: start } });
        expect(response.statusCode).toBe(200); expect(response.json().records).toHaveLength(1000); expect(response.json().nextCursor).toBe('id-999');
        expect(mocks.usageReport.findMany.mock.calls[0][0].where).toMatchObject({ accountId: 'owner', key: { startsWith: 'u2:' }, sessionId: { not: null }, id: { gt: 'cursor' } });
        expect((await app.inject({ method: 'POST', url: '/v2/usage/query', payload: { start, end: start + 40 * 86400_000 } })).statusCode).toBe(400);
        await app.close();
    });
});
