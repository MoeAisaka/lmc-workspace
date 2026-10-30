import { readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { SharedRuntimeSchema, type SharedRuntime } from 'lmc-wire';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

let runtime: SharedRuntime | null | undefined;
let invalidRuntime = false;
export function getSharedRuntime(): SharedRuntime | null {
    if (invalidRuntime) throw new Error('共享会话启动身份无效');
    if (runtime !== undefined) return runtime;
    const path = process.env.LMC_SESSION_RUNTIME_FILE;
    runtime = null;
    if (!path) return null;
    delete process.env.LMC_SESSION_RUNTIME_FILE;
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error();
        runtime = SharedRuntimeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch { invalidRuntime = true; throw new Error('共享会话启动身份无效，未使用设备拥有者的 LMC 登录'); }
    finally { try { unlinkSync(path); } catch { /* Parent also cleans up. */ } }
    return runtime;
}

export function sharedRuntimeCredentials(): Credentials | null {
    const run = getSharedRuntime();
    return run ? { token: run.token, encryption: { type: 'dataKey', publicKey: new Uint8Array(Buffer.from(run.publicKey, 'base64')), machineKey: new Uint8Array(32) } } : null;
}

export async function authorizeSharedRuntimeRpc(method: string, params: unknown) {
    const run = getSharedRuntime();
    if (!run || method === 'abort') return;
    const value = params as Record<string, unknown> | null;
    if (method === 'configure-session' && (!value || Object.keys(value).some(key => key !== 'queueMode'))) throw new Error('共享设备会话暂不支持运行中切换引擎或刷新；请在原设备恢复，或新建会话');
    try { await axios.post(`${configuration.serverUrl}/v1/lmc/runtime/${encodeURIComponent(run.sessionId)}/authorize`, {}, { headers: { Authorization: `Bearer ${run.token}` }, timeout: 10000 }); }
    catch { throw new Error('设备使用权限已变化或暂时无法核实'); }
}

export function sharedRuntimeHandler(machineId: string, token: string, spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>, isRunning?: (sessionId: string) => Promise<boolean> | boolean) {
    const pending = new Map<string, Promise<{ type: 'success'; sessionId: string }>>();
    return async (input: unknown) => {
        const value = input as { sessionId?: unknown; launchId?: unknown } | null;
        if (!value || typeof value.sessionId !== 'string' || !/^[\w-]{1,191}$/.test(value.sessionId) || typeof value.launchId !== 'string' || !/^[\w-]{36}$/.test(value.launchId)) throw new Error('Invalid shared launch');
        const { sessionId, launchId } = value as { sessionId: string; launchId: string };
        if (pending.has(launchId)) return pending.get(launchId)!;
        const work = (async () => {
            if (await isRunning?.(sessionId)) return { type: 'success' as const, sessionId };
            let response;
            try { response = await axios.post(`${configuration.serverUrl}/v1/lmc/runtime/${sessionId}/claim`, { launchId }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 }); }
            catch { throw new Error('共享设备启动授权已失效或无法核实'); }
            const run = SharedRuntimeSchema.parse(response.data);
            if (run.machineId !== machineId || run.sessionId !== sessionId) throw new Error('Shared device scope mismatch');
            const folder = join(configuration.lmcHomeDir, 'shared-runtimes');
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const file = join(folder, randomUUID() + '.json');
            await writeFile(file, JSON.stringify(run), { mode: 0o600, flag: 'wx' });
            try {
                const result = await spawn({ directory: join(configuration.lmcHomeDir, 'shared-workspaces', run.accountId), machineId,
                    agent: run.engine, sharedRuntimeFile: file,
                    ...(run.resume && typeof run.metadata.claudeSessionId === 'string' && run.engine === 'claude' ? { resumeClaudeSessionId: run.metadata.claudeSessionId } : {}),
                    ...(run.resume && typeof run.metadata.codexThreadId === 'string' && run.engine === 'codex' ? { resumeCodexThreadId: run.metadata.codexThreadId } : {}),
                });
                if (result.type !== 'success' || result.sessionId !== sessionId) throw new Error(result.type === 'error' ? result.errorMessage : '共享会话尚未完成注册');
                return { type: 'success' as const, sessionId };
            } finally { await unlink(file).catch(() => {}); }
        })();
        pending.set(launchId, work);
        try { return await work; } finally { pending.delete(launchId); }
    };
}
