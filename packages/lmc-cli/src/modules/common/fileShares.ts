import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AxiosInstance } from 'axios';
import { z } from 'zod';
import { fileShareSchema } from 'lmc-wire';
import { encryptBlob, encodeBase64 } from '@/api/encryption';
import { FILE_SHARE_TOOL } from './fileDelivery';

const inputSchema = z.object(FILE_SHARE_TOOL.inputSchema);
export type ShareFileInput = z.input<typeof inputSchema>;

/** Keys and retry intents are session-local RAM only; existing account files can
 * always be shared from their authenticated file page. */
export class FileShares {
    private keys = new Map<string, Uint8Array>();
    private intents = new Map<string, { id: string; token: string; tokenHash: string; keyEnvelope: string; hours: number; expiresAt?: number }>();
    constructor(private http: Pick<AxiosInstance, 'get' | 'post' | 'delete'>, private webappUrl: string) {}
    remember(id: string, key: Uint8Array) {
        if (!this.keys.has(id) && this.keys.size >= 32) this.keys.delete(this.keys.keys().next().value!);
        this.keys.set(id, new Uint8Array(key));
    }
    clear() { this.keys.clear(); this.intents.clear(); }
    async run(raw: ShareFileInput) {
        const input = inputSchema.parse(raw);
        if (input.action === 'revoke') {
            if (!input.share_id) throw new Error('share_id is required to revoke a link');
            const result = (await this.http.delete('/v1/file-shares/' + input.share_id)).data;
            for (const [identity, intent] of this.intents) if (intent.id === input.share_id) this.intents.delete(identity);
            return result;
        }
        if (!input.asset_id) throw new Error('asset_id from publish_file is required');
        const path = '/v1/files/' + input.asset_id + '/shares';
        if (input.action === 'list') return { shares: z.array(fileShareSchema).parse((await this.http.get(path)).data.shares) };
        if (!input.public_requested) throw new Error('Create a public link only when the user explicitly requests external sharing or an app-import URL. Default delivery is the signed-in file link.');
        const key = this.keys.get(input.asset_id);
        if (!key) throw new Error('This Agent no longer holds this file key. Open its signed-in page to create a link: ' + this.webappUrl.replace(/\/$/, '') + '/saved-files/' + input.asset_id);
        const identity = input.asset_id + ':' + input.hours;
        let intent = this.intents.get(identity);
        if (intent?.expiresAt && intent.expiresAt <= Date.now()) { this.intents.delete(identity); intent = undefined; }
        if (!intent) {
            if (this.intents.size >= 32) throw new Error('Revoke an existing share before creating another link');
            const token = randomBytes(32);
            intent = { id: randomUUID(), token: token.toString('hex'), tokenHash: createHash('sha256').update(token).digest('hex'), keyEnvelope: encodeBase64(encryptBlob(key, token)), hours: input.hours };
            this.intents.set(identity, intent);
        }
        const { token, expiresAt: _, ...body } = intent;
        const share = fileShareSchema.parse((await this.http.post(path, body)).data);
        if (!share.urlPrefix || share.revokedAt || share.expiresAt <= Date.now()) {
            this.intents.delete(identity);
            throw new Error('Share unavailable; create a new link if still needed');
        }
        intent.expiresAt = share.expiresAt;
        return { id: share.id, assetId: share.assetId, url: share.urlPrefix + token, expiresAt: share.expiresAt, access: 'anyone-with-link-until-expiry', revoke: { tool: 'share_file', action: 'revoke', share_id: share.id } };
    }
}
