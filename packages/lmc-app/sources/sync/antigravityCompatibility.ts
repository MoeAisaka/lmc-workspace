import { compareVersionsWithPrerelease, isWellFormedVersion } from '@/utils/versionUtils';

export const ANTIGRAVITY_AGENT_VERSION = '1.2.118';
export const ANTIGRAVITY_UPGRADE_MESSAGE = `Update the LMC Agent on this machine to ${ANTIGRAVITY_AGENT_VERSION} or newer before using Antigravity. No message was sent.`;

export function supportsAntigravityProtocol(version: string | null | undefined): boolean {
    return !!version && isWellFormedVersion(version) && compareVersionsWithPrerelease(version, ANTIGRAVITY_AGENT_VERSION) >= 0;
}

export function assertAntigravityProtocol(flavor: string | null | undefined, version: string | null | undefined): void {
    if (flavor === 'agy' && !supportsAntigravityProtocol(version)) throw new Error(ANTIGRAVITY_UPGRADE_MESSAGE);
}
