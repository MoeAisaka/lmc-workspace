import { getServerUrl } from '@/sync/serverConfig';

/**
 * The pairing link a CLI or Codium shows, and the app reads to approve a new
 * device. Three shapes are accepted, for one reason each.
 *
 * `https://<this centre>/account/connect#key=…` is the one to emit. It needs no
 * OS scheme registration, so it works in the browser the moment the web app is
 * published — which is what makes it usable at all: `happy://` and `lmc://` only
 * reach the app through a scheme the *native* build registers, and a native
 * build is gated on store identity that still belongs upstream. The terminal
 * pairing flow already works this way (see auth/lmcPairing.ts); this brings
 * account pairing alongside it.
 *
 * `lmc:///account?…` and `happy:///account?…` stay readable so a device still
 * pairs against a CLI or Codium that has not been upgraded. The old name goes
 * last, and only once nothing produces it.
 *
 * The key is a 32-byte public key in unpadded base64url — 43 characters, the
 * same shape and check the terminal flow uses.
 */
const SCHEMES = ['lmc', 'happy'] as const;
const SCHEME_SUFFIX = ':///account?';
const KEY = /^[A-Za-z0-9_-]{43}$/;

/** The path the browser pairing link points at, on this centre's own origin. */
export const ACCOUNT_PAIRING_PATH = '/account/connect';

/** Build the link to show in a QR code. */
export function accountPairingUrl(origin: string, publicKey: string): string {
    return `${origin.replace(/\/$/, '')}${ACCOUNT_PAIRING_PATH}#key=${publicKey}`;
}

/**
 * The public key this link carries, or null when it is not a pairing link this
 * centre should act on. A browser link from another origin is refused: the key
 * is what the device is about to be trusted with.
 */
export function accountLinkPublicKey(url: string): string | null {
    for (const scheme of SCHEMES) {
        const prefix = scheme + SCHEME_SUFFIX;
        if (!url.startsWith(prefix)) continue;
        const key = url.slice(prefix.length);
        return KEY.test(key) ? key : null;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.pathname !== ACCOUNT_PAIRING_PATH) return null;
    try {
        if (parsed.origin !== new URL(getServerUrl()).origin) return null;
    } catch {
        return null;
    }
    const key = new URLSearchParams(parsed.hash.slice(1)).get('key');
    return key && KEY.test(key) ? key : null;
}

/** Does this look like a pairing link, under any of the three shapes? */
export function isAccountLinkUrl(url: string): boolean {
    return accountLinkPublicKey(url) !== null;
}
