import { describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/persistence', () => ({ loadSettings: () => ({ settings: {} }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://lmc.example' }));
import { accountLinkPublicKey, accountPairingUrl, isAccountLinkUrl } from './accountLinkUrl';

const KEY = 'a'.repeat(43);

describe('account pairing link', () => {
    it('reads the browser link on this centre, which needs no scheme registration', () => {
        expect(accountLinkPublicKey(`https://lmc.example/account/connect#key=${KEY}`)).toBe(KEY);
        expect(isAccountLinkUrl(`https://lmc.example/account/connect#key=${KEY}`)).toBe(true);
    });

    it('refuses the same link from another origin', () => {
        expect(accountLinkPublicKey(`https://other.example/account/connect#key=${KEY}`)).toBeNull();
    });

    it('still reads both custom schemes, so an un-upgraded CLI can pair', () => {
        expect(accountLinkPublicKey(`lmc:///account?${KEY}`)).toBe(KEY);
        expect(accountLinkPublicKey(`happy:///account?${KEY}`)).toBe(KEY);
    });

    it('rejects a key that is not a 32-byte base64url public key', () => {
        for (const bad of ['', 'short', KEY + 'x', 'a'.repeat(42), `${KEY.slice(0, 42)}+`]) {
            expect(accountLinkPublicKey(`lmc:///account?${bad}`)).toBeNull();
            expect(accountLinkPublicKey(`https://lmc.example/account/connect#key=${bad}`)).toBeNull();
        }
    });

    it('rejects other paths and things that are not URLs at all', () => {
        for (const bad of ['https://lmc.example/terminal/connect#key=' + KEY, 'https://lmc.example/#key=' + KEY, 'not a url', 'lmc://account?' + KEY]) {
            expect(isAccountLinkUrl(bad)).toBe(false);
        }
    });

    it('builds the link it reads', () => {
        const built = accountPairingUrl('https://lmc.example', KEY);
        expect(built).toBe(`https://lmc.example/account/connect#key=${KEY}`);
        expect(accountLinkPublicKey(built)).toBe(KEY);
        expect(accountPairingUrl('https://lmc.example/', KEY)).toBe(built);
    });
});
