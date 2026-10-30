import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { resourcesService } from './resources';
import { AccessError } from './policy';

const paramsSchema = z.object({ kind: z.enum(['session', 'machine', 'project', 'file', 'provider', 'tool', 'memory']), id: z.string().min(1).max(191) });
const policySchema = z.object({ version: z.number().int().nonnegative(), adminManaged: z.boolean(),
    grants: z.array(z.object({ accountId: z.string().min(1).max(191), actions: z.array(z.string().max(32)).min(1).max(10) }).strict()).max(100) }).strict();
export function registerResourceRoutes(app: FastifyInstance, deps: { enabled: () => boolean; origin: string; resources: typeof resourcesService; verifyToken: (token: string) => Promise<{ userId: string; kind: string } | null> }) {
    app.register(async scope => {
        scope.addHook('onRequest', async (req, reply) => {
            reply.header('Cache-Control', 'no-store');
            if (!deps.enabled()) return reply.code(404).send({ error: '多账号功能尚未启用' });
            if (req.headers.origin && req.headers.origin !== deps.origin) return reply.code(403).send({ error: '请求来源无效' });
        });
        scope.setErrorHandler((error, _req, reply) => {
            if (error instanceof AccessError) return reply.code(error.status).send({ error: error.message, code: error.code });
            if (error instanceof z.ZodError) return reply.code(400).send({ error: '输入无效' });
            return reply.code(500).send({ error: '共享操作失败，请稍后重试' });
        });
        const user = async (req: FastifyRequest) => {
            const header = req.headers.authorization;
            const verified = await deps.verifyToken(header?.startsWith('Bearer ') ? header.slice(7) : '');
            if (!verified || verified.kind !== 'web') throw new AccessError(401, 'web_required', '请使用 LMC 网页账号登录');
            return verified.userId;
        };
        scope.get('/v1/lmc/sharing/resources', async req => {
            const actor = await user(req);
            const query = z.object({ ownerId: z.string().min(1).max(191).optional() }).parse(req.query);
            return { resources: await deps.resources.list(actor, query.ownerId ?? actor) };
        });
        scope.get('/v1/lmc/sharing/:kind/:id', async req => {
            const actor = await user(req), params = paramsSchema.parse(req.params);
            return deps.resources.get(actor, params.kind, params.id);
        });
        scope.put('/v1/lmc/sharing/:kind/:id', { bodyLimit: 32 * 1024 }, async req => {
            const actor = await user(req), params = paramsSchema.parse(req.params);
            return deps.resources.set(actor, params.kind, params.id, policySchema.parse(req.body));
        });
        scope.get('/v1/lmc/sharing/:kind/:id/audit', async req => {
            const actor = await user(req), params = paramsSchema.parse(req.params);
            return { events: await deps.resources.audit(actor, params.kind, params.id) };
        });
    });
}
