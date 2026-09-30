import type { Session } from '../session';
import type { PermissionHandler } from '../utils/permissionHandler';
import type { NativeHook } from './interactiveProcess';

export async function nativePermissionHook(session: Session, handler: PermissionHandler, hook: NativeHook, signal: AbortSignal): Promise<object | undefined> {
    if (hook.event !== 'PreToolUse' && hook.event !== 'PermissionRequest') return;
    const worker = session.client.getMetadata()?.orchestration;
    // Independent sessions keep Claude's own question/plan UI. Workers retain
    // the existing live hub policy instead of opening a second human approval.
    if (hook.event === 'PreToolUse' && (!['AskUserQuestion', 'ExitPlanMode'].includes(hook.toolName ?? '') || worker?.role !== 'worker' || worker.hub.autonomy !== true)) return;
    if (!hook.toolName || !hook.requestId) throw new Error('Incomplete native permission request');
    const result = await handler.handleToolCall(hook.toolName, hook.toolInput ?? {}, session.getNativeMode(), {
        signal, toolUseID: hook.toolUseId ?? hook.requestId,
    });
    return { hookSpecificOutput: hook.event === 'PermissionRequest'
        ? { hookEventName: hook.event, decision: result }
        : { hookEventName: hook.event, permissionDecision: result.behavior,
            ...(result.behavior === 'allow' ? { updatedInput: result.updatedInput } : { permissionDecisionReason: result.message }) } };
}
