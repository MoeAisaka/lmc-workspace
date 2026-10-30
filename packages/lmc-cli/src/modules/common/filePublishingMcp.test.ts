import { describe, expect, it, vi } from 'vitest';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { configuration } from '@/configuration';

describe('both engine file tool transports', () => {
    it.each(['claude', 'codex'])('%s lists the publishing tool and forwards path/job requests', async engine => {
        const file = { id: 'd686cc94-931b-40a0-b0c9-53c630fab2cf', name: 'report.pdf', size: 100, mimeType: 'application/pdf', cardPending: true };
        const publishFile = vi.fn(async input => input.job_id === 'failed'
            ? { id: 'failed', state: 'failed', error: 'synthetic upload interrupted', bytes: 0, total: 100 }
            : { id: 'job', state: input.job_id ? 'ready' : 'uploading', bytes: 0, total: 100, ...(input.job_id ? { file } : {}) });
        const shareFile = vi.fn(async input => ({ forwarded: input }));
        const server = await startHappyServer({ sessionId: 'synthetic-file-session', publishFile, shareFile } as any);
        const client = new Client({ name: 'synthetic-file-test', version: '1.0.0' }, { capabilities: {} });
        const transport = engine === 'claude'
            ? new StreamableHTTPClientTransport(new URL(server.url))
            : new StdioClientTransport({ command: process.execPath, args: [resolve('dist/codex/happyMcpStdioBridge.mjs'), '--url', server.url], stderr: 'pipe' });
        try {
            await client.connect(transport);
            const tools = await client.listTools();
            expect(tools.tools.some(tool => tool.name === 'publish_file')).toBe(true);
            expect(tools.tools.some(tool => tool.name === 'share_file')).toBe(true);
            const share = await client.callTool({ name: 'share_file', arguments: { action: 'create', asset_id: file.id, public_requested: true } });
            expect(JSON.parse((share.content as any)[0].text)).toEqual({ forwarded: { action: 'create', asset_id: file.id, public_requested: true, hours: 24 } });
            const started = await client.callTool({ name: 'publish_file', arguments: { path: 'report.pdf' } });
            expect(started.isError).not.toBe(true);
            expect(JSON.parse((started.content as any)[0].text).file).toBeUndefined();
            const ready = await client.callTool({ name: 'publish_file', arguments: { job_id: 'job' } });
            const result = JSON.parse((ready.content as any)[0].text);
            expect(result).toMatchObject({ state: 'ready', file: { ...file, url: configuration.webappUrl.replace(/\/$/, '') + '/saved-files/' + file.id }, access: 'same-account-login-required', sourceOfflineSupported: true });
            expect(publishFile.mock.calls.map(([value]) => value)).toEqual([{ path: 'report.pdf' }, { job_id: 'job' }]);
            const failed = await client.callTool({ name: 'publish_file', arguments: { job_id: 'failed' } });
            expect(failed.isError).toBe(true);
            expect(JSON.parse((failed.content as any)[0].text)).toMatchObject({ state: 'failed', error: 'synthetic upload interrupted' });
        } finally { await client.close(); server.stop(); }
    }, 15_000);

    it('destroys idle HTTP keep-alive sockets on stop so runner shutdown does not hang', async () => {
        const server = await startHappyServer({ sessionId: 'keepalive-stop-session' } as any);
        const url = new URL(server.url);
        const socket = createConnection({ host: url.hostname, port: Number(url.port) });
        await new Promise<void>((resolveConnect, rejectConnect) => {
            socket.once('connect', resolveConnect);
            socket.once('error', rejectConnect);
        });
        const closed = new Promise<void>(resolveClose => socket.once('close', () => resolveClose()));
        server.stop();
        await expect(Promise.race([
            closed.then(() => 'closed'),
            new Promise<string>(r => setTimeout(() => r('hung'), 1000)),
        ])).resolves.toBe('closed');
    });
});
