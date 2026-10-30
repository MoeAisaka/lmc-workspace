import { createHash } from 'node:crypto';
import { z } from 'zod';
import { QuotaObservationSchema, QUOTA_SAMPLE_MS, type QuotaObservation } from 'lmc-wire';
import { db } from '@/storage/db';
import type { ClientConnection } from '@/app/events/eventRouter';
import type { Fastify } from './types';
export const quotaObservationId = (accountId: string, s: QuotaObservation) =>
    'q1_' + createHash('sha256').update(JSON.stringify([accountId, s.machineId, s.engine, Math.floor(s.capturedAt / QUOTA_SAMPLE_MS)])).digest('hex');
export function quotaHistoryHandler(userId: string, connection: ClientConnection) {
    let lastPruned = 0;
    connection.socket.on('quota-observation-v1', async (raw: unknown, callback?: (r: {success: boolean}) => void) => {
        const parsed = QuotaObservationSchema.safeParse(raw);
        if (!parsed.success || connection.connectionType !== 'machine-scoped' || parsed.data.machineId !== connection.machineId
            || parsed.data.capturedAt > Date.now() + 60_000 || parsed.data.capturedAt < Date.now() - 86400_000) { callback?.({success:false}); return; }
        try {
            const sample = parsed.data;
            const machine = await db.machine.findFirst({where:{id:sample.machineId,accountId:userId},select:{id:true}});
            if (!machine) { callback?.({success:false}); return; }
            // Deterministic PK: NULL sessionId cannot provide a composite unique key.
            await db.usageReport.upsert({where:{id:quotaObservationId(userId,sample)},update:{},create:{
                id:quotaObservationId(userId,sample),key:'q1:quota',accountId:userId,sessionId:null,
                createdAt:new Date(sample.capturedAt),data:{quota:sample,tokens:{total:0},cost:{total:0}}
            }});
            callback?.({success:true});
            if (Date.now() - lastPruned > 86400_000) {
                lastPruned = Date.now();
                // Only this feature's expiring telemetry; never token/session history.
                await db.usageReport.deleteMany({where:{accountId:userId,key:'q1:quota',createdAt:{lt:new Date(Date.now()-90*86400_000)}}}).catch(()=>{});
            }
        } catch { callback?.({success:false}); }
    });
}
export function quotaHistoryRoutes(app: Fastify) {
    app.post('/v2/usage/quota/query',{preHandler:app.authenticate,schema:{body:z.object({
        start:z.number().int().positive(),end:z.number().int().positive(),cursor:z.string().max(200).optional()
    })}},async(request,reply)=>{
        const {start,end,cursor}=request.body;
        if(end<=start||end-start>32*86400_000)return reply.code(400).send({error:'Invalid time range'});
        const rows=await db.usageReport.findMany({where:{accountId:request.userId,key:'q1:quota',createdAt:{gte:new Date(start),lt:new Date(end)},
            ...(cursor?{id:{gt:cursor}}:{})},orderBy:{id:'asc'},take:2001,select:{id:true,data:true}});
        return {observations:rows.slice(0,2000).flatMap(r=>{const p=QuotaObservationSchema.safeParse(r.data.quota);return p.success?[p.data]:[]}),
            nextCursor:rows.length>2000?rows[1999].id:null};
    });
}
