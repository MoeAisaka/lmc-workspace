import type { FastifyInstance } from 'fastify';

// Additive LMC route: existing login, account secrets and device pairing are unchanged.
// This file is also the source used by the isolated hub contract tests.
export function registerLmcIdentityRoute(app: FastifyInstance, deps: {
  publicOrigin: string;
  verifyToken: (token: string) => Promise<{userId: string; kind: string} | null>;
  findAccount: (id: string) => Promise<{id: string; username: string | null} | null>;
}) {
  const origin = new URL(deps.publicOrigin).origin;
  app.get('/v1/lmc/identity', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (req.headers.origin && req.headers.origin !== origin) return reply.code(403).send({error: '请求来源无效'});
    const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith('lmc_session='));
    const token = cookies.length === 1 ? cookies[0].slice(12) : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return reply.code(401).send({error: '请登录'});
    const verified = await deps.verifyToken(token);
    if (!verified || verified.kind !== 'web') return reply.code(401).send({error: '请登录'});
    const account = await deps.findAccount(verified.userId);
    if (!account || account.id !== verified.userId) return reply.code(401).send({error: '请登录'});
    return {version: 1, subject: account.id, name: account.username ?? account.id};
  });
}
