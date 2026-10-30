import { db } from '@/storage/db';
import { Prisma } from '@/generated/client';

// A single row serializes account/ACL mutation and invocation checks. Reads do
// not use an authorization cache. MySQL row locks also work across centers.
export async function accessTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return db.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM LmcAccessLock WHERE id = 1 FOR UPDATE`;
        if (rows.length !== 1) throw new Error('Account permissions migration is incomplete');
        return work(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10_000, timeout: 15_000 });
}
