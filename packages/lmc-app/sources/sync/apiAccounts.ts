import { sync } from './sync';
import { getServerUrl } from './serverConfig';
import { t } from '@/text';
import { translateLmcServerMessage } from '@/utils/lmc/serverErrorText';

export type LmcAccount = { id: string; username: string | null; role: 'admin' | 'member'; enabled: boolean; accessVersion: number };
export type AccountCapabilities = { account: LmcAccount; capabilities: { version: number; fileSharing: boolean; sessionSharing: boolean; sharedExecution: boolean; deviceSharing?: boolean; modelIdentity?: 'device' } };
export type AccountInvitation = { id: string; createdById: string; expiresAt: string; consumedAt: string | null; revokedAt: string | null; token?: string };
export type SharingPolicy = { kind: string; resourceId: string; ownerAccountId: string; version: number; adminManaged: boolean; grants: Array<{ accountId: string; actions: string[] }>; canManage: boolean; sharingSupported: boolean; unavailableReason: string | null };
export async function accountRequest<T>(path: string, options?: RequestInit): Promise<T> {
    const credentials = sync.getCredentials();
    if (!credentials) throw new Error(t('lmc.sharing.signInRequired'));
    const response = await fetch(getServerUrl() + path, { ...options, cache: 'no-store', headers: { Authorization: 'Bearer ' + credentials.token, 'Content-Type': 'application/json' }, signal: options?.signal ?? AbortSignal.timeout(15_000) });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(translateLmcServerMessage(body.error, body.code) || t('lmc.sharing.actionFailed')), { status: response.status, code: body.code });
    return body as T;
}
export const accountMe = () => accountRequest<AccountCapabilities>('/v1/lmc/accounts/me');
export const accountList = () => accountRequest<{ accounts: LmcAccount[] }>('/v1/lmc/accounts');
export const accountDirectory = () => accountRequest<{ accounts: Array<Pick<LmcAccount, 'id' | 'username'>> }>('/v1/lmc/accounts/directory');
export const accountUpdate = (account: LmcAccount, patch: Pick<LmcAccount, 'role' | 'enabled'>) => accountRequest('/v1/lmc/accounts/' + encodeURIComponent(account.id), { method: 'PATCH', body: JSON.stringify({ ...patch, version: account.accessVersion }) });
export const getSharing = (kind: string, id: string) => accountRequest<SharingPolicy>('/v1/lmc/sharing/' + kind + '/' + encodeURIComponent(id));
export const putSharing = (policy: SharingPolicy) => accountRequest('/v1/lmc/sharing/' + policy.kind + '/' + encodeURIComponent(policy.resourceId), { method: 'PUT', body: JSON.stringify({ version: policy.version, adminManaged: policy.adminManaged, grants: policy.grants }) });
