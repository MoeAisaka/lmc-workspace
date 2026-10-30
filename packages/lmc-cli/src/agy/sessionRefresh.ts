import type { ApiSessionClient } from '@/api/apiSession';
import { SafeSessionRefresh } from '@/utils/safeSessionRefresh';
import { checkEngineAuth } from '@/utils/engineAuth';
import { EngineAuthPreflightError } from '@/utils/refreshErrors';
import { prepareDaemonSessionRefresh } from '@/daemon/controlClient';
import { isRefreshCliRequest, readFallbackBriefing, readSwitchEngine, readSwitchSettings } from '@/utils/engineSwitchRequest';
import type { ArmedHandoffPort } from '@/utils/handoffPort';

/** Only the runner's settled sendPrompt boundary may relinquish the session. */
export function agySessionRefresh(session: ApiSessionClient, handoff: ArmedHandoffPort, boundary: {
    idle(): boolean; settings(): { model?: string; effort?: string; permissionMode?: string }; exit(): void;
    configureQueue?(request: unknown): boolean;
}) {
    let settings: ReturnType<typeof readSwitchSettings> = {};
    const refresh = new SafeSessionRefresh({
        isIdle: boundary.idle,
        idleBlocker: () => '等当前回合与排队消息结束',
        pause: () => session.pauseIncomingMessages(),
        drain: () => session.waitForIncomingDelivery(),
        resume: seq => session.resumeIncomingMessagesFrom(seq),
        preflight: async target => {
            const engine = target ?? 'agy';
            const status = await checkEngineAuth(engine, process.cwd());
            if (status === 'required') throw new EngineAuthPreflightError(`${engine} 尚未登录，原会话已保留`, engine);
            if (status !== 'ready') throw new Error(`无法核验 ${engine} 的认证或可用性，原会话已保留`);
        },
        prepare: async (receiveSeq, target) => {
            // A model selected in the chat UI may not have been sent in a turn
            // yet. Refresh must preserve that saved choice, not roll it back to
            // the last model that happened to execute a prompt.
            const saved = session.getMetadata();
            const current = { ...boundary.settings(),
                ...(saved?.modelMode ? { model: saved.modelMode } : {}),
                ...(saved?.effortLevel ? { effort: saved.effortLevel } : {}),
                ...(saved?.permissionMode ? { permissionMode: saved.permissionMode } : {}),
            };
            const result = await prepareDaemonSessionRefresh(session.sessionId, process.pid, {
                receiveSeq, ...(target ? { engine: target, ...settings } : current),
            });
            if (result.error) throw new Error(result.error);
        },
        exit: async () => { session.markRelaunching(); boundary.exit(); },
        state: async (state, error, kind) => {
            if (state === 'error' || state === 'applied') handoff.disarm();
            await session.updateMetadata(m => ({ ...m, sessionConfigState: state, sessionConfigError: error,
                sessionConfigErrorKind: kind, sessionConfigStage: undefined, sessionConfigUpdatedAt: Date.now(),
                sessionConfigRequestedAt: state === 'queued' ? Date.now() : m.sessionConfigRequestedAt }));
        },
        stage: async stage => { await session.updateMetadata(m => ({ ...m, sessionConfigStage: stage ?? undefined })); },
    });
    handoff.onSubmitted = () => refresh.hold();
    session.rpcHandlerManager.registerHandler('configure-session', async (request: unknown) => {
        if (boundary.configureQueue?.(request)) return { status: 'applied' };
        if (refresh.pending) return { status: 'queued' };
        const engine = readSwitchEngine(request);
        if (engine === 'agy') throw new Error('Antigravity 已在运行，请直接选择模型');
        if (!engine && !isRefreshCliRequest(request)) throw new Error('Unsupported session configuration');
        settings = readSwitchSettings(request);
        if (engine) handoff.arm(readFallbackBriefing(request), engine);
        // Return the acknowledgement before the runner closes its RPC socket.
        setImmediate(() => { void refresh.request(engine ?? undefined); });
        return { status: 'queued' };
    });
    session.rpcHandlerManager.registerHandler('cancel-session-refresh', async () => {
        const target = await refresh.cancel();
        if (target === undefined) return { status: refresh.pending ? 'too-late' : 'nothing-pending' };
        settings = {};
        if (target) session.sendSessionEvent({ type: 'engine-switch-cancelled', target });
        return { status: 'cancelled' };
    });
    return refresh;
}
