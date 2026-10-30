export type AccountRole = 'admin' | 'member';
export type Actor = { id: string; role: AccountRole; enabled: boolean };
export type ResourceKind = 'session' | 'machine' | 'project' | 'file' | 'provider' | 'tool' | 'memory';
export const resourceActions = {
    session: ['read', 'send', 'stop', 'approve', 'configure'],
    machine: ['read', 'execute'],
    project: ['read', 'write'],
    file: ['read'],
    provider: ['use', 'quota'],
    tool: ['use'],
    memory: ['read', 'write'],
} as const;
export type Grant = { accountId: string; actions: string[] };
export type Policy = { ownerAccountId: string; version: number; adminManaged: boolean; grants: Grant[] };

export class AccessError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function canManage(actor: Actor, policy: Policy): boolean {
    return actor.enabled && (actor.role === 'admin' || (actor.id === policy.ownerAccountId && !policy.adminManaged));
}
/** Admin is a management role, never an implicit content-reading grant. */
export function canAccess(actor: Actor, policy: Policy, action: string): boolean {
    return actor.enabled && (actor.id === policy.ownerAccountId || policy.grants.some(g => g.accountId === actor.id && g.actions.includes(action)));
}
export function validatePolicyChange(actor: Actor, current: Policy, input: { version: number; adminManaged: boolean; grants: Grant[] }, kind: ResourceKind): void {
    if (!canManage(actor, current)) throw new AccessError(403, 'sharing_forbidden', '没有权限修改此资源的共享');
    if (input.version !== current.version) throw new AccessError(409, 'sharing_conflict', '共享设置已变化，请刷新后重试');
    if (actor.role !== 'admin' && input.adminManaged !== current.adminManaged) throw new AccessError(403, 'admin_required', '只有管理员可以设置管理员管理');
    const members = new Set<string>();
    for (const grant of input.grants) {
        if (members.has(grant.accountId) || grant.accountId === current.ownerAccountId || grant.actions.length === 0 || new Set(grant.actions).size !== grant.actions.length || grant.actions.some(a => !(resourceActions[kind] as readonly string[]).includes(a))) {
            throw new AccessError(400, 'invalid_grants', '共享对象或操作范围无效');
        }
        members.add(grant.accountId);
    }
}
export function validateAccountChange(actor: Actor, target: Actor, patch: { role: AccountRole; enabled: boolean }, enabledAdmins: number): void {
    if (!actor.enabled || actor.role !== 'admin') throw new AccessError(403, 'admin_required', '需要管理员权限');
    if (target.role === 'admin' && target.enabled && (patch.role !== 'admin' || !patch.enabled) && enabledAdmins <= 1) {
        throw new AccessError(409, 'last_admin', '至少保留一名有效管理员');
    }
}
