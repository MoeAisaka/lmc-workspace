import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { accountsService } from './accounts';
import { AccessError } from './policy';

type Dependencies = { enabled: () => boolean; origin: string; accounts: typeof accountsService;
    verifyToken: (token: string) => Promise<{ userId: string; kind: string } | null> };
const idParams = z.object({ id: z.string().min(1).max(191) }).strict();
const role = z.enum(['admin', 'member']);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AccessError(400, 'invalid_input', '输入无效');
    return parsed.data;
}
/** Injectable routes: contract tests never import a production database. */
export function registerAccountRoutes(app: FastifyInstance, deps: Dependencies) {
    const attempts = new Map<string, { count: number; expires: number }>();
    app.register(async scope => {
        scope.addHook('onRequest', async (req, reply) => {
            reply.header('Cache-Control', 'no-store');
            if (!deps.enabled()) return reply.code(404).send({ error: '多账号功能尚未启用', code: 'not_enabled' });
            if (req.headers.origin && req.headers.origin !== deps.origin) return reply.code(403).send({ error: '请求来源无效' });
        });
        scope.setErrorHandler((error, _req, reply) => {
            if (error instanceof AccessError) return reply.code(error.status).send({ error: error.message, code: error.code });
            return reply.code(500).send({ error: '账号操作失败，请稍后重试', code: 'account_error' });
        });
        const user = async (req: FastifyRequest) => {
            const header = req.headers.authorization;
            const verified = await deps.verifyToken(header?.startsWith('Bearer ') ? header.slice(7) : '');
            if (!verified || verified.kind !== 'web') throw new AccessError(401, 'web_required', '请使用 LMC 网页账号登录');
            return verified.userId;
        };
        scope.get('/v1/lmc/accounts/me', async req => ({ account: await deps.accounts.me(await user(req)), capabilities: { version: 3, fileSharing: true, sessionSharing: true, sharedExecution: true, deviceSharing: true, modelIdentity: 'device' } }));
        scope.get('/v1/lmc/accounts', async req => ({ accounts: await deps.accounts.list(await user(req)) }));
        scope.get('/v1/lmc/accounts/directory', async req => ({ accounts: await deps.accounts.directory(await user(req)) }));
        scope.patch('/v1/lmc/accounts/:id', { bodyLimit: 2048 }, async req => {
            const actorId = await user(req);
            const { id } = parse(idParams, req.params);
            const patch = parse(z.object({ role, enabled: z.boolean(), version: z.number().int().nonnegative() }).strict(), req.body);
            return { account: await deps.accounts.update(actorId, id, patch) };
        });
        scope.get('/v1/lmc/invitations', async req => ({ invitations: await deps.accounts.invitations(await user(req)) }));
        scope.post('/v1/lmc/invitations', async req => deps.accounts.invite(await user(req)));
        scope.delete('/v1/lmc/invitations/:id', async req => {
            const actorId = await user(req);
            await deps.accounts.revokeInvitation(actorId, parse(idParams, req.params).id);
            return { success: true };
        });
        scope.post('/v1/lmc/invitations/accept', { bodyLimit: 4096 }, async (req, reply) => {
            if (req.headers.origin !== deps.origin) return reply.code(403).send({ error: '请求来源无效' });
            const now = Date.now();
            for (const [ip, value] of attempts) if (value.expires <= now) attempts.delete(ip);
            const attempt = attempts.get(req.ip) ?? { count: 0, expires: now + 15 * 60_000 };
            if (attempt.count >= 10 || attempts.size >= 10000) throw new AccessError(429, 'rate_limit', '尝试次数过多，请稍后重试');
            attempt.count++; attempts.set(req.ip, attempt);
            const body = parse(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), username: z.string().regex(/^[\p{L}\p{N}_-]{3,64}$/u), password: z.string().min(12).max(256) }).strict(), req.body);
            return deps.accounts.accept(body.token, body.username, body.password);
        });
    });
}
