import { getServerUrl } from '@/sync/serverConfig';
import type { AuthCredentials } from './tokenStorage';
import { t } from '@/text';

export async function lmcLogin(username: string, password: string): Promise<AuthCredentials> {
    const result = await fetch(`${getServerUrl()}/v1/lmc/login`, { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password}) });
    const body = await result.json();
    if (!result.ok) throw new Error(body.error || t('lmc.login.retryLater'));
    return body;
}
export async function lmcRestore(): Promise<AuthCredentials | null> {
    const result = await fetch(`${getServerUrl()}/v1/lmc/session`, { credentials:'same-origin', cache:'no-store' });
    if (result.status === 401) return null;
    if (!result.ok) throw new Error(t('lmc.login.unreachable'));
    return result.json();
}
export async function lmcLogout(): Promise<void> {
    const result=await fetch(`${getServerUrl()}/v1/lmc/logout`,{method:'POST',credentials:'same-origin'});
    if(!result.ok)throw new Error(t('lmc.login.signOutFailed'));
}

/** Account identity comes from our authenticated center, never from token internals. */
export async function lmcIdentity(token: string): Promise<string> {
    const result=await fetch(`${getServerUrl()}/v1/account/profile`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    if(!result.ok)throw new Error(t('lmc.login.expired'));
    const profile=await result.json();
    if(typeof profile.id!=='string'||!profile.id)throw new Error(t('lmc.login.invalidAccount'));
    return profile.id;
}
