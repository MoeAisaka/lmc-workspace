import { db } from '@/storage/db';
import { Prisma } from '@/generated/client';
import { EventEmitter } from 'node:events';
import { lmcAuth } from '../auth';
import { loadActor } from './accounts';
import { accessTransaction } from './transaction';
import { multiAccountEnabled } from './features';
import { notifySessionAccessChanged } from './sessionNotifications';
import { AccessError, canAccess, canManage, validatePolicyChange, type ResourceKind, type Policy, type Grant } from './policy';

export const sharingChanges = new EventEmitter();
sharingChanges.setMaxListeners(0);
export { multiAccountEnabled } from './features';
type Store = Pick<Prisma.TransactionClient, 'session' | 'machine' | 'project' | 'fileAsset' | 'lmcResourcePolicy' | 'account'>;
async function resourceOwner(kind: ResourceKind, id: string, tx: Store): Promise<string> {
    const select = { accountId: true };
    const resource = kind === 'file' ? await tx.fileAsset.findFirst({ where: { id, state: 'ready' }, select })
        : kind === 'session' ? await tx.session.findUnique({ where: { id }, select })
        : kind === 'machine' ? await tx.machine.findUnique({ where: { id }, select })
        : kind === 'project' ? await tx.project.findUnique({ where: { id }, select }) : null;
    if (!resource) throw new AccessError(404, 'not_found', '资源不存在');
    return resource.accountId;
}
const actions = (value: unknown): string[] => Array.isArray(value) && value.every(v => typeof v === 'string') ? value as string[] : [];
async function policyFor(kind: ResourceKind, resourceId: string, ownerAccountId: string, tx: Store) {
    const stored = await tx.lmcResourcePolicy.findUnique({ where: { kind_resourceId: { kind, resourceId } }, include: { grants: true } });
    if (stored && stored.ownerAccountId !== ownerAccountId) throw new AccessError(409, 'owner_changed', '资源归属已变化，需要重新设置授权');
    const policy: Policy = { ownerAccountId, version: stored?.version ?? 0, adminManaged: stored?.adminManaged ?? false,
        grants: stored?.grants.map(g => ({ accountId: g.accountId, actions: actions(g.actions) })) ?? [] };
    return { policy, stored };
}
export const resourcesService = {
    async list(actorId: string, ownerId: string) {
        const actor = await loadActor(actorId);
        if (actor.id !== ownerId && actor.role !== 'admin') throw new AccessError(403, 'sharing_forbidden', '只能管理自己的资源');
        // Metadata necessary for access management only. No encrypted content/key.
        const [files, sessions, machines, policies] = await Promise.all([
            db.fileAsset.findMany({ where: { accountId: ownerId, state: 'ready' }, select: { id: true, createdAt: true, size: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
            db.session.findMany({ where: { accountId: ownerId }, select: { id: true, createdAt: true, updatedAt: true, active: true }, orderBy: { updatedAt: 'desc' }, take: 200 }),
            db.machine.findMany({ where: { accountId: ownerId }, select: { id: true, createdAt: true, updatedAt: true, active: true }, orderBy: { updatedAt: 'desc' }, take: 200 }),
            db.lmcResourcePolicy.findMany({ where: { ownerAccountId: ownerId }, include: { grants: true }, take: 1000 }),
        ]);
        const policyByKey = new Map(
            policies.map(p => [
                `${p.kind}:${p.resourceId}`,
                {
                    adminManaged: p.adminManaged,
                    grants: p.grants.map(g => ({ accountId: g.accountId, actions: actions(g.actions) })),
                },
            ]),
        );
        const attachPolicy = <T extends { kind: string; id: string }>(item: T) => {
            const p = policyByKey.get(`${item.kind}:${item.id}`);
            return { ...item, adminManaged: p?.adminManaged ?? false, grants: p?.grants ?? [] };
        };
        return [
            ...files.map(f => attachPolicy({ kind: 'file' as const, id: f.id, createdAt: f.createdAt, size: Number(f.size) })),
            ...sessions.map(s => attachPolicy({ kind: 'session' as const, id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, active: s.active, size: null })),
            ...machines.map(m => attachPolicy({ kind: 'machine' as const, id: m.id, createdAt: m.createdAt, updatedAt: m.updatedAt, active: m.active, size: null })),
        ];
    },
    async get(actorId: string, kind: ResourceKind, resourceId: string) {
        const actor = await loadActor(actorId), owner = await resourceOwner(kind, resourceId, db);
        const { policy } = await policyFor(kind, resourceId, owner, db);
        if (actor.id !== owner && actor.role !== 'admin') throw new AccessError(404, 'not_found', '资源不存在');
        const session = kind === 'session' ? await db.session.findUnique({ where: { id: resourceId }, select: { dataEncryptionKey: true } }) : null;
        const machine = kind === 'machine' ? await db.machine.findUnique({ where: { id: resourceId }, select: { dataEncryptionKey: true } }) : null;
        const supported = kind === 'file' || (kind === 'session' && !!session?.dataEncryptionKey) || (kind === 'machine' && !!machine?.dataEncryptionKey);
        return { ...policy, kind, resourceId, canManage: canManage(actor, policy), sharingSupported: supported,
            unavailableReason: supported ? null : kind === 'session' ? '此旧会话使用账号级密钥，须迁移为独立会话密钥后才能共享' : '此资源的执行隔离或密钥分发尚未接通，暂不开放共享' };
    },
    async set(actorId: string, kind: ResourceKind, resourceId: string, input: { version: number; adminManaged: boolean; grants: Grant[] }) {
        const result = await accessTransaction(async tx => {
            const actor = await loadActor(actorId, tx), owner = await resourceOwner(kind, resourceId, tx);
            const { policy } = await policyFor(kind, resourceId, owner, tx);
            validatePolicyChange(actor, policy, input, kind);
            if (kind !== 'file' && kind !== 'session' && kind !== 'machine') throw new AccessError(409, 'sharing_not_ready', '此资源尚未接通共享');
            if (kind === 'machine' && input.grants.some(g => !g.actions.includes('read'))) throw new AccessError(400, 'invalid_actions', '共享设备须包含查看权限');
            if (kind === 'session' && input.grants.some(g => !g.actions.includes('read') || g.actions.includes('configure'))) throw new AccessError(400, 'invalid_actions', '共享会话须包含查看权限；运行配置由拥有者管理');
            const file = kind === 'file' ? await tx.fileAsset.findUniqueOrThrow({ where: { id: resourceId } }) : null;
            const session = kind === 'session' ? await tx.session.findUniqueOrThrow({ where: { id: resourceId } }) : null;
            const machine = kind === 'machine' ? await tx.machine.findUniqueOrThrow({ where: { id: resourceId } }) : null;
            if (machine && !machine.dataEncryptionKey && input.grants.length) throw new AccessError(409, 'legacy_key', '设备密钥版本不支持共享，请升级并重新连接');
            if (session && !session.dataEncryptionKey && input.grants.length) throw new AccessError(409, 'legacy_key', '旧会话需要迁移为独立会话密钥后才能共享');
            const grants: Array<Grant & { keyEnvelope: Uint8Array | null }> = [];
            for (const grant of input.grants) {
                const recipient = await tx.account.findUnique({ where: { id: grant.accountId }, select: { enabled: true } });
                if (!recipient?.enabled) throw new AccessError(400, 'invalid_member', '共享对象不存在或已停用');
                let keyEnvelope: Uint8Array | null;
                try { keyEnvelope = kind === 'machine' ? null : await lmcAuth.rewrapResourceKey(tx, file ?? { accountId: owner, ownerKey: session!.dataEncryptionKey!, keyMode: 'sealed' }, grant.accountId); }
                catch { throw new AccessError(409, 'key_unavailable', '无法分发此资源的密钥，原共享设置未改变'); }
                grants.push({ ...grant, keyEnvelope });
            }
            const updated = await tx.lmcResourcePolicy.upsert({ where: { kind_resourceId: { kind, resourceId } },
                create: { kind, resourceId, ownerAccountId: owner, version: 1, adminManaged: input.adminManaged },
                update: { version: { increment: 1 }, adminManaged: input.adminManaged } });
            await tx.lmcResourceGrant.deleteMany({ where: { policyId: updated.id } });
            for (const grant of grants) await tx.lmcResourceGrant.create({ data: { policyId: updated.id, accountId: grant.accountId, actions: grant.actions, keyEnvelope: grant.keyEnvelope ? new Uint8Array(grant.keyEnvelope) : null } });
            await tx.lmcAccessAudit.create({ data: { actorId, targetId: resourceId, kind, action: 'sharing.update',
                before: { grants: policy.grants, adminManaged: policy.adminManaged, version: policy.version },
                after: { grants: input.grants, adminManaged: input.adminManaged, version: updated.version } } });
            return { ...input, ownerAccountId: owner, version: updated.version, affected: Array.from(new Set([owner, ...policy.grants.map(g => g.accountId), ...input.grants.map(g => g.accountId)])) };
        });
        sharingChanges.emit('change', { kind, resourceId, accountIds: result.affected });
        if (kind === 'session') notifySessionAccessChanged(resourceId, result.affected);
        return { version: result.version };
    },
    async audit(actorId: string, kind: ResourceKind, resourceId: string) {
        await this.get(actorId, kind, resourceId);
        return db.lmcAccessAudit.findMany({ where: { kind, targetId: resourceId }, select: { id: true, actorId: true, action: true, before: true, after: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 50 });
    },
};

/** Each file read rechecks the resource, recipient and current grant. */
export async function readableFile(accountId: string, id: string) {
    const file = await db.fileAsset.findFirst({ where: { id, state: 'ready' } });
    if (!file) return null;
    if (file.accountId === accountId) return file;
    if (!multiAccountEnabled()) return null;
    const actor = await loadActor(accountId);
    const { policy, stored } = await policyFor('file', id, file.accountId, db);
    const grant = stored?.grants.find(g => g.accountId === accountId);
    if (!canAccess(actor, policy, 'read') || !grant?.keyEnvelope) return null;
    return { ...file, ownerKey: grant.keyEnvelope, keyMode: 'sealed' };
}
export async function sharedFileIds(accountId: string): Promise<string[]> {
    if (!multiAccountEnabled()) return [];
    const policies = await db.lmcResourcePolicy.findMany({ where: { kind: 'file', grants: { some: { accountId } } }, include: { grants: { where: { accountId } } }, take: 1000 });
    return policies.filter(p => p.grants.some(g => actions(g.actions).includes('read') && g.keyEnvelope)).map(p => p.resourceId);
}
