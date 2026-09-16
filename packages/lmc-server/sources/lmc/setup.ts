import { readFileSync } from 'node:fs';
import { db } from '@/storage/db';
import { lmcAuth } from './auth';

// Setup has no public registration route. Supply new account JSON via stdin.
async function setup() {
try {
    const {username,password}=JSON.parse(readFileSync(0,'utf8'));
    await lmcAuth.init();
    await lmcAuth.createAccount(username,password);
    console.log('LMC account created');
} finally { await db.$disconnect(); }
}
setup().catch(() => {
    console.error('LMC account setup failed. Verify account input, database and master key.');
    process.exitCode = 1;
});
