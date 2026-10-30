import { createHash, createHmac } from 'node:crypto';
import nacl from 'tweetnacl';

/** Matches the existing app/CLI Happy EnCoder derivation; not the signing key. */
function contentBox(secret: Uint8Array) {
    const root = createHmac('sha512', 'Happy EnCoder Master Seed').update(secret).digest();
    const child = createHmac('sha512', root.subarray(32)).update(Buffer.concat([Buffer.from([0]), Buffer.from('content')])).digest();
    const seedHash = createHash('sha512').update(child.subarray(0, 32)).digest();
    const pair = nacl.box.keyPair.fromSecretKey(seedHash.subarray(0, 32));
    root.fill(0); child.fill(0); seedHash.fill(0);
    return pair;
}

export function resourcePublicKey(secret: Uint8Array): Uint8Array {
    const pair = contentBox(secret);
    pair.secretKey.fill(0);
    return pair.publicKey;
}

/** Only rewraps a single file's 32-byte key; never an account or session root. */
export function unwrapResourceKey(ownerSecret: Uint8Array, bundle: Uint8Array, mode: string): Uint8Array {
    let key: Uint8Array | null = null;
    try {
        if (mode === 'sealed' && bundle.length === 105 && bundle[0] === 0) {
            const pair = contentBox(ownerSecret);
            try { key = nacl.box.open(bundle.slice(57), bundle.slice(33, 57), bundle.slice(1, 33), pair.secretKey); }
            finally { pair.secretKey.fill(0); }
        } else if (mode === 'legacy' && bundle.length >= 40) {
            const plaintext = nacl.secretbox.open(bundle.slice(24), bundle.slice(0, 24), ownerSecret);
            if (plaintext) {
                try {
                    const value: unknown = JSON.parse(Buffer.from(plaintext).toString('utf8'));
                    if (typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)) key = new Uint8Array(Buffer.from(value, 'base64'));
                } finally { plaintext.fill(0); }
            }
        }
        if (key?.length !== 32) throw new Error('File key cannot be shared');
        return key.slice();
    } finally { key?.fill(0); }
}

export function wrapResourceKey(recipientSecret: Uint8Array, key: Uint8Array): Uint8Array {
    const recipient = contentBox(recipientSecret), ephemeral = nacl.box.keyPair(), nonce = nacl.randomBytes(24);
    try { return new Uint8Array(Buffer.concat([Buffer.from([0]), ephemeral.publicKey, nonce, nacl.box(key, nonce, recipient.publicKey, ephemeral.secretKey)])); }
    finally { recipient.secretKey.fill(0); ephemeral.secretKey.fill(0); }
}

export function rewrapFileKey(ownerSecret: Uint8Array, recipientSecret: Uint8Array, bundle: Uint8Array, mode: string): Uint8Array {
    const key = unwrapResourceKey(ownerSecret, bundle, mode);
    try { return wrapResourceKey(recipientSecret, key); }
    finally { key.fill(0); }
}
