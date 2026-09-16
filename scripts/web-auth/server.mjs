import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { issueCookie, checkCookie, safeReturnPath } from './auth.mjs';
const COOKIE = '__Host-lmc_gate';
// Renaming the cookie outright would sign everyone out. Read the previous name
// too; nothing writes it any more, so it drains as sessions expire.
const LEGACY_COOKIE = '__Host-happy_gate';
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// `allowUser` is an optional extra gate on top of `verify`, which is the real
// check. Leave it unset and any account `verify` accepts may sign in; set it to
// pin the gate to a single operator account.
export function createAuthServer({ origin, key, revision, verify, allowUser, now = () => Math.floor(Date.now() / 1000) }) {
    const failures = new Map();
    return createServer(async (req, res) => {
        const send = (status, body = '', headers = {}) => { res.writeHead(status, { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });res.end(body); };
        const redirect = (path, headers = {}) => send(303, '', { Location: path, ...headers });
        try {
            const url = new URL(req.url, origin);
            const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(p=>p.trim().split('=')));
            const valid = checkCookie(cookies[COOKIE] ?? cookies[LEGACY_COOKIE], key, revision(), now());
            const destination = safeReturnPath(url.searchParams.get('next'));
            if (url.pathname === '/check') {
                if (valid) return send(204);
                const next = safeReturnPath(req.headers['x-forwarded-uri']);
                return send(302, '', { Location: '/_lmc-auth/login?next=' + encodeURIComponent(next) });
            }
            if (req.method === 'GET' && url.pathname === '/_lmc-auth/login') {
                const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="same-origin"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Happy · Sign in</title><style>body{margin:0;background:#f3f4f6;color:#172033;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{box-sizing:border-box;background:white;border-radius:20px;padding:28px;width:min(92vw,400px);box-shadow:0 12px 40px #0001}h1{margin:0 0 8px}p{line-height:1.6;color:#667085}label{display:block;margin-top:18px}input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:12px;border:1px solid #b8c0cc;border-radius:8px;font:inherit;margin-top:7px}button{width:100%;padding:13px;margin-top:24px;border:0;border-radius:8px;background:#007aff;color:white;font:inherit}</style><main><h1>LMC</h1><p>${valid ? 'This device is signed in.' : 'Sign in to reach the web entry point.'}</p>${valid ? `<a href="${esc(destination)}">Continue Happy</a><form action="/_lmc-auth/logout" method="post"><button>Sign outSign in</button></form>` : `<form action="/_lmc-auth/login" method="post"><input type="hidden" name="next" value="${esc(destination)}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><label><input type="checkbox" name="remember" value="1" checked> Remember this device 30 天</label><button>Sign in</button></form>`}</main></html>`;
                return send(200, html, { 'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
            }
            if (req.method !== 'POST' || !['/_lmc-auth/login','/_lmc-auth/logout'].includes(url.pathname)) return send(404);
            if (req.headers.origin !== origin) return send(403, 'Invalid request origin');
            if (url.pathname.endsWith('/logout')) {
                // Clear the previous cookie as well: leaving it set would keep a
                // signed-out browser authenticated through the compatibility read above.
                return redirect('/_lmc-auth/login', { 'Set-Cookie': [`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`, `${LEGACY_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`] });
            }
            if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return send(415);
            let body = '';for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) return send(413); }
            const form = new URLSearchParams(body);
            const ip = String(req.headers['x-happy-client-ip'] ?? req.socket.remoteAddress);
            for (const [ip, entry] of failures) if (entry.until <= now()) failures.delete(ip);
            const entry = failures.get(ip) ?? { count: 0, until: now() + 60 };
            if (entry.count >= 5 || failures.size >= 2048) return send(429, 'Too many attempts. Try again in a minute.', { 'Retry-After':'60', 'Content-Type':'text/plain; charset=utf-8' });
            entry.count++;failures.set(ip, entry);
            const user = form.get('username'); const password = form.get('password');
            const ok = (!allowUser || user === allowUser) && password && await verify(user, password);
            if (!ok) return send(401, 'Wrong username or password. Go back and try again.', { 'Content-Type':'text/plain; charset=utf-8' });
            failures.delete(ip);
            const remembered = form.get('remember') === '1';
            const lifetime = remembered ? 30 * 86400 : 12 * 3600;
            const token = issueCookie(key, revision(), now(), lifetime);
            return redirect(safeReturnPath(form.get('next')), { 'Set-Cookie': `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax${remembered ? '; Max-Age=' + lifetime : ''}` });
        } catch { send(503, 'The sign-in service is unavailable. Try again shortly.', { 'Content-Type':'text/plain; charset=utf-8' }); }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const key = readFileSync(config.keyFile);
    if (key.length !== 32) throw new Error('Invalid signing key');
    // The operator account's name drives two things: which username the gate
    // accepts, and whose credential line in the Caddy fragment is hashed into
    // the cookie revision, so changing the password invalidates old cookies.
    const username = config.username;
    if (!username || !/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error('config.username must be set');
    const revision = () => {
        const match = readFileSync(config.caddyFragment,'utf8').match(new RegExp('\\b' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\S+)'));
        if (!match) throw new Error('Missing verifier');
        return createHash('sha256').update(match[1]).digest('hex');
    };
    const upstream = new URL(config.origin);
    const verify = (user, password) => new Promise((resolve) => {
        const req = httpsRequest({ hostname:'127.0.0.1', port:upstream.port || 443, servername:upstream.hostname, path:'/_lmc-auth/verify', method:'GET', headers:{Host:upstream.host,Authorization:'Basic '+Buffer.from(user+':'+password).toString('base64')}, timeout:5000 }, res=>{res.resume();resolve(res.statusCode===204);});
        req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));req.end();
    });
    const server = createAuthServer({ origin:config.origin,key,revision,verify,allowUser:username });
    server.listen(config.port,'127.0.0.1');
}
