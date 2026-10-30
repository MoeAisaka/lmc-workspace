import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Existing dataKey wire format, shared by the browser and native Agents.
export function decryptResourceJson(key: Uint8Array, value: string): unknown {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 30 || bytes[0] !== 0) throw new Error('Invalid encrypted resource');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
    cipher.setAuthTag(bytes.subarray(-16));
    const plaintext = Buffer.concat([cipher.update(bytes.subarray(13, -16)), cipher.final()]);
    try { return JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
}
export function encryptResourceJson(key: Uint8Array, value: unknown): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const plaintext = Buffer.from(JSON.stringify(value));
    try { return Buffer.concat([Buffer.from([0]), nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64'); }
    finally { plaintext.fill(0); }
}
