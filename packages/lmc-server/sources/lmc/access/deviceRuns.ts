import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@/generated/client';
import { db } from '@/storage/db';
import { lmcAuth } from '../auth';
import { accessTransaction } from './transaction';
import { AccessError } from './policy';
import { sharedMachineTarget } from './execution';
import { decryptResourceJson, encryptResourceJson } from './resourceCrypto';
import { sessionResponse, readableSession } from './sessions';
import { multiAccountEnabled } from './features';
import { SharedRuntimeSchema } from 'lmc-wire';
import { requireSessionAction } from './execution';

const idSchema = z.object({ id: z.string().regex(/^[\w-]{1,191}$/) });
export async function requireMachineExecution(tx: Prisma.TransactionClient, actorId: string, machineId: string) {
    if (!multiAccountEnabled()) throw new AccessError(404, 'not_enabled', '多账号功能尚未启用');
    const [actor, machine, policy] = await Promise.all([
        tx.account.findUnique({ where: { id: actorId }, select: { enabled: true } }),
        tx.machine.findUnique({ where: { id: machineId } }),
        tx.lmcResourcePolicy.findUnique({ where: { kind_resourceId: { kind: 'machine', resourceId: machineId } }, include: { grants: { where: { accountId: actorId } } } }),
    ]);
    const actions = policy?.grants[0]?.actions;
    if (!actor?.enabled || !machine || (machine.accountId !== actorId && (policy?.ownerAccountId !== machine.accountId || !Array.isArray(actions) || !actions.includes('read') || !actions.includes('execute')))) throw new AccessError(403, 'device_forbidden', '设备使用权限已撤销或尚未授予');
    if (!machine.dataEncryptionKey) throw new AccessError(409, 'legacy_machine', '设备密钥版本不支持共享，请升级并重新连接');
    return { machine, version: policy?.version ?? 0 };
}

export async function authorizeDeviceRun(tx: Prisma.TransactionClient, sessionId: string) {
    const run = await tx.lmcDeviceRun.findUnique({ where: { sessionId } });
    if (!run) return;
    const access = await requireMachineExecution(tx, run.accountId, run.machineId);
    if (access.machine.accountId !== run.hostOwnerId || access.version !== run.policyVersion) throw new AccessError(403, 'device_changed', '设备共享范围已变化，请重新打开此会话');
}

export function registerDeviceRunRoutes(app: FastifyInstance, deps: { enabled: () => boolean; origin: string }) {
    app.register(async scope => {
        scope.addHook('onRequest', async (req, reply) => {
            reply.header('Cache-Control', 'no-store');
            if (!deps.enabled()) return reply.code(404).send({ error: '多账号功能尚未启用' });
            if (req.headers.origin && req.headers.origin !== deps.origin) return reply.code(403).send({ error: '请求来源无效' });
        });
        scope.setErrorHandler((error, _req, reply) => {
            if (error instanceof AccessError) return reply.code(error.status).send({ error: error.message, code: error.code });
            if (error instanceof z.ZodError) return reply.code(400).send({ error: '输入无效' });
            return reply.code(500).send({ error: '设备操作未完成，请稍后重试' });
        });
        const identity = async (header: string | undefined, kind: 'web' | 'device' | 'session') => {
            const verified = await lmcAuth.verifyToken(header?.replace(/^Bearer /, '') ?? '');
            if (verified?.kind !== kind) throw new AccessError(401, 'identity_required', '登录身份不匹配');
            return verified;
        };
        scope.get('/v1/lmc/shared-machines', async req => {
            const actor = await identity(req.headers.authorization, 'web');
            const policies = await db.lmcResourcePolicy.findMany({ where: { kind: 'machine', grants: { some: { accountId: actor.userId } } }, include: { grants: { where: { accountId: actor.userId } } } });
            const result: Array<{ id: string; name: string; platform: string; active: boolean; canExecute: boolean }> = [];
            for (const policy of policies) {
                const actions = policy.grants[0]?.actions;
                if (!Array.isArray(actions) || !actions.includes('read')) continue;
                const machine = await db.machine.findUnique({ where: { id: policy.resourceId } });
                if (!machine?.dataEncryptionKey || machine.accountId !== policy.ownerAccountId) continue;
                const metadata = await db.$transaction(tx => lmcAuth.withResourceKey(tx, { accountId: machine.accountId, ownerKey: machine.dataEncryptionKey!, keyMode: 'sealed' }, key => decryptResourceJson(key, machine.metadata))) as Record<string, unknown>;
                result.push({ id: machine.id, name: String(metadata.displayName ?? metadata.host ?? '共享设备'), platform: String(metadata.platform ?? ''), active: machine.active && Date.now() - machine.lastActiveAt.getTime() < 90_000, canExecute: actions.includes('execute') });
            }
            return { machines: result };
        });

        async function dispatch(sessionId: string) {
            const run = await db.lmcDeviceRun.findUniqueOrThrow({ where: { sessionId } });
            const machine = await db.machine.findUniqueOrThrow({ where: { id: run.machineId } });
            const target = await sharedMachineTarget(run.hostOwnerId, run.machineId);
            const params = await db.$transaction(tx => lmcAuth.withResourceKey(tx, { accountId: run.hostOwnerId, ownerKey: machine.dataEncryptionKey!, keyMode: 'sealed' }, key => encryptResourceJson(key, { sessionId, launchId: run.launchId })));
            const result = await target.timeout(100_000).emitWithAck('rpc-request', { method: `${run.machineId}:shared-runtime`, params });
            const response = await db.$transaction(tx => lmcAuth.withResourceKey(tx, { accountId: run.hostOwnerId, ownerKey: machine.dataEncryptionKey!, keyMode: 'sealed' }, key => decryptResourceJson(key, result))) as any;
            if (response?.sessionId !== sessionId || response?.type !== 'success') throw new AccessError(409, 'start_failed', '设备未完成启动，请查看设备状态后重试');
            await db.lmcDeviceRun.updateMany({ where: { sessionId, state: 'pending' }, data: { state: 'active' } });
        }
        scope.post('/v1/lmc/machines/:id/runs', { bodyLimit: 4096 }, async req => {
            const actor = await identity(req.headers.authorization, 'web');
            const { id: machineId } = idSchema.parse(req.params);
            const input = z.object({ requestId: z.string().min(1).max(128), engine: z.enum(['claude', 'codex', 'agy']), title: z.string().max(200).optional() }).strict().parse(req.body);
            const access = await accessTransaction(tx => requireMachineExecution(tx, actor.userId, machineId));
            await sharedMachineTarget(access.machine.accountId, machineId);
            const created = await accessTransaction(async tx => {
                const current = await requireMachineExecution(tx, actor.userId, machineId);
                const existing = await tx.lmcDeviceRun.findUnique({ where: { accountId_requestId: { accountId: actor.userId, requestId: input.requestId } } });
                if (existing) {
                    if (existing.machineId !== machineId || existing.engine !== input.engine) throw new AccessError(409, 'request_conflict', '创建请求已用于另一台设备或引擎');
                    return { id: existing.sessionId, fresh: false };
                }
                const key = new Uint8Array(randomBytes(32));
                try {
                    const metadata = { name: input.title ?? '新对话', flavor: input.engine, machineId, sharedDevice: true };
                    const session = await tx.session.create({ data: { accountId: actor.userId, tag: randomUUID(), metadata: encryptResourceJson(key, metadata), metadataVersion: 1, dataEncryptionKey: new Uint8Array(await lmcAuth.wrapNewResourceKey(tx, actor.userId, key)), active: false } });
                    await tx.lmcDeviceRun.create({ data: { sessionId: session.id, accountId: actor.userId, machineId, hostOwnerId: current.machine.accountId, engine: input.engine, requestId: input.requestId, launchId: randomUUID(), policyVersion: current.version } });
                    await tx.lmcAccessAudit.create({ data: { actorId: actor.userId, kind: 'machine', targetId: machineId, action: 'device.session.create', after: { sessionId: session.id, engine: input.engine } } });
                    return { id: session.id, fresh: true };
                } finally { key.fill(0); }
            });
            if (created.fresh) await dispatch(created.id);
            const run = await db.lmcDeviceRun.findUniqueOrThrow({ where: { sessionId: created.id } });
            return { sessionId: created.id, state: run.state };
        });

        scope.post('/v1/lmc/runtime/:id/claim', { bodyLimit: 2048 }, async req => {
            const host = await identity(req.headers.authorization, 'device');
            const { id: sessionId } = idSchema.parse(req.params);
            const { launchId } = z.object({ launchId: z.string().uuid() }).strict().parse(req.body);
            return accessTransaction(async tx => {
                const run = await tx.lmcDeviceRun.findUnique({ where: { sessionId } });
                if (!run || run.hostOwnerId !== host.userId || run.launchId !== launchId || run.state !== 'pending') throw new AccessError(409, 'launch_unavailable', '启动请求已领取或已失效');
                await authorizeDeviceRun(tx, sessionId);
                const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId } });
                const token = await lmcAuth.createSessionToken(tx, run.accountId, sessionId, run.machineId);
                await tx.lmcDeviceRun.update({ where: { sessionId }, data: { state: 'claimed' } });
                return lmcAuth.withResourceKey(tx, { accountId: run.accountId, ownerKey: session.dataEncryptionKey!, keyMode: 'sealed' }, async key => SharedRuntimeSchema.parse({ sessionId, machineId: run.machineId, accountId: run.accountId, engine: run.engine, token, key: Buffer.from(key).toString('base64'), publicKey: await lmcAuth.resourcePublicKey(tx, run.accountId), resume: session.seq > 0, seq: session.seq, metadata: decryptResourceJson(key, session.metadata) }));
            });
        });
        scope.post('/v1/lmc/runtime/:id/resume', async req => {
            const actor = await identity(req.headers.authorization, 'web');
            const { id: sessionId } = idSchema.parse(req.params);
            // A session shared by its existing owner keeps the owner's native
            // runner. The caller receives neither the machine key nor token.
            if (!await db.lmcDeviceRun.findUnique({ where: { sessionId } })) {
                let delivery: Promise<unknown> | undefined;
                const machine = await accessTransaction(async tx => {
                    const { session } = await requireSessionAction(tx, actor.userId, sessionId, 'send');
                    if (!session.dataEncryptionKey) throw new AccessError(409, 'legacy_key', '旧会话不支持协作恢复');
                    const metadata = await lmcAuth.withResourceKey(tx, { accountId: session.accountId, ownerKey: session.dataEncryptionKey, keyMode: 'sealed' }, key => decryptResourceJson(key, session.metadata)) as Record<string, unknown>;
                    if (typeof metadata.machineId !== 'string') throw new AccessError(409, 'machine_missing', '此会话没有可恢复的设备');
                    const host = await tx.machine.findUnique({ where: { id: metadata.machineId } });
                    if (!host?.dataEncryptionKey || host.accountId !== session.accountId) throw new AccessError(403, 'host_mismatch', '会话与设备归属不匹配');
                    const target = await sharedMachineTarget(host.accountId, host.id);
                    const params = await lmcAuth.withResourceKey(tx, { accountId: host.accountId, ownerKey: host.dataEncryptionKey, keyMode: 'sealed' }, key => encryptResourceJson(key, { sessionId }));
                    delivery = target.timeout(100_000).emitWithAck('rpc-request', { method: `${host.id}:resume-happy-session`, params });
                    void delivery.catch(() => {});
                    await tx.lmcAccessAudit.create({ data: { actorId: actor.userId, kind: 'session', targetId: sessionId, action: 'session.resume' } });
                    return host;
                });
                let result: unknown;
                try { result = await delivery; } catch { throw new AccessError(504, 'resume_unconfirmed', '恢复结果尚未确认，请查看会话状态'); }
                const response = await db.$transaction(tx => lmcAuth.withResourceKey(tx, { accountId: machine.accountId, ownerKey: machine.dataEncryptionKey!, keyMode: 'sealed' }, key => decryptResourceJson(key, result as string))) as any;
                if (response?.type !== 'success' || response.sessionId !== sessionId) throw new AccessError(409, 'resume_failed', '设备未能恢复此会话，请检查设备状态');
                return { type: 'success', sessionId };
            }
            const fresh = await accessTransaction(async tx => {
                await requireSessionAction(tx, actor.userId, sessionId, 'send');
                const run = await tx.lmcDeviceRun.findUnique({ where: { sessionId } });
                if (!run) throw new AccessError(404, 'not_found', '共享设备会话不存在');
                const access = await requireMachineExecution(tx, run.accountId, run.machineId);
                if (access.machine.accountId !== run.hostOwnerId) throw new AccessError(409, 'device_changed', '设备归属已变化');
                if (['pending', 'claimed'].includes(run.state) && Date.now() - run.updatedAt.getTime() < 120_000) throw new AccessError(409, 'start_in_progress', '设备仍在启动此会话，请稍后再试；不会重复创建');
                await tx.lmcDeviceRun.update({ where: { sessionId }, data: { state: 'pending', launchId: randomUUID(), policyVersion: access.version } });
                await tx.lmcAccessAudit.create({ data: { actorId: actor.userId, kind: 'session', targetId: sessionId, action: 'device.session.resume' } });
                return true;
            });
            if (fresh) await dispatch(sessionId);
            return { type: 'success', sessionId };
        });
        scope.post('/v1/lmc/runtime/:id/start', { bodyLimit: 2 * 1024 * 1024 }, async req => {
            const runtime = await identity(req.headers.authorization, 'session');
            const { id: sessionId } = idSchema.parse(req.params);
            if (runtime.extras?.sessionId !== sessionId) throw new AccessError(403, 'scope', '会话身份不匹配');
            const input = z.object({ metadata: z.string().max(1024 * 1024), agentState: z.string().nullable() }).strict().parse(req.body);
            await accessTransaction(async tx => {
                await authorizeDeviceRun(tx, sessionId);
                await tx.session.update({ where: { id: sessionId }, data: { metadata: input.metadata, metadataVersion: { increment: 1 }, agentState: input.agentState, agentStateVersion: { increment: 1 }, active: true, lastActiveAt: new Date() } });
                await tx.lmcDeviceRun.update({ where: { sessionId }, data: { state: 'active' } });
            });
            const session = await readableSession(runtime.userId, sessionId, runtime.kind);
            return { session: sessionResponse(session!) };
        });
        scope.post('/v1/lmc/runtime/:id/authorize', async req => {
            const runtime = await identity(req.headers.authorization, 'session');
            const { id: sessionId } = idSchema.parse(req.params);
            if (runtime.extras?.sessionId !== sessionId) throw new AccessError(403, 'scope', '会话身份不匹配');
            await accessTransaction(tx => authorizeDeviceRun(tx, sessionId));
            return { allowed: true };
        });
    });
}
