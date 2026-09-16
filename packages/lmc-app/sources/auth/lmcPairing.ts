import { getServerUrl } from '@/sync/serverConfig';
import { t } from '@/text';

export function lmcPairingKey(input: string): string {
    const url = new URL(input);
    if (url.origin !== new URL(getServerUrl()).origin || url.pathname !== '/terminal/connect') {
        throw new Error(t('lmc.common.pairingWrongServer'));
    }
    const key = new URLSearchParams(url.hash.slice(1)).get('key');
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error(t('lmc.common.pairingInvalid'));
    return key;
}
