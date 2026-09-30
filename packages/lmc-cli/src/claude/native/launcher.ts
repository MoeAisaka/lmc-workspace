import { nativeRefresh } from './refresh';
import { nativePermissionHook } from './permissions';
import { PermissionHandler } from '../utils/permissionHandler';
import { watchSessionConfiguration } from '@/modules/orchestration/workerConfig';
import { normalizeRemotePermissionMode } from '../utils/permissionMode';
import { claudeTurnFailure } from '@/modules/orchestration/quota';
import { normalizeClaudeGoalEcho } from '../claudeAutomaticGoal';
import { runtimeVersion } from '@/runtime/managedRuntime';
import { randomUUID } from 'node:crypto';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';
import type { TakenItem } from '@/utils/MessageQueue2';
import { claudeExecutable, engineCapabilities } from '@/runtime/managedRuntime';
import { createSessionScanner } from '../utils/sessionScanner';
import { mapToClaudeMode } from '../utils/permissionMode';
import { claudeChromeChoice } from '@/runtime/computerUse';
import { systemPrompt } from '../utils/systemPrompt';
import { registerQueueControlHandlers } from '@/utils/sessionQueueControl';
import { saveAttachmentsToInbox, formatInboxNote } from '@/modules/common/attachmentInbox';
import { NativeBackgroundTasks } from './backgroundTasks';
import { hashObject } from '@/utils/deterministicJson';
import { startNativeInteractiveProcess } from './interactiveProcess';
import { encodeNativeInput, type NativeInputRequest } from './terminalRelay';

export async function claudeNativeLauncher(session: Session): Promise<'switch' | 'exit' | 'restart' | 'refresh'> {
    const resume = !!session.sessionId && !session.nativeUnwritten;
    session.nativeUnwritten = !resume;
    const id = session.sessionId ?? randomUUID();
    const settings = { ...(session.queue.queue[0]?.mode ?? session.getNativeMode()) };
    let phase: 'starting' | 'idle' | 'busy' | 'stopping' | 'sending' | 'unconfirmed' | 'exited' = 'starting';
    let turnStatus: 'completed' | 'failed' = 'completed';
    let leaving = false;
    let exitPurpose: 'switch' | 'restart' | 'refresh' = 'switch';
    const permissions = new PermissionHandler(session);
    permissions.reset('Previous Claude transport exited');
    await permissions.handleModeChange(normalizeRemotePermissionMode(settings.permissionMode));
    let stopWatchingConfiguration = () => {};
    let refresh: ReturnType<typeof nativeRefresh> | undefined;
    let stopped = false;
    let pending: TakenItem<EnhancedMode>[] = [];
    let pendingText = '';
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let deliveryBlocked = false;
    let interruptRevision: number | null = null;
    const echoes: string[] = [];
    const usageByMessage = new Map<string, { inputTokens: number; outputTokens: number }>();
    let commands = session.client.getMetadata()?.slashCommands ?? [];
    // This release's real interactive /goal path is covered by the lab. Unknown
    // engine versions keep their discovered capabilities, rather than guessing.
    if (!(commands.includes('goal') || commands.includes('/goal'))) {
        try { if ((await runtimeVersion('claude')).version === '2.1.285') commands = [...commands, 'goal']; } catch {}
    }
    const tasks = new NativeBackgroundTasks();
    // The SDK queue hash intentionally ignores live permission changes. A PTY
    // child has fixed startup permissions, so native boundaries must include them.
    const runtimeHash = (mode: EnhancedMode) => hashObject({ ...mode, permissionMode: mapToClaudeMode(mode.permissionMode) });
    const policyHash = ({ model: _model, effort: _effort, fallbackModel: _fallback, ...policy }: EnhancedMode) => hashObject({ ...policy, permissionMode: mapToClaudeMode(policy.permissionMode) });
    let chain = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let process: Awaited<ReturnType<typeof startNativeInteractiveProcess>> | undefined;
    let lastWarning = '';
    const warn = (message: string) => { if (lastWarning !== message) { lastWarning = message; session.client.sendSessionEvent({ type: 'message', message }); } };
    const scanner = await createSessionScanner({ sessionId: resume ? id : null, workingDirectory: session.path, onTranscriptEvent: session.onNativeTranscriptEvent, hydrateGoalStatus: true,
        onTaskNotification: event => { tasks.complete(event); schedule(); }, onMessage: raw => {
        const failure = claudeTurnFailure(raw as any); if (failure) session.onTurnFailure?.(failure);
        const m = (raw as any).message;
        if (raw.type === 'assistant' && m?.id && m.usage) {
            const count = (key: string) => typeof m.usage[key] === 'number' ? m.usage[key] : 0;
            const usage = { inputTokens: count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens'), outputTokens: count('output_tokens') };
            const previous = usageByMessage.get(m.id) ?? { inputTokens: 0, outputTokens: 0 };
            const delta = { inputTokens: Math.max(0, usage.inputTokens - previous.inputTokens), outputTokens: Math.max(0, usage.outputTokens - previous.outputTokens) };
            if (delta.inputTokens || delta.outputTokens) session.onTurnUsage?.(delta);
            usageByMessage.set(m.id, usage);
            if (usageByMessage.size > 256) usageByMessage.delete(usageByMessage.keys().next().value!);
        }
        tasks.observe(raw);
        const content = (raw as any).message?.content;
        if (raw.type === 'user' && typeof content === 'string' && /^<(?:local-command|command-name)/.test(content.trim())) {
            if (pending.length && normalizeClaudeGoalEcho(content).trim() === pendingText.trim()) {
                acknowledge();
                phase = 'stopping'; schedule();
            }
            return;
        }
        const echo = raw.type === 'user' && typeof content === 'string' ? echoes.indexOf(content.trim()) : -1;
        if (echo >= 0) { echoes.splice(echo, 1); return; }
        if (raw.type !== 'summary') chain = chain.then(() => session.client.sendClaudeSessionMessageFromLocalTranscript(raw)).catch(() => warn('原生会话记录同步暂时失败，请保留当前会话。'));
    } });
    const acknowledge = () => {
        session.nativeUnwritten = false;
        if (deliveryTimer) clearTimeout(deliveryTimer);
        if (pending.length) {
            echoes.push(pendingText.trim()); if (echoes.length > 32) echoes.shift();
            session.client.sendSessionEvent({ type: 'queue-released', keys: pending.map(item => item.key) });
            pending = []; pendingText = '';
        }
    };
    const boundaryBlocker = () => {
        if (permissions.hasPendingRequests()) return '等权限请求处理完成';
        if (tasks.active) return '等原生后台任务确认结束（可在原生窗口查看 /tasks）';
        if (pending.length || phase !== 'idle' || !process?.relay.snapshot().composer) return '等原生回合或提示处理完成';
        if (leaving) return '会话正在退出';
        return null;
    };
    const leave = async (purpose: typeof exitPurpose) => {
        if (!process || leaving) return;
        exitPurpose = purpose; leaving = true;
        process.write(encodeNativeInput({ type: 'text', text: '/exit' }));
        await new Promise(resolve => setTimeout(resolve, 120));
        process.write(encodeNativeInput({ type: 'key', key: 'enter' }));
    };
    function schedule() {
        if (timer) clearTimeout(timer);
        if (!stopped) timer = setTimeout(() => { void pump().catch(error => warn(String(error))); }, 180);
    }
    let finishingTurn = false;
    const pump = async () => {
        // Claude does not emit Stop after Escape. Require a fresh idle composer
        // before closing that interrupted turn and delivering the promoted item.
        if (process && phase === 'busy' && interruptRevision !== null) {
            await process.settled();
            const screen = process.relay.snapshot();
            if (screen.revision > interruptRevision && screen.composer) {
                phase = 'stopping'; interruptRevision = null;
            }
        }
        if (process && phase === 'stopping' && !finishingTurn) {
            await process.settled();
            if (!process.relay.snapshot().composer) return;
            finishingTurn = true;
            try {
                await scanner.flush(); await chain;
                session.client.closeClaudeSessionTurn(turnStatus);
                phase = 'idle'; session.onThinkingChange(false); tasks.endTurn();
            } finally { finishingTurn = false; }
        }
        if (refresh?.pending) await refresh.drain();
        if (!process || stopped || leaving || phase !== 'idle' || deliveryBlocked || pending.length) return;
        await process.settled();
        if (phase !== 'idle' || !process.relay.snapshot().composer) return;
        const head = session.queue.queue[0];
        let mode = head?.mode ?? session.getNativeMode();
        if (runtimeHash(mode) !== runtimeHash(settings)) {
            if (!boundaryBlocker()) { await leave('restart'); return; }
            // Keep chatting on the running model while its background tasks
            // finish. Never defer permission, tool or system-prompt changes.
            if (tasks.active && head && !head.isolate && !permissions.hasPendingRequests() && policyHash(mode) === policyHash(settings)) {
                warn('后台任务仍在运行，这条消息先使用当前运行的模型；所选模型与思考层级将在后台任务结束后应用。');
                mode = settings;
            } else {
                warn('运行设置已保存，等待当前回合和原生后台任务结束后应用。');
                return;
            }
        }
        if (!head) return;
        phase = 'sending';
        const batch = [head];
        if (session.queue.getQueueMode() === 'batch' && !head.isolate) {
            for (const item of session.queue.queue.slice(1)) {
                if (item.isolate || runtimeHash(item.mode) !== runtimeHash(head.mode)) break;
                batch.push(item);
            }
        }
        pending = batch.map(item => session.queue.takeByKey(item.key)!).filter(Boolean);
        let pasted = false;
        try {
            const attachments = pending.flatMap(item => item.attachments ?? []);
            const note = attachments.length ? formatInboxNote(await saveAttachmentsToInbox(attachments, { projectPath: session.path, sessionId: session.client.sessionId })) : '';
            const text = pending.map(item => item.message).join('\n\n');
            const prepared = await session.prepareGoalMessage?.({ message: text + note, mode, goalText: text }, commands);
            pendingText = typeof prepared?.message === 'string' ? prepared.message : text + note;
            // Slash commands may acknowledge through their transcript rather
            // than UserPromptSubmit. Watch before writing; never resend a timeout.
            if (pendingText.startsWith('/goal ')) void scanner.onNewSession(id);
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
            // Only native submit/command transcript acknowledges consumption. A timeout cannot
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
            onHook: async (hook, signal) => {
                if (hook.event === 'PreToolUse') {
                    if (mapToClaudeMode(session.getNativeMode().permissionMode) !== permission) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Permission settings changed. End this turn so LMC can apply the current settings safely.' } };
                }
                if (hook.event === 'PreToolUse' || hook.event === 'PermissionRequest') return nativePermissionHook(session, permissions, hook, signal);
                if (hook.event === 'SessionStart') { session.onSessionFound(id); phase = 'idle'; }
                if (hook.event === 'UserPromptSubmit') {
                    interruptRevision = null;
                    turnStatus = 'completed';
                    // Fresh interactive sessions may sit at the composer for
                    // hours before a transcript exists. Start watching on the
                    // first real submission, not SessionStart's 60s timeout.
                    void scanner.onNewSession(id);
                    acknowledge();
                    phase = 'busy'; session.onThinkingChange(true);
                }
                if (hook.event === 'Stop' || hook.event === 'StopFailure') {
                    turnStatus = hook.event === 'StopFailure' ? 'failed' : 'completed';
                    phase = 'stopping';
                }
                schedule();
                return undefined;
            } });
        session.mode = 'remote';
        session.client.updateAgentState(state => ({ ...state, controlledByUser: false }));
        await session.client.updateMetadata(metadata => ({ ...metadata, claudeNativeActive: true, slashCommands: commands,
            sessionCapabilities: { ...engineCapabilities('claude'), nativeComputer: true, refresh: true, runtimeConfiguration: false, automaticGoals: commands.some(command => command.replace(/^\//, '') === 'goal') } }));
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
                    const result = process!.relay.input(request as NativeInputRequest);
                    if (!result.repeated && phase === 'busy' && request.input?.type === 'key' && request.input.key === 'escape') {
                        interruptRevision = result.revision; schedule();
                    }
                    return result;
                }
                case 'leave': {
                    process!.relay.assertCurrent(request);
                    if (leaving) return { ok: true };
                    if (tasks.active) throw new Error('原生后台任务尚未确认结束，可在原生窗口查看 /tasks');
                    if (phase !== 'idle' || pending.length || session.queue.size() || !process!.relay.snapshot().composer) throw new Error('请等待回合、排队消息和后台任务结束后退出原生模式');
                    await leave('switch');
                    return { ok: true };
                }
                default: throw new Error('Unsupported native action');
            }
        });
        const interrupt = async () => {
            if (phase === 'sending') throw new Error('原生消息正在交付');
            if (phase === 'busy' && interruptRevision === null) {
                process!.write(encodeNativeInput({ type: 'key', key: 'escape' }));
                interruptRevision = process!.relay.snapshot().revision;
            }
            schedule();
        };
        rpc.registerHandler('abort', interrupt);
        rpc.registerHandler('switch', async () => { throw new Error('请从原生控制窗口退出原生模式'); });
        refresh = nativeRefresh(session, {
            blocker: () => boundaryBlocker() ?? (session.queue.size() ? '等排队消息处理完成' : null),
            flush: async () => { await scanner.flush(); await chain; },
            exit: () => leave('refresh'),
        });
        stopWatchingConfiguration = watchSessionConfiguration(session.client, 'claude', async metadata => {
            if (metadata.permissionMode !== undefined) await permissions.handleModeChange(normalizeRemotePermissionMode(metadata.permissionMode ?? undefined));
            schedule();
        });
        session.interruptTurn = interrupt;
        registerQueueControlHandlers(session.client, session.queue, { isBusy: () => phase !== 'idle', interrupt, wake: schedule });
        session.queue.setOnMessage(schedule);
        schedule();
        const result = await process.exit;
        if (result.exitCode !== 0) warn(`原生 Claude 已退出（${result.exitCode}），未自动重发未确认消息。`);
        return result.exitCode === 0 && !pending.length ? exitPurpose : 'exit';
    } catch (error) {
        if (process) throw error;
        warn('原生进程未能启动，已返回普通模式：' + String(error));
        return 'switch';
    } finally {
        stopped = true; stopWatchingConfiguration(); permissions.reset();
        if (refresh?.pending) await refresh.cancel();
        phase = 'exited'; if (timer) clearTimeout(timer); if (deliveryTimer) clearTimeout(deliveryTimer);
        session.queue.setOnMessage(null); session.interruptTurn = null;
        for (const name of ['native-computer', 'configure-session', 'cancel-session-refresh']) session.client.rpcHandlerManager.unregisterHandler(name);
        await scanner.cleanup(); await chain;
        session.nativeComputer = false;
        session.onThinkingChange(false);
        session.client.closeClaudeSessionTurn(pending.length ? 'failed' : 'completed');
        await session.client.updateMetadata(metadata => ({ ...metadata, claudeNativeActive: false }));
    }
}
