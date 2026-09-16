import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export function issueCookie(key, revision, now, lifetime) {
    const payload = Buffer.from(JSON.stringify({ revision, iat: now, exp: now + lifetime, nonce: randomBytes(16).toString('hex') })).toString('base64url');
    return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}
export function checkCookie(token, key, revision, now) {
    if (typeof token !== 'string' || token.length > 1024 || !/^[\w-]+\.[\w-]+$/.test(token)) return false;
    try {
        const [payload, signature] = token.split('.');
        const expected = createHmac('sha256', key).update(payload).digest();
        const actual = Buffer.from(signature, 'base64url');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return data.revision === revision && Number.isSafeInteger(data.exp) && Number.isSafeInteger(data.iat) && data.iat <= now && data.exp > now && data.exp - data.iat <= 30 * 86400;
    } catch { return false; }
}
export function safeReturnPath(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048) return '/';
    try {
        const decoded = decodeURIComponent(value);
        if (decoded.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decoded) || decoded.startsWith('/_lmc-auth') || decoded.startsWith('/_happy-auth')) return '/';
        return value;
    } catch { return '/'; }
}
