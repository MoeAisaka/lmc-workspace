import type { Session } from '../session';
import { SafeSessionRefresh } from '@/utils/safeSessionRefresh';
import { checkEngineAuth } from '@/utils/engineAuth';
import { EngineAuthPreflightError } from '@/utils/refreshErrors';
import { readFallbackBriefing, readSwitchEngine, readSwitchSettings } from '@/utils/engineSwitchRequest';
import { isPendingState } from '@/utils/refreshState';
import { prepareDaemonSessionRefresh } from '@/daemon/controlClient';
import { claudeCheckSession } from '../utils/claudeCheckSession';
import { applyQueueModeRequest } from '@/utils/sessionQueueControl';

/** Same daemon/cursor contract as the SDK runner; exit only closes our idle PTY. */
export function nativeRefresh(session: Session, boundary: {
    blocker(): string | null; flush(): Promise<void>; exit(): Promise<void>;
}) {
    let switchSettings: ReturnType<typeof readSwitchSettings> = {};
    const refresh = new SafeSessionRefresh({
        isIdle: () => boundary.blocker() === null,
        idleBlocker: boundary.blocker,
        pause: () => session.client.pauseIncomingMessages(),
        drain: () => session.client.waitForIncomingDelivery(),
        resume: seq => session.client.resumeIncomingMessagesFrom(seq),
        preflight: async target => {
            const engine = target ?? 'claude';
            if (engine === 'claude' && (!session.sessionId || !claudeCheckSession(session.sessionId, session.path))) throw new Error('缺少 Claude 恢复记录，原会话已保留');
            const status = await checkEngineAuth(engine, session.path, session.claudeEnvVars);
            if (engine === 'claude') await session.client.updateMetadata(m => ({ ...m, engineAuth: { status, checkedAt: Date.now() } }));
            if (status === 'required') throw new EngineAuthPreflightError(`${engine} 尚未登录，原会话已保留`, engine);
            if (status !== 'ready') throw new Error(`无法核验 ${engine} 认证，原会话已保留`);
            await boundary.flush();
        },
        prepare: async (receiveSeq, target) => {
            const settings = target && target !== 'claude' ? { engine: target, ...switchSettings } : session.getRefreshSettings();
            const result = await prepareDaemonSessionRefresh(session.client.sessionId, process.pid, { receiveSeq, ...settings });
            if (result.error) throw new Error(result.error);
        },
        exit: async () => { session.client.markRelaunching(); await boundary.exit(); },
        state: async (state, error, kind) => {
            if (state === 'error' || state === 'applied') session.handoff?.disarm();
            await session.client.updateMetadata(m => ({ ...m,
                sessionConfigState: state, sessionConfigError: error, sessionConfigErrorKind: kind,
                sessionConfigStage: undefined, sessionConfigUpdatedAt: Date.now(),
                sessionConfigRequestedAt: state === 'queued' ? (isPendingState(m.sessionConfigState) ? m.sessionConfigRequestedAt : Date.now()) : m.sessionConfigRequestedAt,
            }));
        },
        stage: async stage => { await session.client.updateMetadata(m => ({ ...m, sessionConfigStage: stage ?? undefined })); },
    });
    if (session.handoff) session.handoff.onSubmitted = () => refresh.hold();
    session.client.rpcHandlerManager.registerHandler('configure-session', async (request: unknown) => {
        if (applyQueueModeRequest(request, session.queue, session.client)) return { status: 'applied' };
        const engine = readSwitchEngine(request);
        if (engine) {
            switchSettings = readSwitchSettings(request);
            session.handoff?.arm(readFallbackBriefing(request), engine);
            await refresh.request(engine);
            return { status: 'queued' };
        }
        if (!request || typeof request !== 'object' || (request as any).refreshCli !== true || Object.keys(request).some(key => key !== 'refreshCli')) throw new Error('模型与思考层级请在模型面板设置');
        await refresh.request(); return { status: 'queued' };
    });
    session.client.rpcHandlerManager.registerHandler('cancel-session-refresh', async () => {
        const target = await refresh.cancel();
        if (target === undefined) return { status: refresh.pending ? 'too-late' : 'nothing-pending' };
        switchSettings = {};
        if (target) session.client.sendSessionEvent({ type: 'engine-switch-cancelled', target });
        return { status: 'cancelled' };
    });
    return refresh;
}
