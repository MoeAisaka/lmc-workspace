import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';
import type { ClaudeGoalMessage } from './claudeAutomaticGoal';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    it('prepares each consumed turn after discovering native commands and preserves input on failure', async () => {
        const delivered: string[] = [];
        let calls = 0;
        const prepareGoalMessage = vi.fn(async (input: ClaudeGoalMessage, _commands: string[]) => {
            if (input.message === 'second') throw new Error('goal state unavailable');
            return { ...input, message: '/goal ' + input.message };
        });
        vi.mocked(query).mockImplementation(({ prompt }: any) => ({
            initializationResult: async () => ({ commands: [{ name: 'goal' }] }),
            async *[Symbol.asyncIterator]() {
                const inputs = prompt[Symbol.asyncIterator]();
                for (let i = 0; i < 2; i++) {
                    delivered.push((await inputs.next()).value.message.content);
                    yield { type: 'result', subtype: 'success' };
                }
            },
        }) as any);
        await claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ++calls <= 2 ? { message: calls === 1 ? 'first' : 'second', mode } : null,
            prepareGoalMessage, onReady: vi.fn(), canCallTool: async () => ({ behavior: 'deny', message: 'test' }),
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        });
        expect(delivered).toEqual(['/goal first', 'second']);
        expect(prepareGoalMessage.mock.calls[0][1]).toEqual(['goal']);
    });

    it('restores working state on a second turn and keeps it while tools await approval', async () => {
        const states: boolean[] = [];
        let deliverSecond!: (message: { message: string; mode: EnhancedMode }) => void;
        const second = new Promise<{ message: string; mode: EnhancedMode }>(resolve => { deliverSecond = resolve; });
        let calls = 0;
        vi.mocked(query).mockImplementation(({ prompt, options }: any) => ({
            async *[Symbol.asyncIterator]() {
                const input = prompt[Symbol.asyncIterator]();
                await input.next();
                yield { type: 'result', subtype: 'success' };
                expect(states).toEqual([true, false]);
                deliverSecond({ message: 'second', mode });
                await input.next();
                expect(states).toEqual([true, false, true]);
                await options.canCallTool('Read', {}, {});
                expect(states.at(-1)).toBe(true);
                yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1' }] } };
                expect(states.at(-1)).toBe(true);
                yield { type: 'result', subtype: 'success' };
            },
        }) as any);
        await claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ++calls === 1 ? { message: 'first', mode } : calls === 2 ? second : null,
            onReady: vi.fn(), canCallTool: async () => {
                expect(states.at(-1)).toBe(true);
                await Promise.resolve();
                expect(states.at(-1)).toBe(true);
                return { behavior: 'allow' } as any;
            },
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
            onThinkingChange: value => states.push(value),
        });
        expect(states).toEqual([true, false, true, false]);
    });

    it('awaits the safe refresh boundary before consuming another prompt', async () => {
        let boundaryCompleted = false;
        let calls = 0;
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() { yield { type:'result', subtype:'success' }; }
        } as any);
        await claudeRemote({
            sessionId:null, path:process.cwd(), allowedTools:[], hookSettingsPath:'/tmp/happy-test-settings.json',
            nextMessage:async()=> {
                if (++calls === 1) return {message:'first',mode};
                expect(boundaryCompleted).toBe(true); return null;
            },
            onReady: async()=>{ await Promise.resolve(); boundaryCompleted=true; },
            canCallTool:async()=>({behavior:'allow'} as any),isAborted:()=>false,
            onSessionFound:vi.fn(),onThinkingChange:vi.fn(),onMessage:vi.fn(),
        });
        expect(calls).toBe(2);
    });

    it('marks /clear as a completed reset turn', async () => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({
                message: '/clear',
                mode,
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['event:Context was reset', 'reset', 'ready']);
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });
});

it('refreshes quota before the first result, retries errors, and stops polling on exit', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const read = vi.fn()
        .mockRejectedValueOnce(new Error('temporarily unavailable'))
        .mockResolvedValueOnce({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 20, resets_at: null } } })
        .mockResolvedValue({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 35, resets_at: null } } });
    vi.mocked(query).mockReturnValue({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: read,
        async *[Symbol.asyncIterator]() { await gate; },
    } as any);
    const onUsageLimits = vi.fn();
    const running = claudeRemote({
        sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/unused-settings.json',
        nextMessage: async () => ({message:'first',mode}),
        onReady: vi.fn(), canCallTool: async () => ({behavior:'allow'} as any),
        isAborted:()=>false, onSessionFound:vi.fn(),onMessage:vi.fn(),onThinkingChange:vi.fn(),onUsageLimits,
    });
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(onUsageLimits.mock.calls.at(-1)?.[0].windows[0].utilization).toBe(20);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(onUsageLimits.mock.calls.at(-1)?.[0].windows[0].utilization).toBe(35);
        finish(); await running;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(3);
    } finally { finish(); await running; vi.useRealTimers(); }
});

it('publishes pushed quota during a turn without a result or usage API', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const onUsageLimits = vi.fn();
    vi.mocked(query).mockReturnValue({
        async *[Symbol.asyncIterator]() {
            yield { type:'rate_limit_event', rate_limit_info:{status:'allowed',rateLimitType:'seven_day',utilization:0.42} };
            await gate;
        },
    } as any);
    const running = claudeRemote({
        sessionId:null,path:process.cwd(),allowedTools:[],hookSettingsPath:'/tmp/unused-settings.json',
        nextMessage:async()=>({message:'first',mode}),onReady:vi.fn(),canCallTool:async()=>({behavior:'allow'} as any),
        isAborted:()=>false,onSessionFound:vi.fn(),onMessage:vi.fn(),onThinkingChange:vi.fn(),onUsageLimits,
    });
    try {
        await vi.waitFor(()=>expect(onUsageLimits).toHaveBeenCalled());
        expect(onUsageLimits.mock.calls[0][0].windows[0].utilization).toBe(42);
    } finally {finish();await running;}
});
