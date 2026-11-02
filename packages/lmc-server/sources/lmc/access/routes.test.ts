import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAccountRoutes } from './routes';

describe('registerAccountRoutes bodyless & malformed JSON handling', () => {
    it('accepts bodyless POST /v1/lmc/invitations and DELETE /v1/lmc/invitations/:id even with Content-Type: application/json', async () => {
        const invite = vi.fn().mockResolvedValue({
            id: 'inv-1',
            createdById: 'admin-1',
            expiresAt: new Date('2099-01-01T00:00:00Z'),
            consumedAt: null,
            revokedAt: null,
            token: 't'.repeat(43),
        });
        const revokeInvitation = vi.fn().mockResolvedValue(undefined);

        const app = Fastify();
        registerAccountRoutes(app, {
            enabled: () => true,
            origin: 'https://lmc.example',
            accounts: { invite, revokeInvitation } as any,
            verifyToken: async () => ({ userId: 'admin-1', kind: 'web' }),
        });
        await app.ready();

        try {
            const postEmptyJson = await app.inject({
                method: 'POST',
                url: '/v1/lmc/invitations',
                headers: {
                    authorization: 'Bearer valid',
                    origin: 'https://lmc.example',
                    'content-type': 'application/json',
                },
                payload: '',
            });
            expect(postEmptyJson.statusCode).toBe(200);
            expect(invite).toHaveBeenCalledWith('admin-1');

            const deleteEmptyJson = await app.inject({
                method: 'DELETE',
                url: '/v1/lmc/invitations/inv-1',
                headers: {
                    authorization: 'Bearer valid',
                    origin: 'https://lmc.example',
                    'content-type': 'application/json',
                },
                payload: '',
            });
            expect(deleteEmptyJson.statusCode).toBe(200);
            expect(revokeInvitation).toHaveBeenCalledWith('admin-1', 'inv-1');

            const badJson = await app.inject({
                method: 'PATCH',
                url: '/v1/lmc/accounts/u-2',
                headers: {
                    authorization: 'Bearer valid',
                    origin: 'https://lmc.example',
                    'content-type': 'application/json',
                },
                payload: '{broken',
            });
            expect(badJson.statusCode).toBe(400);
            expect(badJson.json()).toEqual({ error: '输入无效', code: 'invalid_input' });
        } finally {
            await app.close();
        }
    });
});
