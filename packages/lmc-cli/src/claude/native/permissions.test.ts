import { describe, expect, it, vi } from 'vitest';
import { nativePermissionHook } from './permissions';
const hook = { event: 'PreToolUse', sessionId: 'provider', toolName: 'AskUserQuestion', toolInput: { question: 'choice' }, requestId: 'request' };
describe('native worker permission transport', () => {
    it('keeps independent questions native and delegates autonomous worker questions through the existing policy', async () => {
        let orchestration: any;
        const session = { client: { getMetadata: () => ({ orchestration }) }, getNativeMode: () => ({}) } as any;
        const handler = { handleToolCall: vi.fn(async () => ({ behavior: 'deny', message: 'sent to hub' })) } as any;
        const signal = new AbortController().signal;
        expect(await nativePermissionHook(session, handler, hook, signal)).toBeUndefined();
        expect(handler.handleToolCall).not.toHaveBeenCalled();
        orchestration = { role: 'worker', hub: { autonomy: true } };
        expect(await nativePermissionHook(session, handler, hook, signal)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'sent to hub' } });
        expect(handler.handleToolCall).toHaveBeenCalledWith('AskUserQuestion', hook.toolInput, {}, { signal, toolUseID: 'request' });
    });
    it('returns official PermissionRequest output including approved input', async () => {
        const session = { client: { getMetadata: () => ({}) }, getNativeMode: () => ({}) } as any;
        const result = { behavior: 'allow', updatedInput: { command: 'pwd' } };
        const handler = { handleToolCall: vi.fn(async () => result) } as any;
        const signal = new AbortController().signal;
        expect(await nativePermissionHook(session, handler, { ...hook, event: 'PermissionRequest', toolName: 'Bash', toolUseId: 'tool' }, signal)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: result } });
        expect(handler.handleToolCall).toHaveBeenCalledWith('Bash', hook.toolInput, {}, { signal, toolUseID: 'tool' });
    });
});
