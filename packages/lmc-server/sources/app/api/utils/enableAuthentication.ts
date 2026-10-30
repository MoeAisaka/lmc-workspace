import { Fastify } from "../types";
import { debug } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { parseRuntimeScope, allowsRuntimeHttp } from '@/lmc/access/runtimeScope';

export function enableAuthentication(app: Fastify) {
    // Covers routes with custom authentication as well as app.authenticate.
    app.addHook('preHandler', async (request: any, reply: any) => {
        const header = request.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return;
        const verified = await auth.verifyToken(header.slice(7));
        request.verifiedAuth = verified;
        if (verified?.kind !== 'session') return;
        const scope = parseRuntimeScope(verified.extras);
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (!scope || !(await allowsRuntimeHttp(scope, request.method, pathname, request.body))) return reply.code(403).send({ error: 'Session credential cannot access this resource' });
        request.runtimeScope = scope;
    });
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            const route = request.routeOptions?.url || '<unmatched>';
            debug({ module: 'auth' }, `auth:check route=${route} hasHeader=${!!authHeader}`);
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                debug({ module: 'auth' }, 'auth:failed reason=missing-or-invalid-header');
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = request.verifiedAuth ?? await auth.verifyToken(token);
            if (!verified) {
                debug({ module: 'auth' }, 'auth:failed reason=invalid-token');
                return reply.code(401).send({ error: 'Invalid token' });
            }

            debug({ module: 'auth' }, `auth:success userId=${verified.userId}`);
            request.userId = verified.userId;
            request.authKind = verified.kind;
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
