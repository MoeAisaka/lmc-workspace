import { EngineLoginManager } from './engineLoginManager';
import { startNativeEngineLogin } from './nativeEngineLogin';
import { checkEngineAuth } from '@/utils/engineAuth';
import { engineLoginEnvironment } from '@/utils/engineLoginContext';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { Metadata } from '@/api/types';
import type { EngineLoginContext, LoginRecovery } from 'lmc-wire';

type Sessions = {
    ids(): string[] | Promise<string[]>;
    metadata(id: string): Promise<Metadata | null>;
    call(id: string, method: string, params: unknown): Promise<any>;
    alive(id: string): Promise<boolean>;
};

export function recoveryProgress(job: LoginRecovery, metadata: Metadata | null, alive = true, now = Date.now()): LoginRecovery {
    if (!metadata) return job;
    if (!alive && now - job.requestedAt > 120_000) return { ...job, state: 'failed' };
    if (metadata.engineAuth?.status === 'required' && metadata.engineAuth.checkedAt >= job.requestedAt) return { ...job, state: 'failed' };
    if ((metadata.sessionConfigUpdatedAt ?? 0) < job.requestedAt) return job;
    if (metadata.sessionConfigState === 'error') return { ...job, state: 'failed' };
    // An RPC acknowledgement or old ready flag is not a restored process.
    if (alive && metadata.sessionConfigState === 'applied' && metadata.hostPid && metadata.hostPid !== job.previousPid && metadata.engineAuth?.status === 'ready' && metadata.engineAuth.checkedAt >= job.requestedAt) return { ...job, state: 'restored' };
    return job;
}

export function registerEngineLogin(machine: ApiMachineClient, sessions: Sessions) {
    const context = async (id: string): Promise<EngineLoginContext> => {
        const metadata = await sessions.metadata(id);
        if (!metadata) throw new Error('offline');
        if (!metadata.sessionCapabilities?.authenticationRecovery) throw new Error('upgrade');
        return sessions.call(id, 'engine-login-context', {});
    };
    const manager = new EngineLoginManager({
        context,
        check: ctx => checkEngineAuth(ctx.engine, ctx.cwd, engineLoginEnvironment(ctx) as Record<string, string>, false),
        launch: startNativeEngineLogin,
        recover: async (ctx, sourceId) => {
            const jobs: LoginRecovery[] = [];
            for (const id of new Set([sourceId, ...await sessions.ids()])) {
                const metadata = await sessions.metadata(id);
                if (!metadata || metadata.flavor !== ctx.engine) continue;
                if (id !== sourceId && metadata.engineAuth?.status !== 'required' && metadata.engineAuth?.status !== 'unknown' && metadata.sessionConfigErrorKind !== 'auth') continue;
                const job: LoginRecovery = { sessionId: id, state: 'waiting', requestedAt: Date.now(), previousPid: metadata.hostPid };
                if (!metadata.sessionCapabilities?.authenticationRecovery) {
                    jobs.push({ ...job, state: 'upgrade' });
                    continue;
                }
                try {
                    const candidate = await context(id);
                    if (!candidate.supported || candidate.key !== ctx.key) {
                        if (id === sourceId) jobs.push({ ...job, state: 'failed' });
                        continue;
                    }
                    // Both engines' configure-session handlers wait for their real safe
                    // boundary. Do not stop/resend/reset the session here.
                    await sessions.call(id, 'configure-session', { refreshCli: true });
                    jobs.push(job);
                } catch { jobs.push({ ...job, state: 'failed' }); }
            }
            return jobs;
        },
        inspect: async job => recoveryProgress(job, await sessions.metadata(job.sessionId), await sessions.alive(job.sessionId)),
    });
    machine.registerDeviceHandler('engine-login', async (params: unknown) => {
        const p = params as Record<string, unknown> | null;
        if (!p || (p.engine !== 'claude' && p.engine !== 'codex')) return { flow: null, error: 'unsupported' };
        if (p.action === 'status') return manager.status(p.engine);
        if (typeof p.sessionId === 'string' && p.sessionId.length > 0 && p.sessionId.length < 256) {
            if (p.action === 'start') return manager.start(p.engine, p.sessionId);
            if (p.action === 'check') return manager.recheck(p.engine, p.sessionId);
            if (p.action === 'auto') return manager.autoCheck(p.engine, p.sessionId);
        }
        if (p.action === 'submit' && typeof p.id === 'string') return manager.submit(p.engine, p.id, p.code);
        if (p.action === 'cancel' && typeof p.id === 'string') return manager.cancel(p.engine, p.id);
        return { flow: null, error: 'unsupported' };
    });
    return () => manager.dispose();
}
