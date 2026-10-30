import type { Server } from 'socket.io';
import type { Prisma } from '@/generated/client';
import { multiAccountEnabled } from './features';
import { AccessError } from './policy';

let io: Server | undefined;
export function initSharedExecution(server: Server) { io = server; }
export async function sharedMachineTarget(ownerId: string, machineId: string) {
    const sockets = io ? await io.in(`rpc:${ownerId}:${machineId}:shared-runtime`).timeout(3000).fetchSockets() : [];
    const targets = sockets.filter(socket => socket.data.userId === ownerId && socket.data.machineId === machineId && socket.data.clientType === 'machine-scoped' && socket.data.authKind === 'device' && socket.data.collaborationProtocol === 1);
    if (targets.length !== 1) throw new AccessError(409, 'agent_upgrade_required', '设备未连接或需升级 Agent 才能多人共用');
    return targets[0];
}
export async function sharedActionTarget(ownerId: string, sessionId: string, method: string) {
    if (!io) throw new AccessError(409, 'agent_unavailable', 'Agent 尚未连接');
    const sockets = await io.in(`rpc:${ownerId}:${sessionId}:${method}`).timeout(3000).fetchSockets();
    const targets = sockets.filter(socket => socket.data.userId === ownerId && socket.data.sessionId === sessionId && socket.data.clientType === 'session-scoped' && socket.data.collaborationProtocol === 1 && socket.data.authKind !== 'web');
    if (targets.length !== 1) throw new AccessError(409, 'agent_unavailable', 'Agent 未连接、版本不支持或存在重复运行，请先处理');
    return targets[0];
}
export async function requireCollaborationAgent(ownerId: string, sessionId: string) {
    const sockets = io ? await io.in(`user:${ownerId}:session:${sessionId}`).timeout(3000).fetchSockets() : [];
    if (!sockets.some(socket => socket.data.userId === ownerId && socket.data.clientType === 'session-scoped' && socket.data.collaborationProtocol === 1 && socket.data.authKind !== 'web')) {
        throw new AccessError(409, 'agent_upgrade_required', '请先连接支持多人协作的新版 Agent');
    }
}
export async function requireSessionAction(tx: Prisma.TransactionClient, actorId: string, sessionId: string, action: string) {
    if (!multiAccountEnabled()) throw new AccessError(404, 'not_enabled', '多账号功能尚未启用');
    const [actor, session, policy] = await Promise.all([
        tx.account.findUnique({ where: { id: actorId }, select: { enabled: true, username: true } }),
        tx.session.findUnique({ where: { id: sessionId } }),
        tx.lmcResourcePolicy.findUnique({ where: { kind_resourceId: { kind: 'session', resourceId: sessionId } }, include: { grants: { where: { accountId: actorId } } } }),
    ]);
    if (!actor?.enabled || !session) throw new AccessError(404, 'not_found', '会话不存在或无权限');
    const grant = policy?.grants[0];
    if (session.accountId !== actorId && (!policy || policy.ownerAccountId !== session.accountId || !grant?.keyEnvelope || !Array.isArray(grant.actions) || !grant.actions.includes('read') || !grant.actions.includes(action))) {
        throw new AccessError(403, 'action_forbidden', '此操作未获授权或授权已撤销');
    }
    return { session, version: policy?.version ?? 0, actorName: actor.username ?? actorId };
}
