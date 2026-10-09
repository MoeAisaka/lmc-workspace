import { nativeRefresh, type BackgroundWorkChoice } from './refresh';
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
import { NativeExitGuard, nativeExitConfirmation, type NativeExitChoice } from './exitGuard';
export { nativeExitConfirmation, NATIVE_EXIT_REFUSED } from './exitGuard';
import { hashObject } from '@/utils/deterministicJson';
import { startNativeInteractiveProcess } from './interactiveProcess';
import { encodeNativeInput, nativeComposerHasDraft, sanitizeNativeText, unwrapNativePaste, NATIVE_TEXT_LIMIT, type NativeInputRequest } from './terminalRelay';
import { LMC_OPTIONS_SYSTEM_PROMPT } from 'lmc-wire';
import { isHub } from '@/modules/orchestration/hubGuard';
import { publishEngineDiagnostic, startSessionProgressMonitor } from '@/modules/diagnostics/noProgress';
import { detectSystemPrompt, systemPromptHint } from '@/modules/diagnostics/systemDiagnostics';

// The native enqueue receipt and ordinary Enter path were verified on 2.1.286.
// Unknown/older runtimes must not advertise a transport they cannot acknowledge.
export function supportsNativeSteering(version: string | undefined): boolean {
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')?.slice(1).map(Number);
    return !!parts && (parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 286))));
}

/** How long a refused exit keeps LMC from asking again. */
const EXIT_REFUSAL_HOLD_MS = 10 * 60_000;

type SteerResult = { steered: boolean; reason?: string; restore?: boolean };
type NativeGuidance = {
    key: string; outputRevision: number;
    text: string; startedAt: number; writing: boolean; submitted: boolean; written: boolean;
    settled: boolean; confirmed: boolean; modelDeferred: boolean; resolve: (result: SteerResult) => void;
    timer?: ReturnType<typeof setTimeout>;
};

function nativeRuntimeMode(mode: EnhancedMode): EnhancedMode {
    return {
        ...mode,
        permissionMode: mapToClaudeMode(mode.permissionMode),
        // The app attaches this exact built-in prompt to ordinary messages.
        // It is already installed at native startup, including after refresh.
        // Any custom append remains a real runtime policy change.
        appendSystemPrompt: mode.appendSystemPrompt?.startsWith(LMC_OPTIONS_SYSTEM_PROMPT) ? (mode.appendSystemPrompt.slice(LMC_OPTIONS_SYSTEM_PROMPT.length).trim() || undefined) : mode.appendSystemPrompt,
    };
}

export async function claudeNativeLauncher(session: Session): Promise<'switch' | 'exit' | 'restart' | 'refresh'> {
    const resume = !!session.sessionId && !session.nativeUnwritten;
    session.nativeUnwritten = !resume;
    const id = session.sessionId ?? randomUUID();
    const settings = nativeRuntimeMode(session.queue.queue[0]?.mode ?? session.getNativeMode());
    let phase: 'starting' | 'idle' | 'busy' | 'stopping' | 'sending' | 'unconfirmed' | 'unresponsive' | 'exited' = 'starting';
    let turnStatus: 'completed' | 'failed' = 'completed';
    let exitRefusedAt = 0;
    let exitRefusedWork: string[] = [];
    let exitPurpose: 'switch' | 'restart' | 'refresh' = 'switch';
    let retainedPurpose: 'switch' | 'restart' | 'refresh' = exitPurpose;
    const permissions = new PermissionHandler(session);
    permissions.reset('Previous Claude transport exited');
    await permissions.handleModeChange(normalizeRemotePermissionMode(settings.permissionMode));
    let stopWatchingConfiguration = () => {};
    let refresh: ReturnType<typeof nativeRefresh> | undefined;
    let stopped = false;
    let pending: TakenItem<EnhancedMode>[] = [];
    // A prepared attachment can move to the next bounded batch. Keep its note
    // until consumed/withdrawn so it is not saved again (or lost to a filename
    // collision) merely because the preceding prompt filled the terminal.
    const attachmentNotes = new Map<string, string>();
    let pendingText = '';
    let deliveryStartedAt = 0;
    let deliveryOutputRevision = 0;
    let deliveryGeneration = 0;
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let deliveryBlocked = false;
    let blockedKey: string | null = null;
    let interruptRevision: number | null = null;
    let draftClears = 0;
    let turnSerial = 0;
    let turnIsHub = isHub(session.client.getMetadata());
    let guidance: NativeGuidance | undefined;
    const echoes: string[] = [];
    const usageByMessage = new Map<string, { inputTokens: number; outputTokens: number }>();
    let commands = session.client.getMetadata()?.slashCommands ?? [];
    let nativeVersion: string | undefined;
    try { nativeVersion = (await runtimeVersion('claude')).version ?? undefined; } catch {}
    const canSteer = supportsNativeSteering(nativeVersion);
    // This release's real interactive /goal path is covered by the lab. Unknown
    // engine versions keep their discovered capabilities, rather than guessing.
    if (!(commands.includes('goal') || commands.includes('/goal'))) {
        if (nativeVersion === '2.1.285') commands = [...commands, 'goal'];
    }
    const tasks = new NativeBackgroundTasks();
    // The SDK queue hash intentionally ignores live permission changes. A PTY
    // child has fixed startup permissions, so native boundaries must include them.
    const runtimeHash = (mode: EnhancedMode) => hashObject(nativeRuntimeMode(mode));
    const policyHash = (mode: EnhancedMode) => {
        const { model: _model, effort: _effort, fallbackModel: _fallback, ...policy } = nativeRuntimeMode(mode);
        return hashObject(policy);
    };
    let chain = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let process: Awaited<ReturnType<typeof startNativeInteractiveProcess>> | undefined;
    const progress = startSessionProgressMonitor(session.client, () => process?.pid);
    publishEngineDiagnostic(session.client, 'delivery', undefined);
    let lastWarning = '';
    const warn = (message: string) => { if (lastWarning !== message) { lastWarning = message; session.client.sendSessionEvent({ type: 'message', message }); } };
    const reportDelivery = async (kind: 'guidance' | 'message', keys: string[], since: number, reason: 'unresponsive' | 'unconfirmed', stillPending: () => boolean) => {
        const generation = ++deliveryGeneration;
        publishEngineDiagnostic(session.client, 'delivery', { kind, keys, since, reason, systemPrompt: { status: 'unknown', checkedAt: Date.now() } });
        const diagnostic = await detectSystemPrompt();
        if (generation !== deliveryGeneration || !stillPending() || stopped) return;
        publishEngineDiagnostic(session.client, 'delivery', { kind, keys, since, reason, systemPrompt: diagnostic });
        const noun = kind === 'guidance' ? '引导消息' : '消息';
        warn((reason === 'unresponsive'
            ? `引擎进程没有响应，${noun}输入已在终端缓冲中，进程恢复后会自行提交；不会重发，也不会恢复进队列。`
            : `${noun}尚未确认送达，请在原生控制窗口查看；不会自动重复发送。`)
            + systemPromptHint(diagnostic, session.client.getMetadata()?.host));
    };
    const clearDelivery = () => { deliveryGeneration++; publishEngineDiagnostic(session.client, 'delivery', undefined); };
    const finishGuidance = (current: NativeGuidance, confirmed: boolean, timedOut = false) => {
        if (current.timer) clearTimeout(current.timer);
        if (confirmed) {
            if (guidance === current) { guidance = undefined; clearDelivery(); }
            if (!current.confirmed) session.client.sendSessionEvent({ type: 'message', message: 'Claude 已接收引导，将在工具步骤结束后读取；若本轮已结束，会在下一轮处理。'
                + (current.modelDeferred ? '本条使用当前运行的模型与思考层级；新设置仍已保存，将在安全空闲后生效。' : '') });
            current.confirmed = true;
        }
        if (!current.settled) {
            const reason = timedOut && current.submitted && process?.relay.outputRevision === current.outputRevision ? 'unresponsive' : 'unconfirmed';
            current.settled = true;
            if (!confirmed && !stopped) void reportDelivery('guidance', [current.key], current.startedAt, reason, () => guidance === current && !current.confirmed).catch(() => {});
            current.resolve(confirmed ? { steered: true } : { steered: false, reason, restore: false });
        }
        schedule();
    };
    const scanner = await createSessionScanner({ sessionId: resume ? id : null, workingDirectory: session.path, onTranscriptEvent: session.onNativeTranscriptEvent, hydrateGoalStatus: true,
        onActivity: () => progress.progress(),
        onQueuedMessage: event => {
            progress.progress();
            if (guidance?.submitted && unwrapNativePaste(event.text) === guidance.text.trim() && event.timestamp >= guidance.startedAt) finishGuidance(guidance, true);
            if (pending.length && unwrapNativePaste(event.text) === pendingText.trim() && event.timestamp >= deliveryStartedAt) {
                acknowledge();
                if (phase === 'unresponsive' || phase === 'unconfirmed') phase = 'sending';
            }
        },
        onTaskNotification: event => { progress.progress(); tasks.complete(event); schedule(); }, onMessage: raw => {
        progress.progress();
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
        const hadTasks = tasks.active;
        tasks.observe(raw);
        if (hadTasks && !tasks.active) schedule();
        const content = (raw as any).message?.content;
        // Bang commands skip UserPromptSubmit: their exact, fresh transcript
        // input is the receipt. It confirms delivery, not command success or
        // turn completion; Claude still runs the command and answers afterwards.
        const bash = raw.type === 'user' && typeof content === 'string'
            ? /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(content.trim()) : null;
        if (bash && pending.length && /^\s*!/.test(pendingText)
            && bash[1].trim() === pendingText.trim().slice(1).trim()
            && typeof raw.timestamp === 'string' && Date.parse(raw.timestamp) >= deliveryStartedAt) {
            acknowledge();
            if (phase === 'sending' || phase === 'unconfirmed' || phase === 'unresponsive') {
                turnSerial++; turnIsHub = isHub(session.client.getMetadata());
                interruptRevision = null; turnStatus = 'completed';
                phase = 'busy'; session.onThinkingChange(true); progress.setBusy(true);
            }
            // A delayed scanner receipt must not undo an already observed Stop.
            schedule();
        }
        if (raw.type === 'user' && typeof content === 'string' && /^<(?:local-command|command-name)/.test(content.trim())) {
            if (pending.length && normalizeClaudeGoalEcho(content).trim() === pendingText.trim()) {
                acknowledge();
                phase = 'stopping'; schedule();
            }
            return;
        }
        const echo = bash ? echoes.findIndex(text => /^\s*!/.test(text) && text.trim().slice(1).trim() === bash[1].trim())
            : raw.type === 'user' && typeof content === 'string' ? echoes.indexOf(unwrapNativePaste(content)) : -1;
        if (echo >= 0) { echoes.splice(echo, 1); return; }
        // Text typed or pasted in the native window itself: show it without the tag.
        if (raw.type === 'user' && typeof content === 'string' && unwrapNativePaste(content) !== content.trim()) raw = { ...raw, message: { ...m, content: unwrapNativePaste(content) } } as typeof raw;
        if (raw.type !== 'summary') chain = chain.then(() => session.client.sendClaudeSessionMessageFromLocalTranscript(raw)).catch(() => warn('原生会话记录同步暂时失败，请保留当前会话。'));
    } });
    const acknowledge = () => {
        session.nativeUnwritten = false;
        if (deliveryTimer) clearTimeout(deliveryTimer);
        if (pending.length) {
            clearDelivery();
            echoes.push(pendingText.trim()); if (echoes.length > 32) echoes.shift();
            session.client.sendSessionEvent({ type: 'queue-released', keys: pending.map(item => item.key) });
            for (const item of pending) attachmentNotes.delete(item.key);
            pending = []; pendingText = '';
        }
    };
    // `stop` is the person's choice to end Claude's own background work: the
    // exit then goes ahead and Claude's menu is answered "Exit and stop".
    const boundaryBlocker = (choice?: BackgroundWorkChoice) => {
        if (permissions.hasPendingRequests()) return '等权限请求处理完成';
        if (guidance) return '等引导消息确认或在原生窗口处理未提交的输入';
        if (tasks.active && choice !== 'stop') return '等原生后台任务确认结束（可在原生窗口查看 /tasks）';
        if (exitRefused() && choice !== 'stop') return exitRefusedWork.length
            ? `原生 Claude 里有后台工作在运行（${exitRefusedWork.join('；')}），退出会停掉它`
            : '原生 Claude 里有定时任务或后台工作在运行，退出会停掉它';
        if (pending.length || phase !== 'idle' || !process?.relay.snapshot().composer) return '等原生回合或提示处理完成';
        if (exitGuard.active) return '会话正在退出';
        return null;
    };
    // Claude asks before an exit that would stop its own scheduled or
    // background work. LMC does not track every kind of that work, so the
    // question is the signal: answer "Stay", keep the session as it was, and
    // let the caller say the exit did not happen. Never choose for the person
    // that their work should stop.
    const exitRefused = () => exitRefusedAt !== 0 && Date.now() - exitRefusedAt < EXIT_REFUSAL_HOLD_MS;
    const exitGuard = new NativeExitGuard({
        snapshot: () => process!.relay.snapshot(), settled: () => process!.settled(), write: bytes => process!.write(bytes),
        retained: work => {
            exitPurpose = retainedPurpose; exitRefusedAt = Date.now(); exitRefusedWork = work;
            publishEngineDiagnostic(session.client, 'nativeExit', undefined);
            schedule();
        },
        uncertain: since => publishEngineDiagnostic(session.client, 'nativeExit', { since }),
    });
    publishEngineDiagnostic(session.client, 'nativeExit', undefined);
    const leave = async (purpose: typeof exitPurpose, choice: NativeExitChoice = 'stay') => {
        if (!process) throw new Error('原生进程尚未就绪');
        if (!exitGuard.active) { retainedPurpose = exitPurpose; exitPurpose = purpose; }
        await exitGuard.leave(choice);
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
                phase = 'stopping'; interruptRevision = null; draftClears = 0;
            } else if (screen.revision > interruptRevision && draftClears < 3 && nativeComposerHasDraft(screen.lines, screen.cursor)) {
                // Claude restored the interrupted prompt into the composer. It is
                // already in the transcript and was interrupted on purpose, so
                // clear it (Escape twice) — otherwise this turn never closes and
                // nothing queued behind it is ever delivered.
                draftClears++;
                process.write(encodeNativeInput({ type: 'key', key: 'escape' }));
                await new Promise(resolve => setTimeout(resolve, 60));
                process.write(encodeNativeInput({ type: 'key', key: 'escape' }));
                interruptRevision = process.relay.snapshot().revision;
                setTimeout(schedule, 600);
            }
        }
        if (process && phase === 'stopping' && !finishingTurn) {
            if (guidance?.writing) return;
            await process.settled();
            if (!process.relay.snapshot().composer) return;
            finishingTurn = true;
            try {
                await scanner.flush(); await chain;
                session.client.closeClaudeSessionTurn(turnStatus);
                phase = 'idle'; session.onThinkingChange(false); progress.setBusy(false); tasks.endTurn();
            } finally { finishingTurn = false; }
        }
        // After an uncertain write, leave the native draft available for manual
        // recovery. A settled, empty idle composer proves that draft is gone;
        // release the guard, never put the already-written prompt back in LMC.
        if (process && phase === 'idle' && guidance?.settled && !guidance.writing) {
            await process.settled();
            if (process.relay.snapshot().composer) { guidance = undefined; clearDelivery(); }
        }
        if (refresh?.pending) await refresh.drain();
        // One message the terminal cannot take must not hold everything behind
        // it for the life of the process: once it is withdrawn, deliver again.
        if (deliveryBlocked && session.queue.queue[0]?.key !== blockedKey) { deliveryBlocked = false; blockedKey = null; }
        if (!process || stopped || exitGuard.active || phase !== 'idle' || deliveryBlocked || pending.length || guidance) return;
        const queuedKeys = new Set(session.queue.queue.map(item => item.key));
        for (const key of attachmentNotes.keys()) if (!queuedKeys.has(key)) attachmentNotes.delete(key);
        await process.settled();
        if (phase !== 'idle' || !process.relay.snapshot().composer) return;
        const head = session.queue.queue[0];
        let mode = head?.mode ?? session.getNativeMode();
        if (runtimeHash(mode) !== runtimeHash(settings)) {
            if (!boundaryBlocker()) {
                try { await leave('restart'); }
                catch (error) { if (!stopped) { warn(error instanceof Error ? error.message : String(error)); schedule(); } }
                return;
            }
            // Keep chatting on the running model while its background tasks
            // finish. Never defer permission, tool or system-prompt changes.
            if ((tasks.active || exitRefused()) && head && !head.isolate && !permissions.hasPendingRequests() && policyHash(mode) === policyHash(settings)) {
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
        // Never turn an adjacent chat message into part of a shell command (or
        // turn a queued shell command into ordinary chat through batching).
        // Bound the combined paste, not just each message. A backlog of valid
        // mails otherwise exceeds the encoder limit and locks the entire queue.
        // Attachment notes are accounted for after saving, below.
        let batchChars = sanitizeNativeText(head.message).length;
        if (session.queue.getQueueMode() === 'batch' && !head.isolate && !/^\s*!/.test(head.message)) {
            for (const item of session.queue.queue.slice(1)) {
                if (item.isolate || /^\s*!/.test(item.message) || runtimeHash(item.mode) !== runtimeHash(head.mode)) break;
                const nextChars = batchChars + 2 + sanitizeNativeText(item.message).length;
                if (nextChars > NATIVE_TEXT_LIMIT) break;
                batch.push(item);
                batchChars = nextChars;
            }
        }
        pending = batch.map(item => session.queue.takeByKey(item.key)!).filter(Boolean);
        let pasted = false;
        try {
            const parts: string[] = [];
            let chars = 0;
            for (let i = 0; i < pending.length; i++) {
                const item = pending[i];
                if (item.attachments?.length && !attachmentNotes.has(item.key)) {
                    attachmentNotes.set(item.key, formatInboxNote(await saveAttachmentsToInbox(item.attachments, { projectPath: session.path, sessionId: session.client.sessionId })));
                }
                const part = sanitizeNativeText(item.message + (attachmentNotes.get(item.key) ?? ''));
                const nextChars = chars + (parts.length ? 2 : 0) + part.length;
                if (parts.length && nextChars > NATIVE_TEXT_LIMIT) {
                    for (const deferred of pending.splice(i).reverse()) session.queue.restore(deferred);
                    break;
                }
                parts.push(part); chars = nextChars;
            }
            const text = pending.map(item => item.message).join('\n\n');
            const message = parts.join('\n\n');
            const prepared = await session.prepareGoalMessage?.({ message, mode, goalText: text }, commands);
            pendingText = sanitizeNativeText(typeof prepared?.message === 'string' ? prepared.message : message);
            if (!pendingText.trim()) {
                // Nothing to deliver — typically a message whose attachments never
                // arrived. Refusing it would block the queue behind an empty line.
                session.client.sendSessionEvent({ type: 'queue-released', keys: pending.map(item => item.key) });
                session.client.sendSessionEvent({ type: 'message', message: '收到一条空消息，没有交给 Claude；如果它本来带附件，附件没有上传成功，请重新发送。' });
                pending = []; pendingText = ''; phase = 'idle'; schedule();
                return;
            }
            // Local commands may acknowledge through their transcript rather
            // than UserPromptSubmit. Watch before writing; never resend a timeout.
            if (pendingText.startsWith('/goal ') || /^\s*!/.test(pendingText)) void scanner.onNewSession(id);
            const bytes = encodeNativeInput({ type: 'text', text: pendingText });
            deliveryStartedAt = Date.now();
            deliveryOutputRevision = process.relay.outputRevision;
            progress.setBusy(true);
            pasted = true;
            process.write(bytes);
            // Claude's composer consumes bracketed paste separately from Enter.
            await new Promise(resolve => setTimeout(resolve, 120));
            await process.settled();
            if (!stopped && phase === 'sending') process.write(encodeNativeInput({ type: 'key', key: 'enter' }));
            deliveryTimer = setTimeout(() => {
                if (phase === 'sending' && pending.length) {
                    const reason = process?.relay.outputRevision === deliveryOutputRevision ? 'unresponsive' : 'unconfirmed';
                    phase = reason;
                    void reportDelivery('message', pending.map(item => item.key), deliveryStartedAt, reason, () => pending.length > 0).catch(() => {});
                }
            }, 5000);
            // Only native submit/command transcript acknowledges consumption. A timeout cannot
            // establish non-delivery, so it must never trigger an automatic retry.
        } catch {
            if (!pasted) {
                blockedKey = pending[0]?.key ?? null;
                for (const item of pending.slice().reverse()) session.queue.restore(item);
                pending = []; pendingText = ''; phase = 'idle'; deliveryBlocked = true;
                progress.setBusy(false);
                warn('排在最前的这条消息无法交付到原生终端（通常是文字过长），已保留在队列。撤回它之后，后面的消息会照常发送。');
            } else {
                phase = 'unconfirmed';
                void reportDelivery('message', pending.map(item => item.key), deliveryStartedAt, 'unconfirmed', () => pending.length > 0).catch(() => {});
            }
        }
    };
    try {
        const args = ['--append-system-prompt', systemPrompt + '\nFor computer interaction, use the built-in computer-use tools. Do not silently substitute third-party desktop tools.\n\n' + LMC_OPTIONS_SYSTEM_PROMPT];
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
            onOutput: () => progress.progress(),
            onHook: async (hook, signal) => {
                progress.progress();
                if (hook.event === 'PreToolUse') {
                    if (mapToClaudeMode(session.getNativeMode().permissionMode) !== permission) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Permission settings changed. End this turn so LMC can apply the current settings safely.' } };
                }
                if (hook.event === 'PreToolUse' || hook.event === 'PermissionRequest') return nativePermissionHook(session, permissions, hook, signal);
                if (hook.event === 'SessionStart') { session.onSessionFound(id); phase = 'idle'; }
                if (hook.event === 'UserPromptSubmit') {
                    turnSerial++; turnIsHub = isHub(session.client.getMetadata());
                    interruptRevision = null;
                    turnStatus = 'completed';
                    // Fresh interactive sessions may sit at the composer for
                    // hours before a transcript exists. Start watching on the
                    // first real submission, not SessionStart's 60s timeout.
                    void scanner.onNewSession(id);
                    acknowledge();
                    phase = 'busy'; session.onThinkingChange(true); progress.setBusy(true);
                }
                if (hook.event === 'Stop' || hook.event === 'StopFailure') {
                    // A first Bash command may run longer than the missing-file
                    // watcher deadline; Claude writes that transcript only when
                    // the command returns. Revive its watcher at the real Stop.
                    if (pending.length && /^\s*!/.test(pendingText)) void scanner.onNewSession(id);
                    turnStatus = hook.event === 'StopFailure' ? 'failed' : 'completed';
                    phase = 'stopping';
                }
                schedule();
                return undefined;
            } });
        session.mode = 'remote';
        session.client.updateAgentState(state => ({ ...state, controlledByUser: false }));
        await session.client.updateMetadata(metadata => ({ ...metadata, claudeNativeActive: true, slashCommands: commands,
            sessionCapabilities: { ...engineCapabilities('claude'), turnSteer: canSteer, nativeComputer: true, refresh: true, runtimeConfiguration: false, automaticGoals: commands.some(command => command.replace(/^\//, '') === 'goal') } }));
        const rpc = session.client.rpcHandlerManager;
        rpc.registerHandler('native-computer', async (request: any) => {
            await process!.settled();
            switch (request?.action) {
                case 'claim': return { ...process!.relay.claim(request.clientId), phase };
                case 'screen': return { ...process!.relay.snapshot(request.clientId), phase };
                case 'release': process!.relay.release(request.clientId); return { ok: true };
                case 'input': {
                    if (request.input?.type === 'text' && /^\s*\/(?:clear|resume|fork|model|effort|permissions|plan|worktree)(?:\s|$)/i.test(request.input.text)) throw new Error('请先退出原生模式，再通过 LMC 调整设置或切换会话');
                    if (phase === 'sending' || guidance?.writing || exitGuard.writing) throw new Error('正在交付消息，请等待原生界面更新');
                    const before = process!.relay.snapshot();
                    const result = process!.relay.input(request as NativeInputRequest);
                    if (!result.repeated && exitGuard.active && (request.input?.type === 'key' && request.input.key === 'escape'
                        || request.input?.type === 'choice' && request.input.choice === nativeExitConfirmation(before.lines))) {
                        exitGuard.cancelledManually(result.revision);
                    }
                    if (!result.repeated && phase === 'busy' && request.input?.type === 'key' && request.input.key === 'escape') {
                        interruptRevision = result.revision; schedule();
                    }
                    return result;
                }
                case 'leave': {
                    process!.relay.assertCurrent(request);
                    if (exitGuard.active) throw new Error('原生退出尚未完成，请先处理原生窗口中的提示');
                    if (tasks.active) throw new Error('原生后台任务尚未确认结束，可在原生窗口查看 /tasks');
                    if (phase !== 'idle' || pending.length || guidance || session.queue.size() || !process!.relay.snapshot().composer) throw new Error('请等待回合、排队消息和后台任务结束后退出原生模式');
                    await leave('switch');
                    return { ok: true };
                }
                default: throw new Error('Unsupported native action');
            }
        });
        const interrupt = async () => {
            if (phase === 'sending' || guidance?.writing) throw new Error('原生消息正在交付');
            if (phase === 'busy' && interruptRevision === null) {
                process!.write(encodeNativeInput({ type: 'key', key: 'escape' }));
                interruptRevision = process!.relay.snapshot().revision;
            }
            schedule();
        };
        rpc.registerHandler('abort', interrupt);
        rpc.registerHandler('switch', async () => { throw new Error('请从原生控制窗口退出原生模式'); });
        refresh = nativeRefresh(session, {
            blocker: choice => boundaryBlocker(choice) ?? (session.queue.size() ? '等排队消息处理完成' : null),
            // Everything else is settled and only background work remains. A
            // person who chose to wait for that work is not given up on.
            standing: choice => choice !== 'wait' && phase === 'idle' && !permissions.hasPendingRequests() && !guidance && !pending.length && !exitGuard.active
                && (deliveryBlocked || ((tasks.active || exitRefused()) && !session.queue.size())),
            flush: async () => { await scanner.flush(); await chain; },
            exit: choice => leave('refresh', choice === 'stop' ? 'stop' : 'stay'),
            blockedWork: () => tasks.active || exitRefused() ? exitRefusedWork : undefined,
        });
        stopWatchingConfiguration = watchSessionConfiguration(session.client, 'claude', async metadata => {
            if (metadata.permissionMode !== undefined) await permissions.handleModeChange(normalizeRemotePermissionMode(metadata.permissionMode ?? undefined));
            schedule();
        });
        session.interruptTurn = interrupt;
        registerQueueControlHandlers(session.client, session.queue, { isBusy: () => phase !== 'idle', interrupt, wake: schedule,
            steer: async item => {
                if (!canSteer) return { steered: false, reason: 'unsupported' };
                if (guidance) return { steered: false, reason: 'refused' };
                if (item.attachments?.length) return { steered: false, reason: 'attachments' };
                if (item.isolate || /^\s*[!/]/.test(item.message)) return { steered: false, reason: 'command' };
                const serial = turnSerial;
                const refusal = () => {
                    if (stopped || exitGuard.active || phase !== 'busy' || turnSerial !== serial || interruptRevision !== null || pending.length) return 'idle';
                    if (refresh?.blocksSteering) return 'refreshing';
                    // Ordinary Enter queues input for this running Claude.
                    // Model/effort changes wait for its next safe boundary;
                    // permissions, tools, prompts and roles must still match.
                    if (policyHash(item.mode) !== policyHash(settings) || policyHash(session.getNativeMode()) !== policyHash(settings)
                        || turnIsHub !== isHub(session.client.getMetadata())) return 'settings';
                    if (permissions.hasPendingRequests()) return 'refused';
                    return null;
                };
                const initialRefusal = refusal();
                if (initialRefusal) return { steered: false, reason: initialRefusal };
                const steerText = sanitizeNativeText(item.message);
                if (!steerText.trim()) return { steered: false, reason: 'refused' };
                // Validate before any write: failures here may safely restore.
                const bytes = encodeNativeInput({ type: 'text', text: steerText });
                let resolve!: NativeGuidance['resolve'];
                const receipt = new Promise<SteerResult>(r => { resolve = r; });
                const current: NativeGuidance = { key: item.key, outputRevision: process!.relay.outputRevision, text: steerText, startedAt: Date.now(), written: false, writing: true, submitted: false, settled: false, confirmed: false,
                    modelDeferred: runtimeHash(item.mode) !== runtimeHash(settings) || runtimeHash(session.getNativeMode()) !== runtimeHash(settings), resolve };
                guidance = current;
                try {
                    await process!.settled();
                    const reason = refusal();
                    const screen = process!.relay.snapshot();
                    // Busy composers intentionally have composer=false. Inspect
                    // the actual cursor line so manual drafts/dialogs are kept.
                    if (reason || !/^\$\s*$/.test(screen.lines[screen.cursor.y] ?? '')) {
                        guidance = undefined;
                        return { steered: false, reason: reason ?? 'refused' };
                    }
                    // A write can throw after partially reaching the PTY. From
                    // this point on, even an exception must never restore/retry.
                    current.written = true;
                    current.outputRevision = process!.relay.outputRevision;
                    echoes.push(steerText.trim()); if (echoes.length > 32) echoes.shift();
                    process!.write(bytes);
                    await new Promise(r => setTimeout(r, 120));
                    await process!.settled();
                    if (refusal()) {
                        finishGuidance(current, false);
                    } else {
                        current.submitted = true;
                        current.timer = setTimeout(() => finishGuidance(current, false, true), 5000);
                        process!.write(encodeNativeInput({ type: 'key', key: 'enter' }));
                    }
                    current.writing = false;
                    return await receipt;
                } catch {
                    if (!current.written) {
                        if (guidance === current) guidance = undefined;
                        return { steered: false, reason: 'refused' };
                    }
                    finishGuidance(current, false);
                    return await receipt;
                } finally { current.writing = false; schedule(); }
            },
        });
        session.queue.setOnMessage(schedule);
        schedule();
        const result = await process.exit;
        exitGuard.exited(result.exitCode);
        if (result.exitCode !== 0) warn(`原生 Claude 已退出（${result.exitCode}），未自动重发未确认消息。`);
        return result.exitCode === 0 && !pending.length && !guidance ? exitPurpose : 'exit';
    } catch (error) {
        if (process) throw error;
        warn('原生进程未能启动，已返回普通模式：' + String(error));
        return 'switch';
    } finally {
        stopped = true; exitGuard.exited(-1); stopWatchingConfiguration(); permissions.reset();
        publishEngineDiagnostic(session.client, 'nativeExit', undefined);
        progress.stop();
        if (guidance) finishGuidance(guidance, false);
        clearDelivery();
        if (refresh?.pending) await refresh.cancel();
        phase = 'exited'; if (timer) clearTimeout(timer); if (deliveryTimer) clearTimeout(deliveryTimer);
        session.queue.setOnMessage(null); session.interruptTurn = null;
        for (const name of ['native-computer', 'configure-session', 'cancel-session-refresh']) session.client.rpcHandlerManager.unregisterHandler(name);
        await scanner.cleanup(); await chain;
        session.nativeComputer = false;
        session.onThinkingChange(false);
        session.client.closeClaudeSessionTurn(pending.length ? 'failed' : 'completed');
        await session.client.updateMetadata(metadata => ({ ...metadata, claudeNativeActive: false,
            sessionCapabilities: { ...engineCapabilities('claude'), ...metadata.sessionCapabilities, turnSteer: false } }));
    }
}
