import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import type { EnhancedMode } from '../loop';

vi.mock('@/lib', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

function createSessionMock() {
    let state: Record<string, any> = {};
    const handlers = new Map<string, (message: any) => Promise<void>>();
    const sendSessionNotification = vi.fn();
    const pushClient = { sendSessionNotification };

    return {
        session: {
            client: {
                sessionId: 'happy-session-1',
                getMetadata: vi.fn(() => ({})),
                updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                    state = updater(state);
                    return state;
                }),
                rpcHandlerManager: {
                    registerHandler: vi.fn((name: string, handler: (message: any) => Promise<void>) => {
                        handlers.set(name, handler);
                    }),
                },
            },
            api: {
                push: vi.fn(() => pushClient),
            },
        },
        getState: () => state,
        handlers,
        sendSessionNotification,
    };
}

function getPermissionResponseHandler(handlers: Map<string, (message: any) => Promise<void>>) {
    const handler = handlers.get('permission');
    expect(handler).toBeDefined();
    return handler!;
}

describe('PermissionHandler', () => {
    it('does not allow a worker plan after a newer tightening overtakes its SDK acknowledgement', async () => {
        const { session } = createSessionMock();
        session.client.getMetadata.mockReturnValue({ orchestration: { role: 'worker', hub: { sessionId: 'H', autonomy: true } } });
        const handler = new PermissionHandler(session as any);
        let finish!: () => void;
        const setter = vi.fn().mockResolvedValueOnce(undefined)
            .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
            .mockResolvedValue(undefined);
        handler.setPermissionModeUpdater(setter);
        await handler.handleModeChange('bypassPermissions');
        const pending = handler.handleToolCall('ExitPlanMode', {}, mode, { signal: new AbortController().signal, toolUseID: 'old-plan' });
        const tighten = handler.handleModeChange('default');
        finish();
        await tighten;
        await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    });
    it('releases a pre-existing worker question to the hub on a policy update, not as an invented answer', async () => {
        const { session, getState } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const pending = handler.handleToolCall('AskUserQuestion', { questions: [{ question: 'Which test?' }] }, mode, { signal: new AbortController().signal, toolUseID: 'old-q' });
        expect(getState().requests['old-q']).toBeDefined();
        session.client.getMetadata.mockReturnValue({ orchestration: { role: 'worker', hub: { sessionId: 'H', autonomy: true } } });
        Object.assign(session.client, { requestHubDecision: vi.fn(async () => true) });
        await handler.handleModeChange('bypassPermissions');
        await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('hub') });
        expect(getState().completedRequests['old-q'].status).toBe('denied');
        expect(getState().requests['old-q']).toBeUndefined();
    });
    it('routes a bound worker question to its hub instead of creating a human approval', async () => {
        const { session, getState, sendSessionNotification } = createSessionMock();
        session.client.getMetadata.mockReturnValue({ orchestration: { role: 'worker', hub: { sessionId: 'H', autonomy: true } } });
        const requestHubDecision = vi.fn(async () => true);
        Object.assign(session.client, { requestHubDecision });
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();
        const pending = handler.handleToolCall('AskUserQuestion', { questions: [{ question: 'Which fixture?' }] }, mode, { signal: controller.signal, toolUseID: 'ask' });
        void pending.catch(() => undefined);
        await Promise.resolve();
        try { expect(requestHubDecision).toHaveBeenCalledTimes(1); } finally { if (!requestHubDecision.mock.calls.length) controller.abort(); }
        const result = await pending;
        expect(result.behavior).toBe('deny');
        expect(result).toMatchObject({ message: expect.stringContaining('hub') });
        expect(requestHubDecision).toHaveBeenCalledWith('ask', 'AskUserQuestion', { questions: [{ question: 'Which fixture?' }] });
        expect(getState().requests).toBeUndefined();
        expect(sendSessionNotification).not.toHaveBeenCalled();
    });

    it('does not require a second plan approval for a worker already granted full permission', async () => {
        const { session, getState } = createSessionMock();
        session.client.getMetadata.mockReturnValue({ orchestration: { role: 'worker', hub: { sessionId: 'H', autonomy: true } } });
        const handler = new PermissionHandler(session as any);
        await handler.handleModeChange('bypassPermissions');
        const controller = new AbortController();
        let settled = false;
        const pending = handler.handleToolCall('ExitPlanMode', { plan: 'run the assigned tests' }, mode, { signal: controller.signal, toolUseID: 'plan' }).then(result => { settled = true; return result; });
        void pending.catch(() => undefined);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        try { expect(settled).toBe(true); } finally { if (!settled) controller.abort(); }
        const result = await pending;
        expect(result.behavior).toBe('allow');
        expect(getState().requests).toBeUndefined();
    });

    it('does not let a late old-query response complete a reused request after reset', async () => {
        const { session, handlers, getState } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const old = handler.handleToolCall('Bash', {}, mode, { signal: new AbortController().signal, toolUseID: 'same' });
        const oldRejected = expect(old).rejects.toThrow('Session reset');
        let finish!: () => void;
        handler.setPermissionModeUpdater(() => new Promise<void>(r => { finish = r; }));
        const respond = getPermissionResponseHandler(handlers);
        const answer = respond({ id: 'same', approved: true, mode: 'bypassPermissions' });
        handler.reset();
        await oldRejected;
        const newer = handler.handleToolCall('Bash', { command: 'new' }, mode, { signal: new AbortController().signal, toolUseID: 'same' });
        finish(); await answer;
        expect(getState().requests.same.arguments).toEqual({ command: 'new' });
        expect(getState().completedRequests.same).toBeUndefined();
        await respond({ id: 'same', approved: false });
        await expect(newer).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('keeps AskUserQuestion and ExitPlanMode pending when ordinary permissions become full', async () => {
        const { session, handlers, getState } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const question = handler.handleToolCall('AskUserQuestion', { questions: [] }, mode, { signal: new AbortController().signal, toolUseID: 'ask' });
        const plan = handler.handleToolCall('ExitPlanMode', { plan: 'plan' }, mode, { signal: new AbortController().signal, toolUseID: 'plan' });
        await handler.handleModeChange('bypassPermissions');
        expect(Object.keys(getState().requests).sort()).toEqual(['ask', 'plan']);
        const respond = getPermissionResponseHandler(handlers);
        await respond({ id: 'ask', approved: true, updatedInput: { answers: { choice: 'A' } } });
        await respond({ id: 'plan', approved: true });
        await expect(question).resolves.toMatchObject({ updatedInput: { answers: { choice: 'A' } } });
        await expect(plan).resolves.toMatchObject({ behavior: 'allow' });
        const next = await handler.handleToolCall('Bash', {}, mode, { signal: new AbortController().signal, toolUseID: 'next' });
        expect(next.behavior).toBe('allow');
    });

    it('does not widen runner policy before the active SDK setter accepts, then settles ordinary old pending once', async () => {
        const { session, handlers, getState } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const pending = handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal: new AbortController().signal, toolUseID: 'old' });
        let finish!: () => void;
        handler.setPermissionModeUpdater(() => new Promise<void>(r => { finish = r; }));
        const change = handler.handleModeChange('bypassPermissions');
        let newerDone = false;
        const newer = handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal: new AbortController().signal, toolUseID: 'new' }).then(r => { newerDone = true; return r; });
        await Promise.resolve();
        expect(newerDone).toBe(false);
        finish();
        await change;
        await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
        await expect(newer).resolves.toMatchObject({ behavior: 'allow' });
        await getPermissionResponseHandler(handlers)({ id: 'old', approved: false });
        expect(getState().requests).toEqual({});
        expect(getState().completedRequests.old.status).toBe('approved');
    });

    it('retains a request when the SDK refuses full permission', async () => {
        const { session, handlers, getState } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        handler.setPermissionModeUpdater(async () => { throw new Error('setter refused'); });
        await expect(handler.handleModeChange('bypassPermissions')).rejects.toThrow('setter refused');
        const pending = handler.handleToolCall('Bash', { command: 'pwd' }, mode, { signal: new AbortController().signal, toolUseID: 'kept' });
        expect(getState().requests.kept).toBeDefined();
        await getPermissionResponseHandler(handlers)({ id: 'kept', approved: false });
        await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    });

    it('auto-approves tool calls in yolo mode without surfacing a request', async () => {
        const { session, getState } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        handler.handleModeChange('yolo');

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_yolo' },
        );

        expect(result).toMatchObject({ behavior: 'allow' });
        expect(getState().requests).toBeUndefined();
    });

    it('auto-approves tool calls in bypassPermissions mode', async () => {
        const { session } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        handler.handleModeChange('bypassPermissions');

        const result = await handler.handleToolCall(
            'Write',
            { file_path: '/tmp/x', content: 'y' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_bypass' },
        );

        expect(result).toMatchObject({ behavior: 'allow' });
    });

    it('syncs the mapped mode into the live query on mode change', async () => {
        const { session } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const setMode = vi.fn(async () => {});

        handler.setPermissionModeUpdater(setMode);
        handler.handleModeChange('yolo');

        expect(setMode).toHaveBeenCalledWith('bypassPermissions');
    });

    it('keeps main-thread request IDs unchanged', async () => {
        const { session, getState, handlers } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        const pending = handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_main' },
        );

        expect(getState().requests.toolu_main).toMatchObject({
            tool: 'Bash',
            arguments: { command: 'pwd' },
        });

        await getPermissionResponseHandler(handlers)({ id: 'toolu_main', approved: true });
        await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('uses agentID to disambiguate sub-agent permission requests with the same toolUseID', async () => {
        const { session, getState, handlers, sendSessionNotification } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const firstController = new AbortController();
        const secondController = new AbortController();

        const firstPending = handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: firstController.signal, toolUseID: 'toolu_shared', agentID: 'agent-a' },
        );
        const secondPending = handler.handleToolCall(
            'Bash',
            { command: 'whoami' },
            mode,
            { signal: secondController.signal, toolUseID: 'toolu_shared', agentID: 'agent-b' },
        );

        expect(getState().requests).toMatchObject({
            'agent-a:toolu_shared': {
                tool: 'Bash',
                arguments: { command: 'pwd' },
                // Raw provider id rides along so the app can attach the
                // permission card to the sidechain tool call.
                toolUseId: 'toolu_shared',
            },
            'agent-b:toolu_shared': {
                tool: 'Bash',
                arguments: { command: 'whoami' },
                toolUseId: 'toolu_shared',
            },
        });
        expect(sendSessionNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({
            data: expect.objectContaining({ requestId: 'agent-a:toolu_shared' }),
        }));
        expect(sendSessionNotification).toHaveBeenNthCalledWith(2, expect.objectContaining({
            data: expect.objectContaining({ requestId: 'agent-b:toolu_shared' }),
        }));

        const respondToPermission = getPermissionResponseHandler(handlers);
        await respondToPermission({
            id: 'agent-b:toolu_shared',
            approved: false,
            reason: 'not this one',
        });
        await respondToPermission({
            id: 'agent-a:toolu_shared',
            approved: true,
        });

        await expect(firstPending).resolves.toMatchObject({ behavior: 'allow' });
        await expect(secondPending).resolves.toMatchObject({
            behavior: 'deny',
            message: 'not this one',
        });
        expect(getState().completedRequests['agent-a:toolu_shared']).toMatchObject({
            status: 'approved',
            toolUseId: 'toolu_shared',
        });
        expect(getState().completedRequests['agent-b:toolu_shared']).toMatchObject({
            status: 'denied',
            toolUseId: 'toolu_shared',
        });
    });

    it('can look up a single sub-agent response by raw toolUseID for transcript follow-up paths', async () => {
        const { session, handlers } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        const pending = handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_result', agentID: 'agent-a' },
        );

        await getPermissionResponseHandler(handlers)({
            id: 'agent-a:toolu_result',
            approved: false,
            reason: 'denied',
            mode: 'default',
        });

        await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
        expect(handler.getResponseForToolUseId('toolu_result')).toMatchObject({
            approved: false,
            reason: 'denied',
        });
        expect(handler.isAborted('toolu_result')).toBe(true);
    });
});
