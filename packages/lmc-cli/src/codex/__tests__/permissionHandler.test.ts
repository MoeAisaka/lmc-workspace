import { describe, expect, it, vi } from 'vitest';
import { CodexPermissionHandler } from '../utils/permissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

function createSessionMock() {
    let state: Record<string, any> = {};

    return {
        session: {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                state = updater(state);
                return state;
            }),
        },
        getState: () => state,
    };
}

describe('CodexPermissionHandler', () => {
    it('sends a restricted worker tool decision to its hub without opening a human request', async () => {
        const { session, getState } = createSessionMock();
        const requestHubDecision = vi.fn(async () => true);
        Object.assign(session, { getMetadata: () => ({ orchestration: { role: 'worker', hub: { autonomy: true } } }), requestHubDecision });
        const handler = new CodexPermissionHandler(session as any);
        await expect(handler.handleToolCall('restricted', 'CodexBash', { command: ['pwd'] })).resolves.toEqual({ decision: 'denied' });
        expect(requestHubDecision).toHaveBeenCalledTimes(1);
        expect(getState().requests).toBeUndefined();
    });
    it('settles only ordinary old requests once when the confirmed runner policy becomes yolo', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);
        const ordinary = (handler.handleToolCall as any)('exec', 'CodexBash', { command: ['pwd'] }, { policyAutoApprove: true });
        const interactive = handler.handleToolCall('question', 'McpTool', { prompt: 'choose' });
        (handler as any).onPolicyChange?.('yolo', false);
        expect(getState().completedRequests?.exec?.status).toBe('approved');
        expect(getState().requests.question).toBeDefined();
        handler.abortAll();
        await expect(ordinary).resolves.toEqual({ decision: 'approved' });
        await expect(interactive).resolves.toEqual({ decision: 'abort' });
        expect(getState().completedRequests.exec.status).toBe('approved');
    });

    it('does not re-evaluate old requests under a tightened or hub-guarded policy', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);
        const pending = (handler.handleToolCall as any)('exec', 'CodexBash', {}, { policyAutoApprove: true });
        (handler as any).onPolicyChange?.('default', false);
        (handler as any).onPolicyChange?.('yolo', true);
        expect(getState().requests.exec).toBeDefined();
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('auto-approves the safe change_title tool', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'call_change_title_123',
            'change_title',
            { title: 'Greeting' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests.call_change_title_123).toMatchObject({
            tool: 'change_title',
            arguments: { title: 'Greeting' },
            status: 'approved',
            decision: 'approved',
        });
    });

    it('keeps non-safe tools pending for user approval', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_exec_123',
            'Bash',
            { command: 'pwd' },
        );

        expect(getState().requests.call_exec_123).toMatchObject({
            tool: 'Bash',
            arguments: { command: 'pwd' },
        });

        handler.abortAll();

        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('does NOT auto-approve a crafted tool name containing change_title as substring', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_malicious_1',
            'change_title_and_run_command',
            { title: 'pwn', cmd: 'rm -rf /' },
        );

        // Should remain pending (not auto-approved) — resolve via abort to clean up.
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('does NOT auto-approve a tool whose ID merely contains change_title as substring', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        // ID like `x_change_title_y` — old substring check would match, new prefix check must not.
        const pending = handler.handleToolCall(
            'x_change_title_y',
            'ExecCommand',
            { command: 'rm -rf /' },
        );

        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('auto-approves change_title tool call by Gemini-style ID (change_title-<timestamp>)', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'change_title-1765385846663',
            'other',
            { title: 'Greeting' },
        );

        expect(result).toEqual({ decision: 'approved' });
    });

    it('auto-approves change_title-prefixed IDs after Codex thread scoping', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'thread-1:change_title-1765385846663',
            'other',
            { title: 'Greeting' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests['thread-1:change_title-1765385846663']).toMatchObject({
            status: 'approved',
        });
    });
});
