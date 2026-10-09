import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type Login = {kind: string; expiresAt: Date; account: {id: string; username: string | null}};

// Only the Hub process sharing the center's network namespace can call these.
// Never trust Fastify req.ip or forwarded headers for the loopback boundary.
export function registerInternalIdentityRoutes(app: FastifyInstance, deps: {
  publicOrigin: string;
  findLogin: (hash: string) => Promise<Login | null>;
}) {
  const origin = new URL(deps.publicOrigin).origin;
  const local = (req: FastifyRequest) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.raw.socket.remoteAddress ?? '');
  const identity = async (reference: string) => {
    if (!/^[a-f0-9]{64}$/.test(reference)) return null;
    const login = await deps.findLogin(reference);
    if (!login || login.kind !== 'web' || login.expiresAt.getTime() <= Date.now()) return null;
    return {version: 1, subject: login.account.id, name: login.account.username ?? login.account.id,
      reference, expiresAt: login.expiresAt.toISOString()};
  };
  const options = {onRequest: async (req: FastifyRequest, reply: any) => {
    reply.header('Cache-Control', 'no-store');
    if (!local(req) || req.headers.origin !== origin) return reply.code(403).send({error: '请求来源无效'});
  }};
  app.get('/v1/lmc/internal/identity-session', options, async (req, reply) => {
    const cookies = (req.headers.cookie ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith('lmc_session='));
    const token = cookies.length === 1 ? cookies[0].slice(12) : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return reply.code(401).send({error: '请登录'});
    const result = await identity(createHash('sha256').update(token).digest('hex'));
    return result ?? reply.code(401).send({error: '请登录'});
  });
  app.post('/v1/lmc/internal/check-session', {...options, bodyLimit: 1024}, async (req, reply) => {
    const body = req.body as {reference?: unknown} | null;
    if (!body || Object.keys(body).join() !== 'reference' || typeof body.reference !== 'string') return reply.code(400).send({error: '参数不合法'});
    const result = await identity(body.reference);
    return result ?? reply.code(401).send({error: '请登录'});
  });
}
