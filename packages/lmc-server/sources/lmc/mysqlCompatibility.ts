import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/client';

/** MySQL has no INSERT RETURNING; select exactly this transaction's generated IDs. */
export async function createMessagesAndReturn(tx: Prisma.TransactionClient, messages: Prisma.SessionMessageCreateManyInput[]) {
    const data=messages.map(message=>({...message,id:message.id||randomUUID()}));
    if(!data.length)return [];
    await tx.sessionMessage.createMany({data});
    // Ordered here rather than in SQL: `content` is LONGTEXT, so an ORDER BY
    // makes MySQL filesort whole rows through sort_buffer_size and a single
    // large message fails the insert with ER_OUT_OF_SORTMEMORY (1038). The set
    // is exactly what this call inserted, so ordering it in memory is cheap.
    const rows = await tx.sessionMessage.findMany({where:{id:{in:data.map(message=>message.id)}}});
    return rows.sort((left, right) => left.seq - right.seq);
}

/** Username search stays case-insensitive while protocol identifiers stay binary. */
export async function findAccountIdsByUsername(query: string) {
    const { db } = await import('@/storage/db');
    const prefix = query.replace(/[!%_]/g, '!$&') + '%';
    return db.$queryRaw<Array<{ id: string }>>`SELECT id FROM Account WHERE LOWER(username) LIKE LOWER(${prefix}) ESCAPE '!' ORDER BY username ASC LIMIT 10`;
}
