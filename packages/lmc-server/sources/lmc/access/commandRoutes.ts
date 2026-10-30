import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { lmcAuth } from '../auth';
import { accessTransaction } from './transaction';
import { AccessError } from './policy';
import { requireCollaborationAgent, requireSessionAction, sharedActionTarget } from './execution';
import { decryptResourceJson, encryptResourceJson } from './resourceCrypto';
import { allocateSessionSeqBatch, allocateUserSeq } from '@/storage/seq';
import { buildNewMessageUpdate, eventRouter } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { authorizeDeviceRun } from './deviceRuns';
import { db } from '@/storage/db';

const paramsSchema = z.object({ id: z.string().min(1).max(191) });
export function registerCommandRoutes(app: FastifyInstance, deps: { enabled: () => boolean; origin: string }) {
    app.register(async scope => {
        scope.addHook('onRequest', async (req, reply) => {
            reply.header('Cache-Control', 'no-store');
            if (!deps.enabled()) return reply.code(404).send({ error: '多账号功能尚未启用' });
            if (req.headers.origin && req.headers.origin !== deps.origin) return reply.code(403).send({ error: '请求来源无效' });
        });
        scope.setErrorHandler((error, _req, reply) => {
            if (error instanceof AccessError) return reply.code(error.status).send({ error: error.message, code: error.code });
            if (error instanceof z.ZodError) return reply.code(400).send({ error: '消息格式无效' });
            return reply.code(500).send({ error: '协作操作未完成，请稍后重试' });
        });
        scope.post('/v1/lmc/sessions/:id/commands', { bodyLimit: 256 * 1024 }, async req => {
            const verified = await lmcAuth.verifyToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
            if (verified?.kind !== 'web') throw new AccessError(401, 'web_required', '请使用 LMC 网页账号登录');
            const { id: sessionId } = paramsSchema.parse(req.params);
            const input = z.object({ requestId: z.string().min(1).max(128), content: z.string().max(200000) }).strict().parse(req.body);
            const result = await accessTransaction(async tx => {
                const access = await requireSessionAction(tx, verified.userId, sessionId, 'send');
                await authorizeDeviceRun(tx, sessionId);
                const { session } = access;
                if (!session.dataEncryptionKey) throw new AccessError(409, 'legacy_key', '此会话尚不支持协作');
                const existing = await tx.lmcSharedCommand.findUnique({ where: { sessionId_actorId_requestId: { sessionId, actorId: verified.userId, requestId: input.requestId } } });
                if (existing) return { id: existing.id, state: existing.state, ownerId: session.accountId, message: null };
                await requireCollaborationAgent(session.accountId, sessionId);
                const id = 'lmc-shared:' + randomUUID();
                const content = await lmcAuth.withResourceKey(tx, { accountId: session.accountId, ownerKey: session.dataEncryptionKey, keyMode: 'sealed' }, key => {
                    let value: unknown;
                    try { value = decryptResourceJson(key, input.content); } catch { throw new AccessError(400, 'invalid_message', '消息解密失败'); }
                    const prompt = z.object({ text: z.string().min(1).max(65536) }).strict().parse(value);
                    if (/^\s*[!/]/.test(prompt.text)) throw new AccessError(400, 'command_forbidden', '共享消息请使用普通文字；运行设置由会话拥有者管理');
                    // No client-supplied role, engine, credentials, tool policy,
                    // model switch, slash command or interrupt intent survives.
                    return encryptResourceJson(key, { role: 'user', localKey: id, content: { type: 'text', text: prompt.text },
                        meta: { sentFrom: 'shared', intent: 'queue', actor: { id: verified.userId, name: access.actorName }, sharedCommandId: id } });
                });
                const seqs = await allocateSessionSeqBatch(sessionId, 1, tx);
                const message = await tx.sessionMessage.create({ data: { sessionId, localId: id, seq: seqs[0], content: { t: 'encrypted', c: content } } });
                await tx.lmcSharedCommand.create({ data: { id, sessionId, actorId: verified.userId, requestId: input.requestId, policyVersion: access.version } });
                await tx.lmcAccessAudit.create({ data: { actorId: verified.userId, kind: 'session', targetId: sessionId, action: 'command.queue', after: { commandId: id } } });
                return { id, state: 'queued', ownerId: session.accountId, message };
            });
            if (result.message) eventRouter.emitUpdate({ userId: result.ownerId,
                payload: buildNewMessageUpdate(result.message, sessionId, await allocateUserSeq(result.ownerId), randomKeyNaked(12)),
                recipientFilter: { type: 'all-interested-in-session', sessionId } });
            return { commandId: result.id, state: result.state };
        });
        // Recovery only returns unclaimed commands. The execution boundary
        // still rechecks the sender's current permission before claiming one.
        scope.get('/v1/lmc/sessions/:id/commands/pending', async req => {
            const verified = await lmcAuth.verifyToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
            if (!verified || verified.kind === 'web') throw new AccessError(401, 'agent_required', '需要会话 Agent');
            const { id: sessionId } = paramsSchema.parse(req.params);
            const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
            if (session?.accountId !== verified.userId || (verified.kind === 'session' && verified.extras?.sessionId !== sessionId)) throw new AccessError(403, 'agent_required', '会话 Agent 不匹配');
            const commands = await db.lmcSharedCommand.findMany({ where: { sessionId, state: 'queued' }, select: { id: true } });
            const messages = await db.sessionMessage.findMany({ where: { sessionId, localId: { in: commands.map(c => c.id) } }, orderBy: { seq: 'asc' }, select: { content: true } });
            return { messages };
        });
        scope.post('/v1/lmc/sessions/:id/commands/claim', { bodyLimit: 2048 }, async req => {
            const verified = await lmcAuth.verifyToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
            if (!verified || verified.kind === 'web') throw new AccessError(401, 'agent_required', '需要会话 Agent');
            const { id: sessionId } = paramsSchema.parse(req.params);
            const { commandId } = z.object({ commandId: z.string().min(1).max(191) }).strict().parse(req.body);
            return accessTransaction(async tx => {
                const session = await tx.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
                if (session?.accountId !== verified.userId || (verified.kind === 'session' && verified.extras?.sessionId !== sessionId)) throw new AccessError(403, 'agent_required', '会话 Agent 不匹配');
                const command = await tx.lmcSharedCommand.findUnique({ where: { id: commandId } });
                if (!command || command.sessionId !== sessionId || command.state !== 'queued') return { allowed: false };
                let allowed = false;
                try { const access = await requireSessionAction(tx, command.actorId, sessionId, 'send'); await authorizeDeviceRun(tx, sessionId); allowed = command.policyVersion === access.version; } catch (error) { if (!(error instanceof AccessError)) throw error; }
                await tx.lmcSharedCommand.update({ where: { id: commandId }, data: { state: allowed ? 'started' : 'cancelled', claimedAt: new Date() } });
                await tx.lmcAccessAudit.create({ data: { actorId: command.actorId, kind: 'session', targetId: sessionId, action: allowed ? 'command.start' : 'command.cancel', after: { commandId } } });
                return { allowed };
            });
        });
        scope.post('/v1/lmc/sessions/:id/action', { bodyLimit: 128 * 1024 }, async req => {
            const verified = await lmcAuth.verifyToken(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
            if (verified?.kind !== 'web') throw new AccessError(401, 'web_required', '请使用 LMC 网页账号登录');
            const { id: sessionId } = paramsSchema.parse(req.params);
            const input = z.object({ method: z.enum(['abort', 'permission', 'communication']), params: z.string().max(100000) }).strict().parse(req.body);
            // Resolve the live target first. Authorization is checked again in
            // the transaction immediately before emitting the operation.
            const access = await accessTransaction(tx => requireSessionAction(tx, verified.userId, sessionId, input.method === 'abort' ? 'stop' : 'approve'));
            const target = await sharedActionTarget(access.session.accountId, sessionId, input.method);
            let delivery: Promise<unknown> | undefined;
            await accessTransaction(async tx => {
                const current = await requireSessionAction(tx, verified.userId, sessionId, input.method === 'abort' ? 'stop' : 'approve');
                await authorizeDeviceRun(tx, sessionId);
                if (!current.session.dataEncryptionKey) throw new AccessError(409, 'legacy_key', '旧会话不支持协作');
                const params = await lmcAuth.withResourceKey(tx, { accountId: current.session.accountId, ownerKey: current.session.dataEncryptionKey, keyMode: 'sealed' }, key => {
                    const raw = decryptResourceJson(key, input.params);
                    const value = input.method === 'abort' ? z.object({ reason: z.string().max(4000).optional() }).strict().parse(raw)
                        : input.method === 'permission' ? z.object({ id: z.string().min(1).max(200), approved: z.boolean(), decision: z.enum(['approved', 'denied', 'abort']).optional(), updatedInput: z.record(z.string(), z.unknown()).optional() }).strict().parse(raw)
                        : z.object({ id: z.string().min(1).max(200), kind: z.string().max(64), status: z.enum(['answered', 'cancelled']), answers: z.record(z.string(), z.unknown()).optional() }).strict().parse(raw);
                    return encryptResourceJson(key, value);
                });
                await tx.lmcAccessAudit.create({ data: { actorId: verified.userId, kind: 'session', targetId: sessionId, action: 'session.' + input.method } });
                delivery = target.timeout(30_000).emitWithAck('rpc-request', { method: `${sessionId}:${input.method}`, params });
                // Register a rejection handler now; the transaction commits
                // before waiting for the Agent's response.
                void delivery.catch(() => {});
            });
            try { return { result: await delivery }; }
            catch { throw new AccessError(504, 'action_unconfirmed', '操作结果尚未确认，请查看会话状态后再试'); }
        });
    });
}
