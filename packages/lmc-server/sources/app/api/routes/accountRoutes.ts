import { eventRouter, buildUpdateAccountUpdate } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { getPublicUrl, isLocalStorage, putLocalFile } from "@/storage/files";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { AccountProfile } from "@/types";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export function accountRoutes(app: Fastify) {
    app.get('/v1/account/profile', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const user = await db.account.findUniqueOrThrow({
            where: { id: userId },
            select: {
                firstName: true,
                lastName: true,
                username: true,
                avatar: true,
                githubUser: true
            }
        });
        const connectedVendors = new Set((await db.serviceAccountToken.findMany({ where: { accountId: userId } })).map(t => t.vendor));
        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: user.avatar ? { ...user.avatar, url: getPublicUrl(user.avatar.path) } : null,
            github: user.githubUser ? user.githubUser.profile : null,
            connectedServices: Array.from(connectedVendors)
        });
    });

    /**
     * Update the display name and avatar of the signed-in account.
     *
     * The avatar arrives as a data URI already cropped and resized by the
     * client, so the server only validates the media type and size before
     * writing it to public storage. Every field is optional: omitted means
     * "leave as is", explicit null clears it.
     */
    app.post('/v1/account/profile', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                firstName: z.string().trim().max(64).nullable().optional(),
                lastName: z.string().trim().max(64).nullable().optional(),
                avatar: z.object({
                    dataUri: z.string().min(1),
                    width: z.number().int().positive(),
                    height: z.number().int().positive(),
                    thumbhash: z.string().min(1),
                }).nullable().optional(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const body = request.body as {
            firstName?: string | null;
            lastName?: string | null;
            avatar?: { dataUri: string; width: number; height: number; thumbhash: string } | null;
        };

        const data: Record<string, unknown> = {};
        if ('firstName' in body) data.firstName = body.firstName?.trim() || null;
        if ('lastName' in body) data.lastName = body.lastName?.trim() || null;

        if (body.avatar === null) {
            data.avatar = null;
        } else if (body.avatar) {
            const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.avatar.dataUri);
            if (!match) return reply.code(400).send({ error: 'Unsupported avatar image' });
            const bytes = Buffer.from(match[2], 'base64');
            if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
                return reply.code(413).send({ error: 'Avatar image too large (max 2MB)' });
            }
            if (!isLocalStorage()) {
                return reply.code(501).send({ error: 'Avatar upload requires local file storage' });
            }
            const extension = match[1] === 'image/png' ? 'png' : match[1] === 'image/webp' ? 'webp' : 'jpg';
            const path = `avatars/${userId}/${randomKeyNaked(16)}.${extension}`;
            await putLocalFile(path, bytes);
            data.avatar = { width: body.avatar.width, height: body.avatar.height, thumbhash: body.avatar.thumbhash, path };
        }

        if (Object.keys(data).length === 0) return reply.code(400).send({ error: 'Nothing to update' });

        const user = await db.account.update({
            where: { id: userId },
            data,
            select: { firstName: true, lastName: true, username: true, avatar: true, githubUser: true },
        });
        const avatar = user.avatar as AccountProfile['avatar'];

        const updSeq = await allocateUserSeq(userId);
        eventRouter.emitUpdate({
            userId,
            payload: buildUpdateAccountUpdate(userId, {
                firstName: user.firstName,
                lastName: user.lastName,
                ...(avatar ? { avatar } : {}),
            }, updSeq, randomKeyNaked(12)),
            recipientFilter: { type: 'user-scoped-only' },
        });

        return reply.send({
            id: userId,
            timestamp: Date.now(),
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            avatar: avatar ? { ...avatar, url: getPublicUrl(avatar.path) } : null,
            github: user.githubUser ? user.githubUser.profile : null,
        });
    });

    // Get Account Settings API
    app.get('/v1/account/settings', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    settings: z.string().nullable(),
                    settingsVersion: z.number()
                }),
                500: z.object({
                    error: z.literal('Failed to get account settings')
                })
            }
        }
    }, async (request, reply) => {
        try {
            const user = await db.account.findUnique({
                where: { id: request.userId },
                select: { settings: true, settingsVersion: true }
            });

            if (!user) {
                return reply.code(500).send({ error: 'Failed to get account settings' });
            }

            return reply.send({
                settings: user.settings,
                settingsVersion: user.settingsVersion
            });
        } catch (error) {
            return reply.code(500).send({ error: 'Failed to get account settings' });
        }
    });

    // Update Account Settings API
    app.post('/v1/account/settings', {
        schema: {
            body: z.object({
                settings: z.string().nullable(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([z.object({
                    success: z.literal(true),
                    version: z.number()
                }), z.object({
                    success: z.literal(false),
                    error: z.literal('version-mismatch'),
                    currentVersion: z.number(),
                    currentSettings: z.string().nullable()
                })]),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update account settings')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { settings, expectedVersion } = request.body;

        try {
            // Get current user data for version check
            const currentUser = await db.account.findUnique({
                where: { id: userId },
                select: { settings: true, settingsVersion: true }
            });

            if (!currentUser) {
                return reply.code(500).send({
                    success: false,
                    error: 'Failed to update account settings'
                });
            }

            // Check current version
            if (currentUser.settingsVersion !== expectedVersion) {
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: currentUser.settingsVersion,
                    currentSettings: currentUser.settings
                });
            }

            // Update settings with version check
            const { count } = await db.account.updateMany({
                where: {
                    id: userId,
                    settingsVersion: expectedVersion
                },
                data: {
                    settings: settings,
                    settingsVersion: expectedVersion + 1,
                    updatedAt: new Date()
                }
            });

            if (count === 0) {
                // Re-fetch to get current version
                const account = await db.account.findUnique({
                    where: { id: userId }
                });
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: account?.settingsVersion || 0,
                    currentSettings: account?.settings || null
                });
            }

            // Generate update for connected clients
            const updSeq = await allocateUserSeq(userId);
            const settingsUpdate = {
                value: settings,
                version: expectedVersion + 1
            };

            // Send account update to user-scoped connections only
            const updatePayload = buildUpdateAccountUpdate(userId, { settings: settingsUpdate }, updSeq, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                success: true,
                version: expectedVersion + 1
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update account settings: ${error}`);
            return reply.code(500).send({
                success: false,
                error: 'Failed to update account settings'
            });
        }
    });

    app.post('/v1/usage/query', {
        schema: {
            body: z.object({
                sessionId: z.string().nullish(),
                startTime: z.number().int().positive().nullish(),
                endTime: z.number().int().positive().nullish(),
                groupBy: z.enum(['hour', 'day']).nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, startTime, endTime, groupBy } = request.body;
        const actualGroupBy = groupBy || 'day';

        try {
            // Build query conditions
            const where: {
                accountId: string;
                sessionId?: string | null;
                createdAt?: {
                    gte?: Date;
                    lte?: Date;
                };
            } = {
                accountId: userId
            };

            if (sessionId) {
                // Verify session belongs to user
                const session = await db.session.findFirst({
                    where: {
                        id: sessionId,
                        accountId: userId
                    }
                });
                if (!session) {
                    return reply.code(404).send({ error: 'Session not found' });
                }
                where.sessionId = sessionId;
            }

            if (startTime || endTime) {
                where.createdAt = {};
                if (startTime) {
                    where.createdAt.gte = new Date(startTime * 1000);
                }
                if (endTime) {
                    where.createdAt.lte = new Date(endTime * 1000);
                }
            }

            // Fetch usage reports
            const reports = await db.usageReport.findMany({
                where,
                orderBy: {
                    createdAt: 'desc'
                }
            });

            // Aggregate data by time period
            const aggregated = new Map<string, {
                tokens: Record<string, number>;
                cost: Record<string, number>;
                count: number;
                timestamp: number;
            }>();

            for (const report of reports) {
                const data = report.data as PrismaJson.UsageReportData;
                const date = new Date(report.createdAt);

                // Calculate timestamp based on groupBy
                let timestamp: number;
                if (actualGroupBy === 'hour') {
                    // Round down to hour
                    const hourDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
                    timestamp = Math.floor(hourDate.getTime() / 1000);
                } else {
                    // Round down to day
                    const dayDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
                    timestamp = Math.floor(dayDate.getTime() / 1000);
                }

                const key = timestamp.toString();

                if (!aggregated.has(key)) {
                    aggregated.set(key, {
                        tokens: {},
                        cost: {},
                        count: 0,
                        timestamp
                    });
                }

                const agg = aggregated.get(key)!;
                agg.count++;

                // Aggregate tokens
                for (const [tokenKey, tokenValue] of Object.entries(data.tokens)) {
                    if (typeof tokenValue === 'number') {
                        agg.tokens[tokenKey] = (agg.tokens[tokenKey] || 0) + tokenValue;
                    }
                }

                // Aggregate costs
                for (const [costKey, costValue] of Object.entries(data.cost)) {
                    if (typeof costValue === 'number') {
                        agg.cost[costKey] = (agg.cost[costKey] || 0) + costValue;
                    }
                }
            }

            // Convert to array and sort by timestamp
            const result = Array.from(aggregated.values())
                .map(data => ({
                    timestamp: data.timestamp,
                    tokens: data.tokens,
                    cost: data.cost,
                    reportCount: data.count
                }))
                .sort((a, b) => a.timestamp - b.timestamp);

            return reply.send({
                usage: result,
                groupBy: actualGroupBy,
                totalReports: reports.length
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to query usage reports: ${error}`);
            return reply.code(500).send({ error: 'Failed to query usage reports' });
        }
    });
}