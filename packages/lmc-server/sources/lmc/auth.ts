import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import nacl from 'tweetnacl';
import { db } from '@/storage/db';
import { Prisma } from '@/generated/client';
import { accessTransaction } from './access/transaction';
import { rewrapFileKey, unwrapResourceKey, wrapResourceKey, resourcePublicKey } from './access/fileKeys';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
function masterKey() {
    const value = process.env.LMC_MASTER_KEY;
    if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('LMC_MASTER_KEY must contain 32 random bytes encoded as hex');
    return Buffer.from(value, 'hex');
}
function seal(secret: Buffer, accountId: string) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', masterKey(), nonce);
    cipher.setAAD(Buffer.from(accountId));
    return Buffer.concat([nonce, cipher.update(secret), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
function open(value: string, accountId: string) {
    const raw = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', masterKey(), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(accountId)); decipher.setAuthTag(raw.subarray(-16));
    return Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('base64url');
}
export const authRevocations = new EventEmitter();
authRevocations.setMaxListeners(0); // One bounded subscription per live socket; removed on disconnect.
export const PERMANENT_LOGIN_EXPIRES_AT = new Date('9999-12-31T23:59:59.000Z');

/** Expensive password work happens before the short permission transaction. */
export async function prepareLmcAccount(username: string, password: string) {
    if (!/^[\p{L}\p{N}_-]{3,64}$/u.test(username) || password.length < 12 || password.length > 256) throw new Error('Invalid username or password');
    const salt = randomBytes(16).toString('hex'), key = await derive(password, salt), secret = randomBytes(32);
    const publicKey = Buffer.from(nacl.sign.keyPair.fromSeed(secret).publicKey).toString('hex');
    return async (tx: Prisma.TransactionClient) => {
        const account = await tx.account.create({ data: { username, publicKey, lmcPasswordHash: `${salt}:${key.toString('hex')}` } });
        await tx.account.update({ where: { id: account.id }, data: { lmcSecret: seal(secret, account.id) } });
        secret.fill(0);
        return account.id;
    };
}
export const lmcAuth = {
    async init() { masterKey(); },
    async createSessionToken(tx: Prisma.TransactionClient, accountId: string, sessionId: string, machineId: string) {
        const token = randomBytes(32).toString('base64url');
        await tx.lmcLogin.create({ data: { hash: hashToken(token), accountId, kind: 'session', extras: { sessionId, machineId }, expiresAt: PERMANENT_LOGIN_EXPIRES_AT } });
        return token;
    },
    async resourcePublicKey(tx: Prisma.TransactionClient, accountId: string) {
        const account = await tx.account.findUnique({ where: { id: accountId }, select: { lmcSecret: true } });
        if (!account?.lmcSecret) throw new Error('Account key unavailable');
        const secret = Buffer.from(open(account.lmcSecret, accountId), 'base64url');
        try { return Buffer.from(resourcePublicKey(secret)).toString('base64'); } finally { secret.fill(0); }
    },
    /** Internal resource adapter only, after checking ACL in the same transaction. */
    async withResourceKey<T>(tx: Prisma.TransactionClient, resource: { accountId: string; ownerKey: Uint8Array; keyMode: string }, work: (key: Uint8Array) => Promise<T> | T): Promise<T> {
        const owner = await tx.account.findUnique({ where: { id: resource.accountId }, select: { lmcSecret: true } });
        if (!owner?.lmcSecret) throw new Error('Account key unavailable');
        const secret = Buffer.from(open(owner.lmcSecret, resource.accountId), 'base64url');
        let key: Uint8Array | undefined;
        try { key = unwrapResourceKey(secret, resource.ownerKey, resource.keyMode); return await work(key); }
        finally { key?.fill(0); secret.fill(0); }
    },
    async wrapNewResourceKey(tx: Prisma.TransactionClient, accountId: string, key: Uint8Array) {
        const owner = await tx.account.findUnique({ where: { id: accountId }, select: { lmcSecret: true, enabled: true } });
        if (!owner?.lmcSecret || !owner.enabled) throw new Error('Account key unavailable');
        const secret = Buffer.from(open(owner.lmcSecret, accountId), 'base64url');
        try { return wrapResourceKey(secret, key); } finally { secret.fill(0); }
    },
    /** Internal only: caller has checked the resource ACL in this transaction. */
    async rewrapResourceKey(tx: Prisma.TransactionClient, file: { accountId: string; ownerKey: Uint8Array; keyMode: string }, recipientId: string) {
        const owner = await tx.account.findUnique({ where: { id: file.accountId }, select: { lmcSecret: true } });
        const recipient = await tx.account.findUnique({ where: { id: recipientId }, select: { lmcSecret: true, enabled: true } });
        if (!owner?.lmcSecret || !recipient?.lmcSecret || !recipient.enabled) throw new Error('Account key unavailable');
        const ownerSecret = Buffer.from(open(owner.lmcSecret, file.accountId), 'base64url');
        const recipientSecret = Buffer.from(open(recipient.lmcSecret, recipientId), 'base64url');
        try { return rewrapFileKey(ownerSecret, recipientSecret, file.ownerKey, file.keyMode); }
        finally { ownerSecret.fill(0); recipientSecret.fill(0); }
    },
    async createAccount(username: string, password: string) {
        return db.$transaction(await prepareLmcAccount(username, password));
    },
    async login(username: string, password: string) {
        if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) return null;
        const account = await db.account.findUnique({ where: { username } });
        const [salt, digest] = (account?.lmcPasswordHash || '00000000000000000000000000000000:'+'00'.repeat(32)).split(':');
        const actual = await derive(password, salt), expected = Buffer.from(digest, 'hex');
        if (expected.length !== actual.length || !timingSafeEqual(actual, expected) || !account?.lmcSecret || !account.enabled) return null;
        const token = await this.createToken(account.id, undefined, 'web');
        return { token, secret: open(account.lmcSecret, account.id) };
    },
    async createToken(userId: string, extras?: Prisma.InputJsonValue, kind: 'web' | 'device' = 'device') {
        const token = randomBytes(32).toString('base64url');
        await accessTransaction(async tx => {
            const account = await tx.account.findUnique({ where: { id: userId }, select: { enabled: true } });
            if (!account?.enabled) throw new Error('Account is unavailable');
            const expiresAt = kind === 'web' ? new Date(Date.now() + 30 * 86400_000) : PERMANENT_LOGIN_EXPIRES_AT;
            await tx.lmcLogin.create({ data: { hash: hashToken(token), accountId: userId, kind, ...(extras === undefined ? {} : { extras }), expiresAt } });
        });
        return token;
    },
    async verifyToken(token: string): Promise<{ userId: string; extras?: any; kind: string } | null> {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
        const login = await db.lmcLogin.findUnique({ where: { hash: hashToken(token) }, include: { account: { select: { enabled: true } } } });
        const notExpired = login ? (login.kind !== 'web' || login.expiresAt.getTime() > Date.now()) : false;
        return login && login.account.enabled && notExpired ? { userId: login.accountId, extras: login.extras, kind: login.kind } : null;
    },
    /**
     * The key paired agents use to talk to each other, derived from the account
     * secret rather than being the secret itself: a stolen agent credential
     * then reaches this channel alone, not every session's contents.
     */
    async agentChannelKey(accountId: string): Promise<string | null> {
        const account = await db.account.findUnique({ where: { id: accountId } });
        if (!account?.lmcSecret) return null;
        const secret = Buffer.from(open(account.lmcSecret, account.id), 'base64url');
        return Buffer.from(hkdfSync('sha256', secret, Buffer.from(accountId), 'lmc-agent-mail', 32)).toString('base64');
    },
    async browserCredentials(token: string) {
        const verified = await this.verifyToken(token);
        if (!verified || verified.kind !== 'web') return null;
        const account = await db.account.findUnique({ where: { id: verified.userId } });
        return account?.lmcSecret ? { token, secret: open(account.lmcSecret, account.id) } : null;
    },
    async invalidateToken(token: string) {
        await db.lmcLogin.deleteMany({ where: { hash: hashToken(token) } });
        authRevocations.emit('token', token);
    },
    async invalidateUserTokens(userId: string) {
        await db.lmcLogin.deleteMany({ where: { accountId: userId } });
        authRevocations.emit('user', userId);
    },
};
