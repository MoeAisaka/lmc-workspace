import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mock = vi.hoisted(() => ({ home: '', post: vi.fn() }));
vi.mock('@/configuration', () => ({ configuration: { get lmcHomeDir() { return mock.home; }, serverUrl: 'http://127.0.0.1:44999' } }));
vi.mock('axios', () => ({ default: { post: mock.post } }));
const payload = () => ({ sessionId: 'session-own', accountId: 'member-own', machineId: 'device-shared', engine: 'codex', token: 't'.repeat(43), key: Buffer.alloc(32, 1).toString('base64'), publicKey: Buffer.alloc(32, 2).toString('base64'), resume: false, seq: 0, metadata: {} });
beforeEach(() => { vi.resetModules(); mock.post.mockReset(); mock.home = mkdtempSync(join(tmpdir(), 'lmc-runtime-unit-')); });
afterEach(() => { delete process.env.LMC_SESSION_RUNTIME_FILE; rmSync(mock.home, { recursive: true, force: true }); });
describe('device-bound session bootstrap', () => {
    it('rechecks device authority for RPC and prevents identity-losing relaunches', async () => {
        const file = join(mock.home, 'context.json'); writeFileSync(file, JSON.stringify(payload()), { mode: 0o600 }); process.env.LMC_SESSION_RUNTIME_FILE = file;
        const { authorizeSharedRuntimeRpc } = await import('./sharedRuntime');
        await expect(authorizeSharedRuntimeRpc('configure-session', { refreshCli: true })).rejects.toThrow('暂不支持');
        mock.post.mockRejectedValue(new Error('revoked'));
        await expect(authorizeSharedRuntimeRpc('permission', { approved: true })).rejects.toThrow('使用权限');
        await expect(authorizeSharedRuntimeRpc('abort', {})).resolves.toBeUndefined();
        mock.post.mockResolvedValue({ data: { allowed: true } });
        await expect(authorizeSharedRuntimeRpc('configure-session', { queueMode: 'queue' })).resolves.toBeUndefined();
    });
    it('consumes its one-session credential without persisting or exposing it to child environments', async () => {
        const file = join(mock.home, 'context.json'); writeFileSync(file, JSON.stringify(payload()), { mode: 0o600 });
        process.env.LMC_SESSION_RUNTIME_FILE = file;
        const { getSharedRuntime, sharedRuntimeCredentials } = await import('./sharedRuntime');
        expect(getSharedRuntime()?.sessionId).toBe('session-own');
        expect(existsSync(file)).toBe(false); expect(process.env.LMC_SESSION_RUNTIME_FILE).toBeUndefined();
        expect(sharedRuntimeCredentials()?.encryption.type).toBe('dataKey');
        expect(existsSync(join(mock.home, 'access.key'))).toBe(false);
    });
    it('never falls back to the host LMC identity after an invalid bootstrap', async () => {
        const file = join(mock.home, 'invalid.json'); writeFileSync(file, '{}', { mode: 0o600 }); process.env.LMC_SESSION_RUNTIME_FILE = file;
        const { getSharedRuntime, sharedRuntimeCredentials } = await import('./sharedRuntime');
        expect(() => getSharedRuntime()).toThrow('身份无效'); expect(() => sharedRuntimeCredentials()).toThrow('身份无效');
    });
    it.each(['codex', 'claude', 'agy'])('starts %s once in the member workspace and removes the bootstrap', async engine => {
        mock.post.mockResolvedValue({ data: { ...payload(), engine } });
        const { sharedRuntimeHandler } = await import('./sharedRuntime');
        let file = '';
        const spawn = vi.fn(async (options: any) => {
            file = options.sharedRuntimeFile;
            expect(options.directory).toBe(join(mock.home, 'shared-workspaces', 'member-own'));
            expect(options.agent).toBe(engine); expect(options.token).toBeUndefined(); expect(options.environmentVariables).toBeUndefined();
            expect(statSync(file).mode & 0o777).toBe(0o600);
            expect(JSON.parse(readFileSync(file, 'utf8')).sessionId).toBe('session-own');
            return { type: 'success' as const, sessionId: 'session-own' };
        });
        const handler = sharedRuntimeHandler('device-shared', 'host-device-token', spawn);
        const input = { sessionId: 'session-own', launchId: '11111111-1111-4111-8111-111111111111' };
        const result = await Promise.all([handler(input), handler(input)]);
        expect(result[0]).toEqual(result[1]); expect(spawn).toHaveBeenCalledTimes(1); expect(mock.post).toHaveBeenCalledTimes(1); expect(existsSync(file)).toBe(false);
    });
    it('does not launch a second process when the existing session is alive', async () => {
        const { sharedRuntimeHandler } = await import('./sharedRuntime');
        const spawn = vi.fn();
        const result = await sharedRuntimeHandler('device-shared', 'host-device-token', spawn, () => true)({ sessionId: 'session-own', launchId: '11111111-1111-4111-8111-111111111111' });
        expect(result.sessionId).toBe('session-own'); expect(mock.post).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    });
});
