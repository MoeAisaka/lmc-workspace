import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db } from '@/storage/db';
import { allocateSessionSeqBatch } from '@/storage/seq';
import { inTx } from '@/storage/inTx';

const ids: string[] = [];
afterAll(async () => {
    for (const id of ids) {
        await db.sessionMessage.deleteMany({ where: { session: { accountId: id } } });
        await db.session.deleteMany({ where: { accountId: id } });
        await db.account.delete({ where: { id } });
    }
    await db.$disconnect();
});
describe('LMC MySQL protocol storage', () => {
    it('preserves large encrypted payloads and per-session sequence', async () => {
        const account = await db.account.create({ data: { publicKey: randomBytes(32).toString('hex') } }); ids.push(account.id);
        const metadata = 'x'.repeat(200_000);
        const session = await db.session.create({ data: { tag: 'mysql-test', accountId: account.id, metadata } });
        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).metadata).toBe(metadata);
        const batches = await Promise.all(Array.from({ length: 4 }, () => inTx(tx => allocateSessionSeqBatch(session.id, 2, tx))));
        expect(batches.flat().sort((a,b)=>a-b)).toEqual([1,2,3,4,5,6,7,8]);
        const results = await Promise.all([1,2].map(() => db.session.updateMany({ where: { id: session.id, metadataVersion: 0 }, data: { metadataVersion: { increment: 1 } } })));
        expect(results.reduce((sum, x)=>sum+x.count,0)).toBe(1);
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 9, localId: 'one', content: {t:'encrypted',c:metadata} } });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(1);
    });
});

it('keeps protocol keys case sensitive, matching the Happy baseline',async()=>{
    const account=await db.account.create({data:{publicKey:randomBytes(32).toString('hex')}});ids.push(account.id);
    await db.session.create({data:{accountId:account.id,tag:'Case',metadata:'one'}});
    await db.session.create({data:{accountId:account.id,tag:'case',metadata:'two'}});
    expect(await db.session.count({where:{accountId:account.id}})).toBe(2);
});
