import { describe, expect, it } from 'vitest';
import { editableProjectAvatarId } from './projectAvatarEligibility';

describe('editableProjectAvatarId', () => {
    it('returns the real project id for its Rig project group', () => {
        expect(editableProjectAvatarId({
            groupId: 'project-1',
            serverProjectId: 'project-1',
            clientId: 'rig',
            projectRecordAvailable: true,
            platform: 'web',
        })).toBe('project-1');
    });

    it.each([
        ['synthetic path group', { groupId: 'happy:["machine-1","/repo"]', serverProjectId: null }],
        ['mismatched server link', { serverProjectId: 'project-2' }],
        ['missing server link', { serverProjectId: null }],
        ['non-Rig client', { clientId: 'codex' }],
        ['missing group id', { groupId: '' }],
        ['missing decrypted Project record', { projectRecordAvailable: false }],
        ['native platform without ThumbHash support', { platform: 'ios' }],
        ['whitespace-altered id', { groupId: ' project-1 ' }],
    ])('keeps %s read-only', (_label, overrides) => {
        expect(editableProjectAvatarId({
            groupId: 'project-1',
            serverProjectId: 'project-1',
            clientId: 'rig',
            projectRecordAvailable: true,
            platform: 'web',
            ...overrides,
        })).toBeNull();
    });
});
