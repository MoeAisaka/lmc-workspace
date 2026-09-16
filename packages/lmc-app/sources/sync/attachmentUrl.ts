/** Local attachment routes belong to the connected center, even after an origin alias changes. */
export function resolveAttachmentUrl(raw: string, serverUrl: string, sessionId: string): string {
    const url = new URL(raw, serverUrl);
    const prefix = `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/`;
    if (url.pathname.startsWith(prefix) && /^[A-Za-z0-9_-]+\.enc$/.test(url.pathname.slice(prefix.length))) {
        const current = new URL(serverUrl);
        url.protocol = current.protocol;
        url.host = current.host;
    }
    return url.href;
}
export function isSameServerUrl(raw: string, serverUrl: string): boolean {
    return new URL(raw).origin === new URL(serverUrl).origin;
}
