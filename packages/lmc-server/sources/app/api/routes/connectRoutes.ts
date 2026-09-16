import { z } from "zod";
import { type Fastify } from "../types";
import { decryptString, encryptString } from "@/modules/encrypt";
import { db } from "@/storage/db";

export function connectRoutes(app: Fastify) {
    app.post('/v1/connect/:vendor/register', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                token: z.string()
            }),
            params: z.object({
                vendor: z.enum(['openai', 'anthropic', 'gemini'])
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const encrypted = encryptString(['user', userId, 'vendors', request.params.vendor, 'token'], request.body.token);
        await db.serviceAccountToken.upsert({
            where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } },
            update: { updatedAt: new Date(), token: encrypted },
            create: { accountId: userId, vendor: request.params.vendor, token: encrypted }
        });
        reply.send({ success: true });
    });

    app.get('/v1/connect/:vendor/token', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                vendor: z.enum(['openai', 'anthropic', 'gemini'])
            }),
            response: {
                200: z.object({
                    token: z.string().nullable()
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const token = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } },
            select: { token: true }
        });
        if (!token) {
            return reply.send({ token: null });
        } else {
            return reply.send({ token: decryptString(['user', userId, 'vendors', request.params.vendor, 'token'], token.token) });
        }
    });

    app.delete('/v1/connect/:vendor', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                vendor: z.enum(['openai', 'anthropic', 'gemini'])
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        await db.serviceAccountToken.delete({ where: { accountId_vendor: { accountId: userId, vendor: request.params.vendor } } });
        reply.send({ success: true });
    });

    app.get('/v1/connect/tokens', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    tokens: z.array(z.object({
                        vendor: z.string(),
                        token: z.string()
                    }))
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const tokens = await db.serviceAccountToken.findMany({ where: { accountId: userId } });
        let decrypted = [];
        for (const token of tokens) {
            decrypted.push({ vendor: token.vendor, token: decryptString(['user', userId, 'vendors', token.vendor, 'token'], token.token) });
        }
        return reply.send({ tokens: decrypted });
    });

}
