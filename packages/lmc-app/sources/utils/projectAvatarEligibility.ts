export function editableProjectAvatarId(input: {
    groupId: string;
    serverProjectId: string | null;
    clientId: string | null;
    projectRecordAvailable: boolean;
    platform: string;
}): string | null {
    if (input.platform !== 'web'
        || input.clientId !== 'rig'
        || !input.projectRecordAvailable
        || input.groupId.length === 0
        || input.serverProjectId === null) {
        return null;
    }
    return input.serverProjectId === input.groupId
        ? input.serverProjectId
        : null;
}
