import type { Metadata } from './storageTypes';

export function sessionCapabilities(metadata?: Metadata | null) {
    if (metadata?.sessionCapabilities) return metadata.sessionCapabilities;
    // Only old Codex Agents implemented this RPC. Absence is never support for Claude.
    const legacyCodex = metadata?.flavor === 'codex' && metadata.sessionConfiguration === true;
    return { refresh: legacyCodex, runtimeConfiguration: legacyCodex, authentication: false, cancelRefresh: false };
}
