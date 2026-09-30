import { randomUUID } from 'node:crypto';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';
import type { TakenItem } from '@/utils/MessageQueue2';
import { claudeExecutable, engineCapabilities } from '@/runtime/managedRuntime';
import { createSessionScanner } from '../utils/sessionScanner';
import { mapToClaudeMode } from '../utils/permissionMode';
import { claudeChromeChoice } from '@/runtime/computerUse';
import { systemPrompt } from '../utils/systemPrompt';
import { registerQueueControlHandlers, applyQueueModeRequest } from '@/utils/sessionQueueControl';
import { saveAttachmentsToInbox, formatInboxNote } from '@/modules/common/attachmentInbox';
import { trackBackgroundTask, releaseForegroundTasks, type BackgroundTasks } from '../utils/backgroundTasks';
import { startNativeInteractiveProcess } from './interactiveProcess';
import { encodeNativeInput, type NativeInputRequest } from './terminalRelay';

export async function claudeNativeLauncher(session: Session): Promise<'switch' | 'exit'> {
    const resume = !!session.sessionId;
    const id = session.sessionId ?? randomUUID();
    const settings = { ...session.getNativeMode() };
    let phase: 'starting' | 'idle' | 'busy' | 'stopping' | 'sending' | 'unconfirmed' | 'exited' = 'starting';
    let turnStatus: 'completed' | 'failed' = 'completed';
    let leaving = false;
    let stopped = false;
    let pending: TakenItem<EnhancedMode>[] = [];
    let pendingText = '';
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let deliveryBlocked = false;
    let possibleBackgroundWork = false;
    const echoes: string[] = [];
    const tasks: BackgroundTasks = new Map();
    let chain = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let process: Awaited<ReturnType<typeof startNativeInteractiveProcess>> | undefined;
    let lastWarning = '';
    const warn = (message: string) => { if (lastWarning !== message) { lastWarning = message; session.client.sendSessionEvent({ type: 'message', message }); } };
    const scanner = await createSessionScanner({ sessionId: resume ? id : null, workingDirectory: session.path, onMessage: raw => {
        trackBackgroundTask(tasks, raw);
        // Transcript task lifecycle events differ from SDK events. A request to
        // background work conservatively disables automatic /exit for this run.
        const result = (raw as any).toolUseResult;
        if (result?.backgroundTaskId || result?.isAsync === true) possibleBackgroundWork = true;
        const blocks = (raw as any).message?.content;
        if (Array.isArray(blocks) && blocks.some((b: any) => b.type === 'tool_use' && b.input?.run_in_background === true)) possibleBackgroundWork = true;
        const content = (raw as any).message?.content;
        if (raw.type === 'user' && typeof content === 'string' && /^<(?:local-command|command-name)/.test(content.trim())) return;
        const echo = raw.type === 'user' && typeof content === 'string' ? echoes.indexOf(content.trim()) : -1;
        if (echo >= 0) { echoes.splice(echo, 1); return; }
        if (raw.type !== 'summary') chain = chain.then(() => session.client.sendClaudeSessionMessageFromLocalTranscript(raw)).catch(() => warn('原生会话记录同步暂时失败，请保留当前会话。'));
    } });
    const schedule = () => {
        if (timer) clearTimeout(timer);
        if (!stopped) timer = setTimeout(() => { void pump().catch(error => warn(String(error))); }, 180);
    };
    let finishingTurn = false;
    const pump = async () => {
        if (process && phase === 'stopping' && !finishingTurn) {
            await process.settled();
            if (!process.relay.snapshot().composer) return;
            finishingTurn = true;
            try {
                await scanner.flush(); await chain;
                session.client.closeClaudeSessionTurn(turnStatus);
                phase = 'idle'; session.onThinkingChange(false); releaseForegroundTasks(tasks);
            } finally { finishingTurn = false; }
        }
        if (!process || stopped || leaving || phase !== 'idle' || deliveryBlocked || pending.length || !session.queue.size()) return;
        await process.settled();
        if (phase !== 'idle' || !process.relay.snapshot().composer) return;
        const head = session.queue.queue[0];
        if (!head) return;
        const mode = head.mode;
        if (session.queue.modeHasher(mode) !== session.queue.modeHasher(settings)) {
            warn('原生模式尚不能应用这条消息的新运行设置。请撤回排队消息，退出原生模式后调整设置再发送。');
            return;
        }
        phase = 'sending';
        const batch = [head];
        if (session.queue.getQueueMode() === 'batch' && !head.isolate) {
            for (const item of session.queue.queue.slice(1)) {
                if (item.isolate || item.modeHash !== head.modeHash) break;
                batch.push(item);
            }
        }
        pending = batch.map(item => session.queue.takeByKey(item.key)!).filter(Boolean);
        let pasted = false;
        try {
            const attachments = pending.flatMap(item => item.attachments ?? []);
            const note = attachments.length ? formatInboxNote(await saveAttachmentsToInbox(attachments, { projectPath: session.path, sessionId: session.client.sessionId })) : '';
            pendingText = pending.map(item => item.message).join('\n\n') + note;
            const bytes = encodeNativeInput({ type: 'text', text: pendingText });
            process.write(bytes);
            pasted = true;
            // Claude's composer consumes bracketed paste separately from Enter.
            await new Promise(resolve => setTimeout(resolve, 120));
            await process.settled();
            if (!stopped && phase === 'sending') process.write(encodeNativeInput({ type: 'key', key: 'enter' }));
            deliveryTimer = setTimeout(() => {
                if (phase === 'sending' && pending.length) {
                    phase = 'unconfirmed';
                    warn('消息交付尚未确认，请在原生窗口检查并手动提交；不会重复发送。');
                }
            }, 5000);
            // Only UserPromptSubmit acknowledges consumption. A timeout cannot
            // establish non-delivery, so it must never trigger an automatic retry.
        } catch {
            if (!pasted) {
                for (const item of pending.slice().reverse()) session.queue.restore(item);
                pending = []; pendingText = ''; phase = 'idle'; deliveryBlocked = true;
                warn('这条消息无法交付到原生终端，已保留在队列。请撤回后退出原生模式再发送。');
            } else {
                phase = 'unconfirmed';
                warn('原生消息交付未确认，请打开原生控制窗口检查；不会自动重复发送。');
            }
        }
    };
    try {
        const args = ['--append-system-prompt', systemPrompt + '\nFor computer interaction, use the built-in computer-use tools. Do not silently substitute third-party desktop tools.'];
        if (settings.customSystemPrompt) args.push('--system-prompt', settings.customSystemPrompt);
        if (settings.appendSystemPrompt) args[1] += '\n' + settings.appendSystemPrompt;
        if (settings.fallbackModel) args.push('--fallback-model', settings.fallbackModel);
        if (settings.disallowedTools?.length) args.push('--disallowedTools', settings.disallowedTools.join(','));
        if (settings.model) args.push('--model', settings.model);
        if (settings.effort) args.push('--effort', settings.effort);
        const permission = mapToClaudeMode(settings.permissionMode as EnhancedMode['permissionMode']);
        if (permission) args.push('--permission-mode', permission);
        const chrome = claudeChromeChoice(session.claudeArgs);
        if (chrome !== undefined) args.push(chrome ? '--chrome' : '--no-chrome');
        const { 'lmc-computer': _thirdPartyDesktop, ...mcpServers } = session.mcpServers;
        args.push('--mcp-config', JSON.stringify({ mcpServers }));
        const allowedTools = [...session.allowedTools ?? [], ...settings.allowedTools ?? []];
        if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
        process = await startNativeInteractiveProcess({ executable: claudeExecutable(), cwd: session.path, sessionId: id, resume, args, env: session.claudeEnvVars,
            onScreen: schedule,
            onHook: hook => {
                if (hook.event === 'SessionStart') { session.onSessionFound(id); phase = 'idle'; }
                if (hook.event === 'UserPromptSubmit') {
                    turnStatus = 'completed';
                    // Fresh interactive sessions may sit at the composer for
                    // hours before a transcript exists. Start watching on the
                    // first real submission, not SessionStart's 60s timeout.
                    void scanner.onNewSession(id);
                    if (deliveryTimer) clearTimeout(deliveryTimer);
                    if (pending.length) {
                        echoes.push(pendingText.trim()); if (echoes.length > 32) echoes.shift();
                        session.client.sendSessionEvent({ type: 'queue-released', keys: pending.map(item => item.key) });
                        pending = []; pendingText = '';
                    }
                    phase = 'busy'; session.onThinkingChange(true);
                }
                if (hook.event === 'Stop' || hook.event === 'StopFailure') {
                    turnStatus = hook.event === 'StopFailure' ? 'failed' : 'completed';
                    phase = 'stopping';
                }
                schedule();
            } });
        session.mode = 'remote';
        session.client.updateAgentState(state => ({ ...state, controlledByUser: false }));
        await session.client.updateMetadata(metadata => ({ ...metadata, claudeNativeActive: true,
            sessionCapabilities: { ...engineCapabilities('claude'), nativeComputer: true, refresh: false, runtimeConfiguration: false, model: false, effort: false, automaticGoals: false } }));
        const rpc = session.client.rpcHandlerManager;
        rpc.registerHandler('native-computer', async (request: any) => {
            await process!.settled();
            switch (request?.action) {
                case 'claim': return { ...process!.relay.claim(request.clientId), phase };
                case 'screen': return { ...process!.relay.snapshot(request.clientId), phase };
                case 'release': process!.relay.release(request.clientId); return { ok: true };
                case 'input': {
                    if (request.input?.type === 'text' && /^\s*\/(?:clear|resume|fork|model|effort|permissions|plan|worktree)(?:\s|$)/i.test(request.input.text)) throw new Error('请先退出原生模式，再通过 LMC 调整设置或切换会话');
                    if (phase === 'sending' || leaving) throw new Error('正在交付消息，请等待原生界面更新');
                    return process!.relay.input(request as NativeInputRequest);
                }
                case 'leave': {
                    process!.relay.assertCurrent(request);
                    if (leaving) return { ok: true };
                    if (possibleBackgroundWork) throw new Error('本次原生会话启动过后台任务，请在原生窗口检查 /tasks，并由你输入 /exit 退出');
                    if (phase !== 'idle' || pending.length || session.queue.size() || tasks.size || !process!.relay.snapshot().composer) throw new Error('请等待回合、排队消息和后台任务结束后退出原生模式');
                    leaving = true;
                    process!.write(encodeNativeInput({ type: 'text', text: '/exit' }));
                    await new Promise(resolve => setTimeout(resolve, 120));
                    process!.write(encodeNativeInput({ type: 'key', key: 'enter' }));
                    return { ok: true };
                }
                default: throw new Error('Unsupported native action');
            }
        });
        const interrupt = async () => {
            if (phase === 'sending') throw new Error('原生消息正在交付');
            if (phase === 'busy') process!.write(encodeNativeInput({ type: 'key', key: 'escape' }));
        };
        rpc.registerHandler('abort', interrupt);
        rpc.registerHandler('switch', async () => { throw new Error('请从原生控制窗口退出原生模式'); });
        rpc.registerHandler('configure-session', async (request: unknown) => { if (applyQueueModeRequest(request, session.queue, session.client)) return { status: 'applied' }; throw new Error('请先退出原生模式再调整运行设置'); });
        session.interruptTurn = interrupt;
        registerQueueControlHandlers(session.client, session.queue, { isBusy: () => phase !== 'idle', interrupt });
        session.queue.setOnMessage(schedule);
        schedule();
        const result = await process.exit;
        if (result.exitCode !== 0) warn(`原生 Claude 已退出（${result.exitCode}），未自动重发未确认消息。`);
        return result.exitCode === 0 && !pending.length ? 'switch' : 'exit';
    } catch (error) {
        if (process) throw error;
        warn('原生进程未能启动，已返回普通模式：' + String(error));
        return 'switch';
    } finally {
        stopped = true; phase = 'exited'; if (timer) clearTimeout(timer); if (deliveryTimer) clearTimeout(deliveryTimer);
        session.queue.setOnMessage(null); session.interruptTurn = null;
        for (const name of ['native-computer', 'configure-session']) session.client.rpcHandlerManager.unregisterHandler(name);
        await scanner.cleanup(); await chain;
        session.nativeComputer = false;
        session.onThinkingChange(false);
        session.client.closeClaudeSessionTurn(pending.length ? 'failed' : 'completed');
        await session.client.updateMetadata(metadata => ({ ...metadata, claudeNativeActive: false }));
    }
}
