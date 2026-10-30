import { describe, it, expect } from 'vitest';
import { canAccess, canManage, validatePolicyChange, validateAccountChange, type Actor, type Policy } from './policy';
const owner: Actor = { id: 'a', role: 'member', enabled: true }, member: Actor = { id: 'b', role: 'member', enabled: true }, admin: Actor = { id: 'm', role: 'admin', enabled: true };
const policy: Policy = { ownerAccountId: 'a', version: 4, adminManaged: false, grants: [{ accountId: 'b', actions: ['read'] }] };
describe('unified resource permissions', () => {
    it('distinguishes management from content access', () => {
        expect(canAccess(admin, policy, 'read')).toBe(false);
        expect(canManage(admin, policy)).toBe(true);
        expect(canAccess(member, policy, 'read')).toBe(true);
        expect(canManage(member, policy)).toBe(false);
        expect(canAccess(member, policy, 'write')).toBe(false);
        expect(canAccess({ ...owner, enabled: false }, policy, 'read')).toBe(false);
    });
    it('enforces administrator-managed ACLs and optimistic revisions', () => {
        expect(() => validatePolicyChange(owner, { ...policy, adminManaged: true }, { ...policy, grants: [] }, 'file')).toThrow();
        expect(() => validatePolicyChange(owner, policy, { ...policy, adminManaged: true }, 'file')).toThrow();
        expect(() => validatePolicyChange(admin, policy, { ...policy, version: 3 }, 'file')).toThrow();
        expect(() => validatePolicyChange(owner, policy, { ...policy, grants: [{ accountId: 'b', actions: ['read', 'write'] }] }, 'file')).toThrow();
        expect(() => validatePolicyChange(owner, policy, { ...policy, grants: [] }, 'file')).not.toThrow();
    });
    it('preserves an active administrator', () => {
        expect(() => validateAccountChange(admin, admin, { role: 'member', enabled: true }, 1)).toThrow();
        expect(() => validateAccountChange(admin, admin, { role: 'admin', enabled: false }, 1)).toThrow();
        expect(() => validateAccountChange(admin, member, { role: 'admin', enabled: true }, 1)).not.toThrow();
    });
});
