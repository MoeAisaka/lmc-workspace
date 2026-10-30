import { db } from '@/storage/db';
import { accessTransaction } from './transaction';

// Explicit operator-only bootstrap. Never elect a browser, first login, or username.
// Usage: tsx sources/lmc/access/bootstrap.ts <existing-account-id>
async function main() {
    const id = process.argv[2];
    if (!id || process.argv.length !== 3 || !/^[A-Za-z0-9_-]{1,191}$/.test(id)) throw new Error('Supply one existing account ID');
    await accessTransaction(async tx => {
        if (await tx.account.count({ where: { role: 'admin' } })) throw new Error('An administrator already exists');
        const account = await tx.account.findUnique({ where: { id }, select: { id: true, enabled: true, lmcPasswordHash: true } });
        if (!account?.enabled || !account.lmcPasswordHash) throw new Error('Account is not an enabled LMC login');
        await tx.account.update({ where: { id }, data: { role: 'admin', accessVersion: { increment: 1 } } });
        await tx.lmcAccessAudit.create({ data: { actorId: 'operator:bootstrap', kind: 'account', targetId: id, action: 'account.bootstrap-admin' } });
    });
    console.log('Initial administrator configured; existing resources remain exclusive.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Bootstrap failed'); process.exitCode = 1; }).finally(() => db.$disconnect());
