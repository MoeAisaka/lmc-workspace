import { z } from 'zod';
import type { FilePublication } from './filePublications';

/** One delivery contract for both engine prompts and both MCP transports. */
export const FILE_DELIVERY_INSTRUCTIONS = `File delivery in LMC:
When the user asks you to create, export, or deliver a file, use the available publish_file tool to save the finished deliverable and provide its downloadable card/link. This is part of delivering the requested file; do not ask for a separate upload confirmation. A source-machine path alone is not a cross-device delivery.
Only publish the requested deliverables, not ordinary source-code edits, incidental logs, credentials, or unrelated files. Reuse the returned job_id while uploading; wait for state=ready before claiming delivery. If cardPending=true, give the returned file.url and explain that the card is pending; do not upload the file again just to recreate the card.
The default saved file requires the same LMC account to sign in and remains available after the source computer goes offline. Do not describe it as an anonymous direct-download URL. Only when the user explicitly requests external sharing or an app-import URL, use share_file on the saved asset with public_requested=true; report the returned expiry and link. Anyone holding that link can download until expiry or revocation. The default expiry is 24 hours (maximum 7 days). Use share_file action=revoke when asked to withdraw a link. Do not use legacy temporary scripts or publish anonymous links as a fallback for failed private delivery. If delivery fails, report the failure and retain the local result.`;

export const FILE_PUBLISH_TOOL = {
    title: 'Save File To This Conversation',
    description: 'Default delivery for files the user asked you to create, export, or receive: save an encrypted persistent snapshot and add a downloadable card. No extra upload confirmation is needed for that requested deliverable. Returns file.url when ready; the same LMC account must sign in. The snapshot remains available when the source computer is offline. Never publish unrelated files, incidental source edits, or credentials. Reuse job_id until ready; cardPending means use the returned URL, not another upload. Does not create anonymous links, send to another person, or start another agent.',
    inputSchema: {
        path: z.string().min(1).max(4096).optional().describe('Absolute or project-relative path of the requested deliverable, up to 2 GiB. Omit when checking an existing job.'),
        job_id: z.string().optional().describe('Previously returned upload job. Waits up to 20 seconds; do not restart by sending the path again.'),
    },
};

export const FILE_SHARE_TOOL = {
    title: 'Manage Expiring File Links',
    description: 'Explicit external sharing only. Create, list, or revoke a temporary anonymous download link for an already saved file. Default delivery remains publish_file and signed-in LMC download. Only create when the user explicitly requests external sharing or an app-import URL; anyone holding the link can download. Default 24 hours, maximum 7 days. Include expiry in the response. Keys are held only for files this Agent has published/received during this process; otherwise use the signed-in file page. Does not send messages to other people.',
    inputSchema: {
        action: z.enum(['create', 'list', 'revoke']),
        asset_id: z.string().uuid().optional().describe('Saved file id from publish_file; required for create/list.'),
        share_id: z.string().uuid().optional().describe('Share id to revoke, returned by create/list.'),
        hours: z.number().int().min(1).max(168).default(24),
        public_requested: z.boolean().optional().describe('Set true only for an explicit user request for external sharing/app import. Required for create.'),
    },
};

export function fileDeliveryResult(value: FilePublication, webappUrl: string) {
    if (value.state !== 'ready' || !value.file) return value;
    const base = new URL(webappUrl.endsWith('/') ? webappUrl : webappUrl + '/');
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error('Invalid LMC web application URL');
    }
    return {
        ...value,
        file: { ...value.file, url: new URL('saved-files/' + encodeURIComponent(value.file.id), base).href },
        access: 'same-account-login-required',
        sourceOfflineSupported: true,
    };
}
