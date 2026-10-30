/** Keep browser pages on the explicitly configured same-host origin. API and
 * websocket clients remain untouched; no CORS/CSRF allowlist is expanded. */
export function canonicalPageRedirect(host: string | undefined, requestPath: string, publicOrigin: string | undefined): string | null {
    if (!host || !publicOrigin) return null;
    try {
        const target = new URL(publicOrigin), incoming = new URL(`https://${host}`);
        if (target.protocol !== 'https:' || incoming.hostname !== target.hostname || incoming.host === target.host) return null;
        const page = new URL(requestPath, target.origin);
        return target.origin + page.pathname + page.search;
    } catch { return null; }
}
