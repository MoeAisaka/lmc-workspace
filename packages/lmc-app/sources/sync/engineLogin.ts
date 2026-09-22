import { apiSocket } from './apiSocket';
import { storage } from './storage';
import type { EngineLoginError, EngineLoginReply, LoginEngine } from 'lmc-wire';
import { t, type TranslationKey } from '@/text';

export function engineLoginError(error: EngineLoginError): string {
    const suffix = error[0].toUpperCase() + error.slice(1);
    return t(`localFeatures.loginError${suffix}` as TranslationKey) as string;
}

export async function engineLoginRequest(sessionId: string, action: 'status' | 'start' | 'check' | 'auto' | 'submit' | 'cancel', extra?: { id?: string; code?: string }): Promise<EngineLoginReply> {
    const session = storage.getState().sessions[sessionId];
    if (session?.metadata?.flavor !== 'claude' && session?.metadata?.flavor !== 'codex') return { flow: null, error: 'unsupported' };
    const machineId = session?.metadata?.machineId;
    const machine = machineId ? storage.getState().machines[machineId] : undefined;
    const engine: LoginEngine = session?.metadata?.flavor === 'codex' ? 'codex' : 'claude';
    if (!machineId || !machine?.active) return { flow: null, error: 'offline' };
    if (!session?.metadata?.sessionCapabilities?.authenticationRecovery || !machine.metadata?.engineLogin?.[engine]) return { flow: null, error: 'upgrade' };
    try {
        return await apiSocket.machineRPC<EngineLoginReply, unknown>(machineId, 'engine-login', { engine, action, sessionId, ...extra });
    } catch { return { flow: null, error: 'offline' }; }
}

// One automatic attempt per observed failure per client. No message is resent.
const attempted = new Map<string, number>();
export function shouldAutoRecover(sessionId: string, checkedAt: number): boolean {
    if ((attempted.get(sessionId) ?? 0) >= checkedAt) return false;
    if (attempted.size > 512) attempted.delete(attempted.keys().next().value!);
    attempted.set(sessionId, checkedAt);
    return true;
}
