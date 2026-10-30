import { createHash, randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { Prisma } from '@/generated/client';
import { authRevocations, prepareLmcAccount } from '../auth';
import { accessTransaction } from './transaction';
import { AccessError, validateAccountChange, type Actor, type AccountRole } from './policy';

const publicAccount = { id: true, username: true, role: true, enabled: true, accessVersion: true, createdAt: true } as const;
const invitationView = { id: true, createdById: true, createdAt: true, expiresAt: true, consumedAt: true, revokedAt: true } as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function loadActor(id: string, tx: Pick<Prisma.TransactionClient, 'account'> = db): Promise<Actor> {
    const actor = await tx.account.findUnique({ where: { id }, select: { id: true, role: true, enabled: true } });
    if (!actor?.enabled) throw new AccessError(401, 'account_unavailable', '账号已停用或登录已失效');
    return actor;
}
export function requireAdmin(actor: Actor) {
    if (actor.role !== 'admin') throw new AccessError(403, 'admin_required', '需要管理员权限');
}
export const accountsService = {
    async me(id: string) {
        await loadActor(id);
        return db.account.findUniqueOrThrow({ where: { id }, select: publicAccount });
    },
    async list(id: string) {
        requireAdmin(await loadActor(id));
        return db.account.findMany({ select: publicAccount, orderBy: { createdAt: 'asc' }, take: 1000 });
    },
    async directory(id: string) {
        await loadActor(id);
        // Shared directory deliberately excludes provider identity, email and activity.
        return db.account.findMany({ where: { enabled: true }, select: { id: true, username: true }, orderBy: { username: 'asc' }, take: 1000 });
    },
    async update(actorId: string, targetId: string, patch: { role: AccountRole; enabled: boolean; version: number }) {
        const result = await accessTransaction(async tx => {
            const actor = await loadActor(actorId, tx);
            requireAdmin(actor);
            const target = await tx.account.findUnique({ where: { id: targetId }, select: publicAccount });
            if (!target) throw new AccessError(404, 'not_found', '账号不存在');
            if (target.accessVersion !== patch.version) throw new AccessError(409, 'account_conflict', '账号已更新，请刷新后重试');
            validateAccountChange(actor, target, patch, await tx.account.count({ where: { role: 'admin', enabled: true } }));
            const changed = target.role !== patch.role || target.enabled !== patch.enabled;
            if (!changed) return { account: target, changed: false };
            const account = await tx.account.update({ where: { id: targetId }, data: { role: patch.role, enabled: patch.enabled, accessVersion: { increment: 1 } }, select: publicAccount });
            await tx.lmcLogin.deleteMany({ where: { accountId: targetId } });
            await tx.terminalAuthRequest.updateMany({ where: { responseAccountId: targetId, consumedAt: null }, data: { consumedAt: new Date(), response: null } });
            await tx.lmcAccessAudit.create({ data: { actorId, targetId, kind: 'account', action: 'account.update', before: { role: target.role, enabled: target.enabled }, after: { role: patch.role, enabled: patch.enabled } } });
            return { account, changed: true };
        });
        if (result.changed) authRevocations.emit('user', targetId);
        return result.account;
    },
    async invite(actorId: string) {
        const token = randomBytes(32).toString('base64url');
        const invitation = await accessTransaction(async tx => {
            requireAdmin(await loadActor(actorId, tx));
            if (await tx.lmcInvitation.count({ where: { consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }) >= 100) throw new AccessError(429, 'invite_limit', '待使用邀请过多，请先撤销旧邀请');
            const invitation = await tx.lmcInvitation.create({ data: { tokenHash: digest(token), createdById: actorId, expiresAt: new Date(Date.now() + 24 * 3600_000) }, select: invitationView });
            await tx.lmcAccessAudit.create({ data: { actorId, targetId: invitation.id, kind: 'invitation', action: 'invitation.create' } });
            return invitation;
        });
        return { ...invitation, token }; // returned once; never logged or stored verbatim
    },
    async invitations(actorId: string) {
        requireAdmin(await loadActor(actorId));
        return db.lmcInvitation.findMany({ select: invitationView, orderBy: { createdAt: 'desc' }, take: 100 });
    },
    async revokeInvitation(actorId: string, id: string) {
        return accessTransaction(async tx => {
            requireAdmin(await loadActor(actorId, tx));
            const changed = await tx.lmcInvitation.updateMany({ where: { id, revokedAt: null, consumedAt: null }, data: { revokedAt: new Date() } });
            if (!changed.count) throw new AccessError(409, 'invite_unavailable', '邀请已使用、撤销或不存在');
            await tx.lmcAccessAudit.create({ data: { actorId, targetId: id, kind: 'invitation', action: 'invitation.revoke' } });
        });
    },
    async accept(token: string, username: string, password: string) {
        const hash = digest(token);
        const valid = (v: { expiresAt: Date; consumedAt: Date | null; revokedAt: Date | null } | null) => v && v.expiresAt.getTime() > Date.now() && !v.consumedAt && !v.revokedAt;
        if (!valid(await db.lmcInvitation.findUnique({ where: { tokenHash: hash } }))) throw new AccessError(410, 'invite_expired', '邀请已过期、撤销或使用');
        const create = await prepareLmcAccount(username, password);
        try {
            return await accessTransaction(async tx => {
                const invitation = await tx.lmcInvitation.findUnique({ where: { tokenHash: hash } });
                if (!valid(invitation)) throw new AccessError(410, 'invite_expired', '邀请已过期、撤销或使用');
                // A demoted or suspended inviter cannot leave active invitations behind.
                requireAdmin(await loadActor(invitation!.createdById, tx));
                const id = await create(tx); // New users always join as members.
                await tx.lmcInvitation.update({ where: { id: invitation!.id }, data: { consumedAt: new Date() } });
                await tx.lmcAccessAudit.create({ data: { actorId: id, targetId: id, kind: 'account', action: 'invitation.accept', after: { invitationId: invitation!.id, role: 'member' } } });
                return { id };
            });
        } catch (error) {
            if ((error as { code?: string }).code === 'P2002') throw new AccessError(409, 'username_taken', '此用户名不可用');
            throw error;
        }
    },
};
