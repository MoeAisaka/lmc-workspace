import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  AgyBackend,
  appendBoundedStderr,
  extractTerminatedBackgroundTaskCount,
  parsePrintTimeoutMs,
  type SpawnFn,
} from './AgyBackend';
import { AGY_PRINT_TIMEOUT } from './constants';
import type { AgentMessage } from '@/agent/core/AgentBackend';

function setup(options: { conversationId?: string; printTimeout?: string } = {}) {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
  const messages: AgentMessage[] = [], calls: { args: string[]; options: any }[] = [];
  const spawnFn = ((_cmd: string, args: string[], opts: any) => { calls.push({ args, options: opts }); return child; }) as unknown as SpawnFn;
  const onConversationId = vi.fn();
  const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, onConversationId, ...options });
  backend.onMessage(m => messages.push(m));
  const line = (event: unknown) => stdout.emit('data', JSON.stringify(event) + '\n');
  return { backend, child, stdout, stderr, messages, calls, line, onConversationId };
}

describe('AgyBackend lifecycle', () => {
  it('does not pass runner reconnect identity to native tools', async () => {
    vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'fixture-owner');
    vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_KEY', 'fixture-key');
    vi.stubEnv('LMC_AGY_MCP_MODULE', '/fixture/bridge.mjs');
    try {
      const f = setup(); const turn = f.backend.sendPrompt('/work', 'hello');
      const env = f.calls[0].options.env;
      f.line({ event: 'result', result: { conversation_id: 'mine', status: 'SUCCESS', response: 'ok' } });
      f.child.emit('close', 0); await turn;
      expect(env.HAPPY_RECONNECT_SESSION_ID).toBeUndefined();
      expect(env.HAPPY_RECONNECT_ENCRYPTION_KEY).toBeUndefined();
      expect(env.LMC_AGY_MCP_MODULE).toBe('/fixture/bridge.mjs');
    } finally { vi.unstubAllEnvs(); }
  });

  it('starts fresh and closes stdin so a print turn can complete', async () => {
    const f = setup(); await f.backend.startSession(); const turn = f.backend.sendPrompt('/work', 'hello');
    expect(f.calls[0].args).not.toContain('--conversation');
    expect(f.calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    f.line({ event: 'result', result: { conversation_id: 'mine', status: 'SUCCESS', response: 'hello' } });
    f.child.emit('close', 0); await turn;
    expect(f.onConversationId).toHaveBeenCalledWith('mine');
    expect(f.messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('passes an explicitly restored conversation and rejects a foreign returned id', async () => {
    const f = setup({ conversationId: 'mine' }); const turn = f.backend.sendPrompt('/work', 'hello');
    const observed = expect(turn).rejects.toThrow(/different conversation/);
    const i = f.calls[0].args.indexOf('--conversation'); expect(f.calls[0].args[i + 1]).toBe('mine');
    f.line({ event: 'init', conversation_id: 'theirs' }); f.child.emit('close', 0); await observed;
    expect(f.onConversationId).not.toHaveBeenCalled();
  });

  it('reports a nonzero exit as failure', async () => {
    const f = setup(); const turn = f.backend.sendPrompt('/work', 'hello');
    const observed = expect(turn).rejects.toThrow(/exited with code 1/);
    f.child.emit('close', 1); await observed;
    expect(f.messages.at(-1)).toMatchObject({ type: 'status', status: 'error' });
  });

  it('emits one error when spawn error is followed by close', async () => {
    const f = setup(); const turn = f.backend.sendPrompt('/work', 'hello');
    const observed = expect(turn).rejects.toThrow(/ENOENT/);
    f.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })); f.child.emit('close', null); await observed;
    expect(f.messages.filter(m => m.type === 'status' && m.status === 'error')).toHaveLength(1);
  });

  it('cancels only its own child', async () => {
    const f = setup(); const turn = f.backend.sendPrompt('/work', 'hello'); const observed = expect(turn).rejects.toThrow();
    await f.backend.cancel(); expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    f.child.emit('close', null); await observed;
  });

  it('does not pass a malformed protocol line off as an assistant reply', async () => {
    const f = setup(); const turn = f.backend.sendPrompt('/work', 'hello'); const observed = expect(turn).rejects.toThrow(/structured output/);
    f.stdout.emit('data', 'not json\n'); f.child.emit('close', 0); await observed;
    expect(f.messages.filter(m => m.type === 'model-output')).toHaveLength(0);
  });

  it('defaults to --print-timeout 168h (bypassing agy 30m background fallback), handles >24.85d Node timers safely, and preserves explicit timeouts', async () => {
    vi.useFakeTimers();
    try {
      expect(AGY_PRINT_TIMEOUT).toBe('168h');
      expect(parsePrintTimeoutMs('0')).toBeNull();
      expect(parsePrintTimeoutMs('0s')).toBeNull();
      expect(parsePrintTimeoutMs('10m')).toBe(600_000);
      expect(parsePrintTimeoutMs('1h30m')).toBe(5_400_000);
      expect(parsePrintTimeoutMs('168h')).toBe(604_800_000);

      const defaultBackend = setup();
      const defaultTurn = defaultBackend.backend.sendPrompt('/work', 'long background task');
      const ptIdx = defaultBackend.calls[0].args.indexOf('--print-timeout');
      expect(defaultBackend.calls[0].args[ptIdx + 1]).toBe('168h');
      // Survives well past both 10m and the former 30m background inactivity boundary.
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      expect(defaultBackend.child.kill).not.toHaveBeenCalled();
      defaultBackend.line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'done' } });
      defaultBackend.child.emit('close', 0);
      await defaultTurn;

      // Durations exceeding Node's 32-bit signed setTimeout max (2_147_483_647 ms ≈ 596.5h)
      // must NOT overflow and fire in 1ms.
      const monthLong = setup({ printTimeout: '720h' });
      const monthTurn = monthLong.backend.sendPrompt('/work', 'month soak');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(monthLong.child.kill).not.toHaveBeenCalled();
      monthLong.line({ event: 'result', result: { conversation_id: 'c-month', status: 'SUCCESS', response: 'ok' } });
      monthLong.child.emit('close', 0);
      await monthTurn;

      const bounded = setup({ printTimeout: '10m' });
      const boundedTurn = bounded.backend.sendPrompt('/work', 'bounded');
      const observed = expect(boundedTurn).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 30_000);
      expect(bounded.child.kill).toHaveBeenCalledWith('SIGTERM');
      bounded.child.emit('close', null);
      await observed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically retries once with continuation prompt after a mid-turn OAuth 401 token refresh race', async () => {
    const makeProc = () => {
      const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      return Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
    };
    const procs = [makeProc(), makeProc()];
    const calls: string[][] = [];
    let idx = 0;
    const spawnFn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return procs[idx++];
    }) as unknown as SpawnFn;
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, authRetryDelayMs: 5 });
    backend.onMessage(m => messages.push(m));

    const turn = backend.sendPrompt('/work', 'investigate production logs');
    procs[0].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-401', init: {} }) + '\n');
    procs[0].stdout.emit('data', JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'conv-401', step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Checking logs... ' },
    }) + '\n');
    procs[0].stderr.emit('data', 'AGY_ERROR: agent executor error: generating and executing: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\n');
    procs[0].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-401', status: 'ERROR', response: '', error: 'older cached error' },
    }) + '\n');
    procs[0].emit('close', 1);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const convIdx = calls[1].indexOf('--conversation');
    expect(calls[1][convIdx + 1]).toBe('conv-401');
    const printIdx = calls[1].indexOf('--print');
    expect(calls[1][printIdx + 1]).not.toBe('investigate production logs');

    procs[1].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-401', init: {} }) + '\n');
    procs[1].stdout.emit('data', JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'conv-401', step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: 'Done!' },
    }) + '\n');
    procs[1].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-401', status: 'SUCCESS', response: 'Done!' },
    }) + '\n');
    procs[1].emit('close', 0);

    await turn;
    expect(messages.filter(m => m.type === 'status' && m.status === 'error')).toHaveLength(0);
    expect(messages.filter(m => m.type === 'model-output').map(m => m.textDelta).join('')).toBe('Checking logs... Done!');
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('stops after one retry when OAuth 401 persists and aborts retry delay on cancel', async () => {
    const makeProc = () => {
      const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      return Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
    };
    const procs = [makeProc(), makeProc(), makeProc()];
    let idx = 0;
    const calls: string[][] = [];
    const spawnFn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return procs[idx++];
    }) as unknown as SpawnFn;
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'default', spawnFn, authRetryDelayMs: 5 });
    backend.onMessage(m => messages.push(m));

    const turn = backend.sendPrompt('/work', 'first');
    const observed = expect(turn).rejects.toThrow(/401|OAuth/i);
    procs[0].stderr.emit('data', 'AGY_ERROR: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\n');
    procs[0].emit('close', 1);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    procs[1].stderr.emit('data', 'AGY_ERROR: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\n');
    procs[1].emit('close', 1);
    await observed;
    expect(calls).toHaveLength(2);
    expect(messages.filter(m => m.type === 'status' && m.status === 'error')).toHaveLength(1);

    // Also verify cancel() during the backoff sleep aborts immediately without spawning a retry child.
    const slowProc = makeProc();
    const slowCalls: string[][] = [];
    const slowBackend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn: ((_cmd: string, args: string[]) => { slowCalls.push(args); return slowProc; }) as unknown as SpawnFn,
      authRetryDelayMs: 60_000,
    });
    const slowTurn = slowBackend.sendPrompt('/work', 'second');
    const slowObserved = expect(slowTurn).rejects.toThrow(/cancelled|aborted|401/i);
    slowProc.stderr.emit('data', 'AGY_ERROR: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.\n');
    slowProc.emit('close', 1);
    await new Promise(r => setTimeout(r, 10));
    await slowBackend.cancel();
    await slowObserved;
    expect(slowCalls).toHaveLength(1);
  });

  it('repairs corrupted conversation media in-place and retries once on INVALID_ARGUMENT (code 400)', async () => {
    const makeProc = () => {
      const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      return Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
    };
    const procs = [makeProc(), makeProc()];
    let idx = 0;
    const calls: string[][] = [];
    const spawnFn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return procs[idx++];
    }) as unknown as SpawnFn;
    const repairConversationMedia = vi.fn(() => ({ repairedCount: 3, repairedSteps: [12256, 12257, 12258] }));
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'bypassPermissions',
      conversationId: '47cca48f-7d13-44b7-adea-3bb0373e47eb',
      spawnFn,
      repairConversationMedia,
    });
    backend.onMessage(m => messages.push(m));

    const turn = backend.sendPrompt('/work', '平台内的文字行距看看需要优化和规范');
    procs[0].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: '47cca48f-7d13-44b7-adea-3bb0373e47eb', init: {} }) + '\n');
    procs[0].stderr.emit('data', 'AGY_ERROR: {"short_error":"INVALID_ARGUMENT (code 400): Request contains an invalid argument.","status":"INVALID_ARGUMENT","error_code":400}\n');
    procs[0].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: '47cca48f-7d13-44b7-adea-3bb0373e47eb', status: 'ERROR', response: '', error: 'INVALID_ARGUMENT (code 400): Request contains an invalid argument.' },
    }) + '\n');
    procs[0].emit('close', 3);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(repairConversationMedia).toHaveBeenCalledWith('47cca48f-7d13-44b7-adea-3bb0373e47eb');
    const retryPrintIdx = calls[1].indexOf('--print');
    expect(calls[1][retryPrintIdx + 1]).toContain('corrupted or truncated image file');

    // Simulate agy 1.4.x resumed turn succeeding with exit 0 while keeping historical result.status=ERROR
    procs[1].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: '47cca48f-7d13-44b7-adea-3bb0373e47eb', init: {} }) + '\n');
    procs[1].stdout.emit('data', JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: '47cca48f-7d13-44b7-adea-3bb0373e47eb', step_index: 12266, step_type: 'agent_response', state: 'DONE', text_delta: '已完成全站文字行距规范梳理与优化。' },
    }) + '\n');
    procs[1].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: '47cca48f-7d13-44b7-adea-3bb0373e47eb', status: 'ERROR', response: '已完成全站文字行距梳理与优化。', error: 'INVALID_ARGUMENT (code 400): Request contains an invalid argument.' },
    }) + '\n');
    procs[1].emit('close', 0);

    await turn;
    expect(messages.filter(m => m.type === 'status' && m.status === 'error')).toHaveLength(0);
    expect(messages.filter(m => m.type === 'model-output').map(m => m.textDelta).join('')).toContain('已完成全站文字行距');
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });

  it('does not retry INVALID_ARGUMENT (code 400) when no corrupted media exists in the conversation DB', async () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
    const calls: string[][] = [];
    const repairConversationMedia = vi.fn(() => ({ repairedCount: 0, repairedSteps: [] }));
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      conversationId: 'clean-conv',
      spawnFn: ((_cmd: string, args: string[]) => { calls.push(args); return child; }) as unknown as SpawnFn,
      repairConversationMedia,
    });
    const turn = backend.sendPrompt('/work', 'hello');
    const observed = expect(turn).rejects.toThrow(/INVALID_ARGUMENT/i);
    stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'clean-conv', init: {} }) + '\n');
    stderr.emit('data', 'AGY_ERROR: INVALID_ARGUMENT (code 400): Request contains an invalid argument.\n');
    child.emit('close', 3);
    await observed;
    expect(repairConversationMedia).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('extracts terminated non-daemon background task counts and preserves stderr tail across >16KB output', () => {
    expect(extractTerminatedBackgroundTaskCount('')).toBe(0);
    expect(extractTerminatedBackgroundTaskCount('terminating 2 daemon task(s) on exit\n')).toBe(0);
    expect(extractTerminatedBackgroundTaskCount('terminating 1 background task(s) on exit\n')).toBe(1);
    expect(
      extractTerminatedBackgroundTaskCount('terminating 3 background task(s) and 1 daemon task(s) on exit\n'),
    ).toBe(3);

    let buf = '';
    buf = appendBoundedStderr(buf, 'startup line\n');
    buf = appendBoundedStderr(buf, 'root agent idle; waiting up to 168h0m0s for 1 background task(s)\n'.repeat(400));
    buf = appendBoundedStderr(buf, 'terminating 1 background task(s) on exit\n');
    expect(buf.length).toBeLessThanOrEqual(16 * 1024);
    expect(buf).toContain('startup line');
    expect(extractTerminatedBackgroundTaskCount(buf)).toBe(1);
  });

  it('automatically wakes up and continues when agy exits 0 after terminating active background task(s)', async () => {
    const makeProc = () => {
      const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      return Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
    };
    const procs = [makeProc(), makeProc()];
    let idx = 0;
    const calls: string[][] = [];
    const spawnFn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return procs[idx++];
    }) as unknown as SpawnFn;
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({ cwd: '/work', permissionMode: 'bypassPermissions', spawnFn });
    backend.onMessage(m => messages.push(m));

    const turn = backend.sendPrompt('/work', 'run multi-round replay');
    procs[0].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-bg-1', init: {} }) + '\n');
    procs[0].stdout.emit('data', JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'conv-bg-1', step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Started replay... ' },
    }) + '\n');
    // Emit >20KB of noisy stderr before the final termination notice to verify tail retention.
    procs[0].stderr.emit('data', 'root agent idle; waiting up to 168h0m0s for 1 background task(s)\n'.repeat(350));
    procs[0].stderr.emit('data', 'terminating 1 background task(s) on exit\n');
    procs[0].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-bg-1', status: 'SUCCESS', response: 'Started replay... ' },
    }) + '\n');
    procs[0].emit('close', 0);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // Must stay running across continuation rather than prematurely emitting idle.
    expect(messages.filter(m => m.type === 'status' && m.status === 'idle')).toHaveLength(0);
    const convIdx = calls[1].indexOf('--conversation');
    expect(calls[1][convIdx + 1]).toBe('conv-bg-1');
    const contPromptIdx = calls[1].indexOf('--print');
    expect(calls[1][contPromptIdx + 1]).toContain('background task(s)');

    procs[1].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-bg-1', init: {} }) + '\n');
    procs[1].stdout.emit('data', JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: 'conv-bg-1', step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: 'Replay resumed and completed.' },
    }) + '\n');
    // Normal daemon cleanup on exit must NOT re-trigger wakeup.
    procs[1].stderr.emit('data', 'terminating 1 daemon task(s) on exit\n');
    procs[1].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-bg-1', status: 'SUCCESS', response: 'Replay resumed and completed.' },
    }) + '\n');
    procs[1].emit('close', 0);

    await turn;
    expect(calls).toHaveLength(2);
    expect(messages.filter(m => m.type === 'model-output').map(m => m.textDelta).join('')).toBe(
      'Started replay... Replay resumed and completed.',
    );
    expect(messages.filter(m => m.type === 'status' && m.status === 'idle')).toHaveLength(1);
  });

  it('rolls over automatically when default print window hits finished_reason=print_timeout, and respects maxBackgroundWakeupRetries', async () => {
    const makeProc = () => {
      const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      return Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
    };
    const procs = [makeProc(), makeProc()];
    let idx = 0;
    const calls: string[][] = [];
    const spawnFn = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return procs[idx++];
    }) as unknown as SpawnFn;
    const messages: AgentMessage[] = [];
    const backend = new AgyBackend({
      cwd: '/work',
      permissionMode: 'default',
      spawnFn,
      maxBackgroundWakeupRetries: 1,
    });
    backend.onMessage(m => messages.push(m));

    const turn = backend.sendPrompt('/work', 'week-long research');
    procs[0].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-pt', init: {} }) + '\n');
    procs[0].stderr.emit('data', '[agy] print timeout after 168h0m0s with turn in progress; returning partial output\n');
    procs[0].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-pt', status: 'SUCCESS', finished_reason: 'print_timeout', response: 'Part 1. ' },
    }) + '\n');
    procs[0].emit('close', 0);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // Second run hits maxBackgroundWakeupRetries=1 cap and finishes cleanly without infinite looping.
    procs[1].stdout.emit('data', JSON.stringify({ event: 'init', conversation_id: 'conv-pt', init: {} }) + '\n');
    procs[1].stderr.emit('data', 'terminating 1 background task(s) on exit\n');
    procs[1].stdout.emit('data', JSON.stringify({
      event: 'result',
      result: { conversation_id: 'conv-pt', status: 'SUCCESS', response: 'Part 2.' },
    }) + '\n');
    procs[1].emit('close', 0);

    await turn;
    expect(calls).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ type: 'status', status: 'idle' });
  });
});
